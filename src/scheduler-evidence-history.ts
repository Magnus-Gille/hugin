import { createHash } from "node:crypto";
import {
  verifySchedulerClaimAttestation,
  verifySchedulerOutcomeAttestation,
} from "./scheduler-evidence-attestation.js";
import {
  hashSchedulerOutcome,
  hashSchedulerPrediction,
  schedulerDecisionOutcomeSchema,
  schedulerDecisionPredictionSchema,
  type SchedulerDecisionOutcome,
} from "./scheduler-evidence.js";
import type {
  MuninClient,
  MuninQueryResult,
  MuninReadRequest,
  MuninReadResult,
} from "./munin-client.js";
import {
  dispatcherRuntimeSchema,
  structuredTaskResultSchema,
  type DispatcherRuntime,
} from "./task-result-schema.js";

const OUTCOME_ATTESTATION_TAG = "type:scheduler-outcome-attestation";
const SCHEDULER_SHADOW_TAG = "scheduler-shadow:v1";
const DECISION_NAMESPACE_PATTERN =
  /^scheduler\/decisions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export interface SchedulerEvidenceHistoryClient {
  query: Pick<MuninClient, "query">["query"];
  readBatch(reads: MuninReadRequest[]): Promise<MuninReadResult[]>;
}

export interface SchedulerEvidenceHistoryOptions {
  windowSize: number;
  runtimes?: DispatcherRuntime[];
}

export interface VerifiedSchedulerOutcomeHistory {
  outcomes: SchedulerDecisionOutcome[];
  rejected: number;
}

