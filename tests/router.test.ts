import { describe, it, expect } from "vitest";
import { routeTask } from "../src/router.js";
import type { RouterInput } from "../src/router.js";
import type { RuntimeCandidate } from "../src/runtime-registry.js";

function makeCandidate(overrides: Partial<RuntimeCandidate> & { id: string }): RuntimeCandidate {
  return {
    dispatcherRuntime: "ollama",
    trustTier: "trusted",
    costModel: "free",
    modelSize: "small",
    capabilities: [],
    available: true,
    models: [],
    ...overrides,
  };
}

const claudeSdk = makeCandidate({
  id: "claude-sdk",
  dispatcherRuntime: "claude",
  trustTier: "semi-trusted",
  costModel: "subscription",
  modelSize: "large",
  capabilities: ["tools", "code", "structured-output"],
});

const codexSpawn = makeCandidate({
  id: "codex-spawn",
  dispatcherRuntime: "codex",
  trustTier: "semi-trusted",
  costModel: "subscription",
  modelSize: "large",
  capabilities: ["tools", "code"],
});

const ollamaPi = makeCandidate({
  id: "ollama-pi",
  dispatcherRuntime: "ollama",
  trustTier: "trusted",
  costModel: "free",
  modelSize: "small",
  capabilities: [],
  ollamaHost: "pi",
  models: ["qwen2.5:3b"],
});

const ollamaLaptop = makeCandidate({
  id: "ollama-laptop",
  dispatcherRuntime: "ollama",
  trustTier: "trusted",
  costModel: "free",
  modelSize: "medium",
  capabilities: [],
  ollamaHost: "laptop",
  models: ["qwen3.5:35b-a3b"],
});

const allRuntimes = [claudeSdk, codexSpawn, ollamaPi, ollamaLaptop];

