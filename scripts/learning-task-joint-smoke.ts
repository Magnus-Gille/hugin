#!/usr/bin/env tsx
/**
 * LearningTaskContract v1 joint live-smoke gate (issue #240).
 *
 * Turns the manual "Joint live-smoke gate" procedure in
 * docs/learning-task-handshake.md into a committed, repeatable check. Two
 * independent modes:
 *
 *   --mode=live      Submits one real authenticated Broker `homeserver` task
 *                     against the deployed M5 gateway and verifies the five
 *                     documented gate points against the durable Munin
 *                     evidence. Never run in CI. Requires explicit
 *                     credentials (below) and a caller-supplied --nonce; it
 *                     never generates the smoke identity itself.
 *
 *   --mode=negative   Spins an in-process, loopback-only stub HTTP server
 *                     that advertises an intentionally unsupported
 *                     LearningTaskContract preflight (a missing required
 *                     feature), drives one real attempt through the real
 *                     producer code against that stub, and asserts: negative
 *                     attempt evidence is durably recorded, the stub's
 *                     `/delegate` endpoint is never hit, and no accepted
 *                     output is published. Fully local — safe for CI. Also
 *                     exercised by tests/learning-task-joint-smoke.test.ts.
 *
 * Per the doc's binding warning, downgrade/replay simulation is NEVER run
 * against the production gateway epoch — --mode=negative talks only to a
 * loopback stub this process starts and stops itself.
 *
 * Both modes reuse the real digest/canonicalization/validation functions
 * from src/learning-task-handshake.ts, src/task-result-schema.ts, and
 * src/homeserver-executor.ts. This script adds no new src/ exports and makes
 * no src/ runtime changes.
 *
 * --mode=live required env (standard Hugin Broker/Munin vars):
 *   HUGIN_BROKER_URL       e.g. http://huginmunin.tail-scale.ts.net:3033
 *   HUGIN_BROKER_TOKEN     bearer token registered in HUGIN_BROKER_KEYS
 *   HUGIN_BROKER_SUBMITTER orchestrator_submitter principal for that token
 *                          (must exactly match the principal HUGIN_BROKER_KEYS
 *                          maps the token to; the Broker rejects a mismatch)
 *   MUNIN_URL              e.g. http://huginmunin.tail-scale.ts.net:3030
 *   MUNIN_API_KEY          Munin credential with read access to tasks/*
 *
 * Usage:
 *   tsx scripts/learning-task-joint-smoke.ts --mode=negative
 *   tsx scripts/learning-task-joint-smoke.ts --mode=live --nonce=<unique-token> \
 *     [--task-type=qa-factual] [--timeout-ms=300000] [--poll-ms=3000]
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { BrokerClient } from "../src/mcp/broker-client.js";
import { delegationRequestSchema, submitResponseSchema, taskTypeSchema } from "../src/broker/types.js";
import { ACTIVE_ALIAS_MAP } from "../src/runtime-registry.js";
import { structuredTaskResultSchema } from "../src/task-result-schema.js";
import { MuninClient, type MuninEntry } from "../src/munin-client.js";
import { createImmutableLearningArtifact } from "../src/learning-task-store.js";
import {
  buildFreshHomeserverDelegateRequestBody,
  executeHomeserverTask,
  renderHomeserverUserMessage,
  type HomeserverTaskConfig,
} from "../src/homeserver-executor.js";
import {
  LEARNING_TASK_CAPABILITIES,
  LEARNING_TASK_FEATURES,
  createPreparedLearningTaskDispatch,
  learningTaskAttemptKey,
  learningTaskExecutionEvidenceSchema,
  learningTaskPreparedDispatchKey,
  learningTaskReplayPayloadKey,
  prepareDurableLearningTaskAttempt,
  preparedLearningTaskDispatchSchema,
  validateLearningTaskGatewayEcho,
  validatePreparedLearningTaskAttemptStart,
  validatePreparedLearningTaskOutcome,
  validatePreparedLearningTaskReplayPayload,
  type LearningTaskPreparation,
} from "../src/learning-task-handshake.js";

// --- Shared helpers -------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`missing required environment variable ${name}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Precise per-gate failure so callers see exactly which documented gate point tripped. */
export class SmokeGateError extends Error {
  constructor(public readonly gate: number, message: string) {
    super(`gate ${gate}: ${message}`);
    this.name = "SmokeGateError";
  }
}

