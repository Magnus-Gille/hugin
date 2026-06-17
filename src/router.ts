import type { Sensitivity } from "./sensitivity.js";
import { compareSensitivity } from "./sensitivity.js";
import { getRuntimeMaxSensitivity } from "./runtime-registry.js";
import type { RuntimeCandidate, RuntimeCapability } from "./runtime-registry.js";
import { getModelPrice } from "./model-pricing.js";

export interface RouterInput {
  effectiveSensitivity: Sensitivity;
  capabilities?: RuntimeCapability[];
  preferredModel?: string;
  availableRuntimes: RuntimeCandidate[];
}

export interface RouterDecision {
  selectedRuntime: RuntimeCandidate;
  reason: string;
  eliminated: Array<{ id: string; reason: string }>;
}

const COST_RANK: Record<string, number> = {
  free: 0,
  subscription: 1,
  "per-token": 2,
};

const TRUST_RANK: Record<string, number> = {
  trusted: 0,
  "semi-trusted": 1,
};

const SIZE_RANK: Record<string, number> = {
  large: 0,
  medium: 1,
  small: 2,
};

/**
 * Blended (input+output)/2 price in USD per million tokens for the candidate's
 * default model. Returns `Number.POSITIVE_INFINITY` when the model is unknown
 * or no defaultModel is set — unpriced candidates sink to the bottom within
 * their cost tier.
 */
function representativePriceUsdPerM(candidate: RuntimeCandidate): number {
  if (!candidate.defaultModel) return Number.POSITIVE_INFINITY;
  const price = getModelPrice(candidate.defaultModel);
  if (!price) return Number.POSITIVE_INFINITY;
  return (price.inputUsdPerM + price.outputUsdPerM) / 2;
}

export function routeTask(input: RouterInput): RouterDecision {
  const { effectiveSensitivity, capabilities, preferredModel, availableRuntimes } = input;
  const eliminated: Array<{ id: string; reason: string }> = [];
  let candidates = [...availableRuntimes];

  // Step 1: Filter by trust tier (sensitivity ceiling)
  candidates = candidates.filter((c) => {
    const maxSens = getRuntimeMaxSensitivity(c.trustTier);
    if (compareSensitivity(effectiveSensitivity, maxSens) > 0) {
      eliminated.push({
        id: c.id,
        reason: `trust: ${c.trustTier} allows max ${maxSens}, task requires ${effectiveSensitivity}`,
      });
      return false;
    }
    return true;
  });

  // Step 2: Filter by availability
  candidates = candidates.filter((c) => {
    if (!c.available) {
      eliminated.push({ id: c.id, reason: "unavailable" });
      return false;
    }
    return true;
  });

  // Step 2b: Filter out runtimes that are explicit-only (autoEligible: false).
  // These can still be selected by alias via the orchestrator broker, but the
  // generic auto-router never picks them.
  candidates = candidates.filter((c) => {
    if (c.autoEligible === false) {
      eliminated.push({ id: c.id, reason: "explicit-only (autoEligible: false)" });
      return false;
    }
    return true;
  });

  // Step 3: Filter by capabilities (if specified)
  if (capabilities && capabilities.length > 0) {
    candidates = candidates.filter((c) => {
      const missing = capabilities.filter((cap) => !c.capabilities.includes(cap));
      if (missing.length > 0) {
        eliminated.push({
          id: c.id,
          reason: `missing capabilities: ${missing.join(", ")}`,
        });
        return false;
      }
      return true;
    });
  }

  // No candidates survive → fail with clear reasons
  if (candidates.length === 0) {
    const reasons = eliminated.map((e) => `  ${e.id}: ${e.reason}`).join("\n");
    throw new Error(
      `No runtime available for ${effectiveSensitivity}-sensitivity task. All eliminated:\n${reasons}`,
    );
  }

  // Step 4: Model affinity boost
  let modelAffinityMatch: RuntimeCandidate | undefined;
  if (preferredModel) {
    modelAffinityMatch = candidates.find((c) =>
      c.models.some((m) => m === preferredModel || m.startsWith(preferredModel + ":")),
    );
  }

  // Step 5: Rank and select
  candidates.sort((a, b) => {
    // Model affinity: preferred model match wins
    if (modelAffinityMatch) {
      if (a === modelAffinityMatch && b !== modelAffinityMatch) return -1;
      if (b === modelAffinityMatch && a !== modelAffinityMatch) return 1;
    }

    // Cost: free > subscription > per-token
    const costDiff = (COST_RANK[a.costModel] ?? 2) - (COST_RANK[b.costModel] ?? 2);
    if (costDiff !== 0) return costDiff;

    // Trust: trusted > semi-trusted
    const trustDiff = (TRUST_RANK[a.trustTier] ?? 1) - (TRUST_RANK[b.trustTier] ?? 1);
    if (trustDiff !== 0) return trustDiff;

    // Size: larger > smaller
    const sizeDiff = (SIZE_RANK[a.modelSize] ?? 2) - (SIZE_RANK[b.modelSize] ?? 2);
    if (sizeDiff !== 0) return sizeDiff;

    // Price: cheaper defaultModel wins (within same tier/trust/size).
    // Unpriced candidates (no defaultModel or unknown price) rank last.
    return representativePriceUsdPerM(a) - representativePriceUsdPerM(b);
  });

  const selected = candidates[0];
  const reason = buildReason(selected, eliminated, modelAffinityMatch, effectiveSensitivity);

  return { selectedRuntime: selected, reason, eliminated };
}

function buildReason(
  selected: RuntimeCandidate,
  eliminated: Array<{ id: string; reason: string }>,
  modelAffinityMatch: RuntimeCandidate | undefined,
  sensitivity: Sensitivity,
): string {
  const parts = [`selected ${selected.id} for ${sensitivity}-sensitivity task`];

  if (modelAffinityMatch && selected === modelAffinityMatch) {
    parts.push(`model affinity match`);
  } else {
    const base = `cost:${selected.costModel}, trust:${selected.trustTier}, size:${selected.modelSize}`;
    if (selected.costModel === "per-token" && selected.defaultModel) {
      const price = representativePriceUsdPerM(selected);
      if (price !== Number.POSITIVE_INFINITY) {
        parts.push(`${base}, price:$${price.toFixed(3)}/M`);
      } else {
        parts.push(base);
      }
    } else {
      parts.push(base);
    }
  }

  if (eliminated.length > 0) {
    parts.push(`${eliminated.length} eliminated`);
  }

  return parts.join("; ");
}
