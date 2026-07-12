/**
 * Learning-loop health (issue #164) — pure computation.
 *
 * Two evidence planes, deliberately NOT collapsed into one verdict, because
 * they answer different questions:
 *
 *   1. **M5 capability evidence** — "can this execution cell do this task?"
 *      Authority: the M5 gateway's ledger. Hugin READS it; it never re-judges
 *      capability or keeps a competing capability store.
 *   2. **Hugin product evidence** — "was durable delegation actually useful
 *      enough to keep?" Authority: Hugin's own task corpus, ratings, and
 *      durable-handoff observations. This is what the #165 role-validation
 *      trial decides on, on 2026-08-22.
 *
 * The governing rule throughout is HONESTY ABOUT DENOMINATORS:
 *
 *   - No percentage without an `n`. A rate over zero verified samples is
 *     `null`, never `0` — "we haven't checked" and "it failed" are different
 *     facts, and conflating them is how a shadow lane starts looking healthy.
 *   - A metric with no data source reports `not-instrumented`, never a
 *     flattering zero. A gate criterion nobody measures must not silently read
 *     as satisfied.
 *   - Attempts that errored (infra) are excluded from quality rates; they are
 *     not evidence about the model.
 *
 * Content-blind: only counts, ids, and enums. No prompt or result text.
 */

import type { Ledger } from "./orchestrator/ledger-client.js";

/** How much can be concluded from a row's evidence. */
export type EvidenceMaturity =
  /** Has verified pass/fail samples — actionable. */
  | "verified"
  /** Calls happened but nothing was ever verified — NOT evidence of quality. */
  | "unverified"
  /** The route policy is observing but not enforcing. */
  | "shadow"
  /** Nothing attempted yet. */
  | "aspirational";

export interface CapabilityRow {
  taskType: string;
  modelId: string;
  attempts: number;
  passes: number;
  fails: number;
  errors: number;
  /** passes + fails. The denominator that a quality rate is honest about. */
  verifiedSamples: number;
  /** null when verifiedSamples === 0 — no percentage without n. */
  qualityRate: number | null;
  maturity: EvidenceMaturity;
  recommendation: string;
  frozen: boolean;
}

export interface CapabilityPlane {
  /** False when the ledger was unreachable — distinct from "no evidence". */
  available: boolean;
  rows: CapabilityRow[];
  totalAttempts: number;
  totalVerifiedSamples: number;
  /** Calls are reaching the cell at all. */
  evidenceArriving: boolean;
  /** At least one row has verified evidence strong enough to act on. */
  actionable: boolean;
}

export interface RoutePolicy {
  policyMode: string | null;
  policyAction: string | null;
  priceCatalogVersion: string | null;
  /** True only when the policy ENFORCES a route AND verified evidence backs it. */
  evidenceDrivenRouteChange: boolean;
  explanation: string;
}

export type TrialCriterionState = "met" | "not-met" | "not-instrumented";

export interface TrialCriterion {
  id: string;
  label: string;
  /** null ⇒ not instrumented. Never a stand-in zero. */
  observed: number | null;
  target: number;
  unit: string;
  state: TrialCriterionState;
  note?: string;
}

export interface ProductPlane {
  substantiveTasks: number;
  producers: string[];
  ratedTasks: number;
  usefulTasks: number;
  /** null when ratedTasks === 0 — unrated is not the same as unuseful. */
  usefulRate: number | null;
  durableHandoffs: number;
  rescueRedo: number;
  criteria: TrialCriterion[];
}

/** One broker task's product evidence. Content-blind by construction. */
export interface ProductTaskEvidence {
  taskId: string;
  lifecycle: string;
  submitter: string | null;
  rating: "pass" | "partial" | "redo" | "wrong" | null;
  verificationOutcome: string | null;
  /** A LATER session collected the terminal result (src/broker/await-observation.ts). */
  durableHandoff: boolean;
  delegation?: {
    policyMode?: string;
    policyAction?: string;
    priceCatalogVersion?: string;
  };
}

