/**
 * Shared M5 `/delegate` execution provenance (issue #163).
 *
 * Hugin makes M5 `/delegate` calls from two independent places — the direct
 * homeserver executor (`src/homeserver-executor.ts`, which backs the canonical
 * #167 MCP-Broker leaf) and the orchestrator's worker fan-out
 * (`src/orchestrator/worker-executor.ts`). Both used to parse the gateway
 * response ad hoc, with different and incomplete field sets, and the
 * orchestrator path then dropped what it did parse before the durable result.
 *
 * This module is the single place that turns a raw gateway response into the
 * provenance Hugin stores. Two invariants:
 *
 *  1. **The gateway response is untrusted input.** Everything is validated for
 *     type, enum membership, and bounds; anything out of contract is DROPPED,
 *     never coerced and never thrown. A malformed field must not be able to
 *     sink the `result-structured` write of an otherwise successful, paid run
 *     (`buildStructuredTaskResult` calls `.parse()`, which throws) or bloat the
 *     Munin doc.
 *  2. **Hugin never re-judges capability.** These fields are copied for
 *     traceability only. M5 remains the sole capability-evidence authority;
 *     `ledgerId` is the join key back to its authoritative row.
 */

/** Outcome values the M5 gateway is contracted to emit. */
export const M5_OUTCOMES = ["pass", "partial", "fail", "error", "unverified"] as const;
export type M5Outcome = (typeof M5_OUTCOMES)[number];

/** Bounds for free-text gateway strings copied into the durable result. */
const MAX_ID_CHARS = 200;
const MAX_REASON_CHARS = 1000;

export interface M5DelegationProvenance {
  /** Join key to the authoritative M5 ledger row. */
  ledgerId?: string;
  /** Node that actually executed the leaf (e.g. "m5", "orin"). */
  nodeId?: string;
  /** Model that actually executed the leaf — may differ from the one requested. */
  modelId?: string;
  /** Ledger bucket the gateway filed this call under. */
  taskType?: string;
  /** M5's verification outcome. Distinct from Hugin's own `ok`. */
  outcome?: M5Outcome;
  /** M5's verification score. Absent (not 0) when the gateway sends null. */
  score?: number;
  /** Why the gateway routed/delegated/escalated the way it did. */
  decisionReason?: string;
  /** Identity of the deterministic verifier that judged this call, if any. */
  verifier?: string;
  /** Free-text notes from that verifier. */
  verifierNotes?: string;
  /** Whether the gateway delegated to a local model. */
  delegated?: boolean;
  /** Whether the gateway escalated to a frontier model. */
  escalated?: boolean;
  /** Whether the gateway retried to satisfy a response-format contract. */
  formatRetried?: boolean;
  /** Route-policy version: the delegate policy's mode (e.g. "shadow", "enforce"). */
  policyMode?: string;
  /** Route-policy version: the action the policy actually took. */
  policyAction?: string;
  /** Route-policy version: why the policy took that action. */
  policyReason?: string;
  /** Price-catalog version the gateway costed this call against. */
  priceCatalogVersion?: string;
  /** The gateway's cost-trace row id, for joins that need the cost view. */
  costTraceId?: string;
}

/**
 * Provider-reported token counts are only trusted as nonnegative integers;
 * anything else (fractional estimates, negatives, NaN, non-numbers) → null.
 * Shared by both M5 call sites so the same contract holds on each.
 */
export function sanitizeProviderTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (trimmed.length === 0) return undefined; // never emit a schema-invalid min(1) value
  return trimmed.slice(0, max);
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function outcome(v: unknown): M5Outcome | undefined {
  return typeof v === "string" && (M5_OUTCOMES as readonly string[]).includes(v)
    ? (v as M5Outcome)
    : undefined;
}

/**
 * Extract M5 execution provenance from a raw `/delegate` response.
 *
 * Total and non-throwing: junk in yields `{}`, never an exception. Every key is
 * omitted rather than set to null/undefined so the result spreads cleanly into
 * an exactOptionalPropertyTypes-style object literal.
 */
export function extractM5Provenance(raw: unknown): M5DelegationProvenance {
  const r = obj(raw);
  if (!r) return {};

  const policy = obj(r["delegatePolicy"]) ?? {};
  const evidence = obj(policy["evidence"]) ?? {};
  const costTrace = obj(r["costTrace"]) ?? {};

  // `ledgerId` is the join key; the cost trace echoes it as `delegationId`.
  // Prefer the top-level field and fall back, so a response that only carries
  // the cost view is still joinable.
  const ledgerId =
    str(r["ledgerId"], MAX_ID_CHARS) ?? str(costTrace["delegationId"], MAX_ID_CHARS);

  const p: M5DelegationProvenance = {};
  if (ledgerId !== undefined) p.ledgerId = ledgerId;

  const nodeId = str(r["nodeId"], MAX_ID_CHARS);
  if (nodeId !== undefined) p.nodeId = nodeId;

  const modelId = str(r["modelId"], MAX_ID_CHARS);
  if (modelId !== undefined) p.modelId = modelId;

  const taskType = str(r["taskType"], MAX_ID_CHARS);
  if (taskType !== undefined) p.taskType = taskType;

  const oc = outcome(r["outcome"]);
  if (oc !== undefined) p.outcome = oc;

  const score = num(r["score"]);
  if (score !== undefined) p.score = score;

  const decisionReason = str(r["decisionReason"], MAX_REASON_CHARS);
  if (decisionReason !== undefined) p.decisionReason = decisionReason;

  const verifier = str(evidence["verifier"], MAX_ID_CHARS);
  if (verifier !== undefined) p.verifier = verifier;

  const verifierNotes = str(r["verifierNotes"], MAX_REASON_CHARS);
  if (verifierNotes !== undefined) p.verifierNotes = verifierNotes;

  const delegated = bool(r["delegated"]);
  if (delegated !== undefined) p.delegated = delegated;

  // The gateway calls it `escalate`; Hugin's durable field is `escalated`.
  const escalated = bool(r["escalate"]);
  if (escalated !== undefined) p.escalated = escalated;

  const formatRetried = bool(r["formatRetried"]);
  if (formatRetried !== undefined) p.formatRetried = formatRetried;

  const policyMode = str(policy["mode"], MAX_ID_CHARS);
  if (policyMode !== undefined) p.policyMode = policyMode;

  const policyAction = str(policy["action"], MAX_ID_CHARS);
  if (policyAction !== undefined) p.policyAction = policyAction;

  const policyReason = str(policy["reason"], MAX_REASON_CHARS);
  if (policyReason !== undefined) p.policyReason = policyReason;

  const priceCatalogVersion = str(costTrace["priceCatalogVersion"], MAX_ID_CHARS);
  if (priceCatalogVersion !== undefined) p.priceCatalogVersion = priceCatalogVersion;

  const costTraceId = str(costTrace["id"], MAX_ID_CHARS);
  if (costTraceId !== undefined) p.costTraceId = costTraceId;

  return p;
}
