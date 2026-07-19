import type { MuninClient, MuninEntry } from "./munin-client.js";
import type { HuginTaskIdentity } from "./task-identity.js";
import {
  learningTaskExecutionEvidenceSchema,
  learningTaskOutcomePersistenceFailure,
  learningTaskPreDispatchRecoveryFailure,
  learningTaskPreparedDispatchKey,
  learningTaskRecoveryFailure,
  preparedLearningTaskDispatchSchema,
  recoverPreparedLearningTaskDispatch,
  validatePreparedLearningTaskAttemptStart,
  validatePreparedLearningTaskOutcome,
  validatePreparedLearningTaskReplayPayload,
  validateStoredLearningTaskAttemptStart,
  type DurableLearningTaskAttemptStart,
  type LearningTaskExecutionEvidence,
} from "./learning-task-handshake.js";
import { createImmutableLearningArtifact } from "./learning-task-store.js";

export interface RecoveredStoredLearningTask {
  evidence: LearningTaskExecutionEvidence;
  huginTaskIdentity: HuginTaskIdentity;
  classification?: string;
}

function sameClassification(actual: string | undefined, expected: string | undefined): boolean {
  return actual === expected;
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Recover one selected immutable prepared dispatch.
 *
 * The task/status classification is the authority for every joined row and
 * newly written artifact. A prepared row or attempt start that cannot be
 * trusted returns no learning metadata because the full #230 producer identity
 * cannot be reconstructed safely.
 */
export async function recoverStoredLearningTaskCandidate(input: {
  munin: MuninClient;
  taskNamespace: string;
  taskClassification?: string;
  preparedEntry: MuninEntry;
  gateway: { baseUrl: string; apiKey: string } | null;
  fetchImpl?: typeof fetch;
}): Promise<RecoveredStoredLearningTask | null> {
  if (!sameClassification(input.preparedEntry.classification, input.taskClassification)) {
    return null;
  }
  const parsedPrepared = preparedLearningTaskDispatchSchema.safeParse(
    parseJson(input.preparedEntry.content),
  );
  if (!parsedPrepared.success) return null;
  const prepared = parsedPrepared.data;
  if (prepared.taskId !== input.taskNamespace.replace(/^tasks\//, "")
    || prepared.preparedDispatchRef.namespace !== input.preparedEntry.namespace
    || prepared.preparedDispatchRef.key !== input.preparedEntry.key) {
    return null;
  }

  const attemptStartEntry = await input.munin.read(
    prepared.attemptStartRef.namespace,
    prepared.attemptStartRef.key,
  );
  if (!attemptStartEntry
    || !sameClassification(attemptStartEntry.classification, input.taskClassification)) {
    return null;
  }
  let huginTaskIdentity: HuginTaskIdentity;
  let attemptStart: DurableLearningTaskAttemptStart;
  try {
    attemptStart = validatePreparedLearningTaskAttemptStart(
      prepared,
      parseJson(attemptStartEntry.content),
    );
    huginTaskIdentity = attemptStart.huginTaskIdentity;
  } catch {
    return null;
  }

  const result = (evidence: LearningTaskExecutionEvidence): RecoveredStoredLearningTask => ({
    evidence: validatePreparedLearningTaskOutcome(prepared, evidence),
    huginTaskIdentity,
    classification: input.taskClassification,
  });
  const failure = (reason: string): RecoveredStoredLearningTask => result(
    learningTaskRecoveryFailure(prepared, reason),
  );

  const persistenceFailure = (
    reason: string,
    evidence: LearningTaskExecutionEvidence = learningTaskRecoveryFailure(prepared, reason),
  ): RecoveredStoredLearningTask => ({
    evidence: learningTaskOutcomePersistenceFailure(evidence, reason),
    huginTaskIdentity,
    classification: input.taskClassification,
  });

  const replayEntry = await input.munin.read(
    prepared.replayPayloadRef.namespace,
    prepared.replayPayloadRef.key,
  );
  let replay: ReturnType<typeof validatePreparedLearningTaskReplayPayload> | null = null;
  let replayFailureReason: string | null = null;
  if (!replayEntry) {
    replayFailureReason = "classified replay payload is missing";
  } else if (!sameClassification(replayEntry.classification, input.taskClassification)) {
    replayFailureReason = "classified replay payload classification differs from task status";
  } else {
    try {
      replay = validatePreparedLearningTaskReplayPayload(
        prepared,
        parseJson(replayEntry.content),
        attemptStart,
      );
    } catch (error) {
      replayFailureReason = error instanceof Error ? error.message : String(error);
    }
  }

  const existingOutcome = await input.munin.read(
    prepared.attemptOutcomeRef.namespace,
    prepared.attemptOutcomeRef.key,
  );
  if (replayFailureReason) {
    if (existingOutcome) return persistenceFailure(replayFailureReason);
    const recovered = failure(replayFailureReason);
    try {
      await createImmutableLearningArtifact(input.munin, {
        namespace: prepared.attemptOutcomeRef.namespace,
        key: prepared.attemptOutcomeRef.key,
        content: JSON.stringify(recovered.evidence),
        tags: [
          "learning-task-attempt",
          "attempt:not-admitted",
          "attempt:recovered",
          "contract:grimnir-learning-task-v1",
        ],
        classification: input.taskClassification,
      }, { allowExactExisting: true });
      return recovered;
    } catch (error) {
      return persistenceFailure(
        `durable learning-task attempt outcome write failed: ${error instanceof Error ? error.message : String(error)}`,
        recovered.evidence,
      );
    }
  }
  if (existingOutcome) {
    if (!sameClassification(existingOutcome.classification, input.taskClassification)) {
      return persistenceFailure(
        "durable learning-task outcome classification differs from task status",
      );
    }
    try {
      return result(learningTaskExecutionEvidenceSchema.parse(parseJson(existingOutcome.content)));
    } catch {
      return persistenceFailure("durable learning-task outcome is malformed or cross-bound");
    }
  }

  let recovered: RecoveredStoredLearningTask;
  if (!input.gateway) {
    recovered = failure("homeserver gateway is unavailable for exact recovery");
  } else {
    const evidence = await recoverPreparedLearningTaskDispatch({
      prepared,
      replayPayload: replay!,
      gatewayBaseUrl: input.gateway.baseUrl,
      apiKey: input.gateway.apiKey,
      fetchImpl: input.fetchImpl,
    });
    recovered = result(evidence);
  }

  try {
    await createImmutableLearningArtifact(input.munin, {
      namespace: prepared.attemptOutcomeRef.namespace,
      key: prepared.attemptOutcomeRef.key,
      content: JSON.stringify(recovered.evidence),
      tags: [
        "learning-task-attempt",
        recovered.evidence.state === "m5-admitted" ? "attempt:admitted" : "attempt:not-admitted",
        "attempt:recovered",
        "contract:grimnir-learning-task-v1",
      ],
      classification: input.taskClassification,
    }, { allowExactExisting: true });
    return recovered;
  } catch (error) {
    return persistenceFailure(
      `durable learning-task attempt outcome write failed: ${error instanceof Error ? error.message : String(error)}`,
      recovered.evidence,
    );
  }
}

export async function recoverLatestStoredLearningTaskAttempt(input: {
  munin: MuninClient;
  taskNamespace: string;
  taskClassification?: string;
  gateway: { baseUrl: string; apiKey: string } | null;
  fetchImpl?: typeof fetch;
}): Promise<RecoveredStoredLearningTask | null> {
  const matches = await input.munin.query({
    tags: ["learning-task-attempt", "attempt:started"],
    namespace: input.taskNamespace,
    entry_type: "state",
    limit: 20,
  });
  const latest = matches.results
    .filter((entry) => entry.namespace === input.taskNamespace
      && entry.key?.startsWith("learning-attempt-")
      && !entry.key.endsWith("-prepared")
      && !entry.key.endsWith("-replay")
      && !entry.key.endsWith("-outcome"))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0];
  if (!latest?.key) return null;
  const attemptStartEntry = await input.munin.read(input.taskNamespace, latest.key);
  if (!attemptStartEntry
    || !sameClassification(attemptStartEntry.classification, input.taskClassification)) {
    return null;
  }
  let attemptStart: DurableLearningTaskAttemptStart;
  try {
    attemptStart = validateStoredLearningTaskAttemptStart({
      taskNamespace: input.taskNamespace,
      key: latest.key,
      raw: parseJson(attemptStartEntry.content),
    });
  } catch {
    return null;
  }
  const attemptStartRef = { namespace: input.taskNamespace, key: latest.key };
  const preparedKey = learningTaskPreparedDispatchKey(attemptStart.attemptId);
  const preparedEntry = await input.munin.read(input.taskNamespace, preparedKey);
  if (!preparedEntry
    || !sameClassification(preparedEntry.classification, input.taskClassification)) {
    return {
      evidence: learningTaskPreDispatchRecoveryFailure({
        start: attemptStart,
        attemptStartRef,
        reason: preparedEntry
          ? "latest prepared dispatch classification differs from task status"
          : "latest attempt has no durable prepared dispatch",
      }),
      huginTaskIdentity: attemptStart.huginTaskIdentity,
      classification: input.taskClassification,
    };
  }
  const recovered = await recoverStoredLearningTaskCandidate({
    munin: input.munin,
    taskNamespace: input.taskNamespace,
    taskClassification: input.taskClassification,
    preparedEntry,
    gateway: input.gateway,
    fetchImpl: input.fetchImpl,
  });
  return recovered ?? {
    evidence: learningTaskPreDispatchRecoveryFailure({
      start: attemptStart,
      attemptStartRef,
      reason: "latest durable prepared dispatch is malformed or cross-bound",
    }),
    huginTaskIdentity: attemptStart.huginTaskIdentity,
    classification: input.taskClassification,
  };
}
