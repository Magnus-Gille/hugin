import { describe, expect, it } from "vitest";
import {
  POLICY_VERSION,
  resolveAliasForBroker,
} from "../../src/broker/alias-resolution.js";

describe("resolveAliasForBroker", () => {
  it("resolves tiny → ollama-pi", () => {
    const r = resolveAliasForBroker("tiny");
    expect(r.alias_resolved.runtime).toBe("ollama");
    expect(r.alias_resolved.runtime_row_id).toBe("ollama-pi");
    expect(r.alias_resolved.host).toBe("pi");
    expect(r.alias_resolved.family).toBe("one-shot");
    expect(r.policy_version).toBe(POLICY_VERSION);
  });

  it("resolves medium → ollama-laptop on mba", () => {
    const r = resolveAliasForBroker("medium");
    expect(r.alias_resolved.runtime).toBe("ollama");
    expect(r.alias_resolved.host).toBe("mba");
  });

  it("resolves large-reasoning → openrouter with reasoning_level", () => {
    const r = resolveAliasForBroker("large-reasoning");
    expect(r.alias_resolved.runtime).toBe("openrouter");
    expect(r.alias_resolved.host).toBe("openrouter");
    expect(r.alias_resolved.reasoning_level).toBe("medium");
  });

  it("resolves pi-large-coder with harness:pi", () => {
    const r = resolveAliasForBroker("pi-large-coder");
    expect(r.alias_resolved.runtime).toBe("pi-harness");
    expect(r.alias_resolved.harness).toBe("pi");
    expect(r.alias_resolved.family).toBe("harness");
  });

  it("includes alias_map_version", () => {
    expect(resolveAliasForBroker("tiny").alias_map_version).toBe(1);
  });
});
