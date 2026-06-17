import { describe, it, expect } from "vitest";
import {
  ALIAS_MAP_V1,
  RUNTIME_REGISTRY,
  buildRuntimeCandidates,
  getAliasMap,
  getRegistryEntryById,
  getRuntimeMaxSensitivity,
  parseActiveSubscriptions,
  resolveAlias,
} from "../src/runtime-registry.js";
import type { OllamaHost } from "../src/ollama-hosts.js";

describe("RUNTIME_REGISTRY", () => {
  it("contains all expected runtimes", () => {
    const ids = RUNTIME_REGISTRY.map((r) => r.id);
    expect(ids).toContain("claude-sdk");
    expect(ids).toContain("codex-spawn");
    expect(ids).toContain("ollama-pi");
    expect(ids).toContain("ollama-laptop");
    expect(ids).toContain("ollama-orin");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("pi-harness");
  });

  it("every entry has required fields", () => {
    for (const entry of RUNTIME_REGISTRY) {
      expect(entry.id).toBeTruthy();
      expect(entry.dispatcherRuntime).toBeTruthy();
      expect(entry.trustTier).toMatch(/^(trusted|semi-trusted)$/);
      expect(entry.costModel).toMatch(/^(subscription|per-token|free)$/);
      expect(entry.modelSize).toMatch(/^(small|medium|large)$/);
      expect(Array.isArray(entry.capabilities)).toBe(true);
    }
  });

  it("ollama entries have ollamaHost set", () => {
    const ollamaEntries = RUNTIME_REGISTRY.filter(
      (r) => r.dispatcherRuntime === "ollama",
    );
    for (const entry of ollamaEntries) {
      expect(entry.ollamaHost).toBeTruthy();
    }
  });

  it("cloud entries are semi-trusted (except berget which is trusted/EU-sovereign)", () => {
    const cloudEntries = RUNTIME_REGISTRY.filter(
      (r) => r.dispatcherRuntime !== "ollama" && r.id !== "berget",
    );
    for (const entry of cloudEntries) {
      expect(entry.trustTier).toBe("semi-trusted");
    }
  });

  it("ollama entries are trusted", () => {
    const ollamaEntries = RUNTIME_REGISTRY.filter(
      (r) => r.dispatcherRuntime === "ollama",
    );
    for (const entry of ollamaEntries) {
      expect(entry.trustTier).toBe("trusted");
    }
  });
});

describe("getRegistryEntryById", () => {
  it("returns entry for known id", () => {
    const entry = getRegistryEntryById("claude-sdk");
    expect(entry).toBeDefined();
    expect(entry!.dispatcherRuntime).toBe("claude");
  });

  it("returns undefined for unknown id", () => {
    expect(getRegistryEntryById("unknown-runtime")).toBeUndefined();
  });
});

describe("getRuntimeMaxSensitivity", () => {
  it("trusted allows private", () => {
    expect(getRuntimeMaxSensitivity("trusted")).toBe("private");
  });

  it("semi-trusted allows internal", () => {
    expect(getRuntimeMaxSensitivity("semi-trusted")).toBe("internal");
  });
});

