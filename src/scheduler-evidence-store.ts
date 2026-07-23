import {
  MuninWriteRejectedError,
  type MuninEntry,
} from "./munin-client.js";
import {
  hashSchedulerClaimAttestation,
  hashSchedulerOutcomeAttestation,
} from "./scheduler-evidence-attestation.js";
import {
  hashSchedulerOutcome,
  hashSchedulerPrediction,
  schedulerDecisionOutcomeSchema,
  schedulerDecisionPredictionSchema,
} from "./scheduler-evidence.js";
import {
  hashSchedulerWorkloadSnapshot,
  schedulerWorkloadSnapshotSchema,
} from "./scheduler-workload.js";
import { dispatcherRuntimeSchema, type DispatcherRuntime } from "./task-result-schema.js";

const PREDICTION_KEY = "prediction";
const PREDICTION_TAGS = ["type:scheduler-decision-prediction", "scheduler-shadow:v1"];
const WORKLOAD_SNAPSHOT_KEY = "workload-snapshot";
const WORKLOAD_SNAPSHOT_TAGS = ["type:scheduler-workload-snapshot", "scheduler-shadow:v1"];
const OUTCOME_KEY = "outcome";
const OUTCOME_TAGS = ["type:scheduler-decision-outcome", "scheduler-shadow:v1"];
const CLAIM_ATTESTATION_KEY = "claim-attestation";
const CLAIM_ATTESTATION_TAGS = ["type:scheduler-claim-attestation", "scheduler-shadow:v1"];
const OUTCOME_ATTESTATION_KEY = "outcome-attestation";

export interface SchedulerEvidenceStoreClient {
  read(
    namespace: string,
    key: string,
  ): Promise<(MuninEntry & { found: true }) | null>;
  write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
    createIfAbsent?: boolean,
  ): Promise<Record<string, unknown>>;
}

export class SchedulerPredictionConflictError extends Error {
  constructor(decisionId: string) {
    super(`scheduler decision ${decisionId} already contains a different prediction`);
    this.name = "SchedulerPredictionConflictError";
  }
}

export class SchedulerWorkloadSnapshotConflictError extends Error {
  constructor(decisionId: string) {
    super(`scheduler decision ${decisionId} already contains a different workload snapshot`);
    this.name = "SchedulerWorkloadSnapshotConflictError";
  }
}

export class SchedulerWorkloadPredictionBindingError extends Error {
  constructor(decisionId: string) {
    super(`scheduler workload snapshot requires the matching stored prediction for ${decisionId}`);
    this.name = "SchedulerWorkloadPredictionBindingError";
  }
}

export class SchedulerOutcomeConflictError extends Error {
  constructor(decisionId: string) {
    super(`scheduler decision ${decisionId} already contains a different outcome`);
    this.name = "SchedulerOutcomeConflictError";
  }
}

export class SchedulerClaimAttestationConflictError extends Error {
  constructor(decisionId: string) {
    super(`scheduler decision ${decisionId} already contains a different claim attestation`);
    this.name = "SchedulerClaimAttestationConflictError";
  }
}

export class SchedulerOutcomeAttestationConflictError extends Error {
  constructor(decisionId: string) {
    super(`scheduler decision ${decisionId} already contains a different outcome attestation`);
    this.name = "SchedulerOutcomeAttestationConflictError";
  }
}

export function schedulerDecisionNamespace(decisionId: string): string {
  return `scheduler/decisions/${decisionId}`;
}

