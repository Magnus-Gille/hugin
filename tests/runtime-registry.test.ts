import { describe, it, expect } from "vitest";
import {
  RUNTIME_REGISTRY,
  buildRuntimeCandidates,
  getRegistryEntryById,
  getRuntimeMaxSensitivity,
} from "../src/runtime-registry.js";
import type { OllamaHost } from "../src/ollama-hosts.js";

describe("RUNTIME_REGISTRY", () => {
  it("contains all expected runtimes", () => {
    const ids = RUNTIME_REGISTRY.map((r) => r.id);
    expect(ids).toContain("claude-sdk");
    expect(ids).toContain("codex-spawn");
    expect(ids).toContain("ollama-pi");
    expect(ids).toContain("ollama-laptop");
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

  it("cloud entries are semi-trusted", () => {
    const cloudEntries = RUNTIME_REGISTRY.filter(
      (r) => r.dispatcherRuntime !== "ollama",
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
    models: ["qwen3.5:2b", "llama3.2:1b"],
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
    expect(pi?.models).toEqual(["qwen3.5:2b", "llama3.2:1b"]);
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
});
