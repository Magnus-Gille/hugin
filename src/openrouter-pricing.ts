/**
 * Per-model pricing snapshot for OpenRouter.
 *
 * Used by the OpenRouter executor to translate token usage into
 * `cost_usd` for the DelegationResult. The registry marks the
 * `openrouter` runtime as `costModel: "per-token"`, so emitting a
 * literal `0` would produce systematically wrong telemetry — instead
 * we look the model up in the table below and compute it.
 *
 * **This is a manual snapshot, not a live feed.** OpenRouter publishes
 * prices at https://openrouter.ai/models; bump `PRICING_SNAPSHOT_DATE`
 * any time you refresh the table. If the model is not in the table
 * the calculator returns `null`, signalling "unknown" — the caller
 * should treat that as a non-fatal observability gap, not a hard error.
 *
 * The table covers the pinned ZDR allowlist (see openrouter-zdr.ts).
 * Add a new row first if/when the allowlist grows.
 */

export const PRICING_SNAPSHOT_DATE = "2026-04-26";

export interface ModelPricing {
  /** USD per million prompt (input) tokens. */
  promptPerMTokens: number;
  /** USD per million completion (output) tokens. */
  completionPerMTokens: number;
}

export interface CostUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Snapshot of OpenRouter list prices for the v1 ZDR-allowlisted models.
 * Keep slug case identical to the allowlist.
 */
export const OPENROUTER_PRICING: Readonly<Record<string, ModelPricing>> = {
  "openai/gpt-oss-120b": {
    promptPerMTokens: 0.05,
    completionPerMTokens: 0.3,
  },
  "qwen/qwen3-coder": {
    promptPerMTokens: 0.3,
    completionPerMTokens: 1.2,
  },
  "qwen/qwen3-coder-next": {
    promptPerMTokens: 0.3,
    completionPerMTokens: 1.2,
  },
};

/**
 * Compute `cost_usd` from token usage. Returns `null` if the model is
 * not in the snapshot (caller decides whether that is allowed).
 *
 * Both token counts default to 0 individually so a partial usage
 * record (e.g. only `total_tokens` reported) still produces a number,
 * just an undercount — better than throwing.
 */
export function computeOpenRouterCostUsd(
  model: string,
  usage: CostUsage,
): number | null {
  const pricing = OPENROUTER_PRICING[model];
  if (!pricing) return null;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const promptCost = (prompt / 1_000_000) * pricing.promptPerMTokens;
  const completionCost = (completion / 1_000_000) * pricing.completionPerMTokens;
  return promptCost + completionCost;
}