interface CandidateRows {
  query: MuninQueryResult;
  decisionId: string;
  prediction: Extract<MuninReadResult, { found: true }>;
  claimAttestation: Extract<MuninReadResult, { found: true }>;
  outcome: Extract<MuninReadResult, { found: true }>;
  outcomeAttestation: Extract<MuninReadResult, { found: true }>;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function readResultMap(results: MuninReadResult[]): Map<string, MuninReadResult> {
  return new Map(results.map((result) => [
    `${result.namespace}\0${result.key}`,
    result,
  ]));
}

function found(
  rows: Map<string, MuninReadResult>,
  namespace: string,
  key: string,
): Extract<MuninReadResult, { found: true }> | undefined {
  const result = rows.get(`${namespace}\0${key}`);
  return result?.found ? result : undefined;
}

function exactTaskRef(
  left: { namespace: string; key: string },
  right: { namespace: string; key: string },
): boolean {
  return left.namespace === right.namespace && left.key === right.key;
}

function terminalClassFor(outcome: string): string {
  return outcome === "timed_out" ? "timed-out" : outcome;
}

async function loadRuntimeHistory(
  munin: SchedulerEvidenceHistoryClient,
  secret: string,
  runtime: DispatcherRuntime,
  windowSize: number,
): Promise<VerifiedSchedulerOutcomeHistory> {
  const queried = await munin.query({
    tags: [
      OUTCOME_ATTESTATION_TAG,
      `scheduler-runtime:${runtime}`,
      SCHEDULER_SHADOW_TAG,
    ],
    limit: windowSize,
  });
  const references = queried.results.filter((result) =>
    result.key === "outcome-attestation" && DECISION_NAMESPACE_PATTERN.test(result.namespace)
  );
  let rejected = queried.results.length - references.length;
  if (references.length === 0) return { outcomes: [], rejected };

  const evidenceReads: MuninReadRequest[] = references.flatMap((result) => [
    { namespace: result.namespace, key: "prediction" },
    { namespace: result.namespace, key: "claim-attestation" },
    { namespace: result.namespace, key: "outcome" },
    { namespace: result.namespace, key: "outcome-attestation" },
  ]);
  const evidenceRows = readResultMap(await munin.readBatch(evidenceReads));
  const candidates: CandidateRows[] = [];
  for (const query of references) {
    const decisionId = DECISION_NAMESPACE_PATTERN.exec(query.namespace)?.[1];
    const prediction = found(evidenceRows, query.namespace, "prediction");
    const claimAttestation = found(evidenceRows, query.namespace, "claim-attestation");
    const outcome = found(evidenceRows, query.namespace, "outcome");
    const outcomeAttestation = found(evidenceRows, query.namespace, "outcome-attestation");
    if (!decisionId || !prediction || !claimAttestation || !outcome || !outcomeAttestation) {
      rejected += 1;
      continue;
    }
    candidates.push({
      query,
      decisionId,
      prediction,
      claimAttestation,
      outcome,
      outcomeAttestation,
    });
  }
  if (candidates.length === 0) return { outcomes: [], rejected };

  const parsedCandidates: Array<CandidateRows & {
    predictionValue: ReturnType<typeof schedulerDecisionPredictionSchema.parse>;
    outcomeValue: SchedulerDecisionOutcome;
  }> = [];
  for (const candidate of candidates) {
    try {
      const predictionValue = schedulerDecisionPredictionSchema.parse(
        JSON.parse(candidate.prediction.content),
      );
      const outcomeValue = schedulerDecisionOutcomeSchema.parse(
        JSON.parse(candidate.outcome.content),
      );
      if (predictionValue.decisionId !== candidate.decisionId
        || outcomeValue.decisionId !== candidate.decisionId
        || outcomeValue.requestedRuntime !== runtime
        || !exactTaskRef(predictionValue.champion.taskRef, outcomeValue.taskRef)) {
        rejected += 1;
        continue;
      }
      parsedCandidates.push({ ...candidate, predictionValue, outcomeValue });
    } catch {
      rejected += 1;
    }
  }
  if (parsedCandidates.length === 0) return { outcomes: [], rejected };

  const taskReads: MuninReadRequest[] = parsedCandidates.flatMap((candidate) => [
    {
      namespace: candidate.predictionValue.champion.taskRef.namespace,
      key: "status",
    },
    {
      namespace: candidate.outcomeValue.terminalResult.namespace,
      key: "result-structured",
    },
  ]);
  const taskRows = readResultMap(await munin.readBatch(taskReads));
  const outcomes: SchedulerDecisionOutcome[] = [];
  for (const candidate of parsedCandidates) {
    try {
      const taskRef = candidate.predictionValue.champion.taskRef;
      const status = found(taskRows, taskRef.namespace, "status");
      const terminal = found(
        taskRows,
        candidate.outcomeValue.terminalResult.namespace,
        "result-structured",
      );
      if (!status || !terminal) throw new Error("missing bound task revision");
      const claimAttestation = verifySchedulerClaimAttestation(
        candidate.claimAttestation.content,
        {
          decisionId: candidate.decisionId,
          taskRef,
          taskContent: status.content,
          predictionSha256: hashSchedulerPrediction(candidate.predictionValue),
        },
        secret,
      );
      if (!claimAttestation) throw new Error("claim attestation is invalid");
      const outcomeAttestation = verifySchedulerOutcomeAttestation(
        candidate.outcomeAttestation.content,
        {
          claimAttestation,
          outcome: candidate.outcomeValue,
        },
        secret,
      );
      if (!outcomeAttestation) throw new Error("outcome attestation is invalid");
      if (terminal.updated_at !== candidate.outcomeValue.terminalResult.updatedAt
        || sha256(terminal.content) !== candidate.outcomeValue.terminalResult.sha256) {
        throw new Error("terminal revision binding is stale");
      }
      const terminalValue = structuredTaskResultSchema.parse(JSON.parse(terminal.content));
      if (terminalValue.taskNamespace !== taskRef.namespace
        || terminalClassFor(terminalValue.outcome) !== candidate.outcomeValue.terminalClass) {
        throw new Error("terminal result does not match scheduler outcome");
      }
      outcomes.push(candidate.outcomeValue);
    } catch {
      rejected += 1;
    }
  }
  return { outcomes, rejected };
}

export async function loadVerifiedSchedulerOutcomeHistory(
  munin: SchedulerEvidenceHistoryClient,
  secret: string,
  options: SchedulerEvidenceHistoryOptions,
): Promise<VerifiedSchedulerOutcomeHistory> {
  if (!Number.isInteger(options.windowSize) || options.windowSize < 1 || options.windowSize > 50) {
    throw new Error("scheduler history window size must be an integer from 1 to 50");
  }
  if (secret.length < 32) {
    throw new Error("scheduler history requires an attestation secret of at least 32 characters");
  }
  const runtimes = options.runtimes
    ? dispatcherRuntimeSchema.array().parse(options.runtimes)
    : [...dispatcherRuntimeSchema.options];
  const unique = new Map<string, SchedulerDecisionOutcome>();
  let rejected = 0;
  for (const runtime of runtimes) {
    const loaded = await loadRuntimeHistory(munin, secret, runtime, options.windowSize);
    rejected += loaded.rejected;
    for (const outcome of loaded.outcomes) {
      const existing = unique.get(outcome.decisionId);
      if (existing && hashSchedulerOutcome(existing) !== hashSchedulerOutcome(outcome)) {
        unique.delete(outcome.decisionId);
        rejected += 1;
        continue;
      }
      unique.set(outcome.decisionId, outcome);
    }
  }
  return { outcomes: [...unique.values()], rejected };
}