function failGate(gate: number, message: string): never {
  throw new SmokeGateError(gate, message);
}

const NONCE_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

function nonceToken(nonce: string): string {
  return `grimnir-joint-smoke-${nonce}`;
}

function buildSmokePrompt(token: string): string {
  return [
    "This is an automated infrastructure connectivity check for the Hugin/Gille",
    "LearningTaskContract joint smoke gate (grimnir#58 / hugin#240). It is not a",
    "real question. Reply with exactly this token and nothing else — no",
    "punctuation, no explanation, no extra whitespace:",
    "",
    token,
  ].join("\n");
}

// --- Mode A: live positive smoke -------------------------------------------

export interface LiveSmokeOptions {
  /** Caller-supplied unique identity for this run. Never generated silently. */
  nonce: string;
  brokerUrl: string;
  brokerToken: string;
  /** Must exactly match the principal HUGIN_BROKER_KEYS maps brokerToken to. */
  submitter: string;
  muninUrl: string;
  muninApiKey: string;
  taskType?: string;
  timeoutMs?: number;
  pollMs?: number;
  deadlineBufferMs?: number;
}

export interface LiveSmokeEvidence {
  taskId: string;
  attemptId: string;
  namespace: string;
  state: string;
  requestStampDigest: string;
  replayPayloadDigest: string;
  gatewayEchoDigest: string;
  refs: {
    attemptStart: { namespace: string; key: string };
    prepared: { namespace: string; key: string };
    replay: { namespace: string; key: string };
    outcome: { namespace: string; key: string };
  };
  gatesPassed: readonly [1, 2, 3, 4, 5];
  roundTripSane: boolean;
}

const awaitResponseSchema = z.object({
  status: z.enum(["completed", "failed", "running", "unknown"]),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  reason: z.string().optional(),
});

async function pollUntilTerminal(
  broker: BrokerClient,
  taskId: string,
  opts: { pollMs: number; deadlineMs: number },
): Promise<z.infer<typeof awaitResponseSchema>> {
  const deadline = Date.now() + opts.deadlineMs;
  for (;;) {
    const parsed = awaitResponseSchema.parse(await broker.await_({ task_id: taskId }));
    if (parsed.status !== "running") return parsed;
    if (Date.now() >= deadline) {
      throw new Error(
        `joint smoke timed out after ${opts.deadlineMs}ms waiting for task ${taskId} to leave "running"`,
      );
    }
    await sleep(opts.pollMs);
  }
}

/**
 * Submit one authenticated Broker `homeserver` task with an innocuous unique
 * prompt embedding `opts.nonce`, await its terminal ordinary result, then
 * verify the five gate points from docs/learning-task-handshake.md's "Joint
 * live-smoke gate" section against the durable Munin evidence. Throws
 * SmokeGateError (or a plain Error for setup/transport failures) with a
 * precise reason on any failure.
 */