describe("buildRuntimeCandidates", () => {
  const piOnline: OllamaHost = {
    name: "pi",
    baseUrl: "http://127.0.0.1:11434",
    available: true,
    models: ["qwen2.5:3b", "llama3.2:1b"],
    lastChecked: Date.now(),
  };

  const laptopOffline: OllamaHost = {
    name: "laptop",
    baseUrl: "http://100.1.2.3:11434",
    available: false,
    models: [],
    lastChecked: Date.now(),
    lastError: "Connection refused",
  };

  const laptopOnline: OllamaHost = {
    name: "laptop",
    baseUrl: "http://100.1.2.3:11434",
    available: true,
    models: ["qwen3.5:35b-a3b", "llama3.3:70b"],
    lastChecked: Date.now(),
  };

  const orinOffline: OllamaHost = {
    name: "orin",
    baseUrl: "http://100.127.176.78:11434",
    available: false,
    models: [],
    lastChecked: Date.now(),
    lastError: "Connection refused",
  };

  const orinOnline: OllamaHost = {
    name: "orin",
    baseUrl: "http://100.127.176.78:11434",
    available: true,
    models: ["qwen2.5-coder:7b", "qwen2.5:3b"],
    lastChecked: Date.now(),
  };

  it("marks cloud runtimes as always available", () => {
    const candidates = buildRuntimeCandidates([piOnline, laptopOffline]);
    const claude = candidates.find((c) => c.id === "claude-sdk");
    const codex = candidates.find((c) => c.id === "codex-spawn");
    expect(claude?.available).toBe(true);
    expect(codex?.available).toBe(true);
  });

  it("marks ollama host as available when probe says so", () => {
    const candidates = buildRuntimeCandidates([piOnline, laptopOffline]);
    const pi = candidates.find((c) => c.id === "ollama-pi");
    expect(pi?.available).toBe(true);
    expect(pi?.models).toEqual(["qwen2.5:3b", "llama3.2:1b"]);
  });

  it("marks ollama host as unavailable when probe says so", () => {
    const candidates = buildRuntimeCandidates([piOnline, laptopOffline]);
    const laptop = candidates.find((c) => c.id === "ollama-laptop");
    expect(laptop?.available).toBe(false);
    expect(laptop?.models).toEqual([]);
  });

  it("handles missing host entry gracefully", () => {
    const candidates = buildRuntimeCandidates([piOnline]); // no laptop host
    const laptop = candidates.find((c) => c.id === "ollama-laptop");
    expect(laptop?.available).toBe(false);
  });

  it("populates models from live host data", () => {
    const candidates = buildRuntimeCandidates([piOnline, laptopOnline]);
    const laptop = candidates.find((c) => c.id === "ollama-laptop");
    expect(laptop?.available).toBe(true);
    expect(laptop?.models).toEqual(["qwen3.5:35b-a3b", "llama3.3:70b"]);
  });

  it("returns all registry entries", () => {
    const candidates = buildRuntimeCandidates([piOnline, laptopOffline]);
    expect(candidates.length).toBe(RUNTIME_REGISTRY.length);
  });

  it("marks orin host as unavailable when probe says so", () => {
    const candidates = buildRuntimeCandidates([piOnline, laptopOffline, orinOffline]);
    const orin = candidates.find((c) => c.id === "ollama-orin");
    expect(orin?.available).toBe(false);
    expect(orin?.models).toEqual([]);
  });

  it("marks orin host as available and populates models when online", () => {
    const candidates = buildRuntimeCandidates([piOnline, laptopOffline, orinOnline]);
    const orin = candidates.find((c) => c.id === "ollama-orin");
    expect(orin?.available).toBe(true);
    expect(orin?.models).toEqual(["qwen2.5-coder:7b", "qwen2.5:3b"]);
  });

  it("handles missing orin host entry gracefully", () => {
    const candidates = buildRuntimeCandidates([piOnline]); // no orin host
    const orin = candidates.find((c) => c.id === "ollama-orin");
    expect(orin?.available).toBe(false);
  });
});

