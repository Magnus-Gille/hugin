import { describe, expect, it } from "vitest";
import {
  buildPhaseApprovalRequestContent,
  buildPhaseOperationKey,
  buildPromptPreview,
  parsePhaseApprovalDecision,
  parsePhaseApprovalRequest,
} from "../src/pipeline-gates.js";

describe("pipeline gate artifacts", () => {
  it("builds and parses an approval request artifact", () => {
    const content = buildPhaseApprovalRequestContent({
      pipelineId: "20260404-demo",
      phaseName: "deploy",
      phaseTaskId: "20260404-demo-deploy",
      authority: "gated",
      sideEffects: ["deploy.service"],
      status: "pending",
      requestedAt: "2026-04-04T10:00:00Z",
      requestedByWorker: "hugin-demo-1",
      replyTo: "telegram:123",
      replyFormat: "summary",
      operationKey: buildPhaseOperationKey(
        "20260404-demo",
        "20260404-demo-deploy"
      ),
      summary: {
        runtime: "codex",
        context: "repo:hugin",
        promptPreview: "Deploy the change.",
        dependencyTaskIds: ["20260404-demo-review"],
      },
    });

    const parsed = parsePhaseApprovalRequest(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.sideEffects).toEqual(["deploy.service"]);
    expect(parsed?.operationKey).toBe("20260404-demo:20260404-demo-deploy");
  });

  it("parses approval decisions", () => {
    const parsed = parsePhaseApprovalDecision(
      JSON.stringify({
        schemaVersion: 1,
        pipelineId: "20260404-demo",
        phaseTaskId: "20260404-demo-deploy",
        decision: "approved",
        decidedAt: "2026-04-04T10:05:00Z",
        source: "ratatoskr",
      })
    );

    expect(parsed?.decision).toBe("approved");
    expect(parsed?.source).toBe("ratatoskr");
  });

  it("builds a bounded prompt preview", () => {
    const preview = buildPromptPreview("Deploy ".repeat(40), 40);
    expect(preview.length).toBeLessThanOrEqual(40);
    expect(preview.endsWith("…")).toBe(true);
  });
});