describe("routeTask", () => {
  describe("trust filtering", () => {
    it("private sensitivity only allows trusted runtimes", () => {
      const input: RouterInput = {
        effectiveSensitivity: "private",
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      expect(decision.selectedRuntime.trustTier).toBe("trusted");
      expect(decision.eliminated).toContainEqual(
        expect.objectContaining({ id: "claude-sdk" }),
      );
      expect(decision.eliminated).toContainEqual(
        expect.objectContaining({ id: "codex-spawn" }),
      );
    });

    it("internal sensitivity allows trusted and semi-trusted", () => {
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      // Should select something — all are allowed
      expect(decision.selectedRuntime).toBeDefined();
      // No trust eliminations
      expect(
        decision.eliminated.filter((e) => e.reason.startsWith("trust:")),
      ).toHaveLength(0);
    });

    it("public sensitivity allows all runtimes", () => {
      const input: RouterInput = {
        effectiveSensitivity: "public",
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      expect(decision.selectedRuntime).toBeDefined();
      expect(
        decision.eliminated.filter((e) => e.reason.startsWith("trust:")),
      ).toHaveLength(0);
    });
  });

  describe("availability filtering", () => {
    it("removes offline runtimes", () => {
      const offlinePi = { ...ollamaPi, available: false };
      const input: RouterInput = {
        effectiveSensitivity: "private",
        availableRuntimes: [offlinePi, ollamaLaptop],
      };
      const decision = routeTask(input);
      expect(decision.selectedRuntime.id).toBe("ollama-laptop");
      expect(decision.eliminated).toContainEqual(
        expect.objectContaining({ id: "ollama-pi", reason: "unavailable" }),
      );
    });
  });

  describe("capability filtering", () => {
    it("drops runtimes missing required capabilities", () => {
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        capabilities: ["tools", "code"],
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      // ollama runtimes have no capabilities, should be eliminated
      expect(decision.selectedRuntime.dispatcherRuntime).not.toBe("ollama");
      expect(decision.eliminated).toContainEqual(
        expect.objectContaining({ id: "ollama-pi" }),
      );
      expect(decision.eliminated).toContainEqual(
        expect.objectContaining({ id: "ollama-laptop" }),
      );
    });

    it("passes through when no capabilities specified", () => {
      const input: RouterInput = {
        effectiveSensitivity: "public",
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      // No capability eliminations
      expect(
        decision.eliminated.filter((e) => e.reason.startsWith("missing capabilities")),
      ).toHaveLength(0);
    });

    it("filters by structured-output capability", () => {
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        capabilities: ["structured-output"],
        availableRuntimes: [claudeSdk, codexSpawn],
      };
      const decision = routeTask(input);
      // Only claude-sdk has structured-output
      expect(decision.selectedRuntime.id).toBe("claude-sdk");
      expect(decision.eliminated).toContainEqual(
        expect.objectContaining({ id: "codex-spawn" }),
      );
    });
  });

  describe("ranking", () => {
    it("prefers free over subscription", () => {
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      expect(decision.selectedRuntime.costModel).toBe("free");
    });

    it("prefers trusted over semi-trusted at same cost", () => {
      const trustedSubscription = makeCandidate({
        id: "trusted-sub",
        trustTier: "trusted",
        costModel: "subscription",
        modelSize: "large",
      });
      const semiTrustedSubscription = makeCandidate({
        id: "semi-sub",
        trustTier: "semi-trusted",
        costModel: "subscription",
        modelSize: "large",
      });
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        availableRuntimes: [semiTrustedSubscription, trustedSubscription],
      };
      const decision = routeTask(input);
      expect(decision.selectedRuntime.id).toBe("trusted-sub");
    });

    it("prefers larger model as tiebreaker", () => {
      const input: RouterInput = {
        effectiveSensitivity: "private",
        availableRuntimes: [ollamaPi, ollamaLaptop],
      };
      const decision = routeTask(input);
      // Both free and trusted — laptop is medium, pi is small
      expect(decision.selectedRuntime.id).toBe("ollama-laptop");
    });
  });

  describe("model affinity", () => {
    it("preferred model on available host wins", () => {
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        preferredModel: "qwen2.5:3b",
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      expect(decision.selectedRuntime.id).toBe("ollama-pi");
      expect(decision.reason).toContain("model affinity");
    });

    it("falls back to ranking when preferred model not found", () => {
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        preferredModel: "nonexistent-model",
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      // Should still select something via normal ranking
      expect(decision.selectedRuntime).toBeDefined();
      expect(decision.reason).not.toContain("model affinity");
    });

    it("model affinity respects trust filtering", () => {
      const input: RouterInput = {
        effectiveSensitivity: "private",
        preferredModel: "qwen2.5:3b",
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      // Should still pick ollama-pi (model match + trusted)
      expect(decision.selectedRuntime.id).toBe("ollama-pi");
      // Cloud runtimes should be eliminated by trust
      expect(decision.eliminated).toContainEqual(
        expect.objectContaining({ id: "claude-sdk" }),
      );
    });
  });

  describe("no candidates", () => {
    it("throws with clear elimination reasons when nothing survives", () => {
      const input: RouterInput = {
        effectiveSensitivity: "private",
        availableRuntimes: [
          { ...ollamaPi, available: false },
          { ...ollamaLaptop, available: false },
          claudeSdk,
          codexSpawn,
        ],
      };
      expect(() => routeTask(input)).toThrow(
        /No runtime available for private-sensitivity task/,
      );
    });

    it("error includes all elimination reasons", () => {
      const input: RouterInput = {
        effectiveSensitivity: "private",
        capabilities: ["tools"],
        availableRuntimes: [ollamaPi],
      };
      expect(() => routeTask(input)).toThrow(/missing capabilities/);
    });

    it("empty runtime list throws", () => {
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        availableRuntimes: [],
      };
      expect(() => routeTask(input)).toThrow(/No runtime available/);
    });
  });

  describe("decision audit trail", () => {
    it("includes reason string", () => {
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      expect(decision.reason).toBeTruthy();
      expect(decision.reason).toContain("internal-sensitivity");
    });

    it("includes eliminated entries", () => {
      const input: RouterInput = {
        effectiveSensitivity: "private",
        availableRuntimes: allRuntimes,
      };
      const decision = routeTask(input);
      expect(decision.eliminated.length).toBeGreaterThan(0);
      for (const e of decision.eliminated) {
        expect(e.id).toBeTruthy();
        expect(e.reason).toBeTruthy();
      }
    });
  });

  describe("autoEligible filter (orchestrator v1)", () => {
    const openrouter = makeCandidate({
      id: "openrouter",
      dispatcherRuntime: "openrouter",
      trustTier: "semi-trusted",
      costModel: "per-token",
      modelSize: "large",
      capabilities: ["code"],
      autoEligible: false,
    });

    const piHarness = makeCandidate({
      id: "pi-harness",
      dispatcherRuntime: "pi-harness",
      trustTier: "semi-trusted",
      costModel: "per-token",
      modelSize: "large",
      capabilities: ["code", "tools"],
      autoEligible: false,
    });

    it("excludes autoEligible:false runtimes from auto-routing", () => {
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        availableRuntimes: [...allRuntimes, openrouter, piHarness],
      };
      const decision = routeTask(input);
      expect(decision.selectedRuntime.id).not.toBe("openrouter");
      expect(decision.selectedRuntime.id).not.toBe("pi-harness");
      const eliminatedIds = decision.eliminated.map((e) => e.id);
      expect(eliminatedIds).toContain("openrouter");
      expect(eliminatedIds).toContain("pi-harness");
    });

    it("records explicit-only reason for eliminated explicit-only runtimes", () => {
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        availableRuntimes: [...allRuntimes, openrouter],
      };
      const decision = routeTask(input);
      const elim = decision.eliminated.find((e) => e.id === "openrouter");
      expect(elim?.reason).toMatch(/explicit-only/);
    });

    it("falls through to autoEligible:true runtimes correctly", () => {
      // Even when openrouter would otherwise win on size, ollama-pi (free, trusted)
      // should still be picked for internal-sensitivity tasks.
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        availableRuntimes: [openrouter, ollamaPi],
      };
      const decision = routeTask(input);
      expect(decision.selectedRuntime.id).toBe("ollama-pi");
    });

    it("undefined autoEligible is treated as eligible (backwards-compatible)", () => {
      const legacy = makeCandidate({
        id: "legacy-runtime",
        // autoEligible omitted
      });
      const input: RouterInput = {
        effectiveSensitivity: "internal",
        availableRuntimes: [legacy],
      };
      const decision = routeTask(input);
      expect(decision.selectedRuntime.id).toBe("legacy-runtime");
    });
  });
});
