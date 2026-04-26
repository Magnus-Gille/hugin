import { describe, expect, it } from "vitest";
import {
  ZDR_ALLOWLIST,
  ZDR_ALLOWLIST_VERSION,
  assertZdrAllowed,
  isZdrAllowed,
} from "../src/openrouter-zdr.js";
import { ALIAS_MAP_V1 } from "../src/runtime-registry.js";

describe("ZDR allowlist", () => {
  it("uses a versioned identifier matching the broker policy_version", () => {
    expect(ZDR_ALLOWLIST_VERSION).toBe("zdr-v1");
  });

  it("permits the v1 cloud-delegated alias models", () => {
    const aliasModels = Object.values(ALIAS_MAP_V1.aliases)
      .filter((a) => a.runtimeId === "openrouter" || a.runtimeId === "pi-harness")
      .map((a) => a.model);
    expect(aliasModels.length).toBeGreaterThan(0);
    for (const model of aliasModels) {
      expect(isZdrAllowed(model)).toBe(true);
    }
  });

  it("rejects models not on the allowlist", () => {
    expect(isZdrAllowed("openai/gpt-4o")).toBe(false);
    expect(isZdrAllowed("anthropic/claude-3-5-sonnet")).toBe(false);
    expect(isZdrAllowed("")).toBe(false);
  });

  it("matches case-sensitively (uppercase variants are not allowed)", () => {
    expect(isZdrAllowed("OPENAI/GPT-OSS-120B")).toBe(false);
  });

  it("assertZdrAllowed throws with code 'zdr_blocked' for non-allowlisted models", () => {
    try {
      assertZdrAllowed("openai/gpt-4o");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe("zdr_blocked");
      expect((err as Error).message).toContain("not on the pinned ZDR allowlist");
      expect((err as Error).message).toContain(ZDR_ALLOWLIST_VERSION);
    }
  });

  it("assertZdrAllowed is silent for allowlisted models", () => {
    expect(() => assertZdrAllowed(ZDR_ALLOWLIST[0]!)).not.toThrow();
  });
});
