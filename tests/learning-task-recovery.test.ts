import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { MuninClient, MuninEntry } from "../src/munin-client.js";
import {
  createLearningTaskAttemptStart,
  durableLearningTaskAttemptStart,
  jcsCanonicalize,
  learningTaskAttemptKey,
  learningTaskExecutionEvidenceSchema,
  requestStampDigest,
} from "../src/learning-task-handshake.js";
import {
  recoverAmbiguousStoredLearningTaskCandidate,
  recoverLatestStoredLearningTaskAttempt,
  recoverStoredLearningTaskCandidate,
} from "../src/learning-task-recovery.js";
import {
  withLearningTaskContext,
  withLearningTaskGatewayEcho,
} from "./helpers/learning-task.js";
import type { HomeserverTaskConfig } from "../src/homeserver-executor.js";

const TASK_ID = "learning-recovery-1";
const CLASSIFICATION = "client-confidential";

function entry(
  key: string,
  content: unknown,
  classification = CLASSIFICATION,
): MuninEntry {
  return {
    id: `tasks/${TASK_ID}/${key}`,
    namespace: `tasks/${TASK_ID}`,
    key,
    content: JSON.stringify(content),
    tags: [],
    classification,
    created_at: "2026-07-19T10:00:00.000Z",
    updated_at: "2026-07-19T10:00:01.000Z",
  };
}

function fixture() {
  const base = {
    prompt: "Recover the exact durable learning attempt.",
    gatewayBaseUrl: "https://m5.test",
    apiKey: "owner-key",
    path: "delegate",
    taskType: "summarize",
    timeoutMs: 30_000,
    maxOutputChars: 4_096,
  } satisfies HomeserverTaskConfig;
  const task = withLearningTaskContext(base, TASK_ID);
  if (task.learningTask?.kind !== "ready") throw new Error("fixture is not learning-ready");
  const prepared = task.learningTask.preparedDispatch;
  const start = durableLearningTaskAttemptStart(task.learningTask.context.attempt);
  const replay = task.learningTask.replayPayload;
  const entries = new Map<string, MuninEntry>([
    [prepared.attemptStartRef.key, entry(prepared.attemptStartRef.key, start)],
    [prepared.preparedDispatchRef.key, entry(prepared.preparedDispatchRef.key, prepared)],
    [prepared.replayPayloadRef.key, entry(prepared.replayPayloadRef.key, replay)],
  ]);
  const writes: unknown[][] = [];
  const client = {
    read: async (_namespace: string, key: string) => entries.get(key) ?? null,
    write: async (...args: unknown[]) => {
      writes.push(args);
      const [namespace, key, content, tags, , classification] = args as [
        string,
        string,
        string,
        string[],
        string | undefined,
        string | undefined,
      ];
      entries.set(key, {
        ...entry(key, JSON.parse(content), classification),
        namespace,
        tags,
      });
      return { status: "created" };
    },
  } as unknown as MuninClient;
  const responseBody = withLearningTaskGatewayEcho(task, TASK_ID, {
    learningTaskAdmission: { recovered: true, outcomeAvailable: false },
  });
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  return { task, prepared, start, entries, writes, client, fetchImpl };
}

function transportFailure(input: ReturnType<typeof fixture>) {
  const stamp = input.prepared.requestStamp;
  return learningTaskExecutionEvidenceSchema.parse({
    schemaVersion: 1,
    contractVersion: "grimnir.learning-task/v1",
    state: "m5-not-admitted",
    evidenceAccepted: false,
    taskId: input.prepared.taskId,
    attemptId: input.prepared.attemptId,
    attemptStartedAt: input.prepared.attemptStartedAt,
    attemptStartRef: input.prepared.attemptStartRef,
    preparedDispatchRef: input.prepared.preparedDispatchRef,
    replayPayloadRef: input.prepared.replayPayloadRef,
    replayPayloadDigest: input.prepared.replayPayloadDigest,
    taskOutcomeRef: input.prepared.taskOutcomeRef,
    rawFingerprint: stamp.raw_fingerprint,
    requestStamp: stamp,
    requestStampDigest: requestStampDigest(stamp),
    failureCode: "transport-not-admitted",
    failureReason: "gateway request failed before an exact admission echo",
  });
}

