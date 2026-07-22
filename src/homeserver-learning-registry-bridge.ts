/**
 * Native registry bridge for direct homeserver/M5 attempts (hugin#284).
 *
 * Direct `Runtime: homeserver` is the one production path that already owns
 * an authenticated LearningTaskContract admission and exact M5 execution
 * provenance. It deliberately owns no checkout or file-edit authority. This
 * bridge records that existing attempt in the learning registry without
 * changing either boundary: only admitted evidence is accepted, and the
 * repository outcome must remain exactly `not-managed`.
 *
 * Validation failures are ordinary learning ineligibility and produce no
 * writes. Storage failures still throw so the caller can report the recovery
 * fault after the primary task has been durably terminalized.
 */

import { taskTypeSchema } from "./broker/task-type-metadata.js";
import type { AppendResult, LearningRegistryStore } from "./learning-registry-store.js";
import type {
  AttemptReferenceEvent,
  SubmissionEvent,
  TerminalOutcomeEvent,
} from "./learning-registry-schema.js";
import { learningTaskExecutionEvidenceSchema } from "./learning-task-handshake.js";
import { delegationProvenanceSchema } from "./task-result-schema.js";
import type { ResolveM5LedgerAttemptBinding } from "./m5-ledger-attempt-binding.js";

export type HomeserverLearningRegistrySkipReason =
  | "invalid-learning-task-evidence"
  | "not-admitted"
  | "task-identity-mismatch"
  | "task-type-mismatch"
  | "missing-delegation-identity"
  | "delegation-binding-mismatch"
  | "repository-authority-mismatch";

export interface AdmittedHomeserverAttemptInput {
  taskId: string;
  taskType: string;
  occurredAt: string;
  outcome: TerminalOutcomeEvent["payload"]["outcome"];
  /** Kept wider than the registry enum so newly-added dispatcher states fail
   * closed here instead of silently becoming learning-eligible. */
  repositoryOutcomeState: string;
  learningTask: unknown;
  provenance: unknown;
}

export type AdmittedHomeserverAttemptResult =
  | {
      status: "skipped";
      reason: HomeserverLearningRegistrySkipReason;
    }
  | {
      status: "recorded";
      attemptId: string;
      registry: {
        submission: AppendResult<SubmissionEvent>;
        attemptReference: AppendResult<AttemptReferenceEvent>;
        terminalOutcome: AppendResult<TerminalOutcomeEvent>;
      };
    };

type RegistryDeps = Pick<
  LearningRegistryStore,
  "recordSubmission" | "recordAttemptReference" | "recordTerminalOutcome"
>;

export interface HomeserverLearningRegistryBridgeDeps {
  registry: RegistryDeps;
  resolveLedgerAttemptBinding: ResolveM5LedgerAttemptBinding;
}

export function isPotentialAdmittedHomeserverAttempt(
  learningTask: unknown,
  provenance: unknown,
): boolean {
  const evidence = learningTaskExecutionEvidenceSchema.safeParse(learningTask);
  const delegation = delegationProvenanceSchema.safeParse(provenance);
  return evidence.success
    && evidence.data.state === "m5-admitted"
    && evidence.data.evidenceAccepted
    && delegation.success
    && Boolean(delegation.data.ledgerId && delegation.data.modelId && delegation.data.taskType);
}

export async function recordAdmittedHomeserverAttempt(
  deps: HomeserverLearningRegistryBridgeDeps,
  input: AdmittedHomeserverAttemptInput,
): Promise<AdmittedHomeserverAttemptResult> {
  // This is the authority boundary, not merely metadata. If the dispatcher
  // ever gives homeserver tasks a checkout, this bridge stops until that new
  // execution model receives an explicit design and review.
  if (input.repositoryOutcomeState !== "not-managed") {
    return { status: "skipped", reason: "repository-authority-mismatch" };
  }

  const taskType = taskTypeSchema.safeParse(input.taskType);
  const evidence = learningTaskExecutionEvidenceSchema.safeParse(input.learningTask);
  if (!evidence.success) {
    return { status: "skipped", reason: "invalid-learning-task-evidence" };
  }
  if (evidence.data.state !== "m5-admitted" || !evidence.data.evidenceAccepted) {
    return { status: "skipped", reason: "not-admitted" };
  }
  if (evidence.data.taskId !== input.taskId) {
    return { status: "skipped", reason: "task-identity-mismatch" };
  }

  const stampedTaskType = evidence.data.requestStamp?.task_type.id;
  if (!taskType.success || stampedTaskType !== taskType.data) {
    return { status: "skipped", reason: "task-type-mismatch" };
  }

  const provenance = delegationProvenanceSchema.safeParse(input.provenance);
  if (!provenance.success
    || !provenance.data.ledgerId
    || !provenance.data.modelId) {
    return { status: "skipped", reason: "missing-delegation-identity" };
  }
  if (provenance.data.taskType !== taskType.data) {
    return { status: "skipped", reason: "task-type-mismatch" };
  }

  const authoritative = await deps.resolveLedgerAttemptBinding(provenance.data.ledgerId);
  if (authoritative.id !== provenance.data.ledgerId
    || authoritative.taskInstanceId !== input.taskId
    || authoritative.attemptId !== evidence.data.attemptId
    || authoritative.taskType !== taskType.data
    || authoritative.modelId !== provenance.data.modelId) {
    return { status: "skipped", reason: "delegation-binding-mismatch" };
  }

  // Admitted evidence is schema-bound to all of these refs. The explicit
  // guards keep the bridge total even if the evidence schema later gains a
  // different admitted state with optional references.
  const attemptStartRef = evidence.data.attemptStartRef;
  const attemptOutcomeRef = evidence.data.attemptOutcomeRef;
  if (!attemptStartRef || !attemptOutcomeRef) {
    return { status: "skipped", reason: "invalid-learning-task-evidence" };
  }

  const delegation = delegationProvenanceSchema.parse({
    ...provenance.data,
    taskType: taskType.data,
    lane: "one-shot",
    evidenceIdentityHash: authoritative.evidenceIdentityHash,
  });
  const taskOutcomeRef = evidence.data.taskOutcomeRef;
  const submission = await deps.registry.recordSubmission({
    taskId: input.taskId,
    taskOutcomeRef,
    occurredAt: input.occurredAt,
  });
  const attemptReference = await deps.registry.recordAttemptReference({
    taskId: input.taskId,
    attemptId: evidence.data.attemptId,
    attemptStartRef,
    taskOutcomeRef,
    occurredAt: input.occurredAt,
  });
  const terminalOutcome = await deps.registry.recordTerminalOutcome({
    taskId: input.taskId,
    attemptId: evidence.data.attemptId,
    outcome: input.outcome,
    repositoryOutcomeState: "not-managed",
    taskOutcomeRef,
    attemptOutcomeRef,
    delegation,
    occurredAt: input.occurredAt,
  });

  return {
    status: "recorded",
    attemptId: evidence.data.attemptId,
    registry: { submission, attemptReference, terminalOutcome },
  };
}
