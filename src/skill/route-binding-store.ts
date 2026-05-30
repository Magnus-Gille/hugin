/**
 * route-binding-store.ts
 *
 * Pure + effectful operations over RouteBinding records:
 *   - transition()           — pure lifecycle enforcement
 *   - isSelectable()         — fail-closed selectability predicate
 *   - loadActiveBinding()    — Munin query + parse
 *   - recordValidationRun()  — write-once ValidationRun guard
 *   - demoteOnDrift()        — stale demotion with CAS write
 *
 * All effectful functions accept a MuninClient to keep them testable without
 * a live Munin server. The pure functions depend on nothing outside this module
 * and refs.ts.
 */

import type { MuninClient } from "../munin-client.js";
import {
  tupleHashesMatch,
  type TupleRef,
  type LifecycleState,
  type Sensitivity,
} from "./refs.js";
import {
  routeBindingSchema,
  validationRunSchema,
  type RouteBinding,
  type ValidationRun,
} from "./route-binding-schema.js";

// ---------------------------------------------------------------------------
// Sensitivity ordering — needed for `isSelectable` ceiling check.
// Re-use compareSensitivity from sensitivity.ts via an inline ordering that
// mirrors the canonical lattice (public < internal < private).
// ---------------------------------------------------------------------------
const SENSITIVITY_ORDER: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  private: 2,
};

function sensitivityGte(ceiling: Sensitivity, task: Sensitivity): boolean {
  return SENSITIVITY_ORDER[ceiling] >= SENSITIVITY_ORDER[task];
}

// ---------------------------------------------------------------------------
// Lifecycle graph
// ---------------------------------------------------------------------------
// Allowed directed edges in the lifecycle DAG.
// Re-promotion from stale/quarantined is conditional (requires new runHash) —
// enforced separately in transition().
const ALLOWED_TRANSITIONS: Map<LifecycleState, ReadonlySet<LifecycleState>> =
  new Map([
    ["draft",       new Set<LifecycleState>(["candidate", "disabled"])],
    ["candidate",   new Set<LifecycleState>(["shadow", "disabled"])],
    ["shadow",      new Set<LifecycleState>(["active", "quarantined", "disabled"])],
    ["active",      new Set<LifecycleState>(["stale", "quarantined", "disabled"])],
    ["stale",       new Set<LifecycleState>(["candidate", "shadow", "active", "disabled"])],
    ["quarantined", new Set<LifecycleState>(["candidate", "shadow", "active", "disabled"])],
    ["disabled",    new Set<LifecycleState>()],     // terminal — no further transitions
  ]);

// States that require a NEW ValidationRun hash to re-promote.
const REQUIRES_NEW_RUN_ON_REPROMOTION: ReadonlySet<LifecycleState> = new Set([
  "stale",
  "quarantined",
]);

// States that count as "promotion" (moving toward active).
const PROMOTION_TARGETS: ReadonlySet<LifecycleState> = new Set([
  "candidate",
  "shadow",
  "active",
]);

// ---------------------------------------------------------------------------
// Pure: transition()
// ---------------------------------------------------------------------------
/**
 * Produce an updated RouteBinding with `state = to` (and `updatedAt` stamped
 * to now). Throws if the transition is not in the allowed lifecycle graph, or
 * if re-promotion from stale/quarantined is attempted without a new `runHash`
 * in `evidence` that differs from the binding's current `activeValidationRunHash`.
 *
 * The caller is responsible for persisting the returned binding to Munin.
 */
