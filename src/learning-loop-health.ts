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
import type { LearningExperimentState } from "./learning/experiment-schema.js";

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

export type TrialCriterionState =
  | "met"
  | "not-met"
  | "not-instrumented"
  /** Tracked as a cost, not scored against a threshold (e.g. rescue/redo). */
  | "informational";

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

/** Whether the corpus behind the product plane was actually readable. */
export interface ProductSource {
  /** False when the task corpus could not be read at all — unmeasured, not zero. */
  available: boolean;
  /** Per-task reads that failed: counts below are then a lower bound. */
  readFailures?: number;
  /** The corpus walk hit its cap: counts below are then a lower bound. */
  truncated?: boolean;
}

export interface ProductPlane {
  /** False ⇒ every count here is unmeasured. Never render them as zeroes. */
  available: boolean;
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
  /** A different MCP process collected the completed result. A PROXY — see the panel note. */
  durableHandoff: boolean;
  /** For deterministic ordering of "most recent". */
  updatedAt?: string;
  delegation?: {
    policyMode?: string;
    policyAction?: string;
    priceCatalogVersion?: string;
    /** Needed to tie a route claim to the ledger row that backs it. */
    modelId?: string;
    taskType?: string;
  };
}

/**
 * Heimdall's typed-panel kinds — rendered with zero Heimdall code.
 *
 * `rows` MUST be an array of plain OBJECTS keyed by column name. Heimdall's
 * normalizer (`src/contract/panel-data.js`, `isObj` = not-null, object, and
 * NOT an array) silently FILTERS OUT array rows — a `string[][]` table renders
 * completely empty on the dashboard while every local test still passes. Found
 * by cross-checking the consumer contract, not by typechecking.
 */
export type TableRow = Record<string, string>;

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

/**
 * A useful-completion rate is only meaningful over a decent slice of the corpus.
 * Below this, the gate reports "not instrumented" rather than a rate inferred
 * from a self-selected handful of ratings.
 */
const MIN_RATING_COVERAGE = 0.5;

/** The live ledger carries ~100 rows; a dashboard table needs a ranked subset. */
const MAX_CAPABILITY_ROWS = 15;

/** Delegate-policy modes that actually change a route (vs merely observing). */
const ENFORCING_POLICY_MODES: ReadonlySet<string> = new Set(["enforce", "enforcing", "active"]);

