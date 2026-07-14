/** Retry and reconcile idempotent learning observations after ambiguous HTTP failures. */

import { BrokerClient, BrokerNetworkError } from "../mcp/broker-client.js";
import {
  learningObservationSchema,
  learningExperimentStateSchema,
  type LearningObservationInput,
  type RecordedLearningObservation,
} from "./experiment-schema.js";

type ObservationBroker = Pick<
  BrokerClient,
  "experimentObserve" | "experimentStatus"
>;

export interface DurableObservationResult {
  attempts: number;
  reconciled: boolean;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameEvidence(
  recorded: RecordedLearningObservation,
  expected: LearningObservationInput,
): boolean {
  const {
    recorded_at: _recordedAt,
    recorded_by: _recordedBy,
    product_rated_at: _productRatedAt,
    product_rated_by: _productRatedBy,
    ...evidence
  } = recorded;
  // Munin persistence crosses a JSON boundary, which removes optional keys
  // whose value is undefined. Compare against that same canonical shape.
  const canonicalExpected = learningObservationSchema.parse(
    JSON.parse(JSON.stringify(expected)),
  );
  return stable(evidence) === stable(canonicalExpected);
}

async function reconcile(
  broker: ObservationBroker,
  observation: LearningObservationInput,
): Promise<boolean> {
  const response = await broker.experimentStatus({
    experiment_id: observation.experiment_id,
  }) as { state?: unknown };
  const state = learningExperimentStateSchema.parse(response.state);
  const recorded = state.observations.find(
    (candidate) => candidate.run_id === observation.run_id,
  );
  if (!recorded) return false;
  if (!sameEvidence(recorded, observation)) {
    throw new Error(
      `run_id ${observation.run_id} was committed with different evidence after an ambiguous write`,
    );
  }
  return true;
}

/**
 * Observation writes are server-side idempotent by run_id. A client timeout is
 * ambiguous, so first read back the durable state; only retry the identical
 * payload when it is absent. Never retry HTTP conflicts or validation errors.
 */
export async function observeDurably(
  broker: ObservationBroker,
  observation: LearningObservationInput,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<DurableObservationResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("maxAttempts must be an integer between 1 and 10");
  }
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastNetworkError: BrokerNetworkError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await broker.experimentObserve(observation);
      return { attempts: attempt, reconciled: false };
    } catch (error) {
      if (!(error instanceof BrokerNetworkError)) throw error;
      lastNetworkError = error;
    }

    try {
      if (await reconcile(broker, observation)) {
        return { attempts: attempt, reconciled: true };
      }
    } catch (error) {
      if (!(error instanceof BrokerNetworkError)) throw error;
      lastNetworkError = error;
    }

    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }

  throw lastNetworkError ?? new Error("observation persistence failed without a network error");
}