describe("orchestrator v1 policy fields", () => {
  it("openrouter is third-party, ZDR-required, explicit-only", () => {
    const entry = getRegistryEntryById("openrouter");
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe("openrouter");
    expect(entry!.egress).toBe("third-party");
    expect(entry!.zdrRequired).toBe(true);
    expect(entry!.autoEligible).toBe(false);
    expect(entry!.family).toBe("one-shot");
    expect(entry!.reasoningLevel).toBe("medium");
  });

  it("pi-harness is third-party, ZDR-required, explicit-only, harness family", () => {
    const entry = getRegistryEntryById("pi-harness");
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe("pi-harness");
    expect(entry!.family).toBe("harness");
    expect(entry!.harnessCmd).toBe("pi");
    expect(entry!.harnessFlags).toEqual(["--no-session", "--provider", "openrouter"]);
    expect(entry!.zdrRequired).toBe(true);
    expect(entry!.autoEligible).toBe(false);
  });

  it("existing one-shot runtimes are auto-eligible by default", () => {
    for (const id of ["claude-sdk", "codex-spawn", "ollama-pi", "ollama-laptop", "ollama-orin"]) {
      const entry = getRegistryEntryById(id);
      expect(entry?.autoEligible).toBe(true);
      expect(entry?.family).toBe("one-shot");
    }
  });

  it("ollama entries are local-egress and not ZDR-flagged", () => {
    const ollamaEntries = RUNTIME_REGISTRY.filter(
      (r) => r.dispatcherRuntime === "ollama",
    );
    for (const entry of ollamaEntries) {
      expect(entry.egress).toBe("local");
      expect(entry.zdrRequired).toBe(false);
    }
  });
});

describe("alias map (v1)", () => {
  it("getAliasMap returns ALIAS_MAP_V1", () => {
    expect(getAliasMap()).toBe(ALIAS_MAP_V1);
    expect(ALIAS_MAP_V1.version).toBe(1);
  });

  it("contains the five v1 aliases (four original + berget-sovereign)", () => {
    const aliases = Object.keys(ALIAS_MAP_V1.aliases).sort();
    expect(aliases).toEqual(["berget-sovereign", "large-reasoning", "medium", "pi-large-coder", "tiny"]);
  });

  it("tiny resolves to ollama-pi/qwen2.5:3b", () => {
    const r = resolveAlias("tiny");
    expect(r.runtimeId).toBe("ollama-pi");
    expect(r.model).toBe("qwen2.5:3b");
    expect(r.family).toBe("one-shot");
  });

  it("medium resolves to ollama-laptop/qwen3:14b (eval-validated)", () => {
    const r = resolveAlias("medium");
    expect(r.runtimeId).toBe("ollama-laptop");
    expect(r.model).toBe("qwen3:14b");
    expect(r.family).toBe("one-shot");
  });

  it("large-reasoning resolves to openrouter/gpt-oss-120b @ medium", () => {
    const r = resolveAlias("large-reasoning");
    expect(r.runtimeId).toBe("openrouter");
    expect(r.model).toBe("openai/gpt-oss-120b");
    expect(r.reasoningLevel).toBe("medium");
    expect(r.family).toBe("one-shot");
  });

  it("pi-large-coder resolves to pi-harness/qwen3-coder-next", () => {
    const r = resolveAlias("pi-large-coder");
    expect(r.runtimeId).toBe("pi-harness");
    expect(r.model).toBe("qwen/qwen3-coder-next");
    expect(r.family).toBe("harness");
    expect(r.harness).toBe("pi");
  });

  it("every alias references a known runtime", () => {
    for (const resolution of Object.values(ALIAS_MAP_V1.aliases)) {
      expect(getRegistryEntryById(resolution.runtimeId)).toBeDefined();
    }
  });

  it("resolveAlias throws on unknown alias", () => {
    expect(() => resolveAlias("nonexistent" as never)).toThrow(/Unknown alias/);
  });

  it("berget-sovereign resolves to berget runtime with mistral-small", () => {
    const r = resolveAlias("berget-sovereign");
    expect(r.runtimeId).toBe("berget");
    expect(r.model).toBe("mistralai/mistral-small-3.2-24b-instruct");
    expect(r.family).toBe("one-shot");
  });
});