/** A trustworthy count: a nonnegative safe integer, or null. */
function countOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

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

  const rows: CapabilityRow[] = [];
  for (const r of ledger.report) {
    // The ledger is another service's output — validate its numeric invariants
    // rather than trusting them. A malformed row (attempts:0 but passes:1, or a
    // fractional/negative count) would otherwise render as confident positive
    // evidence — a false 100% quality rate is worse than no row at all.
    const passes = countOrNull(r.passes);
    const fails = countOrNull(r.fails);
    const attempts = countOrNull(r.attempts);
    const errors = countOrNull(r.errors);
    if (passes === null || fails === null || attempts === null || errors === null) continue;

    const verifiedSamples = passes + fails;
    // Verified outcomes cannot exceed attempts, and attempts must cover errors.
    if (verifiedSamples > attempts || errors > attempts) continue;

    rows.push({
      taskType: r.taskType,
      modelId: r.modelId,
      attempts,
      passes,
      fails,
      errors,
      verifiedSamples,
      // Errors are infra, not model quality — excluded from the denominator.
      qualityRate: verifiedSamples > 0 ? passes / verifiedSamples : null,
      maturity:
        attempts === 0 ? "aspirational" : verifiedSamples > 0 ? "verified" : "unverified",
      recommendation: r.recommendation,
      frozen: r.frozen ?? false,
    });
  }

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
  // Deterministic "most recent": explicitly by recorded time, not by the
  // arbitrary order of a union of two Munin queries.
  const withProvenance = tasks
    .filter((t) => t.delegation?.policyMode)
    .sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
  const latestTask = withProvenance[withProvenance.length - 1];
  const latest = latestTask?.delegation;

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

  const isEnforcing = ENFORCING_POLICY_MODES.has(policyMode);

  // A route change is "evidence-driven" only if the evidence in question is the
  // evidence for THIS route. Any-verified-sample-anywhere would assert a causal
  // link that was never established — the whole point of the criterion is to show
  // that a specific route changed BECAUSE of specific verified evidence.
  const backingRow = ledgerRowFor(capability, latest?.modelId, latest?.taskType);
  const backedBySpecificEvidence =
    backingRow !== undefined && backingRow.verifiedSamples > 0;
  const evidenceDrivenRouteChange = isEnforcing && backedBySpecificEvidence;

  let explanation: string;
  if (!isEnforcing) {
    explanation =
      `Routing is still shadow/manual: the M5 delegate policy is in "${policyMode}" mode, ` +
      `so it observes and records evidence but does not change any route. ` +
      `No route change has been caused by verified evidence.`;
  } else if (evidenceDrivenRouteChange) {
    explanation =
      `Route policy "${policyMode}" is enforcing "${policyAction}" for ` +
      `${latest?.taskType}×${latest?.modelId}, backed by ${backingRow!.verifiedSamples} ` +
      `verified sample(s) for that exact pair (M5 recommends "${backingRow!.recommendation}").`;
  } else {
    explanation =
      `Route policy "${policyMode}" reports action "${policyAction}", but no verified ledger ` +
      `evidence for that specific model × task type backs it — treat the route as manual, ` +
      `not evidence-driven.`;
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

/** Find the ledger row backing a specific (model × task type) claim. */
function ledgerRowFor(
  capability: CapabilityPlane,
  modelId?: string,
  taskType?: string
): CapabilityRow | undefined {
  if (!modelId || !taskType) return undefined;
  return capability.rows.find((r) => r.modelId === modelId && r.taskType === taskType);
}

/**
 * A `partial` is only USEFUL if the human actually used it. `partial` +
 * `major_rewrite`/`discarded`/`escalated_to_claude` means the human had to
 * rescue it — counting that as "useful completion" would inflate the gate with
 * exactly the outcomes that prove the delegation didn't work.
 */
const USEFUL_PARTIAL_OUTCOMES: ReadonlySet<string> = new Set([
  "accepted_unchanged",
  "minor_edit",
]);

function isUseful(t: ProductTaskEvidence): boolean {
  if (t.rating === "pass") return true;
  if (t.rating !== "partial") return false;
  // An unlabelled partial cannot be assumed useful.
  return t.verificationOutcome !== null && USEFUL_PARTIAL_OUTCOMES.has(t.verificationOutcome);
}

function isRescue(t: ProductTaskEvidence): boolean {
  if (t.rating === "redo" || t.rating === "wrong") return true;
  return t.rating === "partial" && !isUseful(t);
}

/**
 * Compute the #165 product gate.
 *
 * `available` distinguishes "we measured, and it is zero" from "we could not
 * measure". They must never render the same: a failed Munin read that displays
 * as `0 tasks` would let a broken collector masquerade as a failing trial (or,
 * worse, an empty corpus masquerade as a measured one).
 */
export function computeProductPlane(
  tasks: ProductTaskEvidence[],
  source: ProductSource = { available: true }
): ProductPlane {
  // Only a COMPLETED task is a completed task. Pending/running/cancelled work
  // is not evidence that Hugin delivered anything.
  const completed = tasks.filter((t) => t.lifecycle === "completed");
  const substantiveTasks = completed.length;

  const producers = [
    ...new Set(completed.map((t) => t.submitter).filter((s): s is string => !!s)),
  ].sort();

  const rated = completed.filter((t) => t.rating !== null);
  const ratedTasks = rated.length;
  const usefulTasks = rated.filter(isUseful).length;
  const rescueRedo = rated.filter(isRescue).length;

  // Unrated is NOT unuseful. With no ratings there is no rate — say so.
  const usefulRate = ratedTasks > 0 ? usefulTasks / ratedTasks : null;
  const durableHandoffs = completed.filter((t) => t.durableHandoff).length;

  // A rate over a tiny slice of the corpus is not a rate for the corpus. Judging
  // "70% useful" from 1 rated task out of 10 would be a lie of selection.
  const coverage = substantiveTasks > 0 ? ratedTasks / substantiveTasks : 0;
  const sufficientCoverage = ratedTasks > 0 && coverage >= MIN_RATING_COVERAGE;

  // If the corpus itself could not be read, EVERY derived count is unmeasured.
  const unavailable = !source.available;
  const incomplete = source.truncated === true || (source.readFailures ?? 0) > 0;

  const measured = <T>(value: T): T | null => (unavailable ? null : value);
  const measuredState = (observed: number | null, target: number): TrialCriterionState =>
    unavailable ? "not-instrumented" : gateState(observed, target);

  const incompleteNote = incomplete
    ? ` (corpus incomplete: ${source.readFailures ?? 0} read failure(s)${
        source.truncated ? ", results truncated" : ""
      } — counts are a LOWER BOUND)`
    : "";
  const unavailableNote =
    "Task corpus could not be read — this is unmeasured, NOT zero.";

  const criteria: TrialCriterion[] = [
    {
      id: "substantive-tasks",
      label: "Completed broker tasks",
      observed: measured(substantiveTasks),
      target: GATE_SUBSTANTIVE_TASKS,
      unit: "tasks",
      state: measuredState(measured(substantiveTasks), GATE_SUBSTANTIVE_TASKS),
      note: unavailable ? unavailableNote : `Completed only${incompleteNote}`,
    },
    {
      id: "producers",
      label: "Independent producers",
      observed: measured(producers.length),
      target: GATE_PRODUCERS,
      unit: "producers",
      state: measuredState(measured(producers.length), GATE_PRODUCERS),
      note: unavailable
        ? unavailableNote
        : `Distinct submitting principals — an identity label, not a verified identity${incompleteNote}`,
    },
    {
      id: "useful-completion",
      label: "Useful completion (pass, or partial the human actually used)",
      observed: usefulRate === null || unavailable ? null : Math.round(usefulRate * 100),
      target: Math.round(GATE_USEFUL_RATE * 100),
      unit: "%",
      // Unrated, under-covered, or unreadable ⇒ unmeasured. Never a zero, and
      // never a "met" inferred from a flattering handful of ratings.
      state:
        unavailable || usefulRate === null || !sufficientCoverage
          ? "not-instrumented"
          : gateState(Math.round(usefulRate * 100), Math.round(GATE_USEFUL_RATE * 100)),
      note: unavailable
        ? unavailableNote
        : ratedTasks === 0
          ? "No completed task has been rated — rate them with hugin_rate or this gate cannot be judged."
          : !sufficientCoverage
            ? `Only ${ratedTasks} of ${substantiveTasks} completed tasks rated (${Math.round(
                coverage * 100
              )}% coverage; need ${Math.round(MIN_RATING_COVERAGE * 100)}%) — too few to judge the gate.`
            : `n=${ratedTasks} rated of ${substantiveTasks} completed${incompleteNote}`,
    },
    {
      id: "durable-handoff",
      label: "Results collected by a later MCP process",
      observed: measured(durableHandoffs),
      target: GATE_DURABLE_HANDOFFS,
      unit: "tasks",
      state: measuredState(measured(durableHandoffs), GATE_DURABLE_HANDOFFS),
      // Say exactly what this measures, and where it can be WRONG. #165 asks for
      // "completed after the initiating L1 session closed"; we cannot observe a
      // session closing, and the session id is client-asserted and minted per
      // MCP process — so an MCP restart inside a still-live session also trips
      // this. It is a proxy in both directions, not a measurement.
      note: unavailable
        ? unavailableNote
        : "PROXY: a completed result collected by a different orchestrator_session_id than " +
          "submitted it. Session closure is not observable; the id is client-asserted and " +
          "minted per MCP process, so an MCP restart within a live session also counts. " +
          "Corroborate before relying on this at the 2026-08-22 decision.",
    },
    {
      id: "rescue-redo",
      label: "Human rescue / redo (a cost, not a gate)",
      observed: measured(rescueRedo),
      target: 0,
      unit: "tasks",
      // Reported, never scored — a count with no threshold cannot be "met".
      state: unavailable || ratedTasks === 0 ? "not-instrumented" : "informational",
      note: unavailable
        ? unavailableNote
        : ratedTasks === 0
          ? "No ratings yet."
          : `n=${ratedTasks} rated; includes partials the human rewrote, discarded, or escalated`,
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
    available: source.available,
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
  experiments?: {
    available: boolean;
    states: LearningExperimentState[];
    truncated?: boolean;
  };
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

  const CAP_COLS = [
    "Task type", "Model", "Attempts", "Verified n", "Quality", "Maturity", "M5 recommends",
  ] as const;
  const emptyCapRow = Object.fromEntries(CAP_COLS.map((c) => [c, ""])) as TableRow;

  const capabilityRows: TableRow[] = capability.available
    ? [
        ...shown.map(
          (r): TableRow => ({
            "Task type": r.taskType,
            Model: r.modelId,
            Attempts: String(r.attempts),
            "Verified n": String(r.verifiedSamples),
            // No percentage without n.
            Quality: r.qualityRate === null ? "— (unverified)" : pct(r.qualityRate),
            Maturity: r.maturity,
            "M5 recommends": r.recommendation,
          })
        ),
        ...(dropped > 0
          ? [
              {
                ...emptyCapRow,
                "Task type": `… ${dropped} more row(s) with less evidence, not shown`,
              },
            ]
          : []),
      ]
    : [
        {
          ...emptyCapRow,
          "Task type":
            "M5 ledger unreachable — no capability evidence available (not the same as zero)",
        },
      ];

  const capabilityPanel: TypedPanel = {
    id: "hugin-capability-evidence",
    label: "M5 capability evidence (can the cell do the task?)",
    kind: "table",
    fullWidth: true,
    refresh: 300,
    cols: [...CAP_COLS],
    rows: capabilityRows,
  };

  const gatePanel: TypedPanel = {
    id: "hugin-trial-gate",
    label: "Hugin product evidence — #165 trial gate (decides 2026-08-22)",
    kind: "table",
    fullWidth: true,
    refresh: 300,
    cols: ["Criterion", "Observed", "Target", "State", "Note"],
    rows: product.criteria.map(
      (c): TableRow => ({
        Criterion: c.label,
        // An unmeasured criterion says so; it never renders as a zero.
        Observed: c.observed === null ? "not measured" : `${c.observed} ${c.unit}`.trim(),
        Target: `${c.target} ${c.unit}`.trim(),
        State: c.state,
        Note: c.note ?? "",
      })
    ),
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

  // A `0` here would read as "measured, and it's zero". When the corpus is
  // unreadable it is neither — show a dash, not a number.
  const handoffPanel: TypedPanel = {
    id: "hugin-durable-handoffs",
    label: `Results collected by a later MCP process (proxy; target ${GATE_DURABLE_HANDOFFS})`,
    kind: "stat",
    refresh: 300,
    value: product.available ? product.durableHandoffs : "—",
  };

  const experimentPanel: TypedPanel | null = input.experiments
    ? {
        id: "hugin-learning-experiments",
        label: "Continuous improvement experiments",
        kind: "table",
        fullWidth: true,
        refresh: 300,
        cols: ["Experiment", "Scope", "Axis", "State", "Matched", "Primary", "Next"],
        rows: input.experiments.available
          ? input.experiments.states.length > 0
            ? [
                ...input.experiments.states.slice(0, 15).map(
                  (state): TableRow => ({
                    Experiment: state.experimentId,
                    Scope: `${state.taskType} / ${state.scope}`,
                    Axis: state.changeAxis,
                    State: state.status,
                    Matched: `${state.evaluation.matchedPairs} (${state.evaluation.holdoutPairs} holdout)`,
                    Primary:
                      state.evaluation.primaryImprovement === null
                        ? `${state.evaluation.primaryMetric}: not measured`
                        : `${state.evaluation.primaryMetric}: ${Math.round(
                            state.evaluation.primaryImprovement * 1_000,
                          ) / 10}% normalized improvement`,
                    Next: state.evaluation.nextAction,
                  }),
                ),
                ...(input.experiments.truncated || input.experiments.states.length > 15
                  ? [{
                      Experiment: "… more experiments not shown",
                      Scope: "",
                      Axis: "",
                      State: "",
                      Matched: "",
                      Primary: "",
                      Next: input.experiments.truncated
                        ? "Munin query reached its cap; this table is incomplete."
                        : `${input.experiments.states.length - 15} lower-ranked row(s) omitted.`,
                    }]
                  : []),
              ]
            : [{
                Experiment: "No versioned experiment recorded yet",
                Scope: "",
                Axis: "",
                State: "gathering",
                Matched: "0",
                Primary: "not measured",
                Next: "Create the first matched champion/challenger experiment through hugin-mcp.",
              }]
          : [{
              Experiment: "Experiment ledger unavailable",
              Scope: "",
              Axis: "",
              State: "unavailable",
              Matched: "not measured",
              Primary: "not measured",
              Next: "Retry after Munin is reachable; this is not evidence of zero experiments.",
            }],
      }
    : null;

  return [
    capabilityPanel,
    gatePanel,
    policyPanel,
    handoffPanel,
    ...(experimentPanel ? [experimentPanel] : []),
  ];
}
