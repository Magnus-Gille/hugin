import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectOrinMacroRoute } from "../../src/orchestrator/orin-macro-route.js";
import { HUGIN_CONFIG_ROOT_ENV, HuginConfigStore } from "../../src/autonomy/hugin-config-adapter.js";

describe("selectOrinMacroRoute", () => {
  const priorRoot = process.env[HUGIN_CONFIG_ROOT_ENV];
  beforeEach(() => { process.env[HUGIN_CONFIG_ROOT_ENV] = mkdtempSync(join(tmpdir(), "hugin-orin-route-")); new HuginConfigStore(process.env[HUGIN_CONFIG_ROOT_ENV]!); });
  afterEach(() => { if (priorRoot === undefined) delete process.env[HUGIN_CONFIG_ROOT_ENV]; else process.env[HUGIN_CONFIG_ROOT_ENV] = priorRoot; });
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