/** Heimdall's typed-panel kinds — rendered with zero Heimdall code. */
export interface TypedPanel {
  id: string;
  label: string;
  kind: "stat" | "timeseries" | "table" | "status";
  fullWidth?: boolean;
  refresh?: number;
  [key: string]: unknown;
}

// --- #165 gate thresholds (from the issue, verbatim) ---
const GATE_SUBSTANTIVE_TASKS = 10;
const GATE_PRODUCERS = 2;
const GATE_USEFUL_RATE = 0.7;
const GATE_DURABLE_HANDOFFS = 5;

/** The live ledger carries ~100 rows; a dashboard table needs a ranked subset. */
const MAX_CAPABILITY_ROWS = 15;

export function computeCapabilityPlane(ledger: Ledger | null): CapabilityPlane {
  if (!ledger) {
    // Unreachable ledger is NOT "zero evidence" — say so, don't render a zero.
    return {
      available: false,
      rows: [],
      totalAttempts: 0,
      totalVerifiedSamples: 0,
      evidenceArriving: false,
      actionable: false,
    };
  }

  const rows: CapabilityRow[] = ledger.report.map((r) => {
    const passes = r.passes ?? 0;
    const fails = r.fails ?? 0;
    const attempts = r.attempts ?? 0;
    const verifiedSamples = passes + fails;

    return {
      taskType: r.taskType,
      modelId: r.modelId,
      attempts,
      passes,
      fails,
      errors: r.errors ?? 0,
      verifiedSamples,
      // Errors are infra, not model quality — excluded from the denominator.
      qualityRate: verifiedSamples > 0 ? passes / verifiedSamples : null,
      maturity:
        attempts === 0 ? "aspirational" : verifiedSamples > 0 ? "verified" : "unverified",
      recommendation: r.recommendation,
      frozen: r.frozen ?? false,
    };
  });

  const totalAttempts = rows.reduce((n, r) => n + r.attempts, 0);
  const totalVerifiedSamples = rows.reduce((n, r) => n + r.verifiedSamples, 0);

  return {
    available: true,
    rows,
    totalAttempts,
    totalVerifiedSamples,
    evidenceArriving: totalAttempts > 0,
    actionable: totalVerifiedSamples > 0,
  };
}

/**
 * Derive the observed route policy from the M5 provenance Hugin now stores on
 * its task results (#163) plus the capability plane.
 *
 * An "evidence-driven route change" is claimed ONLY when the gateway policy is
 * actually enforcing a route AND there is verified evidence behind it. A policy
 * in `shadow` — the current production state — is reported as exactly that:
 * routing is still shadow/manual, and no route has yet changed because of
 * evidence. #164 asks for one or the other, honestly.
 */
export function deriveRoutePolicy(
  tasks: ProductTaskEvidence[],
  capability: CapabilityPlane
): RoutePolicy {
  // Most recent task carrying delegation provenance wins.
  const withProvenance = tasks.filter((t) => t.delegation?.policyMode);
  const latest = withProvenance[withProvenance.length - 1]?.delegation;

  const policyMode = latest?.policyMode ?? null;
  const policyAction = latest?.policyAction ?? null;
  const priceCatalogVersion = latest?.priceCatalogVersion ?? null;

  if (!policyMode) {
    return {
      policyMode: null,
      policyAction: null,
      priceCatalogVersion,
      evidenceDrivenRouteChange: false,
      explanation:
        "No route-policy provenance recorded yet — no M5-delegated task has stored a policy mode.",
    };
  }

  const isShadow = policyMode === "shadow";
  const backedByVerifiedEvidence = capability.actionable;
  const evidenceDrivenRouteChange = !isShadow && backedByVerifiedEvidence;

  let explanation: string;
  if (isShadow) {
    explanation =
      `Routing is still shadow/manual: the M5 delegate policy is in "${policyMode}" mode, ` +
      `so it observes and records evidence but does not change any route. ` +
      `No route change has been caused by verified evidence.`;
  } else if (evidenceDrivenRouteChange) {
    explanation =
      `Route policy "${policyMode}" is enforcing action "${policyAction}" ` +
      `backed by ${capability.totalVerifiedSamples} verified sample(s).`;
  } else {
    explanation =
      `Route policy "${policyMode}" reports action "${policyAction}", but no verified ` +
      `evidence backs it yet — treat the route as manual, not evidence-driven.`;
  }

  return {
    policyMode,
    policyAction,
    priceCatalogVersion,
    evidenceDrivenRouteChange,
    explanation,
  };
}