export async function runLiveSmoke(opts: LiveSmokeOptions): Promise<LiveSmokeEvidence> {
  if (!NONCE_PATTERN.test(opts.nonce)) {
    throw new Error(`--nonce must match ${NONCE_PATTERN} (got ${JSON.stringify(opts.nonce)})`);
  }
  const token = nonceToken(opts.nonce);
  const prompt = buildSmokePrompt(token);
  const taskType = taskTypeSchema.parse(opts.taskType ?? "qa-factual");
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 3_000;
  const deadlineMs = timeoutMs + (opts.deadlineBufferMs ?? 120_000);

  const broker = new BrokerClient({ baseUrl: opts.brokerUrl, bearerToken: opts.brokerToken });
  const munin = new MuninClient({ baseUrl: opts.muninUrl, apiKey: opts.muninApiKey });

  const payload = delegationRequestSchema.parse({
    envelope_version: 2,
    idempotency_key: randomUUID(),
    orchestrator_session_id: randomUUID(),
    orchestrator_submitter: opts.submitter,
    task_type: taskType,
    prompt,
    alias_requested: "m5",
    alias_map_version: ACTIVE_ALIAS_MAP.version,
    sensitivity: "internal",
    timeout_ms: timeoutMs,
    max_output_tokens: 256,
    acceptance: { mode: "verifier", verifier: { type: "containsAll", subs: [token] } },
    allowed_destinations: ["m5"],
    tool_policy: { mode: "none" },
    budget: { max_attempts: 1, max_cost_usd: 0 },
    durability: "required",
    delivery: { mode: "munin" },
    escalation: { mode: "return_to_l1" },
  });

  const submitResponse = submitResponseSchema.parse(await broker.submit(payload));
  const taskId = submitResponse.task_id;
  process.stderr.write(
    `[joint-smoke] submitted ${taskId} (reused_idempotency=${submitResponse.reused_idempotency})\n`,
  );

  const terminal = await pollUntilTerminal(broker, taskId, { pollMs, deadlineMs });
  if (terminal.status === "unknown") {
    throw new Error(`Broker has no record of task ${taskId}`);
  }
  if (terminal.status === "failed") {
    throw new Error(
      `ordinary task failed before learning-task evidence could be checked: ${JSON.stringify(terminal.error ?? {})}`,
    );
  }

  const structured = structuredTaskResultSchema.parse(terminal.result);
  if (structured.taskId !== taskId) {
    throw new Error("structured result task id does not match the submitted task");
  }
  const roundTripSane = structured.bodyText.includes(token);
  if (!roundTripSane) {
    process.stderr.write(
      "[joint-smoke] warning: ordinary task output did not visibly contain the smoke token; " +
        "continuing to check learning-task evidence anyway (ordinary output is outside the " +
        "content-blind evidence projection)\n",
    );
  }

  const learning = structured.runtimeMetadata?.learningTask;
  if (!learning) {
    throw new Error(
      "result-structured carries no LearningTaskContract evidence; this task never entered the " +
        "producer handshake (authenticated source rejected, or effective runtime was not homeserver)",
    );
  }

  // ---- Gate 1: start, classified replay, and content-blind prepared keys exist;
  //              start timestamp precedes the embedded stamp. ----
  const preparedKey = learningTaskPreparedDispatchKey(learning.attemptId);
  const preparedEntry = await munin.read(structured.taskNamespace, preparedKey);
  if (!preparedEntry) {
    failGate(1, `content-blind prepared row ${structured.taskNamespace}/${preparedKey} does not exist`);
  }
  const prepared = preparedLearningTaskDispatchSchema.parse(JSON.parse(preparedEntry.content));

  const startEntry = await munin.read(prepared.attemptStartRef.namespace, prepared.attemptStartRef.key);
  if (!startEntry) {
    failGate(
      1,
      `attempt start row ${prepared.attemptStartRef.namespace}/${prepared.attemptStartRef.key} does not exist`,
    );
  }
  const start = validatePreparedLearningTaskAttemptStart(prepared, JSON.parse(startEntry.content));
  if (!(Date.parse(start.startedAt) <= Date.parse(prepared.requestStamp.stamped_at))) {
    failGate(1, "attempt start timestamp does not precede the embedded request stamp");
  }

  const replayEntry = await munin.read(prepared.replayPayloadRef.namespace, prepared.replayPayloadRef.key);
  if (!replayEntry) {
    failGate(
      1,
      `classified replay row ${prepared.replayPayloadRef.namespace}/${prepared.replayPayloadRef.key} does not exist`,
    );
  }
  const replay = validatePreparedLearningTaskReplayPayload(prepared, JSON.parse(replayEntry.content), start);
  if (replay.taskId !== structured.taskId || replay.attemptId !== learning.attemptId) {
    failGate(1, "classified replay payload does not name the same task and attempt");
  }

  // ---- Gate 2: prepared, outcome, and result-structured rows name the same
  //              task and attempt; every recorded digest recomputes exactly. ----
  const outcomeEntry = await munin.read(prepared.attemptOutcomeRef.namespace, prepared.attemptOutcomeRef.key);
  if (!outcomeEntry) {
    failGate(2, `outcome row ${prepared.attemptOutcomeRef.namespace}/${prepared.attemptOutcomeRef.key} does not exist`);
  }
  // validatePreparedLearningTaskOutcome recomputes and cross-checks every
  // request-stamp/gateway-echo digest via the real learning-task-handshake.ts
  // schemas' superRefine chains — that recompute IS this gate.
  const outcome = validatePreparedLearningTaskOutcome(prepared, JSON.parse(outcomeEntry.content));
  if (
    outcome.taskId !== structured.taskId
    || outcome.attemptId !== learning.attemptId
    || learning.taskId !== outcome.taskId
    || learning.attemptId !== outcome.attemptId
    || prepared.taskId !== structured.taskId
  ) {
    failGate(2, "prepared/outcome/result-structured rows do not name the same task and attempt");
  }

  // ---- Gate 3: the exact gateway echo validates and the state is m5-admitted. ----
  if (outcome.state !== "m5-admitted" || outcome.evidenceAccepted !== true || !outcome.gatewayEcho || !outcome.gatewayEchoDigest) {
    failGate(3, `attempt outcome state is "${outcome.state}", not an accepted m5-admitted echo`);
  }

  // ---- Gate 4: the M5 admission/model clocks follow the stamp clock. ----
  // Re-validate against the real current wall clock (not admitted_at reused as
  // its own observation instant, as the internal recovery path does) so this
  // is a genuine "admission happened before now, after the stamp" recheck.
  let gatewayEchoDigest: string;
  try {
    const echo = validateLearningTaskGatewayEcho(outcome.gatewayEcho, prepared.requestStamp, new Date());
    gatewayEchoDigest = outcome.gatewayEchoDigest.digest;
    void echo;
  } catch (err) {
    failGate(4, err instanceof Error ? err.message : String(err));
  }

  // ---- Gate 5: learning-task attempt/admission rows expose only IDs/digests —
  //              not the smoke prompt or nonce bytes. The classified replay row
  //              legitimately carries the request bytes and is exempt (docs:
  //              "Only the replay payload contains request bytes; it ... is
  //              not learning evidence"). The ordinary task result/log are
  //              explicitly outside this projection and are not checked here. ----
  const forbidden = [token, prompt];
  const contentBlindRows: Array<[string, MuninEntry]> = [
    ["attempt-start", startEntry],
    ["prepared-dispatch", preparedEntry],
    ["outcome", outcomeEntry],
  ];
  for (const [label, checkedEntry] of contentBlindRows) {
    for (const needle of forbidden) {
      if (checkedEntry.content.includes(needle)) {
        failGate(5, `${label} row leaks the smoke prompt or nonce bytes`);
      }
    }
  }

  return {
    taskId,
    attemptId: learning.attemptId,
    namespace: structured.taskNamespace,
    state: outcome.state,
    requestStampDigest: prepared.requestStampDigest.digest,
    replayPayloadDigest: prepared.replayPayloadDigest.digest,
    gatewayEchoDigest,
    refs: {
      attemptStart: prepared.attemptStartRef,
      prepared: { namespace: structured.taskNamespace, key: preparedKey },
      replay: prepared.replayPayloadRef,
      outcome: prepared.attemptOutcomeRef,
    },
    gatesPassed: [1, 2, 3, 4, 5],
    roundTripSane,
  };
}

