import { describe, expect, it } from "vitest";
import type { MuninEntry } from "../src/munin-client.js";
import {
  applyCrossClientExposure,
  buildDailyExamCandidate,
  buildDailyExamManifest,
} from "../src/learning/daily-task-exam-factory.js";
import {
  REQUIRED_TASK_EXPOSURE_LANES,
  TASK_EXPOSURE_FINGERPRINT_VERSION,
  type TaskExposureSnapshot,
} from "../src/learning/m5-task-exposure.js";
import { buildStructuredTaskResult } from "../src/task-result-schema.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const DIFF = "c".repeat(64);

function entry(input: Partial<MuninEntry> & Pick<MuninEntry, "namespace" | "key" | "content">): MuninEntry {
  return {
    id: `${input.namespace}/${input.key}`,
    tags: [],
    classification: "internal",
    created_at: "2026-07-14T10:00:00.000Z",
    updated_at: "2026-07-14T11:00:00.000Z",
    ...input,
  };
}

function taskDocument(runtime = "claude"): string {
  return `## Task: Repair the parser

- **Runtime:** ${runtime}
- **Context:** repo:demo
- **Sensitivity:** internal

### Prompt
Fix the parser and add a regression test.`;
}

function resultContent(runtime: "claude" | "homeserver" = "claude"): string {
  return JSON.stringify(buildStructuredTaskResult({
    schemaVersion: 1,
    taskId: "daily-1",
    taskNamespace: "tasks/daily-1",
    lifecycle: "completed",
    outcome: "completed",
    runtime,
    executor: runtime === "homeserver" ? "homeserver-delegate" : "claude-sdk",
    resultSource: runtime === "homeserver" ? "homeserver-delegate" : "sdk-result",
    exitCode: 0,
    completedAt: "2026-07-14T11:00:00.000Z",
    bodyKind: "response",
    bodyText: "Sensitive answer text that must not enter the candidate manifest",
    prUrl: "https://github.com/Magnus-Gille/demo/pull/42",
    repositoryChange: {
      baseBranch: "master",
      baseCommit: BASE,
      headCommit: HEAD,
      changedFiles: ["src/parser.ts", "tests/parser.test.ts"],
      diffSha256: DIFF,
    },
    sensitivity: { declared: "internal", effective: "internal", mismatch: false },
    ...(runtime === "homeserver"
      ? {
          runtimeMetadata: {
            effectiveHost: "m5",
            effectiveModel: "qwen3-coder-next-80b",
            delegation: {
              delegated: true,
              nodeId: "m5",
              modelId: "qwen3-coder-next-80b",
              ledgerId: "ledger-1",
            },
          },
        }
      : {}),
  }));
}

function source(runtime: "claude" | "homeserver" = "claude") {
  return {
    status: entry({
      namespace: "tasks/daily-1",
      key: "status",
      content: taskDocument(runtime),
      tags: ["completed", "runtime:claude", "type:code-repair"],
    }),
    resultStructured: entry({
      namespace: "tasks/daily-1",
      key: "result-structured",
      content: resultContent(runtime),
      tags: ["type:task-result", "type:task-result-structured"],
    }),
  };
}

function snapshot(fingerprint: string, input: {
  seen?: boolean;
  coverageComplete?: boolean;
  from?: string;
  through?: string;
  lanes?: string[];
} = {}): TaskExposureSnapshot {
  const seen = input.seen ?? false;
  return {
    checkedAt: "2026-07-14T12:01:00.000Z",
    coverage: {
      coverage_complete: input.coverageComplete ?? true,
      from: input.from ?? "2026-07-14T09:00:00.000Z",
      through: input.through ?? "2026-07-14T12:00:00.000Z",
      lanes: input.lanes ?? [...REQUIRED_TASK_EXPOSURE_LANES],
      historical_backfill_complete: false,
      historical_backfill_from: null,
      historical_backfill_through: null,
      historical_events_imported: 0,
      historical_rows_skipped_inexact: 0,
      incomplete_before: "2026-07-14T09:00:00.000Z",
      incomplete_reasons: ["pre-capture history is incomplete"],
    },
    result: {
      fingerprint_sha256: fingerprint,
      seen,
      first_seen_at: seen ? "2026-07-14T10:30:00.000Z" : null,
      last_seen_at: seen ? "2026-07-14T10:30:00.000Z" : null,
      lanes: seen ? ["chat"] : [],
      model_ids: seen ? ["mellum"] : [],
      harness_ids: seen ? ["openai-chat"] : [],
    },
  };
}