export function transition(
  b: RouteBinding,
  to: LifecycleState,
  evidence?: { runHash: string },
): RouteBinding {
  const allowed = ALLOWED_TRANSITIONS.get(b.state);
  if (!allowed || !allowed.has(to)) {
    throw new Error(
      `Illegal lifecycle transition: ${b.state} → ${to} for binding ${b.bindingId}`,
    );
  }

  // Re-promotion from stale or quarantined requires a new immutable ValidationRun.
  if (
    REQUIRES_NEW_RUN_ON_REPROMOTION.has(b.state) &&
    PROMOTION_TARGETS.has(to)
  ) {
    if (!evidence?.runHash) {
      throw new Error(
        `Re-promotion from "${b.state}" to "${to}" requires a new ValidationRun ` +
          `(evidence.runHash missing) for binding ${b.bindingId}`,
      );
    }
    if (evidence.runHash === b.activeValidationRunHash) {
      throw new Error(
        `Re-promotion from "${b.state}" to "${to}" requires a NEW ValidationRun ` +
          `hash distinct from the current one (${evidence.runHash}) ` +
          `for binding ${b.bindingId}`,
      );
    }
  }

  return {
    ...b,
    state: to,
    activeValidationRunHash: evidence?.runHash ?? b.activeValidationRunHash,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pure: isSelectable()
// ---------------------------------------------------------------------------
/**
 * Fail-closed selectability check. Returns `{ ok: true }` only when:
 *   1. The binding is in `active` state.
 *   2. The binding's pinned tuple hashes match `currentHashes` (no drift).
 *   3. The binding's `effectiveSensitivityCeiling >= taskSens`.
 *
 * Each failure produces a distinct `reason` string so the caller can log and
 * act appropriately (e.g. trigger demoteOnDrift for hash-drift).
 */
export function isSelectable(
  b: RouteBinding,
  currentHashes: TupleRef,
  taskSens: Sensitivity,
): { ok: boolean; reason?: string } {
  if (b.state !== "active") {
    return { ok: false, reason: "not-active" };
  }
  if (!tupleHashesMatch(b.tuple, currentHashes)) {
    return { ok: false, reason: "hash-drift" };
  }
  if (!sensitivityGte(b.effectiveSensitivityCeiling, taskSens)) {
    return { ok: false, reason: "sensitivity-ceiling" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Effectful: loadActiveBinding()
// ---------------------------------------------------------------------------
/**
 * Query Munin's `routes/` namespace for an active binding whose `taskClassId`
 * matches. Returns the first valid `RouteBinding` found, or `null` if none.
 *
 * Uses Munin tag filtering (`route-state:active`, `task-class:<id>`) to keep
 * the candidate set small. Silently skips entries that fail Zod parse (stale
 * Munin data should not crash the router).
 */
export async function loadActiveBinding(
  taskClassId: string,
  munin: MuninClient,
): Promise<RouteBinding | null> {
  const { results } = await munin.query({
    query: taskClassId,
    namespace: "routes",
    tags: ["route-state:active", `task-class:${taskClassId}`],
    limit: 10,
  });

  for (const result of results) {
    // Each binding is stored at routes/<bindingId>/binding under key "binding".
    // Skip validation-run records and any other keys in the namespace.
    if (!result.key || result.key !== "binding") continue;

    const [ns, key] = [result.namespace, result.key] as [string, string];
    const entry = await munin.read(ns, key);
    if (!entry) continue;

    const parsed = routeBindingSchema.safeParse(
      safeParseJSON(entry.content),
    );
    if (!parsed.success) {
      // Log the validation error but don't crash — stale schema rows should
      // not take down the router's normal path.
      console.warn(
        `[route-binding-store] Skipping unparseable binding at ${ns}/${key}:`,
        parsed.error.message,
      );
      continue;
    }

    const binding = parsed.data;
    if (binding.state !== "active") continue;
    if (binding.tuple.taskClassId !== taskClassId) continue;

    return binding;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Effectful: recordValidationRun()
// ---------------------------------------------------------------------------
/**
 * Write-once: persist a ValidationRun to Munin at
 * `routes/<bindingId>/validation-run/<runHash>`.
 *
 * Reads the target key first. If an entry already exists, throws — ValidationRuns
 * are immutable by design and must never be overwritten. This ensures the
 * content-addressed provenance chain cannot be silently corrupted.
 */
export async function recordValidationRun(
  run: ValidationRun,
  munin: MuninClient,
): Promise<void> {
  const ns = `routes/${run.bindingId}`;
  const key = `validation-run/${run.runHash}`;

  const existing = await munin.read(ns, key);
  if (existing) {
    throw new Error(
      `ValidationRun ${run.runHash} already exists for binding ${run.bindingId} — ` +
        `ValidationRuns are immutable and must never be overwritten.`,
    );
  }

  await munin.write(
    ns,
    key,
    JSON.stringify(run),
    [
      "validation-run",
      `binding-id:${run.bindingId}`,
      `run-hash:${run.runHash}`,
      `task-class:${run.tuple.taskClassId}`,
    ],
  );
}

// ---------------------------------------------------------------------------
// Effectful: demoteOnDrift()
// ---------------------------------------------------------------------------
/**
 * Transition a binding to `stale` (hash-drift fail-close) and persist it to
 * Munin using CAS semantics (expected_updated_at = binding.updatedAt) to
 * prevent concurrent overwrites.
 *
 * Returns the updated (stale) binding so the caller can log / fall through
 * to cloud routing.
 */
export async function demoteOnDrift(
  b: RouteBinding,
  munin: MuninClient,
): Promise<RouteBinding> {
  const demoted = transition(b, "stale");

  const ns = `routes/${b.bindingId}`;
  const key = "binding";

  await munin.write(
    ns,
    key,
    JSON.stringify(demoted),
    [
      "route-state:stale",
      `task-class:${demoted.tuple.taskClassId}`,
      `binding-id:${demoted.bindingId}`,
    ],
    // CAS: only write if the entry hasn't changed since we last read it.
    b.updatedAt,
  );

  return demoted;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeParseJSON(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}