// --- Mode B: local negative gate -------------------------------------------

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Loopback-only stub gateway that advertises an intentionally unsupported
 * LearningTaskContract preflight (missing a required feature — the real
 * negative semantics enforced by capabilitySchema in
 * src/learning-task-handshake.ts) and fails the test if `/delegate` is ever
 * hit. Never reachable off 127.0.0.1.
 */
async function startNegativeGateStub(): Promise<{
  baseUrl: string;
  delegateHit: () => boolean;
  close: () => Promise<void>;
}> {
  let delegateHit = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/portal/me") {
      respondJson(res, 200, { alias: "joint-smoke-negative-owner", tier: "owner" });
      return;
    }
    if (req.method === "GET" && url === "/v1/capabilities/learning-task") {
      const now = new Date();
      // Intentionally unsupported: drop one required feature. This fails
      // capabilitySchema's length/completeness refine in
      // src/learning-task-handshake.ts — the real negative-advertisement path,
      // not a reimplementation of it.
      const downgradedFeatures = LEARNING_TASK_FEATURES.filter(
        (feature) => feature !== "reproducible-serving-digests-v1",
      );
      respondJson(res, 200, {
        advertisement_id: `opaque:${randomUUID()}`,
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        advertised_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
        authenticated_principal_id: "service:gille-inference",
        authentication: "service-auth",
        capabilities: {
          contract_version: LEARNING_TASK_CAPABILITIES.contract_version,
          schema_revision: LEARNING_TASK_CAPABILITIES.schema_revision,
          features: downgradedFeatures,
        },
      });
      return;
    }
    if (req.method === "POST" && url === "/delegate") {
      delegateHit = true;
      respondJson(res, 500, { error: "negative-gate stub must never receive a model call" });
      return;
    }
    respondJson(res, 404, { error: "not_found" });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    delegateHit: () => delegateHit,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}

