import type { OllamaHost } from "./ollama-hosts.js";
import type { Sensitivity } from "./sensitivity.js";

// Legacy dispatcher runtimes — the three the in-process executor knows how to
// run today (src/index.ts spawn/SDK paths). The dispatcher's TaskConfig.runtime
// is constrained to this narrow set; orchestrator runtimes never flow through
// the legacy dispatcher.
export type LegacyDispatcherRuntime = "claude" | "codex" | "ollama";

// Wider union covering every runtime the registry can describe, including
// orchestrator-only runtimes that are reachable via the broker (Step 4) but
// never dispatched in-process.
export type DispatcherRuntime =
  | LegacyDispatcherRuntime
  | "orchestrator"
  | "openrouter"
  | "pi-harness"
  | "berget";

const LEGACY_DISPATCHER_RUNTIMES: ReadonlySet<DispatcherRuntime> = new Set([
  "claude",
  "codex",
  "ollama",
]);

export function isLegacyDispatcherRuntime(
  runtime: DispatcherRuntime,
): runtime is LegacyDispatcherRuntime {
  return LEGACY_DISPATCHER_RUNTIMES.has(runtime);
}
export type RuntimeCapability = "tools" | "code" | "structured-output";
export type TrustTier = "trusted" | "semi-trusted";
export type CostModel = "subscription" | "per-token" | "free";
export type ModelSize = "small" | "medium" | "large";

export type Provider =
  | "anthropic"
  | "openai-spawn"
  | "ollama-local"
  | "openrouter"
  | "pi-harness"
  | "berget";
export type Egress = "subscription" | "local" | "third-party";
export type RuntimeFamily = "one-shot" | "harness";
export type ReasoningLevel = "low" | "medium" | "high";

export interface RuntimeDefinition {
  id: string;
  dispatcherRuntime: DispatcherRuntime;
  trustTier: TrustTier;
  costModel: CostModel;
  modelSize: ModelSize;
  capabilities: RuntimeCapability[];
  ollamaHost?: "pi" | "laptop" | "orin";
  defaultModel?: string;

