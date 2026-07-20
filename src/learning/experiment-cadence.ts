/**
 * Continuous-improvement experiment cadence (hugin#266, grimnir#88 Phase 4).
 *
 * One idempotent, fail-closed tick that CHAINS the already-merged
 * experiment-pipeline pieces on a schedule -- it never reimplements any of
 * them:
 *
 *   (a) propose  -- experiment-proposer.ts (#234), read-only.
 *   (b) dedupe   -- pick the top ranked proposal not already "in flight" for
 *                   its (scope, axis, championFingerprint, challengerFingerprint)
 *                   natural key. This cadence-owned index is additive
 *                   bookkeeping, not a change to the store's own identity
 *                   rules.
 *   (c) package  -- candidate-packager.ts (#233) via `packageAndHandOff`,
 *                   which itself calls `LearningExperimentStore.create` --
 *                   already idempotent on content-derived `experiment_id`.
 *   (d) observe  -- read (never mutate) every experiment this cadence has
 *                   ever packaged; an experiment still `running` is reported,
 *                   not concluded.
 *   (e) conclude -- an experiment whose evaluator decision left "gathering"
 *                   (i.e. `promotion-ready` or `rejected` -- it reached its
 *                   frozen sample target) gets: a best-effort gille outcome
 *                   export attempt (#8 contract, experiment-outcome-export.ts)
 *                   and a durable, idempotent REVIEWABLE SUMMARY record.
 *   (f) NEVER promote. `LearningExperimentStore.promote` is not imported by
 *                   this module. Promotion/adoption is gi#49's job; until
 *                   that exists, the reviewable summary IS the deliverable.
 *
 * Fail-closed composition: a failure in one stage (proposer error, packaging
 * refusal, store conflict, index/summary read/write error) is RECORDED and
 * the tick continues with the rest -- it never throws out of
 * `runExperimentCadenceTick` for a business-rule failure. The caller (the
 * CLI) decides the process exit code from `result.errors`.
 *
 * Idempotency: re-running a tick against unchanged state is a no-op --
 * nothing new is proposed-and-packaged (already in flight), nothing is
 * re-concluded (a reviewable summary already exists), and the durable tick
 * log is the only thing written every time (by design -- "ran and found
 * nothing new" is itself a fact worth logging).
 *
 * Documented limitation (evidence-source scope). Assembling the full
 * production `PackagerCandidateInput[]` pool -- walking every rated task in
 * the quality-receipt ledger -- is explicitly out of #234/#233's scope (see
 * candidate-packager-schema.ts: "the caller ... or a future daily factory
 * conductor is responsible for resolving configuration and qualityReceipt").
 * That conductor does not exist yet. This module therefore takes
 * `loadCandidates` as a required injected dependency rather than building a
 * bulk evidence scan under this ticket's narrower orchestration scope.
 *
 * Documented limitation (gille-side quarantine visibility). The ticket asks
 * this tick to refuse an axis gille has quarantined, IF that signal is
 * visible via the #8 import contract. It is not: gille-inference#34's
 * `POST /admin/experiments/import` is a one-way IMPORT endpoint with no
 * companion query surface for "is axis X quarantined." No such channel is
 * invented here; `LIMITATIONS.quarantineVisibility` names the gap on every
 * tick result instead.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { MuninWriteRejectedError } from "../munin-client.js";
import type { LearningRegistryStore } from "../learning-registry-store.js";
import { buildTaskLifecycleTimeline, type TaskLifecycleTimeline } from "../learning-registry-view.js";
import {
  learningChangeAxisSchema,
  sha256Schema,
  type LearningExperimentGates,
  type LearningExperimentState,
} from "./experiment-schema.js";
import {
  proposeExperimentsFromRegistry,
  proposalToPackageRequest,
  type ExperimentProposal,
  type PopulationDeclineReason,
  type ProposeRequest,
} from "./experiment-proposer.js";
import {
  packageAndHandOff,
  packageExperimentCandidates,
  type PackageRequest,
} from "./candidate-packager.js";
import type { PackagerCandidateInput, PackagerQualityRating } from "./candidate-packager-schema.js";
import { LearningExperimentStore, LearningStoreError } from "./experiment-store.js";
import {
  buildOutcomeExportBundle,
  type GilleOutcomeEvidenceResolver,
  type GilleOutcomeExportPort,
} from "./experiment-outcome-export.js";

// ─── Munin surface (minimal, mirrors publication-recovery.ts's own idiom) ──────

export interface CadenceMuninClient {
  read(namespace: string, key: string): Promise<{ content: string; updated_at: string } | null>;
  write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
    createIfAbsent?: boolean,
  ): Promise<unknown>;
  log(namespace: string, content: string, tags?: string[]): Promise<unknown>;
}

const CADENCE_SCHEMA_VERSION = 1 as const;
const CADENCE_INDEX_KEY = "index";
const MAX_INDEX_MUTATION_ATTEMPTS = 3;

function principalHash(principal: string): string {
  return createHash("sha256").update(principal).digest("hex").slice(0, 12);
}
function cadenceIndexNamespace(principal: string): string {
  return `experiments/hugin/cadence-index-${principalHash(principal)}`;
}
function cadenceSummaryNamespace(principal: string): string {
  return `experiments/hugin/cadence-summary-${principalHash(principal)}`;
}
function cadenceTickLogNamespace(principal: string): string {
  return `experiments/hugin/cadence-log-${principalHash(principal)}`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Dedup index (natural key: scope, axis, championFingerprint, challengerFingerprint) ──

const cadenceIndexEntrySchema = z.object({
  scope: z.string().min(1),
  taskType: z.string().min(1),
  changeAxis: learningChangeAxisSchema,
  championFingerprint: sha256Schema,
  challengerFingerprint: sha256Schema,
  experimentId: z.string().min(1),
  packagedAt: z.string().min(1),
}).strict();
export type CadenceIndexEntry = z.infer<typeof cadenceIndexEntrySchema>;

const cadenceIndexSchema = z.object({
  schemaVersion: z.literal(CADENCE_SCHEMA_VERSION),
  entries: z.array(cadenceIndexEntrySchema).max(2_000),
}).strict();

function sameNaturalKey(a: CadenceIndexEntry, b: Omit<CadenceIndexEntry, "experimentId" | "packagedAt">): boolean {
  return (
    a.scope === b.scope &&
    a.changeAxis === b.changeAxis &&
    a.championFingerprint === b.championFingerprint &&
    a.challengerFingerprint === b.challengerFingerprint
  );
}

async function readCadenceIndex(
  munin: CadenceMuninClient,
  principal: string,
): Promise<{ entries: CadenceIndexEntry[]; updatedAt?: string }> {
  const entry = await munin.read(cadenceIndexNamespace(principal), CADENCE_INDEX_KEY);
  if (!entry) return { entries: [] };
  const parsed = cadenceIndexSchema.safeParse(JSON.parse(entry.content));
  if (!parsed.success) throw new Error(`cadence index content is invalid: ${parsed.error.message}`);
  return { entries: parsed.data.entries, updatedAt: entry.updated_at };
}

/** Idempotent: a natural key already present is a no-op, never a duplicate entry. */
async function appendCadenceIndexEntry(
  munin: CadenceMuninClient,
  principal: string,
  newEntry: CadenceIndexEntry,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_INDEX_MUTATION_ATTEMPTS; attempt += 1) {
    const { entries, updatedAt } = await readCadenceIndex(munin, principal);
    if (entries.some((e) => sameNaturalKey(e, newEntry))) return;
    const next = { schemaVersion: CADENCE_SCHEMA_VERSION, entries: [...entries, newEntry] };
    try {
      if (updatedAt === undefined) {
        await munin.write(
          cadenceIndexNamespace(principal), CADENCE_INDEX_KEY, JSON.stringify(next),
          ["learning:cadence-index"], undefined, "internal", true,
        );
      } else {
        await munin.write(
          cadenceIndexNamespace(principal), CADENCE_INDEX_KEY, JSON.stringify(next),
          ["learning:cadence-index"], updatedAt, "internal",
        );
      }
      return;
    } catch (err) {
      if (err instanceof MuninWriteRejectedError && attempt < MAX_INDEX_MUTATION_ATTEMPTS - 1) continue;
      throw err;
    }
  }
  throw new Error("cadence index update lost repeated CAS races");
}