/** Minimal in-memory Munin double — read/write only, exactly what the producer path needs. */
class InProcessLearningMunin {
  private readonly rows = new Map<string, MuninEntry>();

  async read(namespace: string, key: string): Promise<(MuninEntry & { found: true }) | null> {
    const row = this.rows.get(`${namespace}::${key}`);
    return row ? { ...row, found: true } : null;
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    _expectedUpdatedAt?: string,
    classification?: string,
    _createIfAbsent?: boolean,
  ): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    this.rows.set(`${namespace}::${key}`, {
      id: `${namespace}/${key}`,
      namespace,
      key,
      content,
      tags: tags ?? [],
      classification,
      created_at: now,
      updated_at: now,
    });
    return { status: "created" };
  }
}

export interface NegativeGateEvidence {
  taskId: string;
  attemptId: string;
  state: string;
  failureCode?: string;
  delegateHit: boolean;
  attemptStartPersisted: boolean;
  preparedPersisted: boolean;
  replayPersisted: boolean;
  outcomePersisted: boolean;
  executorExitCode: number | "TIMEOUT";
  executorResultText: string | null;
}

/**
 * Drive one attempt against a local stub that advertises an unsupported
 * LearningTaskContract preflight, and verify: negative attempt evidence is
 * durably created, the stub's /delegate is never hit, and no accepted output
 * is published. Fully local (loopback HTTP + an in-memory Munin double) —
 * never touches the production gateway epoch.
 */
