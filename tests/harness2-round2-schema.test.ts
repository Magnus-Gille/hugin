import { describe, expect, it } from "vitest";

import {
  HARNESS2_ROUND2_ARMS,
  computeHarness2Round2ProtocolHash,
  createHarness2Round2Schedule,
  harness2Round2DraftSchema,
  harness2Round2FrozenSchema,
  validateHarness2Round2Protocol,
} from "../src/learning/harness2-round2-schema.js";
import { computeConfigurationFingerprint } from "../src/learning/experiment-schema.js";

const hash = (letter: string) => letter.repeat(64);
const gitHash = (letter: string) => letter.repeat(40);

function task(id: string, holdout = false) {
  const taskMarker = holdout
    ? (id.endsWith("1") ? "d" : "e")
    : (id.endsWith("1") ? "a" : id.endsWith("2") ? "b" : "c");
  return {
    id,
    holdout,
    repository: "Magnus-Gille/hugin",
    base_sha: gitHash("b"),
    task_sha: gitHash(taskMarker),
    verifier_sha: gitHash("f"),
  };
}

function arm(name: typeof HARNESS2_ROUND2_ARMS[number], learned = false) {
  const harnessVariant = name.startsWith("Harness") ? "harness-2" : "harness-1";
  const promptVariant = learned ? "learned" : "fresh";
  const configuration = {
    prompt: { id: "round2-prompt", version: promptVariant, sha256: hash(promptVariant === "fresh" ? "a" : "b") },
    harness: { id: "round2-harness", version: harnessVariant, configSha256: hash(harnessVariant === "harness-1" ? "c" : "d") },
    model: { id: "gpt-5.6-sol", provider: "openai", runtime: "subscription", config: { reasoning: "high" as const } },
    logging: { schemaVersion: "1", requiredFieldsSha256: hash("e") },
    testHarness: { id: "round2-tests", version: "1", corpusSha256: hash("f"), oracleVersion: "1", holdoutRevision: "1" },
    routing: { policyId: "round2-routing", version: "1", configSha256: hash("1") },
  };
  return {
    name,
    guidance: learned ? "learned" : "fresh",
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "high",
    auth_route: "subscription",
    resource_caps: { input_tokens: 10_000, output_tokens: 4_000, cache_read_tokens: 0, cache_write_tokens: 0, total_reported_tokens: 14_000, wall_time_ms: 600_000, attempts: 2 },
    configuration: { ...configuration, fingerprint: computeConfigurationFingerprint(configuration) },
  };
}

function refreshFingerprint(record: ReturnType<typeof arm>): void {
  record.configuration.fingerprint = computeConfigurationFingerprint(record.configuration);
}

function protocol(options: { learnedHash?: string | null; learnedHoldoutIds?: string[]; primaryPending?: boolean } = {}) {
  const fresh = [task("fresh-1"), task("fresh-2"), task("fresh-3")];
  const holdout = [task("holdout-1", true), task("holdout-2", true)];
  return {
    protocol_id: "harness2-round2",
    phase: "draft" as "draft" | "frozen",
    admission_stage: "fresh" as "fresh" | "transfer",
    protocol_sha256: undefined as string | undefined,
    fresh_tasks: fresh,
    holdout_tasks: holdout,
    repeats: 3,
    arms: HARNESS2_ROUND2_ARMS.map((name) => arm(name, name.endsWith("Learned"))),
    resources: { input_tokens: 10_000, output_tokens: 4_000, cache_read_tokens: 0, cache_write_tokens: 0, total_reported_tokens: 14_000, wall_time_ms: 600_000, attempts: 2 },
    primary_criteria: [{ id: "tests", status: options.primaryPending ? "pending" : "frozen", oracle_sha: hash("2"), known_bad_sha: hash("3"), known_good_sha: hash("4") }],
    learned_artifact: options.learnedHash === null ? { status: "pending" as const } : { status: "frozen" as const, sha256: options.learnedHash ?? hash("b"), source_task_ids: options.learnedHoldoutIds ?? ["fresh-1", "fresh-2", "fresh-3"] },
  };
}