describe("berget runtime", () => {
  it("getRegistryEntryById returns berget with correct fields", () => {
    const entry = getRegistryEntryById("berget");
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe("berget");
    expect(entry!.egress).toBe("third-party");
    expect(entry!.trustTier).toBe("trusted");
    expect(entry!.autoEligible).toBe(false);
    expect(entry!.family).toBe("one-shot");
    expect(entry!.zdrRequired).toBe(false);
    expect(entry!.dispatcherRuntime).toBe("berget");
  });

  it("berget is available:true in buildRuntimeCandidates (cloud runtime)", () => {
    const candidates = buildRuntimeCandidates([]);
    const berget = candidates.find((c) => c.id === "berget");
    expect(berget).toBeDefined();
    expect(berget!.available).toBe(true);
  });
});

describe("parseActiveSubscriptions", () => {
  it("undefined returns undefined (all subscriptions active, backwards-compat)", () => {
    expect(parseActiveSubscriptions(undefined)).toBeUndefined();
  });

  it("empty string returns undefined", () => {
    expect(parseActiveSubscriptions("")).toBeUndefined();
  });

  it("whitespace-only string returns undefined", () => {
    expect(parseActiveSubscriptions("   ")).toBeUndefined();
  });

  it("single runtime id returns a Set with that id", () => {
    const result = parseActiveSubscriptions("claude-sdk");
    expect(result).toBeInstanceOf(Set);
    expect(result!.has("claude-sdk")).toBe(true);
    expect(result!.size).toBe(1);
  });

  it("trims whitespace around comma-separated ids", () => {
    const result = parseActiveSubscriptions("a, b ,c");
    expect(result).toBeInstanceOf(Set);
    expect(result!.has("a")).toBe(true);
    expect(result!.has("b")).toBe(true);
    expect(result!.has("c")).toBe(true);
    expect(result!.size).toBe(3);
  });

  it("ignores empty segments from double commas", () => {
    const result = parseActiveSubscriptions("claude-sdk,,codex-spawn");
    expect(result).toBeInstanceOf(Set);
    expect(result!.has("claude-sdk")).toBe(true);
    expect(result!.has("codex-spawn")).toBe(true);
    expect(result!.size).toBe(2);
  });
});

describe("buildRuntimeCandidates with activeSubscriptions", () => {
  it("with activeSubscriptions={claude-sdk}: claude-sdk available:true, codex-spawn available:false", () => {
    const active = new Set(["claude-sdk"]);
    const candidates = buildRuntimeCandidates([], { activeSubscriptions: active });
    const claudeSdk = candidates.find((c) => c.id === "claude-sdk");
    const codexSpawn = candidates.find((c) => c.id === "codex-spawn");
    expect(claudeSdk?.available).toBe(true);
    expect(codexSpawn?.available).toBe(false);
  });

  it("with activeSubscriptions=undefined: both claude-sdk and codex-spawn are available:true (regression)", () => {
    const candidates = buildRuntimeCandidates([], { activeSubscriptions: undefined });
    const claudeSdk = candidates.find((c) => c.id === "claude-sdk");
    const codexSpawn = candidates.find((c) => c.id === "codex-spawn");
    expect(claudeSdk?.available).toBe(true);
    expect(codexSpawn?.available).toBe(true);
  });

  it("activeSubscriptions does not affect non-subscription runtimes (ollama stays available)", () => {
    const piOnline: OllamaHost = {
      name: "pi",
      baseUrl: "http://127.0.0.1:11434",
      available: true,
      models: ["qwen2.5:3b"],
      lastChecked: Date.now(),
    };
    const active = new Set(["claude-sdk"]); // does not include ollama runtimes
    const candidates = buildRuntimeCandidates([piOnline], { activeSubscriptions: active });
    const pi = candidates.find((c) => c.id === "ollama-pi");
    expect(pi?.available).toBe(true); // free, unaffected by subscription filter
  });

  it("no opts argument keeps existing behaviour (both subscription runtimes available)", () => {
    const candidates = buildRuntimeCandidates([]);
    const claudeSdk = candidates.find((c) => c.id === "claude-sdk");
    const codexSpawn = candidates.find((c) => c.id === "codex-spawn");
    expect(claudeSdk?.available).toBe(true);
    expect(codexSpawn?.available).toBe(true);
  });
});