async function recover(input: ReturnType<typeof fixture>) {
  return recoverStoredLearningTaskCandidate({
    munin: input.client,
    taskNamespace: `tasks/${TASK_ID}`,
    taskClassification: CLASSIFICATION,
    preparedEntry: entry(
      input.prepared.preparedDispatchRef.key,
      input.prepared,
    ),
    gateway: { baseUrl: "https://m5.test", apiKey: "owner-key" },
    fetchImpl: input.fetchImpl as typeof fetch,
  });
}

describe("stored LearningTaskContract recovery", () => {
  it("immediately probes the exact classified stored attempt without persisting a second outcome", async () => {
    const input = fixture();
    const recovered = await recoverAmbiguousStoredLearningTaskCandidate({
      munin: input.client,
      taskNamespace: `tasks/${TASK_ID}`,
      taskClassification: CLASSIFICATION,
      preparedDispatchRef: input.prepared.preparedDispatchRef,
      failureEvidence: transportFailure(input),
      gateway: { baseUrl: "https://m5.test", apiKey: "owner-key" },
      fetchImpl: input.fetchImpl as typeof fetch,
    });

    expect(recovered?.evidence).toMatchObject({ state: "m5-admitted", evidenceAccepted: true });
    expect(recovered?.classification).toBe(CLASSIFICATION);
    expect(input.fetchImpl).toHaveBeenCalledTimes(1);
    expect((input.fetchImpl.mock.calls[0]?.[1] as RequestInit).body)
      .toBe(JSON.stringify(input.task.learningTask!.kind === "ready"
        ? input.task.learningTask.replayPayload.requestBody
        : null));
    expect(input.writes).toHaveLength(0);
  });

  it("does not probe when immediate recovery storage classification differs", async () => {
    const input = fixture();
    input.entries.set(
      input.prepared.preparedDispatchRef.key,
      entry(input.prepared.preparedDispatchRef.key, input.prepared, "internal"),
    );
    const recovered = await recoverAmbiguousStoredLearningTaskCandidate({
      munin: input.client,
      taskNamespace: `tasks/${TASK_ID}`,
      taskClassification: CLASSIFICATION,
      preparedDispatchRef: input.prepared.preparedDispatchRef,
      failureEvidence: transportFailure(input),
      gateway: { baseUrl: "https://m5.test", apiKey: "owner-key" },
      fetchImpl: input.fetchImpl as typeof fetch,
    });

    expect(recovered).toBeNull();
    expect(input.fetchImpl).not.toHaveBeenCalled();
    expect(input.writes).toHaveLength(0);
  });

  it("does not probe past a differently classified existing outcome", async () => {
    const input = fixture();
    input.entries.set(
      input.prepared.attemptOutcomeRef.key,
      entry(input.prepared.attemptOutcomeRef.key, transportFailure(input), "internal"),
    );
    const recovered = await recoverAmbiguousStoredLearningTaskCandidate({
      munin: input.client,
      taskNamespace: `tasks/${TASK_ID}`,
      taskClassification: CLASSIFICATION,
      preparedDispatchRef: input.prepared.preparedDispatchRef,
      failureEvidence: transportFailure(input),
      gateway: { baseUrl: "https://m5.test", apiKey: "owner-key" },
      fetchImpl: input.fetchImpl as typeof fetch,
    });

    expect(recovered).toBeNull();
    expect(input.fetchImpl).not.toHaveBeenCalled();
    expect(input.writes).toHaveLength(0);
  });

  it("bounds stalled storage lookup and never starts a late gateway probe", async () => {
    const input = fixture();
    const stalledClient = {
      read: async () => new Promise<MuninEntry | null>(() => {}),
    } as unknown as MuninClient;
    const recovered = await recoverAmbiguousStoredLearningTaskCandidate({
      munin: stalledClient,
      taskNamespace: `tasks/${TASK_ID}`,
      taskClassification: CLASSIFICATION,
      preparedDispatchRef: input.prepared.preparedDispatchRef,
      failureEvidence: transportFailure(input),
      gateway: { baseUrl: "https://m5.test", apiKey: "owner-key" },
      timeoutMs: 20,
      fetchImpl: input.fetchImpl as typeof fetch,
    });

    expect(recovered).toBeNull();
    expect(input.fetchImpl).not.toHaveBeenCalled();
  });

  it("loads the immutable attempt start, preserves its full identity, and classifies output", async () => {
    const input = fixture();
    const recovered = await recover(input);

    expect(recovered?.huginTaskIdentity).toEqual(input.start.huginTaskIdentity);
    expect(recovered?.evidence).toMatchObject({
      state: "m5-admitted",
      evidenceAccepted: true,
    });
    expect(recovered?.classification).toBe(CLASSIFICATION);
    expect(input.writes).toHaveLength(1);
    expect(input.writes[0]?.[1]).toBe(input.prepared.attemptOutcomeRef.key);
    expect(input.writes[0]?.[5]).toBe(CLASSIFICATION);
  });

  it("fails closed on prepared and replay classification drift", async () => {
    const preparedDrift = fixture();
    const preparedResult = await recoverStoredLearningTaskCandidate({
      munin: preparedDrift.client,
      taskNamespace: `tasks/${TASK_ID}`,
      taskClassification: CLASSIFICATION,
      preparedEntry: entry(
        preparedDrift.prepared.preparedDispatchRef.key,
        preparedDrift.prepared,
        "public",
      ),
      gateway: { baseUrl: "https://m5.test", apiKey: "owner-key" },
      fetchImpl: preparedDrift.fetchImpl as typeof fetch,
    });
    expect(preparedResult).toBeNull();
    expect(preparedDrift.fetchImpl).not.toHaveBeenCalled();
    expect(preparedDrift.writes).toHaveLength(0);

    const replayDrift = fixture();
    const replay = replayDrift.entries.get(replayDrift.prepared.replayPayloadRef.key)!;
    replay.classification = "public";
    const replayResult = await recover(replayDrift);
    expect(replayResult?.evidence).toMatchObject({
      state: "join-failed",
      evidenceAccepted: false,
      failureCode: "recovery-unavailable",
    });
    expect(replayResult?.evidence.failureReason).toMatch(/classification/i);
    expect(replayDrift.fetchImpl).not.toHaveBeenCalled();
    expect(replayDrift.writes[0]?.[5]).toBe(CLASSIFICATION);
  });

  it("rejects a differently classified existing outcome instead of trusting it", async () => {
    const first = fixture();
    const accepted = await recover(first);
    expect(accepted).not.toBeNull();

    const second = fixture();
    second.entries.set(
      second.prepared.attemptOutcomeRef.key,
      entry(second.prepared.attemptOutcomeRef.key, accepted!.evidence, "public"),
    );
    const rejected = await recover(second);

    expect(rejected?.evidence).toMatchObject({
      state: "join-failed",
      evidenceAccepted: false,
      failureCode: "attempt-outcome-persistence-failed",
      attemptOutcomeRef: undefined,
    });
    expect(rejected?.evidence.failureReason).toMatch(/classification/i);
    expect(second.fetchImpl).not.toHaveBeenCalled();
    expect(second.writes).toHaveLength(0);

    const malformed = fixture();
    malformed.entries.set(
      malformed.prepared.attemptOutcomeRef.key,
      { ...entry(malformed.prepared.attemptOutcomeRef.key, {}), content: "not-json" },
    );
    const malformedResult = await recover(malformed);
    expect(malformedResult?.evidence).toMatchObject({
      evidenceAccepted: false,
      failureCode: "attempt-outcome-persistence-failed",
      attemptOutcomeRef: undefined,
    });
    expect(malformed.fetchImpl).not.toHaveBeenCalled();
  });

  it("validates stored replay bytes and the complete attempt-start identity before an existing outcome", async () => {
    const digestMismatch = fixture();
    const accepted = await recover(digestMismatch);
    expect(accepted?.evidence.evidenceAccepted).toBe(true);
    const storedReplay = JSON.parse(
      digestMismatch.entries.get(digestMismatch.prepared.replayPayloadRef.key)!.content,
    ) as { requestBody: { prompt: string } };
    storedReplay.requestBody.prompt += " tampered";
    digestMismatch.entries.set(
      digestMismatch.prepared.replayPayloadRef.key,
      entry(digestMismatch.prepared.replayPayloadRef.key, storedReplay),
    );
    digestMismatch.fetchImpl.mockClear();
    const digestRejected = await recover(digestMismatch);
    expect(digestRejected?.evidence.evidenceAccepted).toBe(false);
    expect(digestMismatch.fetchImpl).not.toHaveBeenCalled();

    const identityMismatch = fixture();
    const identityAccepted = await recover(identityMismatch);
    expect(identityAccepted?.evidence.evidenceAccepted).toBe(true);
    const identityReplay = JSON.parse(
      identityMismatch.entries.get(identityMismatch.prepared.replayPayloadRef.key)!.content,
    ) as {
      requestBody: {
        huginTaskIdentity: {
          renderedPromptFingerprint: { digest: string };
        };
      };
    };
    identityReplay.requestBody.huginTaskIdentity.renderedPromptFingerprint.digest = "f".repeat(64);
    const replayDigest = createHash("sha256")
      .update(jcsCanonicalize(identityReplay), "utf8")
      .digest("hex");
    identityMismatch.prepared.replayPayloadDigest.digest = replayDigest;
    identityMismatch.entries.set(
      identityMismatch.prepared.replayPayloadRef.key,
      entry(identityMismatch.prepared.replayPayloadRef.key, identityReplay),
    );
    const apparentlyBoundOutcome = structuredClone(identityAccepted!.evidence);
    apparentlyBoundOutcome.replayPayloadDigest!.digest = replayDigest;
    identityMismatch.entries.set(
      identityMismatch.prepared.attemptOutcomeRef.key,
      entry(identityMismatch.prepared.attemptOutcomeRef.key, apparentlyBoundOutcome),
    );
    identityMismatch.fetchImpl.mockClear();
    const identityRejected = await recover(identityMismatch);
    expect(identityRejected?.evidence.evidenceAccepted).toBe(false);
    expect(identityMismatch.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a changed stored prompt even when replay and outcome digests are updated consistently", async () => {
    const input = fixture();
    const accepted = await recover(input);
    expect(accepted?.evidence.evidenceAccepted).toBe(true);

    const changedReplay = JSON.parse(
      input.entries.get(input.prepared.replayPayloadRef.key)!.content,
    ) as {
      requestBody: {
        prompt: string;
        huginTaskIdentity: {
          rawTaskFingerprint: { digest: string };
        };
      };
    };
    const originalRawDigest = changedReplay.requestBody.huginTaskIdentity.rawTaskFingerprint.digest;
    changedReplay.requestBody.prompt += " attacker-controlled suffix";
    const changedReplayDigest = createHash("sha256")
      .update(jcsCanonicalize(changedReplay), "utf8")
      .digest("hex");
    input.prepared.replayPayloadDigest.digest = changedReplayDigest;
    input.entries.set(
      input.prepared.replayPayloadRef.key,
      entry(input.prepared.replayPayloadRef.key, changedReplay),
    );
    const consistentlyUpdatedOutcome = structuredClone(accepted!.evidence);
    consistentlyUpdatedOutcome.replayPayloadDigest!.digest = changedReplayDigest;
    input.entries.set(
      input.prepared.attemptOutcomeRef.key,
      entry(input.prepared.attemptOutcomeRef.key, consistentlyUpdatedOutcome),
    );
    input.fetchImpl.mockClear();

    const rejected = await recover(input);
    expect(rejected?.evidence).toMatchObject({
      evidenceAccepted: false,
      failureCode: "attempt-outcome-persistence-failed",
      attemptOutcomeRef: undefined,
    });
    expect(changedReplay.requestBody.huginTaskIdentity.rawTaskFingerprint.digest)
      .toBe(originalRawDigest);
    expect(input.fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the replay-provided raw identity bound to the immutable attempt start", async () => {
    const input = fixture();
    const accepted = await recover(input);
    expect(accepted?.evidence.evidenceAccepted).toBe(true);

    const changedReplay = JSON.parse(
      input.entries.get(input.prepared.replayPayloadRef.key)!.content,
    ) as {
      requestBody: {
        huginTaskIdentity: {
          rawTaskFingerprint: { digest: string };
        };
      };
    };
    changedReplay.requestBody.huginTaskIdentity.rawTaskFingerprint.digest = "e".repeat(64);
    const changedReplayDigest = createHash("sha256")
      .update(jcsCanonicalize(changedReplay), "utf8")
      .digest("hex");
    input.prepared.replayPayloadDigest.digest = changedReplayDigest;
    input.entries.set(
      input.prepared.replayPayloadRef.key,
      entry(input.prepared.replayPayloadRef.key, changedReplay),
    );
    const consistentlyUpdatedOutcome = structuredClone(accepted!.evidence);
    consistentlyUpdatedOutcome.replayPayloadDigest!.digest = changedReplayDigest;
    input.entries.set(
      input.prepared.attemptOutcomeRef.key,
      entry(input.prepared.attemptOutcomeRef.key, consistentlyUpdatedOutcome),
    );
    input.fetchImpl.mockClear();

    const rejected = await recover(input);
    expect(rejected?.evidence).toMatchObject({
      evidenceAccepted: false,
      failureCode: "attempt-outcome-persistence-failed",
      attemptOutcomeRef: undefined,
    });
    expect(input.fetchImpl).not.toHaveBeenCalled();
  });

  it("anchors recovery on the latest attempt start and never falls back to an older prepared attempt", async () => {
    const input = fixture();
    const latestAttempt = createLearningTaskAttemptStart({
      taskId: TASK_ID,
      attemptId: "hugin-attempt:99999999-9999-4999-8999-999999999999",
      startedAt: "2026-07-19T10:00:02.000Z",
      rawTaskText: input.task.prompt,
      renderedPrompt: input.task.learningTask!.kind === "ready"
        ? input.task.learningTask.context.attempt.renderedPrompt
        : "unreachable",
    });
    const latestKey = learningTaskAttemptKey(latestAttempt.attemptId);
    const latestEntry = {
      ...entry(latestKey, durableLearningTaskAttemptStart(latestAttempt)),
      tags: ["learning-task-attempt", "attempt:started"],
      updated_at: "2026-07-19T10:00:03.000Z",
    };
    input.entries.set(latestKey, latestEntry);
    const olderStart = input.entries.get(input.prepared.attemptStartRef.key)!;
    Object.assign(input.client as object, {
      query: async () => ({
        results: [
          { ...olderStart, entry_type: "state", content_preview: "" },
          { ...latestEntry, entry_type: "state", content_preview: "" },
        ],
        total: 2,
      }),
    });

    const recovered = await recoverLatestStoredLearningTaskAttempt({
      munin: input.client,
      taskNamespace: `tasks/${TASK_ID}`,
      taskClassification: CLASSIFICATION,
      gateway: { baseUrl: "https://m5.test", apiKey: "owner-key" },
      fetchImpl: input.fetchImpl as typeof fetch,
    });

    expect(recovered?.evidence).toMatchObject({
      taskId: TASK_ID,
      attemptId: latestAttempt.attemptId,
      state: "preflight-failed",
      evidenceAccepted: false,
      failureCode: "recovery-unavailable",
    });
    expect(recovered?.evidence.requestStamp).toBeUndefined();
    expect(recovered?.evidence.attemptOutcomeRef).toBeUndefined();
    expect(recovered?.huginTaskIdentity).toEqual(latestAttempt.huginTaskIdentity);
    expect(input.fetchImpl).not.toHaveBeenCalled();
    expect(input.writes).toHaveLength(0);
  });

  it("recovers only the prepared row derived from the authoritative latest start", async () => {
    const input = fixture();
    const startEntry = {
      ...input.entries.get(input.prepared.attemptStartRef.key)!,
      tags: ["learning-task-attempt", "attempt:started"],
    };
    input.entries.set(
      input.prepared.preparedDispatchRef.key,
      {
        ...entry(input.prepared.preparedDispatchRef.key, input.prepared),
        tags: ["learning-task-dispatch", "attempt:prepared"],
      },
    );
    Object.assign(input.client as object, {
      query: async () => ({
        results: [{ ...startEntry, entry_type: "state", content_preview: "" }],
        total: 1,
      }),
    });

    const recovered = await recoverLatestStoredLearningTaskAttempt({
      munin: input.client,
      taskNamespace: `tasks/${TASK_ID}`,
      taskClassification: CLASSIFICATION,
      gateway: { baseUrl: "https://m5.test", apiKey: "owner-key" },
      fetchImpl: input.fetchImpl as typeof fetch,
    });

    expect(recovered?.evidence).toMatchObject({
      attemptId: input.start.attemptId,
      state: "m5-admitted",
      evidenceAccepted: true,
    });
    expect(recovered?.huginTaskIdentity).toEqual(input.start.huginTaskIdentity);
  });

  it("turns a new immutable outcome write failure into truthful no-ref evidence", async () => {
    const input = fixture();
    Object.assign(input.client as object, {
      write: async () => {
        throw new Error(`Munin unavailable ${"x".repeat(600)}`);
      },
    });

    const recovered = await recover(input);
    expect(recovered).toMatchObject({
      evidence: {
        state: "join-failed",
        evidenceAccepted: false,
        failureCode: "attempt-outcome-persistence-failed",
        attemptOutcomeRef: undefined,
      },
    });
    expect(recovered?.evidence.failureReason).toHaveLength(512);
  });
});
