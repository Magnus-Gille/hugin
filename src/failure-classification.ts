/**
 * Failure classification for Hugin task results (issue #129).
 *
 * A task that fails because the runtime could not authenticate (an expired or
 * absent Pi Claude Code credential → HTTP 401) is indistinguishable, from the
 * outside, from a generic task-logic failure: the `failed` tag carries no
 * reason and the 401 is buried in the raw Pi log. That silently drains the
 * whole overnight queue with no visible cause.
 *
 * This module turns that into a legible, machine-readable signal so the
 * dispatcher can tag auth/credential failures distinctly (`failure:auth`) and
 * write the reason into the task's Munin result — instead of an opaque
 * `failed`. Pure and side-effect-free so it can be unit-tested without the SDK.
 */

/** Distinct status tag applied to a task that failed to authenticate. */
export const AUTH_FAILURE_TAG = "failure:auth";

/** Machine-readable failure kind rendered into the result document. */
export const AUTH_FAILURE_KIND = "AUTH_FAILED";

export interface FailureClassification {
  /** Failure kind, e.g. `AUTH_FAILED`. Rendered as `- **Failure kind:** …`. */
  kind: string;
  /** Distinct status tag, e.g. `failure:auth`. */
  tag: string;
  /** Human-readable one-line reason for the structured result / status. */
  reason: string;
}

// Patterns that, in the captured output of a Claude SDK run, uniquely indicate
// an authentication/credential failure rather than a task-logic error. Kept
// deliberately narrow (Codex review, #129): each is a full API-error envelope
// or a structured Anthropic error body — NOT a bare token like "401",
// "authentication_error", or `apiKeySource:"none"`, which a failed task could
// legitimately print (e.g. a task testing auth, or output quoting an error).
// A real runtime auth failure always surfaces one of these anchored shapes.
const AUTH_FAILURE_PATTERNS: RegExp[] = [
  // The SDK renders a bad credential as `API Error: 401` / `status 401`.
  /\bAPI Error:\s*401\b/i,
  /\bstatus(?:\s*code)?[:\s]+401\b/i,
  // The SDK's exact combined phrasing on an auth failure.
  /Failed to authenticate\.\s*API Error:\s*401\b/i,
  // The structured Anthropic error body returned for a bad credential:
  // `"type":"authentication_error"` as a JSON field (not a bare mention).
  /"type"\s*:\s*"authentication_error"/i,
];

/**
 * Classify a failed Claude SDK task's captured output.
 *
 * Returns an {@link FailureClassification} when the output bears the signature
 * of an authentication/credential failure (401, `authentication_error`,
 * `apiKeySource: none`, …); otherwise `null` (a generic failure the caller
 * should surface as before).
 *
 * The caller is responsible for only invoking this on an actual failure
 * (non-zero, non-timeout, non-cancelled) — a successful run whose text happens
 * to quote "401" is never passed in.
 */
export function classifyClaudeFailure(
  output: string | null | undefined,
): FailureClassification | null {
  if (!output) return null;
  if (!AUTH_FAILURE_PATTERNS.some((re) => re.test(output))) return null;
  return {
    kind: AUTH_FAILURE_KIND,
    tag: AUTH_FAILURE_TAG,
    reason:
      "Runtime failed to authenticate (HTTP 401 — expired or absent Pi Claude credential). " +
      "Refresh the Pi's Claude Code credential to unblock autonomous tasks.",
  };
}
