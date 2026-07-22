import { describe, expect, it } from "vitest";
import { BROKER_TASK_TYPE_TAXONOMY_VERSION } from "../src/broker/task-type-metadata.js";
import {
  attachSchedulerDecisionPointer,
  buildAwaitingApprovalTags,
  buildClaimedTerminalStatusTags,
  buildLeasedStatusTags,
  buildPipelineParentCancelledTags,
  buildPipelineParentSuccessTags,
  buildTerminalStatusTags,
  getPersistentStatusTags,
  shouldDeferCancellationToClaimOwner,
  stripSchedulerDecisionPointers,
} from "../src/task-status-tags.js";

describe("task status tag helpers", () => {
  it("replaces caller scheduler pointers and preserves the dispatcher pointer", () => {
    const decisionId = "34f2d430-6c31-47de-860a-8b22bc97f4d4";
    const predictionDigest = "a".repeat(64);
    const attached = attachSchedulerDecisionPointer([
      "pending",
      "runtime:codex",
      "scheduler-decision:caller-controlled",
      `scheduler-prediction-sha256:${"b".repeat(64)}`,
    ], { decisionId, predictionDigest });

    expect(attached).toEqual([
      "pending",
      "runtime:codex",
      `scheduler-decision:${decisionId}`,
      `scheduler-prediction-sha256:${predictionDigest}`,
    ]);
    expect(buildClaimedTerminalStatusTags("completed", attached)).toEqual([
      "completed",
      "runtime:codex",
      `scheduler-decision:${decisionId}`,
      `scheduler-prediction-sha256:${predictionDigest}`,
    ]);
    expect(buildLeasedStatusTags(
      attached,
      "running",
      "hugin-pi",
      "1784757000000",
    )).toEqual([
      "running",
      "runtime:codex",
      `scheduler-decision:${decisionId}`,
      `scheduler-prediction-sha256:${predictionDigest}`,
      "claimed_by:hugin-pi",
      "lease_expires:1784757000000",
    ]);
    expect(stripSchedulerDecisionPointers(attached)).toEqual([
      "pending",
      "runtime:codex",
    ]);
  });

  it("keeps scheduler pointers through delivery and pipeline terminal rewrites", () => {
    const decisionTag = "scheduler-decision:34f2d430-6c31-47de-860a-8b22bc97f4d4";
    const digestTag = `scheduler-prediction-sha256:${"a".repeat(64)}`;
    const deliveryTags = buildLeasedStatusTags([
      "runtime:codex",
      decisionTag,
      digestTag,
      "delivery:pending",
    ], "running", "hugin-pi", "1784757000000");

    expect(buildClaimedTerminalStatusTags("completed", [
      ...deliveryTags.filter((tag) => !tag.startsWith("delivery:")),
      "delivery:verified",
    ])).toEqual([
      "completed",
      "runtime:codex",
      "delivery:verified",
      decisionTag,
      digestTag,
    ]);
    expect(buildPipelineParentSuccessTags([
      "running",
      "runtime:pipeline",
      decisionTag,
      digestTag,
    ], true)).toEqual([
      "completed",
      "runtime:pipeline",
      decisionTag,
      digestTag,
      "type:pipeline",
    ]);
    expect(buildPipelineParentCancelledTags([
      "pending",
      "runtime:pipeline",
      decisionTag,
      digestTag,
    ])).toEqual([
      "cancelled",
      "runtime:pipeline",
      "type:pipeline",
    ]);
    expect(buildPipelineParentCancelledTags([
      "running",
      "runtime:pipeline",
      decisionTag,
      digestTag,
    ], true)).toEqual([
      "cancelled",
      "runtime:pipeline",
      decisionTag,
      digestTag,
      "type:pipeline",
    ]);
  });

  it("drops incomplete, malformed, or ambiguous scheduler pointers", () => {
    const validDecision = "scheduler-decision:34f2d430-6c31-47de-860a-8b22bc97f4d4";
    const otherDecision = "scheduler-decision:5f1848e1-d3fb-46bf-9121-e1f38e79d158";
    const validDigest = `scheduler-prediction-sha256:${"a".repeat(64)}`;

    expect(getPersistentStatusTags(["runtime:codex", validDecision])).toEqual([
      "runtime:codex",
    ]);
    expect(getPersistentStatusTags([
      "runtime:codex",
      validDecision,
      otherDecision,
      validDigest,
    ])).toEqual(["runtime:codex"]);
    expect(getPersistentStatusTags([
      "runtime:codex",
      "scheduler-decision:not-a-uuid",
      validDigest,
    ])).toEqual(["runtime:codex"]);
  });

  it("never promotes a valid-looking caller pointer before a successful claim", () => {
    const decisionTag = "scheduler-decision:34f2d430-6c31-47de-860a-8b22bc97f4d4";
    const digestTag = `scheduler-prediction-sha256:${"a".repeat(64)}`;
    const untrustedPending = ["pending", "runtime:codex", decisionTag, digestTag];

    expect(buildTerminalStatusTags("failed", untrustedPending)).toEqual([
      "failed",
      "runtime:codex",
    ]);
    expect(buildAwaitingApprovalTags(untrustedPending)).toEqual([
      "awaiting-approval",
      "runtime:codex",
    ]);
    expect(buildPipelineParentSuccessTags([
      "pending",
      "runtime:pipeline",
      decisionTag,
      digestTag,
    ])).toEqual([
      "completed",
      "runtime:pipeline",
      "type:pipeline",
    ]);
    expect(buildClaimedTerminalStatusTags("completed", [
      "running",
      "runtime:codex",
      decisionTag,
      digestTag,
    ])).toEqual([
      "completed",
      "runtime:codex",
      decisionTag,
      digestTag,
    ]);
  });

  it("defers running cancellation without trusting lifecycle tags as claim authority", () => {
    const decisionTag = "scheduler-decision:34f2d430-6c31-47de-860a-8b22bc97f4d4";
    const digestTag = `scheduler-prediction-sha256:${"a".repeat(64)}`;
    const pointerTags = [decisionTag, digestTag];

    expect(buildTerminalStatusTags("cancelled", [
      "pending",
      "runtime:codex",
      ...pointerTags,
    ])).toEqual(["cancelled", "runtime:codex"]);
    expect(buildTerminalStatusTags("cancelled", [
      "blocked",
      "runtime:codex",
      ...pointerTags,
    ])).toEqual(["cancelled", "runtime:codex"]);
    expect(shouldDeferCancellationToClaimOwner([
      "pending",
      "running",
      "cancel-requested",
      "runtime:codex",
      ...pointerTags,
    ])).toBe(true);
    expect(shouldDeferCancellationToClaimOwner([
      "pending",
      "cancel-requested",
      "runtime:codex",
    ])).toBe(false);
    expect(shouldDeferCancellationToClaimOwner([
      "blocked",
      "cancel-requested",
      "runtime:codex",
    ])).toBe(false);
  });

  it("preserves durable MCP Broker identity and query tags", () => {
    const input = [
      "running",
      "runtime:homeserver",
      "broker:mcp-v2",
      "alias:m5",
      "task-type:extract",
      `task-taxonomy:${BROKER_TASK_TYPE_TAXONOMY_VERSION}`,
      "runtime-row:homeserver-m5",
      "idempotency:abc123",
      "claimed_by:hugin-pi",
    ];
    const persistent = [
      "completed",
      "runtime:homeserver",
      "broker:mcp-v2",
      "alias:m5",
      "task-type:extract",
      `task-taxonomy:${BROKER_TASK_TYPE_TAXONOMY_VERSION}`,
      "runtime-row:homeserver-m5",
      "idempotency:abc123",
    ];
    expect(getPersistentStatusTags(input)).toEqual(persistent.slice(1));
    expect(buildTerminalStatusTags("completed", input)).toEqual(persistent);
  });

  it("preserves publication recovery tags (#225) across a terminal status rewrite", () => {
    // The publication-recovery orchestration rewrites a task's terminal tags
    // to swap `publication:failed` for `publication:recovered`/`publication:abandoned`
    // via buildTerminalStatusTags — this must survive that pass exactly like
    // `delivery:*` does for artifact delivery.
    expect(
      buildTerminalStatusTags("completed", [
        "completed",
        "runtime:codex",
        "publication:failed",
      ]),
    ).toEqual(["completed", "runtime:codex", "publication:failed"]);

    expect(
      buildTerminalStatusTags("completed", [
        "completed",
        "runtime:codex",
        "publication:recovered",
      ]),
    ).toEqual(["completed", "runtime:codex", "publication:recovered"]);
  });

  it("preserves learning-registry recovery state across terminal rewrites", () => {
    expect(buildTerminalStatusTags("completed", [
      "completed",
      "runtime:homeserver",
      "learning-registry:pending",
    ])).toEqual([
      "completed",
      "runtime:homeserver",
      "learning-registry:pending",
    ]);
  });

  it.each(["draft", "conversation"])(
    "preserves the additive M5 task type %s through terminalization",
    (taskType) => {
      expect(
        buildTerminalStatusTags("completed", [
          "running",
          "runtime:homeserver",
          "broker:mcp-v2",
          `task-type:${taskType}`,
          "claimed_by:hugin-pi",
        ]),
      ).toContain(`task-type:${taskType}`);
    },
  );

  it("preserves policy tags on terminal child tasks", () => {
    expect(
      buildTerminalStatusTags("completed", [
        "running",
        "runtime:ollama",
        "type:pipeline",
        "type:pipeline-phase",
        "authority:gated",
        "on-dep-failure:continue",
        "claimed_by:hugin-x",
        "lease_expires:2026-04-02T10:00:00Z",
      ])
    ).toEqual([
      "completed",
      "runtime:ollama",
      "type:pipeline",
      "type:pipeline-phase",
      "on-dep-failure:continue",
      "authority:gated",
    ]);
  });

  it("preserves incoming type tags on successful pipeline parents", () => {
    expect(
      buildPipelineParentSuccessTags([
        "running",
        "runtime:pipeline",
        "type:research",
        "type:evaluation",
      ])
    ).toEqual([
      "completed",
      "runtime:pipeline",
      "type:research",
      "type:evaluation",
      "type:pipeline",
    ]);
  });

  it("preserves policy tags on cancelled child tasks", () => {
    expect(
      buildTerminalStatusTags("cancelled", [
        "running",
        "runtime:ollama",
        "type:pipeline",
        "type:pipeline-phase",
        "authority:gated",
        "on-dep-failure:continue",
        "claimed_by:hugin-x",
        "lease_expires:2026-04-02T10:00:00Z",
      ])
    ).toEqual([
      "cancelled",
      "runtime:ollama",
      "type:pipeline",
      "type:pipeline-phase",
      "on-dep-failure:continue",
      "authority:gated",
    ]);
  });

  it("builds awaiting-approval tags while preserving persistent metadata", () => {
    expect(
      buildAwaitingApprovalTags([
        "pending",
        "runtime:codex",
        "type:pipeline",
        "type:pipeline-phase",
        "authority:gated",
        "claimed_by:hugin-x",
      ])
    ).toEqual([
      "awaiting-approval",
      "runtime:codex",
      "type:pipeline",
      "type:pipeline-phase",
      "authority:gated",
    ]);
  });

  it("preserves incoming type tags on cancelled pipeline parents", () => {
    expect(
      buildPipelineParentCancelledTags([
        "completed",
        "runtime:pipeline",
        "type:research",
        "type:evaluation",
        "cancel-requested",
      ])
    ).toEqual([
      "cancelled",
      "runtime:pipeline",
      "type:research",
      "type:evaluation",
      "type:pipeline",
    ]);
  });
});
