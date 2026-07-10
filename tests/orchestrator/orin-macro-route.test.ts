import { describe, expect, it } from "vitest";
import { selectOrinMacroRoute } from "../../src/orchestrator/orin-macro-route.js";

describe("selectOrinMacroRoute", () => {
  it("selects the reviewed Orin node only for homeserver classify/extract leaves", () => {
    expect(
      selectOrinMacroRoute({
        workerProvider: "homeserver",
        taskType: "classify",
        sensitivity: "internal",
      }),
    ).toEqual({ nodeId: "orin", modelId: "qwen2.5-coder:3b" });

    expect(
      selectOrinMacroRoute({
        workerProvider: "homeserver",
        taskType: "extract",
        sensitivity: "public",
      }),
    ).toEqual({ nodeId: "orin", modelId: "qwen2.5-coder:3b" });
  });

  it("keeps private, broad, unclassified, and non-homeserver leaves off Orin", () => {
    expect(
      selectOrinMacroRoute({
        workerProvider: "homeserver",
        taskType: "classify",
        sensitivity: "private",
      }),
    ).toBeNull();
    expect(
      selectOrinMacroRoute({
        workerProvider: "homeserver",
        taskType: "other",
        sensitivity: "internal",
      }),
    ).toBeNull();
    expect(
      selectOrinMacroRoute({
        workerProvider: "openrouter",
        taskType: "extract",
        sensitivity: "internal",
      }),
    ).toBeNull();
  });
});