export async function runNegativeGate(): Promise<NegativeGateEvidence> {
  const stub = await startNegativeGateStub();
  const workDir = mkdtempSync(join(tmpdir(), "hugin-joint-smoke-negative-"));
  try {
    const munin = new InProcessLearningMunin();
    const taskId = "joint-smoke-negative-gate";
    const taskNs = `tasks/${taskId}`;
    const homeserverTaskConfig: HomeserverTaskConfig = {
      prompt: "Local negative-gate fixture prompt. This text must never leave this process or reach any model.",
      gatewayBaseUrl: stub.baseUrl,
      apiKey: "stub-local-key",
      path: "delegate",
      taskType: "qa-factual",
      timeoutMs: 5_000,
      maxOutputChars: 2_048,
    };
    const startedAt = new Date().toISOString();
    const renderedPrompt = renderHomeserverUserMessage(homeserverTaskConfig);

    const prep = await prepareDurableLearningTaskAttempt({
      taskId,
      startedAt,
      rawTaskText: homeserverTaskConfig.prompt,
      renderedPrompt,
      gatewayBaseUrl: stub.baseUrl,
      apiKey: homeserverTaskConfig.apiKey,
      buildSource: () => ({
        component: "hugin",
        system: "joint-smoke-negative-gate",
        id: taskNs,
        created_at: startedAt,
        accepted_at: startedAt,
        principal: {
          id: "principal:joint-smoke-negative-gate",
          authentication: "verified-signature",
          scope: "owner",
        },
        content_owner: {
          id: "principal:joint-smoke-negative-gate",
          authority: "authenticated-owner",
        },
      }),
      persistStart: async (ref, record) => {
        await createImmutableLearningArtifact(munin, {
          namespace: ref.namespace,
          key: ref.key,
          content: JSON.stringify(record),
          tags: ["learning-task-attempt", "attempt:started", "contract:grimnir-learning-task-v1"],
          classification: "internal",
        });
      },
      // Unreachable on this negative path (the stub's preflight fails first),
      // kept real — not stubbed out — so a future contract loosening that
      // accidentally reaches dispatch here fails loudly instead of silently.
      buildPreparedDispatch: (context) => {
        const requestBody = buildFreshHomeserverDelegateRequestBody(homeserverTaskConfig, taskId, context);
        return createPreparedLearningTaskDispatch({
          context,
          requestStamp: requestBody.learningTaskStamp!,
          requestBody,
        });
      },
      persistReplayPayload: async (ref, record) => {
        await createImmutableLearningArtifact(munin, {
          namespace: ref.namespace,
          key: ref.key,
          content: JSON.stringify(record),
          tags: ["learning-task-replay", "attempt:prepared", "contract:grimnir-learning-task-v1"],
          classification: "internal",
        });
      },
      persistPrepared: async (ref, record) => {
        await createImmutableLearningArtifact(munin, {
          namespace: ref.namespace,
          key: ref.key,
          content: JSON.stringify(record),
          tags: ["learning-task-dispatch", "attempt:prepared", "contract:grimnir-learning-task-v1"],
          classification: "internal",
        });
      },
    });

    if (prep.preparation.kind !== "preflight-failed") {
      throw new Error(
        `negative gate fixture did not reproduce a preflight failure (got "${prep.preparation.kind}"); ` +
          "the stub's missing-feature advertisement no longer trips fetchLearningTaskPreflight",
      );
    }
    const preparation: Extract<LearningTaskPreparation, { kind: "preflight-failed" }> = prep.preparation;

    const executorResult = await executeHomeserverTask(
      { ...homeserverTaskConfig, learningTask: preparation },
      taskId,
      workDir,
    );

    if (stub.delegateHit()) {
      throw new Error("negative gate violated: the stub /delegate endpoint was hit despite a failed preflight");
    }
    if (executorResult.resultText !== null) {
      throw new Error("negative gate violated: executor published accepted output after a failed preflight");
    }
    if (executorResult.exitCode === 0) {
      throw new Error("negative gate violated: executor reported success after a failed preflight");
    }
    if (
      !executorResult.learningTask
      || executorResult.learningTask.state !== "preflight-failed"
      || executorResult.learningTask.evidenceAccepted !== false
    ) {
      throw new Error("negative gate violated: executor did not record preflight-failed evidence");
    }

    // Mirror src/index.ts's own outcome-persistence step so the durable
    // negative evidence is written the same way the real dispatcher writes it.
    const attemptKey = learningTaskAttemptKey(prep.attempt.attemptId);
    const outcomeRef = { namespace: taskNs, key: `${attemptKey}-outcome` };
    const outcomeEvidence = learningTaskExecutionEvidenceSchema.parse({
      ...executorResult.learningTask,
      attemptOutcomeRef: outcomeRef,
    });
    await createImmutableLearningArtifact(munin, {
      namespace: outcomeRef.namespace,
      key: outcomeRef.key,
      content: JSON.stringify(outcomeEvidence),
      tags: ["learning-task-attempt", "attempt:not-admitted", "contract:grimnir-learning-task-v1"],
      classification: "internal",
    });

    const attemptStartEntry = await munin.read(taskNs, attemptKey);
    const preparedEntry = await munin.read(taskNs, learningTaskPreparedDispatchKey(prep.attempt.attemptId));
    const replayEntry = await munin.read(taskNs, learningTaskReplayPayloadKey(prep.attempt.attemptId));
    const outcomeEntry = await munin.read(taskNs, outcomeRef.key);

    if (!attemptStartEntry) {
      throw new Error("negative gate violated: no durable attempt-start evidence was written");
    }
    if (preparedEntry) {
      throw new Error("negative gate violated: a prepared dispatch was written despite the failed preflight");
    }
    if (replayEntry) {
      throw new Error("negative gate violated: a classified replay payload was written despite the failed preflight");
    }
    if (!outcomeEntry) {
      throw new Error("negative gate violated: no durable negative attempt outcome was written");
    }

    return {
      taskId,
      attemptId: prep.attempt.attemptId,
      state: outcomeEvidence.state,
      failureCode: outcomeEvidence.failureCode,
      delegateHit: stub.delegateHit(),
      attemptStartPersisted: true,
      preparedPersisted: false,
      replayPersisted: false,
      outcomePersisted: true,
      executorExitCode: executorResult.exitCode,
      executorResultText: executorResult.resultText,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    await stub.close();
  }
}

// --- CLI ---------------------------------------------------------------

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const args = new Map<string, string | boolean>();
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) args.set(raw.slice(2), true);
    else args.set(raw.slice(2, eq), raw.slice(eq + 1));
  }
  return args;
}