function parseStoredPrediction(content: string) {
  try {
    return schedulerDecisionPredictionSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

export async function persistSchedulerPrediction(
  munin: SchedulerEvidenceStoreClient,
  input: unknown,
): Promise<{ status: "created" | "exact-existing" }> {
  const prediction = schedulerDecisionPredictionSchema.parse(input);
  const namespace = schedulerDecisionNamespace(prediction.decisionId);
  try {
    const result = await munin.write(
      namespace,
      PREDICTION_KEY,
      JSON.stringify(prediction),
      PREDICTION_TAGS,
      undefined,
      "internal",
      true,
    );
    if (result.status !== "created") {
      throw new Error(
        `scheduler prediction write returned non-created status for ${namespace}/${PREDICTION_KEY}`,
      );
    }
    return { status: "created" };
  } catch (error) {
    if (!(error instanceof MuninWriteRejectedError)
      || error.conflictReason !== "already_exists") {
      throw error;
    }
    const existing = await munin.read(namespace, PREDICTION_KEY);
    const stored = existing ? parseStoredPrediction(existing.content) : null;
    if (!stored || hashSchedulerPrediction(stored) !== hashSchedulerPrediction(prediction)) {
      throw new SchedulerPredictionConflictError(prediction.decisionId);
    }
    return { status: "exact-existing" };
  }
}

export async function persistSchedulerWorkloadSnapshot(
  munin: SchedulerEvidenceStoreClient,
  predictionInput: unknown,
  input: unknown,
): Promise<{ status: "created" | "exact-existing" }> {
  const prediction = schedulerDecisionPredictionSchema.parse(predictionInput);
  const snapshot = schedulerWorkloadSnapshotSchema.parse(input);
  const digest = hashSchedulerWorkloadSnapshot(snapshot);
  if (digest !== prediction.workloadSnapshotSha256) {
    throw new Error(
      `scheduler workload snapshot digest does not match prediction for `
        + `${prediction.decisionId}`,
    );
  }
  const namespace = schedulerDecisionNamespace(prediction.decisionId);
  const predictionEntry = await munin.read(namespace, PREDICTION_KEY);
  const storedPrediction = predictionEntry
    ? parseStoredPrediction(predictionEntry.content)
    : null;
  if (!storedPrediction
    || hashSchedulerPrediction(storedPrediction) !== hashSchedulerPrediction(prediction)) {
    throw new SchedulerWorkloadPredictionBindingError(prediction.decisionId);
  }
  try {
    const result = await munin.write(
      namespace,
      WORKLOAD_SNAPSHOT_KEY,
      JSON.stringify(snapshot),
      WORKLOAD_SNAPSHOT_TAGS,
      undefined,
      "internal",
      true,
    );
    if (result.status !== "created") {
      throw new Error(
        `scheduler workload snapshot write returned non-created status for `
          + `${namespace}/${WORKLOAD_SNAPSHOT_KEY}`,
      );
    }
    return { status: "created" };
  } catch (error) {
    if (!(error instanceof MuninWriteRejectedError)
      || error.conflictReason !== "already_exists") {
      throw error;
    }
    const existing = await munin.read(namespace, WORKLOAD_SNAPSHOT_KEY);
    let stored: unknown = null;
    try {
      stored = existing
        ? schedulerWorkloadSnapshotSchema.parse(JSON.parse(existing.content))
        : null;
    } catch {
      stored = null;
    }
    if (!stored || hashSchedulerWorkloadSnapshot(stored) !== digest) {
      throw new SchedulerWorkloadSnapshotConflictError(prediction.decisionId);
    }
    return { status: "exact-existing" };
  }
}

export async function persistSchedulerOutcome(
  munin: SchedulerEvidenceStoreClient,
  input: unknown,
): Promise<{ status: "created" | "exact-existing" }> {
  const outcome = schedulerDecisionOutcomeSchema.parse(input);
  const namespace = schedulerDecisionNamespace(outcome.decisionId);
  try {
    const result = await munin.write(
      namespace,
      OUTCOME_KEY,
      JSON.stringify(outcome),
      OUTCOME_TAGS,
      undefined,
      "internal",
      true,
    );
    if (result.status !== "created") {
      throw new Error(
        `scheduler outcome write returned non-created status for ${namespace}/${OUTCOME_KEY}`,
      );
    }
    return { status: "created" };
  } catch (error) {
    if (!(error instanceof MuninWriteRejectedError)
      || error.conflictReason !== "already_exists") {
      throw error;
    }
    const existing = await munin.read(namespace, OUTCOME_KEY);
    let stored: unknown = null;
    try {
      stored = existing
        ? schedulerDecisionOutcomeSchema.parse(JSON.parse(existing.content))
        : null;
    } catch {
      stored = null;
    }
    if (!stored || hashSchedulerOutcome(stored) !== hashSchedulerOutcome(outcome)) {
      throw new SchedulerOutcomeConflictError(outcome.decisionId);
    }
    return { status: "exact-existing" };
  }
}

export async function persistSchedulerClaimAttestation(
  munin: SchedulerEvidenceStoreClient,
  input: unknown,
): Promise<{ status: "created" | "exact-existing" }> {
  const content = JSON.stringify(input);
  const digest = hashSchedulerClaimAttestation(input);
  const parsed = JSON.parse(content) as { decisionId: string };
  const namespace = schedulerDecisionNamespace(parsed.decisionId);
  try {
    const result = await munin.write(
      namespace,
      CLAIM_ATTESTATION_KEY,
      content,
      CLAIM_ATTESTATION_TAGS,
      undefined,
      "internal",
      true,
    );
    if (result.status !== "created") {
      throw new Error(
        `scheduler claim attestation write returned non-created status for `
          + `${namespace}/${CLAIM_ATTESTATION_KEY}`,
      );
    }
    return { status: "created" };
  } catch (error) {
    if (!(error instanceof MuninWriteRejectedError)
      || error.conflictReason !== "already_exists") {
      throw error;
    }
    const existing = await munin.read(namespace, CLAIM_ATTESTATION_KEY);
    let storedDigest: string | null = null;
    try {
      storedDigest = existing
        ? hashSchedulerClaimAttestation(JSON.parse(existing.content))
        : null;
    } catch {
      storedDigest = null;
    }
    if (storedDigest !== digest) {
      throw new SchedulerClaimAttestationConflictError(parsed.decisionId);
    }
    return { status: "exact-existing" };
  }
}

export async function persistSchedulerOutcomeAttestation(
  munin: SchedulerEvidenceStoreClient,
  input: unknown,
  requestedRuntime: DispatcherRuntime,
): Promise<{ status: "created" | "exact-existing" }> {
  const runtime = dispatcherRuntimeSchema.parse(requestedRuntime);
  const content = JSON.stringify(input);
  const digest = hashSchedulerOutcomeAttestation(input);
  const parsed = JSON.parse(content) as { decisionId: string };
  const namespace = schedulerDecisionNamespace(parsed.decisionId);
  try {
    const result = await munin.write(
      namespace,
      OUTCOME_ATTESTATION_KEY,
      content,
      [
        "type:scheduler-outcome-attestation",
        `scheduler-runtime:${runtime}`,
        "scheduler-shadow:v1",
      ],
      undefined,
      "internal",
      true,
    );
    if (result.status !== "created") {
      throw new Error(
        `scheduler outcome attestation write returned non-created status for `
          + `${namespace}/${OUTCOME_ATTESTATION_KEY}`,
      );
    }
    return { status: "created" };
  } catch (error) {
    if (!(error instanceof MuninWriteRejectedError)
      || error.conflictReason !== "already_exists") {
      throw error;
    }
    const existing = await munin.read(namespace, OUTCOME_ATTESTATION_KEY);
    let storedDigest: string | null = null;
    try {
      storedDigest = existing
        ? hashSchedulerOutcomeAttestation(JSON.parse(existing.content))
        : null;
    } catch {
      storedDigest = null;
    }
    if (storedDigest !== digest) {
      throw new SchedulerOutcomeAttestationConflictError(parsed.decisionId);
    }
    return { status: "exact-existing" };
  }
}