// ─── Reviewable summary (idempotent, natural-keyed on experimentId) ────────────

const outcomeExportStatusSchema = z.enum(["skipped", "attempted", "would-export", "failed"]);

const reviewableSummarySchema = z.object({
  schemaVersion: z.literal(CADENCE_SCHEMA_VERSION),
  experimentId: z.string().min(1),
  scope: z.string().min(1),
  taskType: z.string().min(1),
  changeAxis: learningChangeAxisSchema,
  championFingerprint: sha256Schema,
  challengerFingerprint: sha256Schema,
  championModelId: z.string().min(1),
  challengerModelId: z.string().min(1),
  decision: z.enum(["promotion-ready", "reject"]),
  reason: z.string().min(1),
  nextAction: z.string().min(1),
  matchedPairs: z.number().int().nonnegative(),
  holdoutPairs: z.number().int().nonnegative(),
  primaryMetric: z.string().min(1),
  primaryChampion: z.number().nullable(),
  primaryChallenger: z.number().nullable(),
  primaryImprovement: z.number().nullable(),
  guardFailures: z.array(z.string()),
  narrative: z.string().min(1),
  documentedGaps: z.array(z.string()),
  outcomeExport: z.object({
    status: outcomeExportStatusSchema,
    detail: z.string().optional(),
  }).strict(),
  awaitingReview: z.literal(true),
  concludedAt: z.string().min(1),
}).strict();
export type ReviewableSummaryRecord = z.infer<typeof reviewableSummarySchema>;