function gateState(observed: number | null, target: number): TrialCriterionState {
  if (observed === null) return "not-instrumented";
  return observed >= target ? "met" : "not-met";
}

export function computeProductPlane(tasks: ProductTaskEvidence[]): ProductPlane {
  const substantiveTasks = tasks.length;

  const producers = [
    ...new Set(tasks.map((t) => t.submitter).filter((s): s is string => !!s)),
  ].sort();

  const rated = tasks.filter((t) => t.rating !== null);
  const ratedTasks = rated.length;
  const usefulTasks = rated.filter((t) => t.rating === "pass" || t.rating === "partial").length;
  const rescueRedo = rated.filter((t) => t.rating === "redo" || t.rating === "wrong").length;

  // Unrated is NOT unuseful. With no ratings there is no rate — say so.
  const usefulRate = ratedTasks > 0 ? usefulTasks / ratedTasks : null;

  const durableHandoffs = tasks.filter((t) => t.durableHandoff).length;

  const criteria: TrialCriterion[] = [
    {
      id: "substantive-tasks",
      label: "Substantive tasks",
      observed: substantiveTasks,
      target: GATE_SUBSTANTIVE_TASKS,
      unit: "tasks",
      state: gateState(substantiveTasks, GATE_SUBSTANTIVE_TASKS),
    },
    {
      id: "producers",
      label: "Independent producers",
      observed: producers.length,
      target: GATE_PRODUCERS,
      unit: "producers",
      state: gateState(producers.length, GATE_PRODUCERS),
    },
    {
      id: "useful-completion",
      label: "Useful completion (pass or useful partial)",
      // A rate over zero ratings is not 0% — it is unmeasured.
      observed: usefulRate === null ? null : Math.round(usefulRate * 100),
      target: Math.round(GATE_USEFUL_RATE * 100),
      unit: "%",
      state: usefulRate === null ? "not-instrumented" : gateState(Math.round(usefulRate * 100), 70),
      note:
        usefulRate === null
          ? "No task has been rated yet — rate delegated tasks with hugin_rate, or this gate cannot be judged."
          : `n=${ratedTasks} rated of ${substantiveTasks} tasks`,
    },
    {
      id: "durable-handoff",
      label: "Results collected after the initiating session ended",
      observed: durableHandoffs,
      target: GATE_DURABLE_HANDOFFS,
      unit: "tasks",
      state: gateState(durableHandoffs, GATE_DURABLE_HANDOFFS),
      note:
        "Conservative proxy: a terminal result collected by a DIFFERENT orchestrator " +
        "session than the one that submitted it. Under-counts rather than over-counts.",
    },
    {
      id: "rescue-redo",
      label: "Human rescue / redo (lower is better)",
      observed: rescueRedo,
      target: 0,
      unit: "tasks",
      // Not a pass/fail gate — a tracked cost. Reported, never scored.
      state: ratedTasks > 0 ? "met" : "not-instrumented",
      note: ratedTasks > 0 ? `n=${ratedTasks} rated` : "No ratings yet.",
    },
    {
      id: "maintenance-time",
      label: "Maintenance time during trial (<2h)",
      observed: null,
      target: 2,
      unit: "hours",
      state: "not-instrumented",
      note: "No maintenance-time tracking exists. Judge this manually at the 2026-08-22 decision.",
    },
    {
      id: "incidents",
      label: "Lost tasks / duplicate side effects / security failures",
      observed: null,
      target: 0,
      unit: "incidents",
      state: "not-instrumented",
      note:
        "No aggregate incident counter exists. Idempotency prevents duplicate submission, " +
        "but occurrences are not counted — judge manually.",
    },
  ];

  return {
    substantiveTasks,
    producers,
    ratedTasks,
    usefulTasks,
    usefulRate,
    durableHandoffs,
    rescueRedo,
    criteria,
  };
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/**
 * Render the two planes as Heimdall typed panels (`stat`/`table`/`status`).
 *
 * Typed panels carry DATA, never HTML, and Heimdall renders them with zero
 * per-panel code — so this whole surface is a Hugin-only change, with no
 * cross-repo dependency on the heimdall repo.
 */
export function buildLearningLoopPanels(input: {
  capability: CapabilityPlane;
  product: ProductPlane;
  policy: RoutePolicy;
}): TypedPanel[] {
  const { capability, product, policy } = input;

  // The real ledger carries ~100 rows. Rank by how much evidence a row actually
  // has (verified samples, then attempts) and cap — but NEVER silently: a
  // truncated table that doesn't say so reads as "this is everything".
  const ranked = [...capability.rows].sort(
    (a, b) => b.verifiedSamples - a.verifiedSamples || b.attempts - a.attempts
  );
  const shown = ranked.slice(0, MAX_CAPABILITY_ROWS);
  const dropped = ranked.length - shown.length;

  const capabilityRows: string[][] = capability.available
    ? [
        ...shown.map((r) => [
          r.taskType,
          r.modelId,
          String(r.attempts),
          String(r.verifiedSamples),
          // No percentage without n.
          r.qualityRate === null ? "— (unverified)" : pct(r.qualityRate),
          r.maturity,
          r.recommendation,
        ]),
        ...(dropped > 0
          ? [[`… ${dropped} more row(s) with less evidence, not shown`, "", "", "", "", "", ""]]
          : []),
      ]
    : [
        [
          "M5 ledger unreachable — no capability evidence available (not the same as zero)",
          "", "", "", "", "", "",
        ],
      ];

  const capabilityPanel: TypedPanel = {
    id: "hugin-capability-evidence",
    label: "M5 capability evidence (can the cell do the task?)",
    kind: "table",
    fullWidth: true,
    refresh: 300,
    cols: ["Task type", "Model", "Attempts", "Verified n", "Quality", "Maturity", "M5 recommends"],
    rows: capabilityRows,
  };

  const gatePanel: TypedPanel = {
    id: "hugin-trial-gate",
    label: "Hugin product evidence — #165 trial gate (decides 2026-08-22)",
    kind: "table",
    fullWidth: true,
    refresh: 300,
    cols: ["Criterion", "Observed", "Target", "State"],
    rows: product.criteria.map((c) => [
      c.note ? `${c.label} — ${c.note}` : c.label,
      c.observed === null ? "not instrumented" : `${c.observed} ${c.unit}`.trim(),
      `${c.target} ${c.unit}`.trim(),
      c.state,
    ]),
  };

  const policyPanel: TypedPanel = {
    id: "hugin-route-policy",
    label: "Route policy",
    kind: "status",
    refresh: 300,
    state: policy.evidenceDrivenRouteChange ? "pass" : "warn",
    message:
      policy.explanation +
      (policy.priceCatalogVersion ? ` (price catalog ${policy.priceCatalogVersion})` : ""),
  };

  const handoffPanel: TypedPanel = {
    id: "hugin-durable-handoffs",
    label: `Durable handoffs (target ${GATE_DURABLE_HANDOFFS})`,
    kind: "stat",
    refresh: 300,
    value: product.durableHandoffs,
  };

  return [capabilityPanel, gatePanel, policyPanel, handoffPanel];
}
