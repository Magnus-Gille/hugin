/**
 * Standing harness-lane execution wiring (hugin#267).
 *
 * This module owns exactly two things: (1) asking the deterministic sampler
 * (`src/harness-lane-sampler.ts`) which lane an eligible sub-task belongs to,
 * and (2) folding whatever that lane's EXISTING execution path produced into
 * the durable #232 registry (`src/learning-registry-store.ts`) with harness
 * identity attached. It never spawns a runtime itself — per hugin#267's
 * explicit instruction, the one-shot and harness lanes are whatever the
 * codebase already exposes (the Broker `/delegate` submit path for one-shot;
 * `src/opencode-executor.ts` or `src/learning/m5-code-loop-*` for harness).
 * Callers inject those as `HarnessLaneExecutors`.
 *
 * Grading discipline: both lanes are graded identically — a mechanical
 * self-verify (or an explicit "none" when no verifier applies) folds into the
 * SAME #163 evidence-identity shape (`delegationProvenanceSchema`) already
 * used for M5 delegation provenance, with one new field (`lane`) added in
 * hugin#267 to distinguish which lane produced it. Nothing here duplicates a
 * capability verdict into a Hugin-owned capability store — this is a content-
 * blind TRACE, exactly like the #163 fields it reuses.
 *
 * Fail-closed contract:
 *  - A SAMPLER malfunction (bad env, hash error) is handled entirely inside
 *    `decideHarnessLane` — it degrades to the one-shot lane and is recorded
 *    as such (see `HarnessLaneDecision.reason === "sampler-malfunction"`).
 *    This module never re-derives or second-guesses that decision.
 *  - Once a lane is chosen, this module calls exactly that lane's executor
 *    and records exactly that lane's outcome — success or failure. It never
 *    silently reroutes a failed harness attempt into a fresh one-shot retry
 *    (that would double-spend the task and hide the harness failure from the
 *    comparison), and it never fabricates registry evidence for an executor
 *    that did not produce any: `HarnessLaneExecutors` callbacks are contract-
 *    bound to resolve — never reject — with a `LaneAttemptOutcome`, exactly
 *    like the dispatcher's own `finalizeTaskCompletion` already guarantees a
 *    durable structured result before any terminal status flip (see
 *    AGENTS.md). If an executor breaks that contract and rejects anyway, this
 *    module rethrows rather than inventing evidence — an infrastructure fault
 *    is a recovery fault, never something to paper over with a made-up ref.
 *  - Registry writes reuse the store's own natural-key idempotency: replaying
 *    the same attempt (same taskId/attemptId) is a safe no-op, never a
 *    duplicate and never a lost event.
 */

import type { AppendResult, LearningRegistryStore } from "./learning-registry-store.js";
import type {
  AttemptReferenceEvent,
  RegistryEvidenceRef,
  RegistryOriginComponent,
  SubmissionEvent,
  TerminalOutcomeEvent,
} from "./learning-registry-schema.js";
import {
  decideHarnessLane,
  type HarnessLaneDecision,
  type HarnessLaneSamplerDeps,
  type LaneKind,
} from "./harness-lane-sampler.js";
import { delegationProvenanceSchema, type DelegationProvenance } from "./task-result-schema.js";
import type { M5Outcome } from "./m5-provenance.js";

/**
 * One executed lane attempt's content-blind, already-graded outcome —
 * produced by whichever EXISTING execution path actually ran the sub-task.
 * Callers build this from the real executor's own result (e.g. `opencode-
 * executor.ts`'s exit code / test commands, or an M5 `code_loop_result` via
 * `src/learning/m5-code-loop-adapter.ts`'s `qualityOf`-style classification).
 */
export interface LaneAttemptOutcome {
  /** Dispatcher-level execution result — mirrors `taskExecutionOutcomeSchema`. */
  outcome: "completed" | "failed" | "timed_out" | "cancelled";
  repositoryOutcomeState?: TerminalOutcomeEvent["payload"]["repositoryOutcomeState"];
  /** Durable evidence this attempt's own executor already wrote (e.g. the
   * dispatcher's `result-structured` doc). Required — this module never
   * invents evidence for an executor that produced none. */
  taskOutcomeRef: RegistryEvidenceRef;
  attemptOutcomeRef?: RegistryEvidenceRef;
  /** Same-discipline self-verify → grade signal as the one-shot lane. `"none"`
   * means no mechanical verifier applied (rare for harness leaves, since
   * hugin#192's discipline is "attach a verifier wherever possible"). */
  verifierKind: "mechanical" | "none";
  /** M5-style verdict; `"unverified"` when `verifierKind` is `"none"` or the
   * verifier itself could not run. */
  verdict: M5Outcome;
  verifierNotes?: string;
  modelId?: string;
  nodeId?: string;
  /** Harness-specific iteration signal (rounds/turns taken). Absent for
   * one-shot leaves; present when the harness executor reports it. */
  iterations?: number;
  escalated?: boolean;
  escalationReason?: string;
}

export interface HarnessLaneTaskRef {
  taskId: string;
  taskType: string;
}

export interface HarnessLaneExecutors {
  oneShot: (task: HarnessLaneTaskRef) => Promise<LaneAttemptOutcome>;
  harness: (task: HarnessLaneTaskRef) => Promise<LaneAttemptOutcome>;
}

export interface RunHarnessLaneSampledAttemptInput {
  taskId: string;
  attemptId: string;
  taskType: string;
  /** RFC 3339 UTC instant the underlying fact happened — see
   * `registryTimestampSchema`. */
  occurredAt: string;
  originComponent?: RegistryOriginComponent;
}

