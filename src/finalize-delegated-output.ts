/**
 * Shared finalization helper for orchestrator delegation output.
 *
 * Every byte of provider output that crosses the broker → MCP → Claude boundary
 * passes through this helper. It runs the exfiltration scanner, packages the
 * result with provenance metadata, and is the single place where raw provider
 * bytes are converted into a typed DelegationResult.
 *
 * Outcome contract (post orch-v1-impl-review):
 * - Text path: redact policy is allowed to mutate `output` and return success
 *   with `scanner_pass: "redact"`. A redacted human-readable string is still
 *   useful to the caller.
 * - Diff path: redact policy escalates to a `scanner_blocked` error outcome.
 *   A redacted unified diff is no longer a valid patch (`git apply` fails on
 *   the replaced span), so the caller must not see a "completed" status with
 *   a corrupted diff. The default `warn` policy still returns success with the
 *   raw diff intact, regardless of result_kind.
 *
 * See docs/orchestrator-v1-data-model.md §4 (result schema), §5 (scanner pass),
 * §7 (provenance chain). See docs/security/exfiltration-scanner.md for the
 * scanner policy semantics.
 */

import {
  redactExfiltration,
  scanForExfiltration,
  type ExfilScanResult,
} from "./exfiltration-scanner.js";
import type { Alias } from "./runtime-registry.js";

export type DelegationRuntimeEffective = "ollama" | "openrouter" | "pi-harness";
export type DelegationHostEffective = "pi" | "mba" | "openrouter";
export type DelegationResultKind = "text" | "diff";
export type ScannerPass = "clean" | "warn" | "redact";

export interface DelegationDiff {
  base_sha: string;
  head_sha: string;
  files_touched: string[];
  unified_diff: string;
  stats: { files: number; insertions: number; deletions: number };
  worktree_path: string;
}

export interface DelegationProvenance {
  source: "delegated";
  scanner_pass: ScannerPass;
  policy_version: string;
  harness_version?: string;
}

export interface DelegationResult {
  task_id: string;
  alias_requested: Alias;
  model_effective: string;
  runtime_effective: DelegationRuntimeEffective;
  host_effective: DelegationHostEffective;
  result_kind: DelegationResultKind;

  output?: string;
  diff?: DelegationDiff;

  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  duration_s: number;
  load_ms?: number;
  cost_usd: number;
  finalized_at: string;
  provenance: DelegationProvenance;
}

export type DelegationErrorKind =
  | "alias_unknown"
  | "alias_unavailable"
  | "policy_rejected"
  | "executor_failed"
  | "scanner_blocked"
  | "timeout"
  | "internal";

export interface DelegationError {
  task_id: string;
  kind: DelegationErrorKind;
  message: string;
  retryable: boolean;
}

export type FinalizeOutcome =
  | { ok: true; result: DelegationResult }
  | { ok: false; error: DelegationError };

export type ScannerPolicy = "warn" | "redact";

interface BaseInput {
  task_id: string;
  alias_requested: Alias;
  model_effective: string;
  runtime_effective: DelegationRuntimeEffective;
  host_effective: DelegationHostEffective;
  policy_version: string;
  harness_version?: string;
  scanner_policy?: ScannerPolicy;

  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  duration_s: number;
  load_ms?: number;
  cost_usd: number;
}

export interface FinalizeTextInput extends BaseInput {
  result_kind: "text";
  raw_output: string;
}

export interface FinalizeDiffInput extends BaseInput {
  result_kind: "diff";
  raw_diff: Omit<DelegationDiff, "unified_diff"> & { unified_diff: string };
}

export type FinalizeInput = FinalizeTextInput | FinalizeDiffInput;

/**
 * Single shared finalizer. Returns a `FinalizeOutcome` discriminated union.
 *
 * - Clean payloads → `{ ok: true, result }` with `scanner_pass: "clean"`.
 * - Matched payloads under `warn` policy → `{ ok: true, result }` with
 *   `scanner_pass: "warn"`; payload is unmodified.
 * - Text matched under `redact` policy → `{ ok: true, result }` with
 *   `scanner_pass: "redact"`; matched spans replaced.
 * - Diff matched under `redact` policy → `{ ok: false, error }` with
 *   `kind: "scanner_blocked"`. Redacted diffs are not valid patches.
 */
export function finalizeDelegatedOutput(input: FinalizeInput): FinalizeOutcome {
  const policy: ScannerPolicy = input.scanner_policy ?? "warn";

  const scannedPayload = scanPayload(input);

  if (
    input.result_kind === "diff" &&
    policy === "redact" &&
    scannedPayload.scan.severity !== "none"
  ) {
    return {
      ok: false,
      error: {
        task_id: input.task_id,
        kind: "scanner_blocked",
        message:
          "Exfiltration scanner matched the unified diff under redact policy. " +
          "A redacted diff is not a valid patch; the harness output must be " +
          "rejected rather than partially applied.",
        retryable: false,
      },
    };
  }

  const { scannerPass, finalizedPayload } = applyScannerPolicy(
    scannedPayload.text,
    scannedPayload.scan,
    policy,
  );

  const provenance: DelegationProvenance = {
    source: "delegated",
    scanner_pass: scannerPass,
    policy_version: input.policy_version,
  };
  if (input.harness_version) {
    provenance.harness_version = input.harness_version;
  }

  const base = {
    task_id: input.task_id,
    alias_requested: input.alias_requested,
    model_effective: input.model_effective,
    runtime_effective: input.runtime_effective,
    host_effective: input.host_effective,
    result_kind: input.result_kind,
    prompt_tokens: input.prompt_tokens,
    completion_tokens: input.completion_tokens,
    total_tokens: input.total_tokens,
    duration_s: input.duration_s,
    load_ms: input.load_ms,
    cost_usd: input.cost_usd,
    finalized_at: new Date().toISOString(),
    provenance,
  } satisfies Omit<DelegationResult, "output" | "diff">;

  if (input.result_kind === "text") {
    return { ok: true, result: { ...base, output: finalizedPayload } };
  }
  return {
    ok: true,
    result: {
      ...base,
      diff: { ...input.raw_diff, unified_diff: finalizedPayload },
    },
  };
}

interface ScannedPayload {
  text: string;
  scan: ExfilScanResult;
}

function scanPayload(input: FinalizeInput): ScannedPayload {
  const text =
    input.result_kind === "text" ? input.raw_output : input.raw_diff.unified_diff;
  const scan = scanForExfiltration(text);
  return { text, scan };
}

function applyScannerPolicy(
  text: string,
  scan: ExfilScanResult,
  policy: ScannerPolicy,
): { scannerPass: ScannerPass; finalizedPayload: string } {
  if (scan.severity === "none") {
    return { scannerPass: "clean", finalizedPayload: text };
  }
  if (policy === "redact") {
    return {
      scannerPass: "redact",
      finalizedPayload: redactExfiltration(text, scan),
    };
  }
  return { scannerPass: "warn", finalizedPayload: text };
}
