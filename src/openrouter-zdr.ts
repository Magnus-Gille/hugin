/**
 * Pinned ZDR (zero-data-retention) allowlist for OpenRouter.
 *
 * Per docs/orchestrator-v1-data-model.md §6, every model that flows
 * through the `openrouter` and `pi-harness` runtimes must be on this
 * list. The list is *intentionally* small: orchestrator v1 only ships
 * two delegated aliases (`large-reasoning`, `pi-large-coder`), so the
 * allowlist mirrors them plus a tightly scoped set of qwen3-coder
 * variants that the pi-harness eval used.
 *
 * The version string `zdr-v1` is part of the broker's `policy_version`
 * field (`zdr-v1+rlv-v1`). Bump the version any time the allowlist
 * changes — clients must be able to detect when the policy under which
 * a result was produced has shifted.
 *
 * The allowlist is a hard gate, not a hint. The OpenRouter HTTP client
 * rejects any request whose model is not on this list before the
 * request hits the network — there is no "warn" or "log" mode.
 */

/**
 * Monotonic version stamp for the allowlist contents below. Bump on any
 * addition, removal, or substantive renaming. Kept short so it can be
 * concatenated into the broker's combined `policy_version` string
 * (`zdr-v1+rlv-v1`).
 */
export const ZDR_ALLOWLIST_VERSION = "zdr-v1";

/**
 * Models permitted to flow through the OpenRouter executor.
 *
 * Each entry is the OpenRouter slug (`<provider>/<model>` or
 * `<model>` for OpenAI's first-party). Slugs are matched case-
 * sensitively against the resolved alias model.
 */
export const ZDR_ALLOWLIST: readonly string[] = [
  "openai/gpt-oss-120b",
  "qwen/qwen3-coder",
  "qwen/qwen3-coder-next",
];

const ZDR_ALLOWLIST_SET: ReadonlySet<string> = new Set(ZDR_ALLOWLIST);

/**
 * Returns true when `model` is on the pinned ZDR allowlist.
 */
export function isZdrAllowed(model: string): boolean {
  return ZDR_ALLOWLIST_SET.has(model);
}

/**
 * Throws a stable Error with `code: "zdr_blocked"` if `model` is not on
 * the allowlist. Caller (executor) maps this to a `policy_rejected`
 * DelegationError so the broker can surface it cleanly to the MCP.
 */
export function assertZdrAllowed(model: string): void {
  if (!isZdrAllowed(model)) {
    const err = new Error(
      `model '${model}' is not on the pinned ZDR allowlist (${ZDR_ALLOWLIST_VERSION}). ` +
        `Allowed: ${ZDR_ALLOWLIST.join(", ")}`,
    );
    (err as Error & { code?: string }).code = "zdr_blocked";
    throw err;
  }
}
