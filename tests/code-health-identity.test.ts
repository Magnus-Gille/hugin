import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCodeHealthEnvelope,
  buildCodeHealthClaimTags,
  classifyCodeHealthContext,
  createNotStartedRefusalIdentity,
  buildCodeHealthLifecycleEnvelope,
  CODE_HEALTH_ATTEMPT_PREFIX,
  isCodeHealthEligible,
} from "../src/code-health-identity.js";
import {
  buildClaimedTerminalStatusTags,
  buildLeasedStatusTags,
  getPersistentStatusTags,
  stripCodeHealthAttemptTags,
} from "../src/task-status-tags.js";
import { buildStructuredTaskResult } from "../src/task-result-schema.js";

const ATTEMPT = "34f2d430-6c31-47de-860a-8b22bc97f4d4";

describe("code-health attempt identity", () => {
  it("captures only explicitly enabled code-capability requests in the exact pilot registry", () => {
    expect(classifyCodeHealthContext("repo:sagascript")).toEqual({
      owner: "Magnus-Gille", name: "sagascript",
    });
    expect(classifyCodeHealthContext("repo:gille-inference")).toEqual({
      owner: "Magnus-Gille", name: "gille-inference",
    });
    for (const context of ["repo:SagaScript", "repo:/repos/sagascript", "repo:other", "scratch"]) {
      expect(classifyCodeHealthContext(context)).toBeNull();
    }
    expect(isCodeHealthEligible({ enabled: false, context: "repo:sagascript", capabilities: ["code"] })).toBe(false);
    expect(isCodeHealthEligible({ enabled: true, context: "repo:sagascript", capabilities: [] })).toBe(false);
    expect(isCodeHealthEligible({ enabled: true, context: "repo:sagascript", capabilities: ["code"] })).toBe(true);
  });

  it("binds refusal identity to namespace and exact rejected revision without an attempt UUID", () => {
    const revision = "2026-10-10T12:30:00.000Z";
    const identity = createNotStartedRefusalIdentity("tasks/example", revision);
    expect(identity.kind).toBe("not-started-refused");
    expect(identity.rejectedStatusRevisionSha256).toBe(createHash("sha256").update(revision).digest("hex"));
    expect(identity.notStartedId).toBe(createHash("sha256")
      .update(`hugin-code-health-not-started-v1\0tasks/example\0${revision}`).digest("hex"));
    expect(createNotStartedRefusalIdentity("tasks/example", "other").notStartedId)
      .not.toBe(identity.notStartedId);
  });

  it("creates a fresh attempt only for enabled eligible claims and replaces stale identities", () => {
    const stale = `${CODE_HEALTH_ATTEMPT_PREFIX}11111111-1111-4111-8111-111111111111`;
    let generated = 0;
    const eligible = buildCodeHealthClaimTags({
      tags: ["pending", "runtime:codex", stale],
      enabled: true,
      context: "repo:sagascript",
      capabilities: ["code"],
      createAttemptId: () => { generated += 1; return ATTEMPT; },
    });
    expect(eligible).toEqual({
      tags: ["pending", "runtime:codex", `${CODE_HEALTH_ATTEMPT_PREFIX}${ATTEMPT}`],
      attemptId: ATTEMPT,
    });
    expect(buildCodeHealthClaimTags({
      tags: ["pending", stale], enabled: false, context: "repo:sagascript", capabilities: ["code"],
      createAttemptId: () => { generated += 1; return ATTEMPT; },
    })).toEqual({ tags: ["pending"], attemptId: null });
    expect(generated).toBe(1);
  });

  it("binds a known planned child to the parent attempt so a new claim has distinct lineage", () => {
    const child = { plannerId: "child-1", taskType: "code-review" as const };
    const make = (attemptId: string) => buildCodeHealthEnvelope({
      taskNamespace: "tasks/example",
      taskId: "example",
      attemptId,
      repo: { owner: "Magnus-Gille", name: "sagascript" },
      executionFact: "failed",
      plannedChildren: [child],
    });
    expect(make(ATTEMPT).plannedChildren[0].identitySha256)
      .not.toBe(make("5f1848e1-d3fb-46bf-9121-e1f38e79d158").plannedChildren[0].identitySha256);
  });

  it("emits a content-blind missing-assessment envelope and preserves observed absence", () => {
    const envelope = buildCodeHealthEnvelope({
      taskNamespace: "tasks/example",
      taskId: "example",
      attemptId: ATTEMPT,
      repo: { owner: "Magnus-Gille", name: "sagascript" },
      executionFact: "timed_out",
      requestedModel: "claude-sonnet-4",
      plannedChildren: [{ plannerId: "worker-secret-prompt-id", taskType: "code-review" }],
    });
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      identity: { kind: "attempt", attemptId: ATTEMPT },
      repo: { owner: "Magnus-Gille", name: "sagascript" },
      executionFact: "timed_out",
      assessmentState: "missing",
      requestedModel: "claude-sonnet-4",
      observedModel: null,
      taskClass: null,
      plannedChildren: [{ outcome: "planned", taskType: "code-review" }],
    });
    expect(JSON.stringify(envelope)).not.toContain("worker-secret-prompt-id");
    expect(JSON.stringify(envelope)).not.toContain("prompt");
  });

  it("keeps accepted attempt identity separate from a pre-claim refusal identity", () => {
    const common = {
      enabled: true,
      taskNamespace: "tasks/example",
      taskId: "example",
      context: "repo:sagascript",
      capabilities: ["code"],
      statusRevision: "rev-1",
      requestedModel: "m",
    };
    const refusal = buildCodeHealthLifecycleEnvelope({
      ...common,
      tags: [`${CODE_HEALTH_ATTEMPT_PREFIX}${ATTEMPT}`],
      executionFact: "not_started_refused",
    });
    expect(refusal?.identity.kind).toBe("not-started-refused");
    const accepted = buildCodeHealthLifecycleEnvelope({
      ...common,
      tags: [`${CODE_HEALTH_ATTEMPT_PREFIX}${ATTEMPT}`],
      executionFact: "failed",
    });
    expect(accepted?.identity).toEqual({ kind: "attempt", attemptId: ATTEMPT });
  });

  it("requires content-blind identity and consistent execution fields in optional result envelope", () => {
    const base = {
      schemaVersion: 1 as const,
      taskId: "example", taskNamespace: "tasks/example", lifecycle: "failed" as const,
      outcome: "timed_out" as const, runtime: "claude" as const, executor: "claude-sdk",
      resultSource: "sdk-result", exitCode: "TIMEOUT" as const,
      completedAt: "2026-10-10T12:30:00Z", bodyKind: "error" as const, bodyText: "timeout",
      codeHealth: buildCodeHealthEnvelope({
        taskNamespace: "tasks/example", taskId: "example", attemptId: ATTEMPT,
        repo: { owner: "Magnus-Gille", name: "sagascript" }, executionFact: "timed_out",
      }),
    };
    expect(buildStructuredTaskResult(base).codeHealth?.assessmentState).toBe("missing");
    expect(() => buildStructuredTaskResult({
      ...base,
      codeHealth: { ...base.codeHealth!, errorMessage: "secret diagnostic" },
    } as never)).toThrow();
    expect(() => buildStructuredTaskResult({
      ...base,
      codeHealth: { ...base.codeHealth!, executionFact: "completed" },
    })).toThrow();
    const refusal = buildCodeHealthEnvelope({
      taskNamespace: "tasks/example",
      taskId: "example",
      notStartedIdentity: createNotStartedRefusalIdentity("tasks/example", "rev-1"),
      repo: { owner: "Magnus-Gille", name: "sagascript" },
      executionFact: "not_started_refused",
    });
    expect(buildStructuredTaskResult({
      ...base,
      outcome: "failed",
      exitCode: 2,
      codeHealth: refusal,
    }).codeHealth?.identity.kind).toBe("not-started-refused");
    expect(() => buildStructuredTaskResult({
      ...base,
      outcome: "failed",
      exitCode: 2,
      codeHealth: { ...refusal, observationRefs: ["https://host/private/path"] },
    })).toThrow();
  });
});