function stringArg(args: Map<string, string | boolean>, name: string): string | undefined {
  const value = args.get(name);
  return typeof value === "string" ? value : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = stringArg(args, "mode");

  if (mode === "negative") {
    const evidence = await runNegativeGate();
    process.stdout.write(`${JSON.stringify({ mode: "negative", ok: true, evidence }, null, 2)}\n`);
    return;
  }

  if (mode === "live") {
    const nonce = stringArg(args, "nonce");
    if (!nonce) {
      throw new Error("--mode=live requires --nonce=<caller-supplied unique token>");
    }
    const timeoutMsArg = stringArg(args, "timeout-ms");
    const pollMsArg = stringArg(args, "poll-ms");
    const evidence = await runLiveSmoke({
      nonce,
      brokerUrl: requiredEnv("HUGIN_BROKER_URL"),
      brokerToken: requiredEnv("HUGIN_BROKER_TOKEN"),
      submitter: requiredEnv("HUGIN_BROKER_SUBMITTER"),
      muninUrl: requiredEnv("MUNIN_URL"),
      muninApiKey: requiredEnv("MUNIN_API_KEY"),
      taskType: stringArg(args, "task-type"),
      timeoutMs: timeoutMsArg ? Number(timeoutMsArg) : undefined,
      pollMs: pollMsArg ? Number(pollMsArg) : undefined,
    });
    process.stdout.write(`${JSON.stringify({ mode: "live", ok: true, evidence }, null, 2)}\n`);
    return;
  }

  throw new Error(
    "usage: tsx scripts/learning-task-joint-smoke.ts --mode=live --nonce=<token> | --mode=negative",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err: unknown) => {
    const gateSuffix = err instanceof SmokeGateError ? ` (gate ${err.gate})` : "";
    process.stderr.write(
      `joint smoke failed${gateSuffix}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
