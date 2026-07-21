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

export const IMMEDIATE_LEARNING_TASK_RECOVERY_TIMEOUT_MS = 5_000;

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

async function readLearningEntryBeforeDeadline(
  munin: MuninClient,
  namespace: string,
  key: string,
  signal: AbortSignal,
): Promise<MuninEntry | null> {
  if (signal.aborted) return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (entry: MuninEntry | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(entry);
    };
    const onAbort = (): void => finish(null);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    munin.read(namespace, key, { signal, maxRetries: 0 }).then(finish, () => finish(null));
  });
}

/**
 * Probe one exact prepared attempt immediately after an ambiguous transport
 * result. This deliberately performs no writes: only a fully admitted exact
 * recovery is returned, so a failed probe cannot replace the original
 * transport-not-admitted outcome before normal outcome persistence.
 */
export async function recoverAmbiguousStoredLearningTaskCandidate(input: {
  munin: MuninClient;
  taskNamespace: string;
  taskClassification?: string;
  preparedDispatchRef: { namespace: string; key: string };
  failureEvidence: LearningTaskExecutionEvidence;
  gateway: { baseUrl: string; apiKey: string } | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<RecoveredStoredLearningTask | null> {
  const failure = learningTaskExecutionEvidenceSchema.safeParse(input.failureEvidence);
  if (!failure.success
    || failure.data.state !== "m5-not-admitted"
    || failure.data.evidenceAccepted
    || failure.data.failureCode !== "transport-not-admitted"
    || !input.gateway
    || !failure.data.preparedDispatchRef
    || input.preparedDispatchRef.namespace !== input.taskNamespace
    || input.preparedDispatchRef.namespace !== failure.data.preparedDispatchRef.namespace
    || input.preparedDispatchRef.key !== failure.data.preparedDispatchRef.key) {
    return null;
  }
  const timeoutMs = Math.min(
    IMMEDIATE_LEARNING_TASK_RECOVERY_TIMEOUT_MS,
    Math.max(1, input.timeoutMs ?? IMMEDIATE_LEARNING_TASK_RECOVERY_TIMEOUT_MS),
  );
  const signal = AbortSignal.timeout(timeoutMs);
  const preparedEntry = await readLearningEntryBeforeDeadline(
    input.munin,
    input.preparedDispatchRef.namespace,
    input.preparedDispatchRef.key,
    signal,
  );
  if (!preparedEntry
    || signal.aborted
    || !sameClassification(preparedEntry.classification, input.taskClassification)) {
    return null;
  }
  const parsedPrepared = preparedLearningTaskDispatchSchema.safeParse(
    parseJson(preparedEntry.content),
  );
  if (!parsedPrepared.success) return null;
  const prepared = parsedPrepared.data;
  if (prepared.taskId !== input.taskNamespace.replace(/^tasks\//, "")
    || prepared.preparedDispatchRef.namespace !== preparedEntry.namespace
    || prepared.preparedDispatchRef.key !== preparedEntry.key) {
    return null;
  }

  const attemptStartEntry = await readLearningEntryBeforeDeadline(
    input.munin,
    prepared.attemptStartRef.namespace,
    prepared.attemptStartRef.key,
    signal,
  );
  if (!attemptStartEntry
    || signal.aborted
    || !sameClassification(attemptStartEntry.classification, input.taskClassification)) {
    return null;
  }
  let attemptStart: DurableLearningTaskAttemptStart;
  try {
    attemptStart = validatePreparedLearningTaskAttemptStart(
      prepared,
      parseJson(attemptStartEntry.content),
    );
  } catch {
    return null;
  }

  const replayEntry = await readLearningEntryBeforeDeadline(
    input.munin,
    prepared.replayPayloadRef.namespace,
    prepared.replayPayloadRef.key,
    signal,
  );
  if (!replayEntry
    || signal.aborted
    || !sameClassification(replayEntry.classification, input.taskClassification)) {
    return null;
  }
  let replay: ReturnType<typeof validatePreparedLearningTaskReplayPayload>;
  try {
    replay = validatePreparedLearningTaskReplayPayload(
      prepared,
      parseJson(replayEntry.content),
      attemptStart,
    );
    const boundFailure = failure.data.attemptOutcomeRef
      ? failure.data
      : { ...failure.data, attemptOutcomeRef: prepared.attemptOutcomeRef };
    validatePreparedLearningTaskOutcome(prepared, boundFailure);
  } catch {
    return null;
  }

  const existingOutcome = await readLearningEntryBeforeDeadline(
    input.munin,
    prepared.attemptOutcomeRef.namespace,
    prepared.attemptOutcomeRef.key,
    signal,
  );
  if (signal.aborted) return null;
  if (existingOutcome) {
    if (!sameClassification(existingOutcome.classification, input.taskClassification)) return null;
    try {
      const evidence = validatePreparedLearningTaskOutcome(
        prepared,
        learningTaskExecutionEvidenceSchema.parse(parseJson(existingOutcome.content)),
      );
      return evidence.state === "m5-admitted" && evidence.evidenceAccepted
        ? {
            evidence,
            huginTaskIdentity: attemptStart.huginTaskIdentity,
            classification: input.taskClassification,
          }
        : null;
    } catch {
      return null;
    }
  }

  const evidence = await recoverPreparedLearningTaskDispatch({
    prepared,
    replayPayload: replay,
    gatewayBaseUrl: input.gateway.baseUrl,
    apiKey: input.gateway.apiKey,
    signal,
    fetchImpl: input.fetchImpl,
  });
  if (evidence.state !== "m5-admitted" || !evidence.evidenceAccepted) return null;
  try {
    return {
      evidence: validatePreparedLearningTaskOutcome(prepared, evidence),
      huginTaskIdentity: attemptStart.huginTaskIdentity,
      classification: input.taskClassification,
    };
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