  // Orthogonal policy fields (orchestrator v1, see docs/orchestrator-v1-data-model.md §6)
  provider?: Provider;
  egress?: Egress;
  zdrRequired?: boolean;
  autoEligible?: boolean;
  family?: RuntimeFamily;
  reasoningLevel?: ReasoningLevel;
  harnessCmd?: string;
  harnessFlags?: readonly string[];
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
    provider: "anthropic",
    egress: "subscription",
    zdrRequired: false,
    autoEligible: true,
    family: "one-shot",
  },
  {
    id: "codex-spawn",
    dispatcherRuntime: "codex",
    trustTier: "semi-trusted",
    costModel: "subscription",
    modelSize: "large",
    capabilities: ["tools", "code"],
    provider: "openai-spawn",
    egress: "subscription",
    zdrRequired: false,
    autoEligible: true,
    family: "one-shot",
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
    provider: "ollama-local",
    egress: "local",
    zdrRequired: false,
    // The Pi is the always-on control plane; its qwen2.5:3b is too limited
    // to be a general auto-routed worker. Explicit-only: use Runtime: ollama
    // + Ollama-host: pi to target it deliberately.
    autoEligible: false,
    family: "one-shot",
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
    provider: "ollama-local",
    egress: "local",
    zdrRequired: false,
    autoEligible: true,
    family: "one-shot",
  },
  {
    id: "ollama-orin",
    dispatcherRuntime: "ollama",
    trustTier: "trusted",
    costModel: "free",
    modelSize: "small",
    capabilities: [],
    ollamaHost: "orin",
    // qwen2.5-coder:7b OOMs on the 8 GB Orin Nano (contiguous CUDA buffer alloc fails;
    // empirically verified 2026-06-15). qwen2.5-coder:3b is the largest coder model that
    // fits and runs on GPU (~18 tok/s headless). Do not raise without re-testing on hardware.
    defaultModel: "qwen2.5-coder:3b",
    provider: "ollama-local",
    egress: "local",
    zdrRequired: false,
    autoEligible: true,
    family: "one-shot",
  },
  {
    id: "openrouter",
    dispatcherRuntime: "openrouter",
    trustTier: "semi-trusted",
    costModel: "per-token",
    modelSize: "large",
    capabilities: ["code"],
    provider: "openrouter",
    egress: "third-party",
    zdrRequired: true,
    autoEligible: false,
    family: "one-shot",
    reasoningLevel: "medium",
  },
  {
    id: "pi-harness",
    dispatcherRuntime: "pi-harness",
    trustTier: "semi-trusted",
    costModel: "per-token",
    modelSize: "large",
    capabilities: ["code", "tools"],
    provider: "pi-harness",
    egress: "third-party",
    zdrRequired: true,
    autoEligible: false,
    family: "harness",
    harnessCmd: "pi",
    harnessFlags: ["--no-session", "--provider", "openrouter"],
  },
  {
    id: "berget",
    dispatcherRuntime: "berget",
    // Berget.ai is a Swedish company providing EU-sovereign GPU compute with
    // GDPR-by-design architecture, NIS2 compliance, and no US jurisdiction.
    // This makes it the sovereignty lane eligible to carry `private` data,
    // unlike semi-trusted third-party runtimes that are capped at `internal`.
    trustTier: "trusted",
    costModel: "per-token",
    modelSize: "large",
    capabilities: ["code"],
    provider: "berget",
    egress: "third-party",
    zdrRequired: false, // EU-native, no US nexus
    autoEligible: false, // explicit-only for now, consistent with openrouter/pi-harness
    family: "one-shot",
    defaultModel: "mistralai/mistral-small-3.2-24b-instruct",
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

/**
 * Parse the HUGIN_ACTIVE_SUBSCRIPTIONS env var into a Set of runtime ids.
 *
 * - `undefined` / empty / whitespace → `undefined` (meaning "all subscriptions
 *   active", backwards-compatible default).
 * - Otherwise → a Set of trimmed, non-empty, comma-separated runtime ids.
 */
export function parseActiveSubscriptions(
  env: string | undefined,
): ReadonlySet<string> | undefined {
  if (!env || !env.trim()) return undefined;
  const ids = env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return undefined;
  return new Set(ids);
}

export interface BuildRuntimeCandidatesOpts {
  /** When provided, subscription-cost runtimes are only available if their id
   *  is in this set. `undefined` = all subscriptions are active (default). */
  activeSubscriptions?: ReadonlySet<string>;
}

export function buildRuntimeCandidates(
  ollamaHosts: OllamaHost[],
  opts?: BuildRuntimeCandidatesOpts,
): RuntimeCandidate[] {
  const hostMap = new Map(ollamaHosts.map((h) => [h.name, h]));
  const { activeSubscriptions } = opts ?? {};

  return RUNTIME_REGISTRY.map((def): RuntimeCandidate => {
    if (def.ollamaHost) {
      const host = hostMap.get(def.ollamaHost);
      return {
        ...def,
        available: host?.available ?? false,
        models: host?.models ?? [],
      };
    }

    // For subscription-cost runtimes, honour the active-subscriptions filter
    // when provided. Non-subscription and unset behave as before.
    const available =
      def.costModel === "subscription" && activeSubscriptions !== undefined
        ? activeSubscriptions.has(def.id)
        : true;

    // Cloud runtimes (claude, codex, openrouter, pi-harness, berget) are assumed
    // always available at the registry level unless filtered out above. Per-call
    // availability (e.g. OpenRouter rate limits, harness binary missing) is
    // enforced by the executor.
    return {
      ...def,
      available,
      models: [],
    };
  });
}

// ---------------------------------------------------------------------------
// Stable aliases (orchestrator v1, see docs/orchestrator-v1-data-model.md §2)
// ---------------------------------------------------------------------------

export type Alias = "tiny" | "medium" | "large-reasoning" | "pi-large-coder" | "berget-sovereign";

export interface AliasResolution {
  alias: Alias;
  family: RuntimeFamily;
  harness?: "pi";
  model: string;
  runtimeId: string;
  host?: "pi" | "mba" | "openrouter";
  reasoningLevel?: ReasoningLevel;
  notes?: string;
}

export interface AliasMap {
  version: number;
  effective_at: string;
  aliases: Record<Alias, AliasResolution>;
}

export const ALIAS_MAP_V1: AliasMap = {
  version: 1,
  effective_at: "2026-04-26T00:00:00Z",
  aliases: {
    tiny: {
      alias: "tiny",
      family: "one-shot",
      model: "qwen2.5:3b",
      runtimeId: "ollama-pi",
      host: "pi",
      notes: "Only viable Pi-local model per ollama-performance-spike.",
    },
    medium: {
      alias: "medium",
      family: "one-shot",
      model: "qwen3:14b",
      runtimeId: "ollama-laptop",
      host: "mba",
      notes:
        "Eval-validated. Registry default for ollama-laptop is currently qwen3.5:35b-a3b — alias pins the working model regardless.",
    },
    "large-reasoning": {
      alias: "large-reasoning",
      family: "one-shot",
      model: "openai/gpt-oss-120b",
      runtimeId: "openrouter",
      host: "openrouter",
      reasoningLevel: "medium",
      notes: "Studio proxy. Reasoning level pinned for v1.",
    },
    "pi-large-coder": {
      alias: "pi-large-coder",
      family: "harness",
      harness: "pi",
      model: "qwen/qwen3-coder-next",
      runtimeId: "pi-harness",
      host: "pi",
      notes:
        "Validated 2026-04-26: 5/6 strict, 6/6 lenient on aider eval. pi --no-session calling OR for the model.",
    },
    "berget-sovereign": {
      alias: "berget-sovereign",
      family: "one-shot",
      model: "mistralai/mistral-small-3.2-24b-instruct",
      runtimeId: "berget",
      notes:
        "EU-sovereignty lane for private/internal tasks. Berget.ai: Swedish co, GDPR-by-design, NIS2, no US jurisdiction.",
    },
  },
};

export function getAliasMap(): AliasMap {
  return ALIAS_MAP_V1;
}

export function resolveAlias(alias: Alias): AliasResolution {
  const resolution = ALIAS_MAP_V1.aliases[alias];
  if (!resolution) {
    throw new Error(`Unknown alias: ${alias}`);
  }
  return resolution;
}