function buildNarrative(state: LearningExperimentState): string {
  const verdict = state.status === "promotion-ready" ? "beat" : "did not beat";
  const delta = state.evaluation.primaryImprovement === null ? "n/a" : state.evaluation.primaryImprovement.toFixed(4);
  return (
    `challenger ${state.challenger.model.id} vs champion ${state.champion.model.id} on task-type ` +
    `${state.taskType} (axis: ${state.changeAxis}): challenger ${verdict} the champion on ` +
    `${state.evaluation.primaryMetric} (improvement=${delta}), n=${state.evaluation.matchedPairs} matched pairs ` +
    `(${state.evaluation.holdoutPairs} holdout). ${state.evaluation.reason} Awaiting review/adoption -- this ` +
    `tick never promotes; promotion is a separate, explicit action (gi#49).`
  );
}

const DOCUMENTED_GAP_NO_CI =
  "no formal confidence interval is computed here -- the monotonic gate evaluator " +
  "(experiment-evaluator.ts) reports matchedPairs/primaryImprovement/guardFailures as its decision basis, not a CI.";

function buildReviewableSummary(
  state: LearningExperimentState,
  concludedAt: string,
  outcomeExport: { status: z.infer<typeof outcomeExportStatusSchema>; detail?: string },
): ReviewableSummaryRecord {
  const documentedGaps = [DOCUMENTED_GAP_NO_CI];
  if (outcomeExport.status === "skipped") {
    documentedGaps.push(
      "gille outcome export skipped -- Hugin's content-blind experiment records do not carry the raw " +
      "prompt bytes / full evidence-identity bundle gille-inference#8's import contract requires; see " +
      "experiment-outcome-export.ts's module doc comment.",
    );
  }
  return reviewableSummarySchema.parse({
    schemaVersion: CADENCE_SCHEMA_VERSION,
    experimentId: state.experimentId,
    scope: state.scope,
    taskType: state.taskType,
    changeAxis: state.changeAxis,
    championFingerprint: state.champion.fingerprint,
    challengerFingerprint: state.challenger.fingerprint,
    championModelId: state.champion.model.id,
    challengerModelId: state.challenger.model.id,
    decision: state.status === "promotion-ready" ? "promotion-ready" : "reject",
    reason: state.evaluation.reason,
    nextAction: state.evaluation.nextAction,
    matchedPairs: state.evaluation.matchedPairs,
    holdoutPairs: state.evaluation.holdoutPairs,
    primaryMetric: state.evaluation.primaryMetric,
    primaryChampion: state.evaluation.primaryChampion,
    primaryChallenger: state.evaluation.primaryChallenger,
    primaryImprovement: state.evaluation.primaryImprovement,
    guardFailures: state.evaluation.guardFailures,
    narrative: buildNarrative(state),
    documentedGaps,
    outcomeExport,
    awaitingReview: true,
    concludedAt,
  });
}

