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
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  // ---- OpenRouter ----
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

  // ---- Berget (EU-sovereign) ----
  "mistralai/mistral-small-3.2-24b-instruct": {
    provider: "berget",
    inputUsdPerM: 0.33,
    outputUsdPerM: 0.33,
  },
  "google/gemma-4-31b-instruct": {
    provider: "berget",
    inputUsdPerM: 0.28,
    outputUsdPerM: 0.55,
  },
  "openai/gpt-oss-120b": {
    provider: "berget",
    inputUsdPerM: 0.44,
    outputUsdPerM: 0.99,
  },
  "zhipu/glm-4.7": {
    provider: "berget",
    inputUsdPerM: 0.77,
    outputUsdPerM: 2.75,
  },
  "mistralai/mistral-medium-3.5": {
    provider: "berget",
    inputUsdPerM: 1.65,
    outputUsdPerM: 5.50,
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
