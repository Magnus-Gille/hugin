import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import { recordAdmittedHomeserverAttempt } from "../src/homeserver-learning-registry-bridge.js";
import {
  LEARNING_REGISTRY_CAPTURED_TAG,
  LEARNING_REGISTRY_PENDING_TAG,
  reconcilePendingHomeserverLearningTasks,
} from "../src/homeserver-learning-registry-recovery.js";
import type { M5LedgerAttemptBinding } from "../src/m5-ledger-attempt-binding.js";
import { buildStructuredTaskResult } from "../src/task-result-schema.js";
import { finalizeTaskCompletion } from "../src/task-helpers.js";
import { assembleCandidatePool } from "../src/learning/candidate-pool-assembler.js";
import { buildQualityBinding, buildQualityReceipt } from "../src/quality-receipt.js";
import {
  buildFixtureAdmittedAttempt,
  buildFixtureResultStructuredDocument,
  buildFixtureStatusDocument,
} from "./helpers/candidate-evidence-fixtures.js";

interface StoredEntry {
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

class InMemoryMunin {
  private readonly entries: StoredEntry[] = [];
  private seq = 0;

  private clock(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 6, 1) + this.seq).toISOString();
  }

  private find(namespace: string, key: string): StoredEntry | undefined {
    return this.entries.find((entry) => entry.namespace === namespace && entry.key === key);
  }

  async read(namespace: string, key: string) {
    const entry = this.find(namespace, key);
    return entry ? { ...entry, found: true as const } : null;
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
    createIfAbsent?: boolean,
  ) {
    const existing = this.find(namespace, key);
    if (createIfAbsent && existing) {
      throw new MuninWriteRejectedError(namespace, key, {
        error: "conflict",
        message: "Entry already exists.",
        conflict_reason: "already_exists",
        current_updated_at: existing.updated_at,
      });
    }
    if (expectedUpdatedAt !== undefined && existing?.updated_at !== expectedUpdatedAt) {
      throw new MuninWriteRejectedError(namespace, key, {
        error: "conflict",
        message: "Entry version changed.",
        conflict_reason: "version_mismatch",
        current_updated_at: existing?.updated_at,
      });
    }
    const updated_at = this.clock();
    const next: StoredEntry = {
      namespace,
      key,
      content,
      tags: tags ?? [],
      classification,
      created_at: existing?.created_at ?? updated_at,
      updated_at,
    };
    if (existing) Object.assign(existing, next);
    else this.entries.push(next);
    return { ok: true, status: existing ? "updated" : "created", updated_at };
  }

  async query(opts: { namespace?: string; tags?: string[]; limit?: number }) {
    const rows = this.entries.filter((entry) =>
      (!opts.namespace || entry.namespace.startsWith(opts.namespace))
      && (opts.tags ?? []).every((tag) => entry.tags.includes(tag)));
    const limited = rows.slice(0, opts.limit ?? 50);
    return {
      results: limited.map((entry) => ({
        id: `${entry.namespace}/${entry.key}`,
        namespace: entry.namespace,
        key: entry.key,
        entry_type: "state",
        content_preview: entry.content.slice(0, 80),
        tags: entry.tags,
        classification: entry.classification,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      })),
      total: rows.length,
    };
  }

  async log() {}
}

function setup() {
  const munin = new InMemoryMunin() as unknown as InMemoryMunin & MuninClient;
  return { munin, registry: new LearningRegistryStore(munin) };
}

function admittedInput(taskId = "broker-learning-1") {
  const admitted = buildFixtureAdmittedAttempt({ taskId, taskType: "code-edit" });
  const binding: M5LedgerAttemptBinding = {
    id: `ledger:${taskId}`,
    evidenceIdentityHash: hash(`evidence:${taskId}`),
    taskInstanceId: taskId,
    attemptId: admitted.attemptId,
    taskType: "code-edit",
    modelId: "qwen3-coder-next",
  };
  return {
    admitted,
    binding,
    input: {
      taskId,
      taskType: "code-edit",
      occurredAt: "2026-07-22T12:00:00.000Z",
      outcome: "completed" as const,
      repositoryOutcomeState: "not-managed" as const,
      learningTask: admitted.evidence,
      provenance: {
        ledgerId: `ledger:${taskId}`,
        nodeId: "m5",
        modelId: "qwen3-coder-next",
        taskType: "code-edit",
        outcome: "pass" as const,
        delegated: true,
      },
    },
  };
}

function bridgeDeps(
  registry: LearningRegistryStore,
  binding: M5LedgerAttemptBinding,
) {
  return {
    registry,
    resolveLedgerAttemptBinding: async () => binding,
  };
}

