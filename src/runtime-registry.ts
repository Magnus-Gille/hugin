import type { OllamaHost } from "./ollama-hosts.js";
import type { Sensitivity } from "./sensitivity.js";

export type DispatcherRuntime = "claude" | "codex" | "ollama";
export type RuntimeCapability = "tools" | "code" | "structured-output";
export type TrustTier = "trusted" | "semi-trusted";
export type CostModel = "subscription" | "per-token" | "free";
export type ModelSize = "small" | "medium" | "large";

export interface RuntimeDefinition {
  id: string;
  dispatcherRuntime: DispatcherRuntime;
  trustTier: TrustTier;
  costModel: CostModel;
  modelSize: ModelSize;
  capabilities: RuntimeCapability[];
  ollamaHost?: "pi" | "laptop";
  defaultModel?: string;
}

export interface RuntimeCandidate extends RuntimeDefinition {
  available: boolean;
  models: string[];
}

export const RUNTIME_REGISTRY: readonly RuntimeDefinition[] = [
  {
    id: "claude-sdk",
    dispatcherRuntime: "claude",
    trustTier: "semi-trusted",
    costModel: "subscription",
    modelSize: "large",
    capabilities: ["tools", "code", "structured-output"],
  },
  {
    id: "codex-spawn",
    dispatcherRuntime: "codex",
    trustTier: "semi-trusted",
    costModel: "subscription",
    modelSize: "large",
    capabilities: ["tools", "code"],
  },
  {
    id: "ollama-pi",
    dispatcherRuntime: "ollama",
    trustTier: "trusted",
    costModel: "free",
    modelSize: "small",
    capabilities: [],
    ollamaHost: "pi",
    defaultModel: "qwen2.5:3b",
  },
  {
    id: "ollama-laptop",
    dispatcherRuntime: "ollama",
    trustTier: "trusted",
    costModel: "free",
    modelSize: "medium",
    capabilities: [],
    ollamaHost: "laptop",
    defaultModel: "qwen3.5:35b-a3b",
  },
];

const TRUST_TIER_MAX_SENSITIVITY: Record<TrustTier, Sensitivity> = {
  trusted: "private",
  "semi-trusted": "internal",
};

export function getRuntimeMaxSensitivity(trustTier: TrustTier): Sensitivity {
  return TRUST_TIER_MAX_SENSITIVITY[trustTier];
}

export function getRegistryEntryById(id: string): RuntimeDefinition | undefined {
  return RUNTIME_REGISTRY.find((r) => r.id === id);
}

export function buildRuntimeCandidates(
  ollamaHosts: OllamaHost[],
): RuntimeCandidate[] {
  const hostMap = new Map(ollamaHosts.map((h) => [h.name, h]));

  return RUNTIME_REGISTRY.map((def): RuntimeCandidate => {
    if (def.ollamaHost) {
      const host = hostMap.get(def.ollamaHost);
      return {
        ...def,
        available: host?.available ?? false,
        models: host?.models ?? [],
      };
    }
    // Cloud runtimes (claude, codex) are assumed always available
    return {
      ...def,
      available: true,
      models: [],
    };
  });
}
