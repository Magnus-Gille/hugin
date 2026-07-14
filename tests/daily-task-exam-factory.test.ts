import { describe, expect, it } from "vitest";
import type { MuninEntry } from "../src/munin-client.js";
import {
  buildDailyExamCandidate,
  buildDailyExamManifest,
} from "../src/learning/daily-task-exam-factory.js";
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

describe("daily task exam factory", () => {
  it("turns cloud-completed repository work into a provisional, content-blind holdout candidate", () => {
    const candidate = buildDailyExamCandidate(source("claude"));
    expect(candidate.lane).toBe("provisional-holdout");
    expect(candidate.readiness).toBe("needs-independent-verifier");
    expect(candidate.exposure.state).toBe("no-m5-evidence");
    expect(candidate.repository).toEqual(expect.objectContaining({
      githubRepository: "Magnus-Gille/demo",
      contextAlias: "repo:demo",
      baseCommit: BASE,
      headCommit: HEAD,
      diffSha256: DIFF,
    }));
    const serialized = JSON.stringify(candidate);
    expect(serialized).not.toContain("Fix the parser");
    expect(serialized).not.toContain("Sensitive answer text");
    expect(candidate.reasons).toContain("requires-cross-client-exposure-check-before-holdout-seal");
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
    expect(manifest.counts).toEqual({ provisionalHoldout: 1, regression: 1, quarantine: 0 });
  });
});