describe("daily task exam factory", () => {
  it("turns cloud-completed repository work into a provisional, content-blind holdout candidate", () => {
    const candidate = buildDailyExamCandidate(source("claude"));
    expect(candidate.lane).toBe("provisional-holdout");
    expect(candidate.readiness).toBe("needs-independent-verifier");
    expect(candidate.exposure.state).toBe("no-m5-evidence");
    expect(candidate.repository).toEqual(expect.objectContaining({
      githubRepository: "Magnus-Gille/demo",
      contextAlias: "repo:demo",
      baseBranch: "master",
      baseCommit: BASE,
      headCommit: HEAD,
      diffSha256: DIFF,
    }));
    const serialized = JSON.stringify(candidate);
    expect(serialized).not.toContain("Fix the parser");
    expect(serialized).not.toContain("Sensitive answer text");
    expect(candidate.reasons).toContain("requires-cross-client-exposure-check-before-holdout-seal");
    expect(candidate.schemaVersion).toBe(2);
    expect(candidate.source.taskCreatedAt).toBe("2026-07-14T10:00:00.000Z");
    expect(candidate.crossClientExposure).toEqual(expect.objectContaining({
      state: "not-checked",
      fingerprintVersion: TASK_EXPOSURE_FINGERPRINT_VERSION,
      fingerprintSha256: candidate.source.promptSha256,
    }));
  });

  it("routes a task already seen by M5 to regression rather than a holdout", () => {
    const candidate = buildDailyExamCandidate(source("homeserver"));
    expect(candidate.lane).toBe("regression");
    expect(candidate.exposure.state).toBe("m5-exposed");
    expect(candidate.exposure.models).toContain("qwen3-coder-next-80b");
    expect(candidate.reasons).toContain("already-exposed-to-m5-use-only-as-regression");
  });

  it("quarantines historical tasks without exact repository evidence", () => {
    const historical = source("claude");
    const parsed = JSON.parse(historical.resultStructured.content) as Record<string, unknown>;
    delete parsed.repositoryChange;
    historical.resultStructured.content = JSON.stringify(parsed);
    const candidate = buildDailyExamCandidate(historical);
    expect(candidate.lane).toBe("quarantine");
    expect(candidate.readiness).toBe("quarantined");
    expect(candidate.reasons).toContain("repository-change-evidence-missing");
  });

  it("quarantines malformed results instead of trusting result prose", () => {
    const malformed = source("claude");
    malformed.resultStructured.content = "not json";
    const candidate = buildDailyExamCandidate(malformed);
    expect(candidate.lane).toBe("quarantine");
    expect(candidate.exposure.state).toBe("unknown");
    expect(candidate.reasons).toContain("valid-result-structured-missing");
  });

  it("omits repository metadata when quarantining a private task", () => {
    const privateTask = source("claude");
    const parsed = JSON.parse(privateTask.resultStructured.content) as Record<string, unknown>;
    parsed.sensitivity = { declared: "private", effective: "private", mismatch: false };
    privateTask.resultStructured.content = JSON.stringify(parsed);
    const candidate = buildDailyExamCandidate(privateTask);
    expect(candidate.lane).toBe("quarantine");
    expect(candidate.repository).toBeUndefined();
    expect(candidate.reasons).toContain("private-task-not-eligible-for-automatic-packaging");
  });

  it("fails closed when Munin classification is more sensitive than the result snapshot", () => {
    const classified = source("claude");
    classified.status.classification = "client-confidential";
    const candidate = buildDailyExamCandidate(classified);
    expect(candidate.lane).toBe("quarantine");
    expect(candidate.repository).toBeUndefined();
    expect(candidate.reasons).toContain("source-classification-not-eligible-for-automatic-packaging");
  });

  it("builds deterministic candidate IDs and honest manifest counts", () => {
    const cloud = source("claude");
    const m5 = source("homeserver");
    m5.status.namespace = "tasks/daily-2";
    m5.status.id = "tasks/daily-2/status";
    const parsed = JSON.parse(m5.resultStructured.content) as Record<string, unknown>;
    parsed.taskId = "daily-2";
    parsed.taskNamespace = "tasks/daily-2";
    m5.resultStructured.namespace = "tasks/daily-2";
    m5.resultStructured.id = "tasks/daily-2/result-structured";
    m5.resultStructured.content = JSON.stringify(parsed);

    const one = buildDailyExamCandidate(cloud);
    const two = buildDailyExamCandidate(cloud);
    expect(one.candidateId).toBe(two.candidateId);

    const manifest = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: false,
      sources: [cloud, m5],
    });
    expect(manifest.historyComplete).toBe(false);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.counts).toEqual({ provisionalHoldout: 1, regression: 1, quarantine: 0 });
  });

  it("clears only an unseen task created inside complete all-lane coverage", () => {
    const manifest = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [source("claude")],
    });
    const digest = manifest.candidates[0]!.source.promptSha256!;
    const finalized = applyCrossClientExposure(manifest, {
      snapshots: new Map([[digest, snapshot(digest)]]),
    });
    const candidate = finalized.candidates[0]!;

    expect(candidate.lane).toBe("provisional-holdout");
    expect(candidate.readiness).toBe("needs-independent-verifier");
    expect(candidate.crossClientExposure.state).toBe("unseen-covered");
    expect(candidate.crossClientExposure.checkedAt).toBe("2026-07-14T12:01:00.000Z");
    expect(candidate.crossClientExposure.coverage?.through).toBe("2026-07-14T12:00:00.000Z");
    expect(candidate.reasons).not.toContain("requires-cross-client-exposure-check-before-holdout-seal");
    expect(candidate.reasons).toContain("independent-verifier-required");
  });

  it("routes seen=true to regression even when coverage is incomplete", () => {
    const manifest = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [source("claude")],
    });
    const digest = manifest.candidates[0]!.source.promptSha256!;
    const finalized = applyCrossClientExposure(manifest, {
      snapshots: new Map([[digest, snapshot(digest, {
        seen: true,
        coverageComplete: false,
        lanes: ["chat"],
      })]]),
    });

    expect(finalized.candidates[0]).toEqual(expect.objectContaining({
      lane: "regression",
      readiness: "needs-independent-verifier",
    }));
    expect(finalized.candidates[0]!.crossClientExposure.state).toBe("seen");
  });

  it.each([
    ["coverage incomplete", { coverageComplete: false }, "cross-client-coverage-incomplete"],
    ["created before coverage", { from: "2026-07-14T10:00:01.000Z" }, "task-created-before-cross-client-coverage"],
    ["created after coverage", { through: "2026-07-14T09:59:59.000Z" }, "task-created-after-cross-client-coverage"],
    ["missing a lane", { lanes: REQUIRED_TASK_EXPOSURE_LANES.slice(0, -1) }, "cross-client-coverage-lanes-missing"],
  ])("quarantines unseen when %s", (_label, options, reason) => {
    const manifest = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [source("claude")],
    });
    const digest = manifest.candidates[0]!.source.promptSha256!;
    const candidate = applyCrossClientExposure(manifest, {
      snapshots: new Map([[digest, snapshot(digest, options)]]),
    }).candidates[0]!;

    expect(candidate.lane).toBe("quarantine");
    expect(candidate.readiness).toBe("quarantined");
    expect(candidate.crossClientExposure.state).toBe("incomplete");
    expect(candidate.reasons).toContain(reason);
    expect(candidate.reasons).not.toContain("independent-verifier-required");
  });

  it("quarantines lookup errors and invalid task creation timestamps", () => {
    const normal = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [source("claude")],
    });
    expect(applyCrossClientExposure(normal, {
      error: { code: "http-401", checkedAt: "2026-07-14T12:01:00.000Z" },
    }).candidates[0]).toEqual(expect.objectContaining({ lane: "quarantine", readiness: "quarantined" }));

    const invalidSource = source("claude");
    invalidSource.status.created_at = "not-a-date";
    const invalid = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [invalidSource],
    });
    const candidate = invalid.candidates[0]!;
    expect(candidate.lane).toBe("quarantine");
    expect(candidate.crossClientExposure.state).toBe("not-checked");
    expect(candidate.crossClientExposure.evidence).toEqual(["lookup-not-required-ineligible"]);
    expect(candidate.reasons).toContain("task-created-at-invalid");

    const missingSource = source("claude");
    missingSource.status.created_at = "";
    const missing = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [missingSource],
    });
    expect(missing.candidates[0]).toEqual(expect.objectContaining({
      lane: "quarantine",
      crossClientExposure: expect.objectContaining({ state: "not-checked" }),
    }));
    expect(missing.candidates[0]!.reasons).toContain("task-created-at-invalid");

    for (const invalidCreatedAt of [undefined, 42]) {
      const invalidSource = source("claude");
      (invalidSource.status as unknown as { created_at: unknown }).created_at = invalidCreatedAt;
      const invalid = buildDailyExamManifest({
        generatedAt: "2026-07-14T12:00:00.000Z",
        historyComplete: true,
        sources: [invalidSource],
      });
      expect(invalid.candidates[0]).toEqual(expect.objectContaining({
        lane: "quarantine",
        crossClientExposure: expect.objectContaining({ state: "not-checked" }),
      }));
      expect(invalid.candidates[0]!.reasons).toContain("task-created-at-invalid");
    }

    const tampered = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [source("claude")],
    });
    tampered.candidates[0]!.source.taskCreatedAt = "not-a-date";
    const tamperedDigest = tampered.candidates[0]!.source.promptSha256!;
    const defended = applyCrossClientExposure(tampered, {
      snapshots: new Map([[tamperedDigest, snapshot(tamperedDigest)]]),
    }).candidates[0]!;
    expect(defended.lane).toBe("quarantine");
    expect(defended.reasons).toContain("task-created-at-invalid");
  });

  it("quarantines a snapshot map whose value is bound to another fingerprint", () => {
    const manifest = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [source("claude")],
    });
    const digest = manifest.candidates[0]!.source.promptSha256!;
    const mismatched = snapshot("d".repeat(64));
    const candidate = applyCrossClientExposure(manifest, {
      snapshots: new Map([[digest, mismatched]]),
    }).candidates[0]!;
    expect(candidate.lane).toBe("quarantine");
    expect(candidate.crossClientExposure.evidence)
      .toContain("lookup-result-fingerprint-mismatch");
  });

  it("deduplicates identical prompts before lookup and quarantines every duplicate candidate", () => {
    const first = source("claude");
    const second = source("claude");
    second.status.namespace = "tasks/daily-2";
    second.status.id = "tasks/daily-2/status";
    second.status.created_at = "2026-07-14T10:01:00.000Z";
    second.resultStructured.namespace = "tasks/daily-2";
    second.resultStructured.id = "tasks/daily-2/result-structured";
    const parsed = JSON.parse(second.resultStructured.content) as Record<string, unknown>;
    parsed.taskId = "daily-2";
    parsed.taskNamespace = "tasks/daily-2";
    second.resultStructured.content = JSON.stringify(parsed);
    const manifest = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [second, first],
    });
    const digest = manifest.candidates[0]!.source.promptSha256!;
    const finalized = applyCrossClientExposure(manifest, {
      snapshots: new Map([[digest, snapshot(digest)]]),
    });

    expect(finalized.candidates.filter((candidate) => candidate.lane === "provisional-holdout"))
      .toHaveLength(0);
    expect(finalized.candidates.find((candidate) => candidate.source.taskId === "daily-1")?.lane)
      .toBe("quarantine");
    expect(finalized.candidates.find((candidate) => candidate.source.taskId === "daily-1")?.reasons)
      .toContain("duplicate-prompt-in-daily-manifest");
    expect(finalized.candidates.find((candidate) => candidate.source.taskId === "daily-2")?.reasons)
      .toContain("duplicate-prompt-in-daily-manifest");
  });

  it("does not require or apply the cross-client lookup to quarantined or local-regression candidates", () => {
    const privateTask = source("claude");
    const privateResult = JSON.parse(privateTask.resultStructured.content) as Record<string, unknown>;
    privateResult.sensitivity = { declared: "private", effective: "private", mismatch: false };
    privateTask.resultStructured.content = JSON.stringify(privateResult);
    const local = source("homeserver");
    local.status.namespace = "tasks/daily-local";
    local.status.id = "tasks/daily-local/status";
    local.resultStructured.namespace = "tasks/daily-local";
    local.resultStructured.id = "tasks/daily-local/result-structured";
    const localResult = JSON.parse(local.resultStructured.content) as Record<string, unknown>;
    localResult.taskId = "daily-local";
    localResult.taskNamespace = "tasks/daily-local";
    local.resultStructured.content = JSON.stringify(localResult);
    const manifest = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [privateTask, local],
    });
    const finalized = applyCrossClientExposure(manifest, {
      error: { code: "network-error", checkedAt: "2026-07-14T12:01:00.000Z" },
    });

    expect(finalized.candidates.map((candidate) => candidate.crossClientExposure.state))
      .toEqual(["not-checked", "not-checked"]);
    expect(finalized.candidates.map((candidate) => candidate.crossClientExposure.evidence[0]))
      .toEqual(expect.arrayContaining([
        "lookup-not-required-ineligible",
        "lookup-not-required-local-m5-exposure",
      ]));
    expect(finalized.candidates.map((candidate) => candidate.lane).sort())
      .toEqual(["quarantine", "regression"]);
  });

  it("quarantines a covered candidate when any same-manifest candidate has the same prompt", () => {
    const covered = source("claude");
    const local = source("homeserver");
    local.status.namespace = "tasks/daily-local-duplicate";
    local.status.id = "tasks/daily-local-duplicate/status";
    local.resultStructured.namespace = "tasks/daily-local-duplicate";
    local.resultStructured.id = "tasks/daily-local-duplicate/result-structured";
    const localResult = JSON.parse(local.resultStructured.content) as Record<string, unknown>;
    localResult.taskId = "daily-local-duplicate";
    localResult.taskNamespace = "tasks/daily-local-duplicate";
    local.resultStructured.content = JSON.stringify(localResult);
    const manifest = buildDailyExamManifest({
      generatedAt: "2026-07-14T12:00:00.000Z",
      historyComplete: true,
      sources: [covered, local],
    });
    const candidate = manifest.candidates.find((item) => item.lane === "provisional-holdout")!;
    const digest = candidate.source.promptSha256!;
    const finalized = applyCrossClientExposure(manifest, {
      snapshots: new Map([[digest, snapshot(digest)]]),
    });
    expect(finalized.candidates.find((item) => item.source.taskId === "daily-1")?.lane)
      .toBe("quarantine");
    expect(finalized.candidates.every((item) =>
      item.reasons.includes("duplicate-prompt-in-daily-manifest"))).toBe(true);

    const reapplied = applyCrossClientExposure(finalized, { snapshots: new Map() });
    expect(reapplied.candidates.every((item) =>
      item.crossClientExposure.evidence.filter(
        (entry) => entry === "duplicate-prompt-in-daily-manifest",
      ).length === 1)).toBe(true);
  });
});
