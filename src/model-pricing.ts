/**
 * Vendor-neutral model price table (USD per 1 million tokens).
 *
 * Used for price-aware routing and savings tracking. Prices are approximate
 * and sourced from provider documentation / OpenRouter listings.
 *
 * **Last updated: 2026-06-16.**
 *
 * This is a manual snapshot, not a live feed. Bump the comment date when
 * you refresh prices. If a model is not in the table, `getModelPrice` returns
 * `undefined` and `estimateCostUsd` returns `null` — callers should treat
 * that as a non-fatal observability gap, not a hard error.
 */

export interface ModelPrice {
  provider: string;
  /** USD per million input (prompt) tokens. */
  inputUsdPerM: number;
  /** USD per million output (completion) tokens. */
  outputUsdPerM: number;
}

/**
 * Price table keyed by model id (slug, matching provider conventions).
 *
 * Sections:
 *   - OpenRouter models (routed via openrouter runtime)
 *   - Berget models (EU-sovereign, routed via berget runtime)
 *   - Anthropic baseline (for savings comparison via CLAUDE_BASELINE_MODEL_ID)
 *
 * Berget prices are in EUR; converted to USD at EUR/USD ≈ 1.12 (June 2026).
 * Berget slugs are case-sensitive and must match exactly as returned by the
 * Berget /v1/models endpoint.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  // ---- OpenRouter ----
  // Verified via /api/v1/models on 2026-06-17.
  "deepseek/deepseek-v4-flash": {
    provider: "openrouter",
    inputUsdPerM: 0.09,
    outputUsdPerM: 0.18,
  },
  "meta-llama/llama-4-scout": {
    provider: "openrouter",
    inputUsdPerM: 0.10,
    outputUsdPerM: 0.30,
  },
  "deepseek/deepseek-v4-pro": {
    provider: "openrouter",
    inputUsdPerM: 0.44,
    outputUsdPerM: 0.87,
  },
  "qwen/qwen3.7-plus": {
    provider: "openrouter",
    inputUsdPerM: 0.32,
    outputUsdPerM: 1.28,
  },
  "moonshotai/kimi-k2.6": {
    provider: "openrouter",
    inputUsdPerM: 0.68,
    outputUsdPerM: 3.41,
  },
  // Planner/verifier/synthesizer default on OpenRouter
  "anthropic/claude-sonnet-4.6": {
    provider: "openrouter",
    inputUsdPerM: 3.00,
    outputUsdPerM: 15.00,
  },

  // ---- Berget (EU-sovereign) ----
  // Verified slugs and prices from Berget /v1/models on 2026-06-17.
  // Prices are EUR/M tokens × 1.12 (EUR→USD) rounded to 4 decimal places.
  "meta-llama/Llama-3.1-8B-Instruct": {
    provider: "berget",
    inputUsdPerM: 0.22,
    outputUsdPerM: 0.22,
  },
  "mistralai/Mistral-Small-3.2-24B-Instruct-2506": {
    provider: "berget",
    inputUsdPerM: 0.34,
    outputUsdPerM: 0.34,
  },
  "google/gemma-4-31B-it": {
    provider: "berget",
    inputUsdPerM: 0.28,
    outputUsdPerM: 0.56,
  },
  "openai/gpt-oss-120b": {
    provider: "berget",
    inputUsdPerM: 0.22,
    outputUsdPerM: 0.84,
  },
  "zai-org/GLM-4.7-FP8": {
    provider: "berget",
    inputUsdPerM: 0.78,
    outputUsdPerM: 2.80,
  },
  "mistralai/Mistral-Medium-3.5-128B": {
    provider: "berget",
    inputUsdPerM: 1.68,
    outputUsdPerM: 5.60,
  },
  "meta-llama/Llama-3.3-70B-Instruct": {
    provider: "berget",
    inputUsdPerM: 1.01,
    outputUsdPerM: 1.01,
  },
  "moonshotai/Kimi-K2.6": {
    provider: "berget",
    inputUsdPerM: 0.84,
    outputUsdPerM: 3.92,
  },

  // ---- Homeserver (M5 local-inference gateway, ADR-004) ----
  // Owned hardware: marginal cost is $0 (electricity not metered here).
  // Explicit $0 entries keep local runs distinguishable from unknown-cost
  // models (null). Slugs match the gateway /v1/models ids exactly
  // (verified 2026-07-03).
  "mellum": {
    provider: "homeserver",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },
  "qwen3-30b-instruct": {
    provider: "homeserver",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },
  "qwen3-coder-next-80b": {
    provider: "homeserver",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },
  "gpt-oss-120b": {
    provider: "homeserver",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },
  "gemma4": {
    provider: "homeserver",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },
  "qwen36-a3b": {
    provider: "homeserver",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },
  "tongyi-dr": {
    provider: "homeserver",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
  },

  // ---- Anthropic baseline (for savings comparison) ----
  "claude-opus-4-8": {
    provider: "anthropic",
    inputUsdPerM: 5.00,
    outputUsdPerM: 25.00,
  },
  "claude-sonnet-4-6": {
    provider: "anthropic",
    inputUsdPerM: 3.00,
    outputUsdPerM: 15.00,
  },
  "claude-haiku-4-5": {
    provider: "anthropic",
    inputUsdPerM: 1.00,
    outputUsdPerM: 5.00,
  },
};

/**
 * Look up pricing for a model by id.
 * Returns `undefined` if the model is not in the snapshot.
 */
export function getModelPrice(modelId: string): ModelPrice | undefined {
  return MODEL_PRICING[modelId];
}

/**
 * Estimate the cost in USD for a given model and token counts.
 * Returns `null` if the model is not in the snapshot.
 */
export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = MODEL_PRICING[modelId];
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.inputUsdPerM +
    (outputTokens / 1_000_000) * price.outputUsdPerM;
}

/**
 * The all-Claude baseline model used for savings comparison.
 * Routing decisions that substitute a cheaper model save against this rate.
 */
export const CLAUDE_BASELINE_MODEL_ID = "claude-sonnet-4-6";