export interface HarnessLaneAttemptResult {
  decision: HarnessLaneDecision;
  lane: LaneKind;
  execution: LaneAttemptOutcome;
  delegation: DelegationProvenance;
  registry: {
    submission: AppendResult<SubmissionEvent>;
    attemptReference: AppendResult<AttemptReferenceEvent>;
    terminalOutcome: AppendResult<TerminalOutcomeEvent>;
  };
}

type RegistryDeps = Pick<
  LearningRegistryStore,
  "recordSubmission" | "recordAttemptReference" | "recordTerminalOutcome"
>;

/**
 * Build the #163 evidence-identity payload for one lane attempt.
 *
 * Registry events are JCS-canonicalized for digesting (`jcsDigestHex`, used
 * throughout `learning-registry-store.ts`), and JCS explicitly REJECTS a key
 * whose value is the literal `undefined` (see `jcsCanonicalize` in
 * `learning-task-handshake.ts`) — a field zod would happily treat as
 * "optional and absent" is not the same as a key present with value
 * `undefined`. Every optional field below is therefore conditionally
 * spread in, never assigned `undefined` directly, mirroring the exact
 * pattern `recordTerminalOutcome` already uses for its own optional fields.
 */
/** hugin#192's rating discipline calls out iterations/rounds taken as "the
 * harness-specific signal we have none of" — fold it into the verifier-notes
 * free-text field alongside whatever notes the executor itself supplied,
 * rather than growing a dedicated schema field for one lane's telemetry. */
function withIterationsNote(iterations: number | undefined, verifierNotes: string | undefined): string | undefined {
  if (iterations === undefined) return verifierNotes;
  const note = `iterations=${iterations}`;
  return verifierNotes ? `${verifierNotes}; ${note}` : note;
}

function buildDelegationProvenance(
  input: RunHarnessLaneSampledAttemptInput,
  decision: HarnessLaneDecision,
  execution: LaneAttemptOutcome,
): DelegationProvenance {
  const verifierNotes = withIterationsNote(execution.iterations, execution.verifierNotes);
  return delegationProvenanceSchema.parse({
    lane: decision.lane,
    taskType: input.taskType,
    outcome: execution.verdict,
    verifier: execution.verifierKind === "mechanical" ? "mechanical" : "none",
    // Sampler audit trail — reuses the generic policy trio rather than
    // growing a second competing shape. `policyMode` names the decision
    // maker, `policyAction` is the sampler's own reason enum,
    // `policyReason` carries WHY when that reason is a malfunction.
    policyMode: "harness-lane-sampler",
    policyAction: decision.reason,
    ...(execution.escalated !== undefined ? { escalated: execution.escalated } : {}),
    ...(execution.modelId !== undefined ? { modelId: execution.modelId } : {}),
    ...(execution.nodeId !== undefined ? { nodeId: execution.nodeId } : {}),
    ...(decision.malfunctionDetail !== undefined ? { policyReason: decision.malfunctionDetail } : {}),
    ...(execution.escalationReason !== undefined ? { decisionReason: execution.escalationReason } : {}),
    ...(verifierNotes !== undefined ? { verifierNotes } : {}),
  });
}

/**
 * Decide the lane for one eligible bounded coding sub-task, execute it
 * through whichever injected executor matches that lane, and record the
 * attempt into the durable #232 registry with harness identity. Idempotent:
 * calling this twice with the same `taskId`/`attemptId` and equivalent
 * execution evidence is a safe no-op on the registry side (natural-key
 * dedup) — the executor itself may still be invoked twice, since re-running
 * an already-graded lane attempt is the caller's concern, not this module's.
 */
export async function runHarnessLaneSampledAttempt(
  registry: RegistryDeps,
  input: RunHarnessLaneSampledAttemptInput,
  executors: HarnessLaneExecutors,
  samplerDeps: HarnessLaneSamplerDeps = {},
  /** A decision made by a caller only after its mandatory preflight gates.
   * When absent, this helper makes the decision itself as before. */
  precomputedDecision?: HarnessLaneDecision,
): Promise<HarnessLaneAttemptResult> {
  const decision = precomputedDecision
    ?? decideHarnessLane({ taskId: input.taskId, taskType: input.taskType }, samplerDeps);
  const lane = decision.lane;
  const taskRef: HarnessLaneTaskRef = { taskId: input.taskId, taskType: input.taskType };

  // Whichever lane the sampler picked is EXACTLY the lane that runs. A
  // harness-lane failure below is never caught-and-rerouted into a one-shot
  // retry here — see the module doc for why that would corrupt the
  // comparison this ticket exists to produce.
  const execution = lane === "harness" ? await executors.harness(taskRef) : await executors.oneShot(taskRef);

  const delegation = buildDelegationProvenance(input, decision, execution);

  const submission = await registry.recordSubmission({
    taskId: input.taskId,
    taskOutcomeRef: execution.taskOutcomeRef,
    occurredAt: input.occurredAt,
    originComponent: input.originComponent,
  });
  const attemptReference = await registry.recordAttemptReference({
    taskId: input.taskId,
    attemptId: input.attemptId,
    attemptStartRef: execution.taskOutcomeRef,
    taskOutcomeRef: execution.taskOutcomeRef,
    occurredAt: input.occurredAt,
  });
  const terminalOutcome = await registry.recordTerminalOutcome({
    taskId: input.taskId,
    attemptId: input.attemptId,
    outcome: execution.outcome,
    repositoryOutcomeState: execution.repositoryOutcomeState,
    taskOutcomeRef: execution.taskOutcomeRef,
    attemptOutcomeRef: execution.attemptOutcomeRef,
    occurredAt: input.occurredAt,
    delegation,
  });

  return {
    decision,
    lane,
    execution,
    delegation,
    registry: { submission, attemptReference, terminalOutcome },
  };
}