describe("strict code-health attempt status tag", () => {
  const tag = `${CODE_HEALTH_ATTEMPT_PREFIX}${ATTEMPT}`;

  it("drops caller supplied tags before claim, then preserves a valid claimed UUID through lease and terminal rewrites", () => {
    const forged = ["pending", "runtime:claude", tag, `${CODE_HEALTH_ATTEMPT_PREFIX}arbitrary`];
    expect(stripCodeHealthAttemptTags(forged)).toEqual(["pending", "runtime:claude"]);
    expect(getPersistentStatusTags(["runtime:claude", tag])).toEqual(["runtime:claude"]);
    const leased = buildLeasedStatusTags(["runtime:claude", tag], "running", "worker", "123", true);
    expect(leased).toContain(tag);
    expect(buildClaimedTerminalStatusTags("failed", leased)).toContain(tag);
  });

  it("drops malformed and ambiguous capture tags", () => {
    expect(getPersistentStatusTags([
      "runtime:claude", `${CODE_HEALTH_ATTEMPT_PREFIX}bad`, tag,
    ])).toEqual(["runtime:claude"]);
    expect(buildClaimedTerminalStatusTags("failed", ["runtime:claude", tag, `${CODE_HEALTH_ATTEMPT_PREFIX}${ATTEMPT}`]))
      .toEqual(["failed", "runtime:claude"]);
  });
});