describe("Harness² round 2 protocol schema", () => {
  it("rejects task collisions and fresh/holdout overlap", () => {
    const value = protocol();
    value.holdout_tasks[0].id = value.fresh_tasks[0].id;
    expect(validateHarness2Round2Protocol(value).success).toBe(false);
  });

  it("rejects a task identity duplicate even when only the verifier differs", () => {
    const value = protocol();
    value.holdout_tasks[0].repository = value.fresh_tasks[0].repository;
    value.holdout_tasks[0].base_sha = value.fresh_tasks[0].base_sha;
    value.holdout_tasks[0].task_sha = value.fresh_tasks[0].task_sha;
    value.holdout_tasks[0].verifier_sha = gitHash("e");
    expect(validateHarness2Round2Protocol(value).success).toBe(false);
  });

  it("rejects incomplete primary criteria", () => {
    expect(validateHarness2Round2Protocol(protocol({ primaryPending: true })).success).toBe(false);
  });

  it("rejects mutable version identities", () => {
    const value = protocol();
    value.arms[0].configuration.harness.version = "mutable-latest";
    expect(validateHarness2Round2Protocol(value).success).toBe(false);
  });

  it.each([
    ["testHarness.oracleVersion", (record: ReturnType<typeof arm>) => { record.configuration.testHarness.oracleVersion = "latest"; }],
    ["testHarness.holdoutRevision", (record: ReturnType<typeof arm>) => { record.configuration.testHarness.holdoutRevision = "main"; }],
    ["harness.toolPolicyVersion", (record: ReturnType<typeof arm>) => { record.configuration.harness.toolPolicyVersion = "current"; }],
    ["model.config.templateVersion", (record: ReturnType<typeof arm>) => { record.configuration.model.config.templateVersion = "head"; }],
    ["model.config.quantization", (record: ReturnType<typeof arm>) => { record.configuration.model.config.quantization = "master"; }],
  ])("rejects mutable nested version binding %s after fingerprint refresh", (_field, mutate) => {
    const value = protocol();
    value.arms.forEach((record) => {
      mutate(record);
      refreshFingerprint(record);
    });
    expect(validateHarness2Round2Protocol(value).success).toBe(false);
  });

  it.each([
    ["provider", "anthropic"],
    ["model", "other-model"],
    ["effort", "medium"],
    ["auth_route", "api-key"],
  ])("rejects wrong %s", (field, wrong) => {
    const value = protocol();
    (value.arms[1] as Record<string, unknown>)[field] = wrong;
    expect(validateHarness2Round2Protocol(value).success).toBe(false);
  });

  it("rejects unequal resource caps", () => {
    const value = protocol();
    value.arms[1].resource_caps.output_tokens = 4_001;
    expect(validateHarness2Round2Protocol(value).success).toBe(false);
    const totals = protocol();
    totals.resources.total_reported_tokens = 10_000;
    expect(validateHarness2Round2Protocol(totals).success).toBe(false);
  });

  it("allows frozen fresh admission to prepare learned guidance, but requires it for transfer", () => {
    const missing = protocol({ learnedHash: null });
    missing.phase = "frozen";
    missing.protocol_sha256 = computeHarness2Round2ProtocolHash(missing);
    expect(validateHarness2Round2Protocol(missing).success).toBe(true);
    missing.admission_stage = "transfer";
    expect(validateHarness2Round2Protocol(missing).success).toBe(false);
    const leak = protocol({ learnedHoldoutIds: ["holdout-1"] });
    leak.phase = "frozen";
    leak.admission_stage = "transfer";
    leak.protocol_sha256 = computeHarness2Round2ProtocolHash(leak);
    expect(validateHarness2Round2Protocol(leak).success).toBe(false);
  });

  it("binds a frozen learned artifact to both learned prompt hashes", () => {
    const stale = protocol({ learnedHash: hash("9") });
    expect(validateHarness2Round2Protocol(stale).success).toBe(false);
  });

  it("does not skip pending prompt contrasts when learned arms change other axes", () => {
    const value = protocol({ learnedHash: null });
    value.arms[2].configuration.model.config.temperature = 0.5;
    value.arms[2].configuration.testHarness.corpusSha256 = hash("9");
    value.arms[3].configuration.model.config.temperature = 0.5;
    value.arms[3].configuration.testHarness.corpusSha256 = hash("9");
    refreshFingerprint(value.arms[2]);
    refreshFingerprint(value.arms[3]);
    expect(validateHarness2Round2Protocol(value).success).toBe(false);
  });

  it("distinguishes draft from frozen admission", () => {
    const draft = protocol({ learnedHash: null });
    expect(harness2Round2DraftSchema.safeParse(draft).success).toBe(true);
    expect(harness2Round2FrozenSchema.safeParse(draft).success).toBe(false);
  });

  it("creates exact deterministic schedules and stable canonical hashes", () => {
    const value = protocol();
    const schedule = createHarness2Round2Schedule(value);
    expect(schedule.fresh).toHaveLength(18);
    expect(schedule.transfer).toHaveLength(24);
    expect(schedule.fresh.slice(0, 4).map((cell) => cell.arm)).toEqual([
      "PiFresh", "HarnessFresh", "HarnessFresh", "PiFresh",
    ]);
    expect(schedule.transfer.slice(0, 8).map((cell) => cell.arm)).toEqual([
      "PiFresh", "HarnessFresh", "PiLearned", "HarnessLearned",
      "HarnessFresh", "PiLearned", "HarnessLearned", "PiFresh",
    ]);
    expect(schedule).toEqual(createHarness2Round2Schedule(structuredClone(value)));
    const firstHash = computeHarness2Round2ProtocolHash(value);
    expect(firstHash).toBe(computeHarness2Round2ProtocolHash(structuredClone(value)));
    value.fresh_tasks[0].task_sha = hash("x");
    expect(computeHarness2Round2ProtocolHash(value)).not.toBe(firstHash);
  });
});