/** True if a summary already exists (idempotent no-op) versus freshly written. */
async function writeReviewableSummaryIfAbsent(
  munin: CadenceMuninClient,
  principal: string,
  summary: ReviewableSummaryRecord,
): Promise<{ wrote: boolean }> {
  try {
    await munin.write(
      cadenceSummaryNamespace(principal),
      summary.experimentId,
      JSON.stringify(summary),
      ["learning:cadence-summary", `learning:${summary.decision}`, `axis:${summary.changeAxis}`, `type:${summary.taskType}`],
      undefined,
      "internal",
      true,
    );
    return { wrote: true };
  } catch (err) {
    if (err instanceof MuninWriteRejectedError && err.conflictReason === "already_exists") {
      return { wrote: false };
    }
    throw err;
  }
}

async function readReviewableSummary(
  munin: CadenceMuninClient,
  principal: string,
  experimentId: string,
): Promise<ReviewableSummaryRecord | null> {
  const entry = await munin.read(cadenceSummaryNamespace(principal), experimentId);
  if (!entry) return null;
  const parsed = reviewableSummarySchema.safeParse(JSON.parse(entry.content));
  if (!parsed.success) throw new Error(`stored reviewable summary for ${experimentId} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

// ─── Tick types ─────────────────────────────────────────────────────────────────

export interface ExperimentCadenceDeps {
  registry: Pick<LearningRegistryStore, "listEventsForTask">;
  experimentStore: LearningExperimentStore;
  munin: CadenceMuninClient;
  /** The owning principal for both the experiment store and this cadence's own durable records. */
  principal: string;
  /**
   * Resolve the current qualified evidence pool. Required, not defaulted: see
   * the module doc comment's "documented limitation" -- Hugin has no
   * production-ready bulk assembler for this yet.
   */
  loadCandidates: () => Promise<PackagerCandidateInput[]>;
  /** Injected #8 export port. Omit to always skip export with a recorded reason. */
  gilleExport?: GilleOutcomeExportPort;
  /** Injected evidence resolver for the export bundle. Omit to always skip export. */
  evidenceResolver?: GilleOutcomeEvidenceResolver;
  now?: () => string;
}

export interface CadenceTickOptions {
  dryRun?: boolean;
  runId?: string;
  proposerOptions?: ProposeRequest;
  /** Per-proposal packaging overrides (scope/gates/etc). Defaults to `proposalToPackageRequest`'s own defaults. */
  packageOverrides?: (proposal: ExperimentProposal) => {
    scope?: string;
    gates?: LearningExperimentGates;
    minCandidatesPerArm?: number;
    minQualityRating?: PackagerQualityRating;
  };
}

export interface CadenceRefusal {
  stage: "package";
  proposalId: string;
  reason: string;
}

export interface CadenceError {
  stage: "load-candidates" | "propose" | "index-read" | "package" | "observe-or-conclude";
  message: string;
}

export interface CadenceObservedExperiment {
  experimentId: string;
  status: LearningExperimentState["status"];
  matchedPairs: number;
  holdoutPairs: number;
}

export interface CadenceConcludedExperiment {
  experimentId: string;
  alreadyConcluded: boolean;
  summaryWritten: boolean;
  exportStatus: z.infer<typeof outcomeExportStatusSchema>;
  exportDetail?: string;
}

export interface CadenceTickResult {
  tickId: string;
  dryRun: boolean;
  startedAt: string;
  candidatesLoaded: number;
  proposalsConsidered: number;
  /**
   * Populations the #234 proposer itself declined to propose -- includes
   * `multi-axis-delta` (the one-axis-discipline refusal), `insufficient-
   * samples`, `no-quality-signal-delta`, etc. This tick never overrides or
   * reinterprets these; it only surfaces them so "refused, with a reason" is
   * durable and discoverable even when nothing was ever chosen to package.
   */
  proposalDeclines: PopulationDeclineReason[];
  skippedInFlight: string[];
  packaged: { experimentId: string; scope: string; reused: boolean; wouldPackage?: boolean } | null;
  refusals: CadenceRefusal[];
  observed: CadenceObservedExperiment[];
  concluded: CadenceConcludedExperiment[];
  errors: CadenceError[];
  limitations: string[];
}

const QUARANTINE_VISIBILITY_LIMITATION =
  "gille-side axis quarantine is not observable through the gille-inference#8 import contract " +
  "(POST /admin/experiments/import is import-only; no query surface exists for quarantine state). " +
  "This tick cannot check it and does not invent a channel to do so.";

function naturalKeyOf(scope: string, proposal: ExperimentProposal): Omit<CadenceIndexEntry, "experimentId" | "packagedAt"> {
  return {
    scope,
    taskType: proposal.taskType,
    changeAxis: proposal.changeAxis,
    championFingerprint: proposal.championFingerprint,
    challengerFingerprint: proposal.challengerFingerprint,
  };
}

function resolveMatchedCandidates(
  candidates: readonly PackagerCandidateInput[],
  proposal: ExperimentProposal,
): PackagerCandidateInput[] {
  const wanted = new Set(proposal.matchedTasks.map((t) => `${t.taskId}/${t.attemptId}`));
  return candidates.filter((c) => wanted.has(`${c.taskId}/${c.attemptId}`));
}

async function buildTimelines(
  registry: Pick<LearningRegistryStore, "listEventsForTask">,
  candidates: readonly PackagerCandidateInput[],
): Promise<Map<string, TaskLifecycleTimeline>> {
  const taskIds = [...new Set(candidates.map((c) => c.taskId))];
  const timelines = new Map<string, TaskLifecycleTimeline>();
  for (const taskId of taskIds) {
    timelines.set(taskId, await buildTaskLifecycleTimeline(registry, taskId));
  }
  return timelines;
}

/** Content-blind: ids, counts, statuses, and reasons only -- never candidate/task content. */
function buildTickLogContent(result: CadenceTickResult): string {
  return JSON.stringify({
    tickId: result.tickId,
    startedAt: result.startedAt,
    candidatesLoaded: result.candidatesLoaded,
    proposalsConsidered: result.proposalsConsidered,
    proposalDeclines: result.proposalDeclines,
    skippedInFlight: result.skippedInFlight,
    packaged: result.packaged,
    refusals: result.refusals,
    observed: result.observed,
    concluded: result.concluded,
    errors: result.errors,
    limitations: result.limitations,
  });
}

/**
 * Run exactly one cadence tick. Never throws for a business-rule failure --
 * see the module doc comment's fail-closed composition note. May reject only
 * for a genuine programming error (e.g. malformed `deps`).
 */
export async function runExperimentCadenceTick(
  deps: ExperimentCadenceDeps,
  options: CadenceTickOptions = {},
): Promise<CadenceTickResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const dryRun = options.dryRun ?? false;
  const tickId = options.runId ?? `tick-${startedAt.replace(/[^0-9]/g, "")}`;

  const refusals: CadenceRefusal[] = [];
  const errors: CadenceError[] = [];
  const observed: CadenceObservedExperiment[] = [];
  const concluded: CadenceConcludedExperiment[] = [];
  const skippedInFlight: string[] = [];
  let packaged: CadenceTickResult["packaged"] = null;

  // -- (a) load evidence + propose --------------------------------------------
  let candidates: PackagerCandidateInput[] = [];
  try {
    candidates = await deps.loadCandidates();
  } catch (err) {
    errors.push({ stage: "load-candidates", message: describeError(err) });
  }

  let proposals: ExperimentProposal[] = [];
  let proposalsConsidered = 0;
  let proposalDeclines: PopulationDeclineReason[] = [];
  if (candidates.length > 0) {
    try {
      const outcome = await proposeExperimentsFromRegistry(deps.registry, candidates, options.proposerOptions);
      proposals = outcome.proposals;
      proposalsConsidered = outcome.proposals.length;
      proposalDeclines = outcome.declinedPopulations;
    } catch (err) {
      errors.push({ stage: "propose", message: describeError(err) });
    }
  }

  // -- (b) dedupe against the cadence's own in-flight index --------------------
  let indexEntries: CadenceIndexEntry[] = [];
  let indexReadable = true;
  try {
    indexEntries = (await readCadenceIndex(deps.munin, deps.principal)).entries;
  } catch (err) {
    indexReadable = false;
    errors.push({ stage: "index-read", message: describeError(err) });
  }

  let chosenProposal: ExperimentProposal | null = null;
  let chosenScope = "";
  if (indexReadable) {
    for (const proposal of proposals) {
      const scope = options.packageOverrides?.(proposal)?.scope ?? proposal.suggestedScope;
      const key = naturalKeyOf(scope, proposal);
      if (indexEntries.some((e) => sameNaturalKey(e, key))) {
        skippedInFlight.push(proposal.proposalId);
        continue;
      }
      chosenProposal = proposal;
      chosenScope = scope;
      break;
    }
  } else if (proposals.length > 0) {
    refusals.push({
      stage: "package",
      proposalId: proposals[0]!.proposalId,
      reason: "index-unavailable: refusing to package without a safe in-flight dedup read",
    });
  }

  // -- (c) package + create (or, in dry-run, package-preview only) -------------
  if (chosenProposal) {
    const overrides = options.packageOverrides?.(chosenProposal) ?? {};
    const packageRequest: PackageRequest = proposalToPackageRequest(chosenProposal, { ...overrides, scope: chosenScope, now });
    const matchedCandidates = resolveMatchedCandidates(candidates, chosenProposal);
    if (matchedCandidates.length !== chosenProposal.matchedTasks.length) {
      refusals.push({
        stage: "package",
        proposalId: chosenProposal.proposalId,
        reason: "matched-candidate-resolution-incomplete: not every proposal.matchedTasks entry was found in the supplied candidate pool",
      });
    } else if (dryRun) {
      try {
        const timelines = await buildTimelines(deps.registry, matchedCandidates);
        const preview = packageExperimentCandidates(matchedCandidates, timelines, packageRequest);
        if (preview.status === "packaged" && preview.package) {
          packaged = { experimentId: `pkg-${preview.package.packageId.slice(4, 20)}`, scope: chosenScope, reused: false, wouldPackage: true };
        } else {
          refusals.push({
            stage: "package",
            proposalId: chosenProposal.proposalId,
            reason: `packaging would be refused: ${JSON.stringify(preview.refusalReasons)}`,
          });
        }
      } catch (err) {
        errors.push({ stage: "package", message: describeError(err) });
      }
    } else {
      try {
        const outcome = await packageAndHandOff(
          deps.registry, deps.experimentStore, deps.principal, matchedCandidates, packageRequest,
        );
        if (outcome.status === "packaged" && outcome.experiment && outcome.createInput) {
          packaged = { experimentId: outcome.createInput.experiment_id, scope: chosenScope, reused: outcome.experiment.reused };
          await appendCadenceIndexEntry(deps.munin, deps.principal, {
            ...naturalKeyOf(chosenScope, chosenProposal),
            experimentId: outcome.createInput.experiment_id,
            packagedAt: now(),
          });
          if (!indexEntries.some((e) => e.experimentId === outcome.createInput!.experiment_id)) {
            indexEntries = [...indexEntries, {
              ...naturalKeyOf(chosenScope, chosenProposal),
              experimentId: outcome.createInput.experiment_id,
              packagedAt: now(),
            }];
          }
        } else {
          refusals.push({
            stage: "package",
            proposalId: chosenProposal.proposalId,
            reason: `packaging refused: ${JSON.stringify(outcome.refusalReasons)}`,
          });
        }
      } catch (err) {
        if (err instanceof LearningStoreError) {
          errors.push({ stage: "package", message: `${err.code}: ${err.message}` });
        } else {
          errors.push({ stage: "package", message: describeError(err) });
        }
      }
    }
  }

  // -- (d)/(e) observe every tracked experiment; conclude terminal ones --------
  for (const entry of indexEntries) {
    try {
      const state = await deps.experimentStore.read(deps.principal, entry.experimentId);
      if (state.status === "running") {
        observed.push({
          experimentId: entry.experimentId, status: state.status,
          matchedPairs: state.evaluation.matchedPairs, holdoutPairs: state.evaluation.holdoutPairs,
        });
        continue;
      }
      if (state.status === "promoted") {
        // Promotion happened outside this cadence (gi#49's job, or a manual
        // action) -- nothing left for a tick to do for this experiment.
        continue;
      }
      // "promotion-ready" or "rejected": the frozen sample target was reached.
      observed.push({
        experimentId: entry.experimentId, status: state.status,
        matchedPairs: state.evaluation.matchedPairs, holdoutPairs: state.evaluation.holdoutPairs,
      });
      const existingSummary = await readReviewableSummary(deps.munin, deps.principal, entry.experimentId);
      if (existingSummary) {
        concluded.push({
          experimentId: entry.experimentId, alreadyConcluded: true, summaryWritten: false,
          exportStatus: existingSummary.outcomeExport.status, exportDetail: existingSummary.outcomeExport.detail,
        });
        continue;
      }

      let exportStatus: z.infer<typeof outcomeExportStatusSchema>;
      let exportDetail: string | undefined;
      if (deps.gilleExport && deps.evidenceResolver) {
        try {
          const runId = `${entry.experimentId}-${tickId}`;
          const { bundle, unresolvedSamples } = await buildOutcomeExportBundle(state, runId, deps.evidenceResolver);
          if (!bundle) {
            exportStatus = "skipped";
            exportDetail = `no-resolvable-evidence: ${unresolvedSamples.length} sample(s) unresolved`;
          } else if (dryRun) {
            exportStatus = "would-export";
            exportDetail = `${bundle.arms.length} arm(s) ready; ${unresolvedSamples.length} unresolved`;
          } else {
            const result = await deps.gilleExport.exportOutcome(bundle);
            exportStatus = "attempted";
            exportDetail = JSON.stringify(result.arms.map((a) => ({ armId: a.armId, sampleId: a.sampleId, status: a.status, reason: a.reason })));
          }
        } catch (err) {
          exportStatus = "failed";
          exportDetail = describeError(err);
        }
      } else {
        exportStatus = "skipped";
        exportDetail = "evidence-resolver-or-export-port-not-configured (documented limitation)";
      }

      const summary = buildReviewableSummary(state, now(), { status: exportStatus, detail: exportDetail });
      let summaryWritten = false;
      if (!dryRun) {
        const writeResult = await writeReviewableSummaryIfAbsent(deps.munin, deps.principal, summary);
        summaryWritten = writeResult.wrote;
      }
      concluded.push({ experimentId: entry.experimentId, alreadyConcluded: false, summaryWritten, exportStatus, exportDetail });
    } catch (err) {
      errors.push({ stage: "observe-or-conclude", message: `${entry.experimentId}: ${describeError(err)}` });
    }
  }

  const result: CadenceTickResult = {
    tickId,
    dryRun,
    startedAt,
    candidatesLoaded: candidates.length,
    proposalsConsidered,
    proposalDeclines,
    skippedInFlight,
    packaged,
    refusals,
    observed,
    concluded,
    errors,
    limitations: [QUARANTINE_VISIBILITY_LIMITATION],
  };

  if (!dryRun) {
    await deps.munin.log(cadenceTickLogNamespace(deps.principal), buildTickLogContent(result), ["learning:cadence-tick"]);
  }

  return result;
}
