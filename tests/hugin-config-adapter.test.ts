import { describe, expect, it } from "vitest";
import {
  HUGIN_CONFIG_ADAPTER_VERSION,
  readHuginConfigBase,
  selectHuginMacroRoute,
  validateHuginConfig,
} from "../src/autonomy/hugin-config-adapter.js";

describe("Hugin strict autonomous config adapter (W4.3)", () => {
  it.each([
    ["homeserver", "classify", "public", true],
    ["homeserver", "extract", "internal", true],
    ["homeserver", "classify", "private", false],
    ["homeserver", "summarize", "public", false],
    ["openrouter", "classify", "public", false],
  ])("preserves the Orin macro-route matrix", (workerProvider, taskType, sensitivity, allowed) => {
    expect(selectHuginMacroRoute({ workerProvider, taskType, sensitivity: sensitivity as "public" | "internal" | "private" }) !== null).toBe(allowed);
  });

  it("has versioned, digest-bound bases without content storage", () => {
    expect(readHuginConfigBase("hugin-orin-macro-routing")).toMatchObject({ revision: "orin-macro-route-v1", digest: expect.stringMatching(/^sha256:/) });
  });

  it.each([
    { targetId: "gille-model", model: "x" },
    { targetId: "gille-model-config", modelConfig: "x" },
    { targetId: "hugin-logging", logging: "on" },
    { targetId: "hugin-test-harness", testHarness: "on" },
    { targetId: "gille-tool-policy", toolPolicyDigest: "sha256:" + "0".repeat(64) },
    { targetId: "hugin-deploy", deploy: true },
    { targetId: "hugin-auth", auth: "x" },
    { targetId: "hugin-key", key: "x" },
    { targetId: "hugin-safety-gate", safety: "x" },
    { targetId: "hugin-risk-budget", risk: 1 },
    { targetId: "hugin-retention", retention: 1 },
  ])("rejects protected or cross-owner target %#", (input) => {
    expect(() => validateHuginConfig({ schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION, revision: "candidate-v1", ...input })).toThrow();
  });
});