describe("recordAdmittedHomeserverAttempt", () => {
  it("records one real admitted Broker/M5 attempt with an explicit non-managed authority ceiling", async () => {
    const { munin, registry } = setup();
    const { admitted, binding, input } = admittedInput();
    await munin.write(
      admitted.attemptOutcomeRef.namespace,
      admitted.attemptOutcomeRef.key,
      JSON.stringify(admitted.evidence),
      ["learning-task-attempt", "attempt:admitted"],
    );

    const result = await recordAdmittedHomeserverAttempt(bridgeDeps(registry, binding), input);

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") throw new Error("expected recorded result");
    expect(result.attemptId).toBe(admitted.attemptId);
    expect(result.registry.attemptReference.event.payload.attemptStartRef)
      .toEqual(admitted.evidence.attemptStartRef);
    expect(result.registry.terminalOutcome.event.payload).toMatchObject({
      outcome: "completed",
      repositoryOutcomeState: "not-managed",
      attemptOutcomeRef: admitted.attemptOutcomeRef,
      delegation: {
        lane: "one-shot",
        ledgerId: "ledger:broker-learning-1",
        modelId: "qwen3-coder-next",
        taskType: "code-edit",
        evidenceIdentityHash: binding.evidenceIdentityHash,
      },
    });

    const statusContent = buildFixtureStatusDocument(input.taskId, "production-shaped Broker prompt");
    const structuredResultContent = buildFixtureResultStructuredDocument(input.taskId);
    await munin.write(`tasks/${input.taskId}`, "status", statusContent, ["completed"]);
    await munin.write(`tasks/${input.taskId}`, "result-structured", structuredResultContent, ["result"]);
    const receipt = buildQualityReceipt({
      taskId: input.taskId,
      reviewerPrincipal: "codex",
      reviewerIndependence: "independent",
      rating: "pass",
      ratingReason: "Bound independent review accepted the one-shot result.",
      verificationOutcome: "accepted_unchanged",
      ratedAt: input.occurredAt,
      bindingAttestation: "server-bound",
      binding: buildQualityBinding({ statusContent, structuredResultContent }),
    });
    await munin.write(
      `tasks/${input.taskId}`,
      "feedback",
      JSON.stringify({ schemaVersion: 1, taskId: input.taskId, receipts: [receipt] }),
      ["feedback"],
    );

    const pool = await assembleCandidatePool(
      { registry, munin },
      { periods: ["2026-07"] },
    );
    expect(pool.skipped).toEqual([]);
    expect(pool.candidates).toEqual([
      expect.objectContaining({
        taskId: input.taskId,
        attemptId: admitted.attemptId,
        taskType: "code-edit",
        configuration: expect.objectContaining({
          model: expect.objectContaining({ id: "qwen3-coder-next" }),
        }),
      }),
    ]);
  });

  it("is idempotent for an exact replay of the same admitted attempt", async () => {
    const { registry } = setup();
    const { binding, input } = admittedInput("broker-learning-replay");

    const first = await recordAdmittedHomeserverAttempt(bridgeDeps(registry, binding), input);
    const second = await recordAdmittedHomeserverAttempt(bridgeDeps(registry, binding), input);

    expect(first.status).toBe("recorded");
    expect(second.status).toBe("recorded");
    if (second.status !== "recorded") throw new Error("expected recorded result");
    expect(second.registry.submission.status).toBe("exact-existing");
    expect(second.registry.attemptReference.status).toBe("exact-existing");
    expect(second.registry.terminalOutcome.status).toBe("exact-existing");
  });

  it.each([
    ["not-admitted", (input: ReturnType<typeof admittedInput>["input"]) => ({
      ...input,
      learningTask: { ...input.learningTask, state: "m5-not-admitted", evidenceAccepted: false },
    })],
    ["task-identity-mismatch", (input: ReturnType<typeof admittedInput>["input"]) => ({
      ...input,
      taskId: "different-task",
    })],
    ["task-type-mismatch", (input: ReturnType<typeof admittedInput>["input"]) => ({
      ...input,
      provenance: { ...input.provenance, taskType: "summarize" },
    })],
    ["missing-delegation-identity", (input: ReturnType<typeof admittedInput>["input"]) => ({
      ...input,
      provenance: { taskType: input.taskType },
    })],
    ["repository-authority-mismatch", (input: ReturnType<typeof admittedInput>["input"]) => ({
      ...input,
      repositoryOutcomeState: "changes-present" as const,
    })],
  ])("fails closed without registry writes for %s", async (reason, mutate) => {
    const { registry } = setup();
    const { binding, input } = admittedInput(`broker-learning-${reason}`);

    const result = await recordAdmittedHomeserverAttempt(bridgeDeps(registry, binding), mutate(input));

    expect(result).toEqual({ status: "skipped", reason });
    expect((await registry.listEventsForTask(input.taskId)).events).toEqual([]);
  });

  it("rejects a stale ledger row bound to another admitted attempt", async () => {
    const { registry } = setup();
    const { binding, input } = admittedInput("broker-learning-stale-ledger");
    const result = await recordAdmittedHomeserverAttempt(
      bridgeDeps(registry, { ...binding, attemptId: "hugin-attempt:00000000-0000-4000-8000-000000000000" }),
      input,
    );
    expect(result).toEqual({ status: "skipped", reason: "delegation-binding-mismatch" });
    expect((await registry.listEventsForTask(input.taskId)).events).toEqual([]);
  });

  it("recovers a partial post-terminal registry write without re-running the task", async () => {
    const { munin, registry } = setup();
    const { admitted, binding, input } = admittedInput("broker-learning-recovery");
    const taskNamespace = `tasks/${input.taskId}`;
    await munin.write(
      admitted.attemptOutcomeRef.namespace,
      admitted.attemptOutcomeRef.key,
      JSON.stringify(admitted.evidence),
      ["learning-task-attempt", "attempt:admitted"],
    );
    const structured = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: input.taskId,
      taskNamespace,
      lifecycle: "completed",
      outcome: "completed",
      runtime: "homeserver",
      executor: "homeserver/M5",
      resultSource: "homeserver",
      exitCode: 0,
      startedAt: input.occurredAt,
      completedAt: "2026-07-22T12:01:00.000Z",
      bodyKind: "response",
      bodyText: "fixture output",
      repositoryOutcome: { state: "not-managed" },
      runtimeMetadata: {
        effectiveModel: input.provenance.modelId,
        effectiveHost: "m5",
        delegation: input.provenance,
        huginTaskIdentity: {
          schemaVersion: 1,
          producer: "hugin",
          taskId: input.taskId,
          rawTaskFingerprint: admitted.evidence.rawFingerprint,
          renderedPromptFingerprint: {
            algorithm: "sha256",
            version: "hugin-delegate-prompt-utf8-sha256-v1",
            digest: hash("rendered-prompt"),
            utf8Bytes: 15,
          },
        },
        learningTask: admitted.evidence,
      },
    });
    const statusContent = buildFixtureStatusDocument(input.taskId, "production-shaped Broker prompt");
    await finalizeTaskCompletion(munin, taskNamespace, {
      statusContent,
      terminalTags: ["completed", "runtime:homeserver", LEARNING_REGISTRY_PENDING_TAG],
      classification: "internal",
      writeStructuredResult: () => munin.write(
        taskNamespace,
        "result-structured",
        JSON.stringify(structured),
        ["result"],
        undefined,
        "internal",
      ).then(() => undefined),
      logMessage: "task completed",
    });

    let failTerminalOnce = true;
    const partialRegistry = {
      recordSubmission: registry.recordSubmission.bind(registry),
      recordAttemptReference: registry.recordAttemptReference.bind(registry),
      recordTerminalOutcome: async (...args: Parameters<LearningRegistryStore["recordTerminalOutcome"]>) => {
        if (failTerminalOnce) {
          failTerminalOnce = false;
          throw new Error("injected terminal registry outage");
        }
        return registry.recordTerminalOutcome(...args);
      },
    } as LearningRegistryStore;
    const first = await reconcilePendingHomeserverLearningTasks({
      munin,
      registry: partialRegistry,
      resolveLedgerAttemptBinding: async () => binding,
    });
    expect(first).toMatchObject({ scanned: 1, captured: 0, failed: 1 });
    expect((await registry.listEventsForTask(input.taskId)).events.map((event) => event.recordKind).sort())
      .toEqual(["attempt-reference", "submission"]);
    expect((await munin.read(taskNamespace, "status"))?.tags).toContain(LEARNING_REGISTRY_PENDING_TAG);

    const second = await reconcilePendingHomeserverLearningTasks({
      munin,
      registry,
      resolveLedgerAttemptBinding: async () => binding,
    });
    expect(second).toMatchObject({ scanned: 1, captured: 1, failed: 0 });
    expect((await registry.listEventsForTask(input.taskId)).events.map((event) => event.recordKind).sort())
      .toEqual(["attempt-reference", "submission", "terminal-outcome"]);
    expect((await munin.read(taskNamespace, "status"))?.tags).toContain(LEARNING_REGISTRY_CAPTURED_TAG);

    const receipt = buildQualityReceipt({
      taskId: input.taskId,
      reviewerPrincipal: "codex-independent",
      reviewerIndependence: "independent",
      rating: "pass",
      ratingReason: "Independent review accepted the recovered candidate.",
      verificationOutcome: "accepted_unchanged",
      ratedAt: "2026-07-22T12:02:00.000Z",
      bindingAttestation: "server-bound",
      binding: buildQualityBinding({
        statusContent,
        structuredResultContent: JSON.stringify(structured),
      }),
    });
    await munin.write(
      taskNamespace,
      "feedback",
      JSON.stringify({ schemaVersion: 1, taskId: input.taskId, receipts: [receipt] }),
      ["feedback"],
    );
    const pool = await assembleCandidatePool({ registry, munin }, { periods: ["2026-07"] });
    expect(pool.skipped).toEqual([]);
    expect(pool.candidates.map((candidate) => candidate.taskId)).toEqual([input.taskId]);
  });
});
