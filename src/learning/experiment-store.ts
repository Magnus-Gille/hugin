/** Munin-backed durable store for champion/challenger learning experiments. */

import { createHash } from "node:crypto";
import type { MuninClient } from "../munin-client.js";
import { evaluateLearningExperiment } from "./experiment-evaluator.js";
import {
  learningExperimentCreateSchema,
  learningExperimentPromoteSchema,
  learningExperimentRateSchema,
  learningExperimentStateSchema,
  learningChampionStateSchema,
  learningObservationSchema,
  type LearningExperimentCreate,
  type LearningExperimentPromote,
  type LearningExperimentRate,
  type LearningExperimentState,
  type LearningChampionState,
  type LearningObservationInput,
  type RecordedLearningObservation,
} from "./experiment-schema.js";

const STATE_KEY = "state";
const MAX_MUTATION_ATTEMPTS = 3;

export type LearningStoreErrorCode =
  | "not-found"
  | "forbidden"
  | "conflict"
  | "invalid-state"
  | "capacity";

export class LearningStoreError extends Error {
  constructor(
    public readonly code: LearningStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LearningStoreError";
  }
}

function namespaceFor(principal: string, experimentId: string): string {
  const principalHash = createHash("sha256").update(principal).digest("hex").slice(0, 12);
  return `experiments/hugin/${experimentId}-${principalHash}`;
}

function championNamespaceFor(principal: string, scope: string): string {
  const principalHash = createHash("sha256").update(principal).digest("hex").slice(0, 12);
  return `experiments/hugin/champions/${scope}-${principalHash}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameInput(state: LearningExperimentState, input: LearningExperimentCreate): boolean {
  return stable({
    experiment_id: state.experimentId,
    scope: state.scope,
    task_type: state.taskType,
    hypothesis: state.hypothesis,
    change_axis: state.changeAxis,
    champion: state.champion,
    challenger: state.challenger,
    gates: state.gates,
  }) === stable(input);
}

function statusTags(state: LearningExperimentState): string[] {
  return [
    "learning:experiment",
    `learning:${state.status}`,
    `axis:${state.changeAxis}`,
    `type:${state.taskType}`,
  ];
}

function parseState(content: string): LearningExperimentState {
  try {
    return learningExperimentStateSchema.parse(JSON.parse(content));
  } catch (err) {
    throw new LearningStoreError(
      "invalid-state",
      `stored experiment state is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseChampion(content: string): LearningChampionState {
  try {
    return learningChampionStateSchema.parse(JSON.parse(content));
  } catch (err) {
    throw new LearningStoreError(
      "invalid-state",
      `stored champion state is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface LearningExperimentStoreOptions {
  now?: () => Date;
}

export class LearningExperimentStore {
  private readonly now: () => Date;
  /** Serialize same-process updates; cross-process races are still guarded by Munin CAS. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly munin: MuninClient,
    options: LearningExperimentStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async create(
    principal: string,
    rawInput: LearningExperimentCreate,
  ): Promise<{ state: LearningExperimentState; reused: boolean }> {
    const input = learningExperimentCreateSchema.parse(rawInput);
    const namespace = namespaceFor(principal, input.experiment_id);
    return this.withLock(championNamespaceFor(principal, input.scope), async () => {
      const existing = await this.munin.read(namespace, STATE_KEY);
      if (existing) {
        const state = parseState(existing.content);
        this.assertOwner(state, principal);
        if (!sameInput(state, input)) {
          throw new LearningStoreError(
            "conflict",
            `experiment ${input.experiment_id} already exists with a different contract`,
          );
        }
        return { state, reused: true };
      }

      await this.ensureChampionBaseline(principal, input);

      const timestamp = this.now().toISOString();
      const evaluation = evaluateLearningExperiment({
        observations: [],
        gates: input.gates,
        now: this.now,
      });
      const state = learningExperimentStateSchema.parse({
        schemaVersion: 1,
        experimentId: input.experiment_id,
        scope: input.scope,
        taskType: input.task_type,
        ownerPrincipal: principal,
        hypothesis: input.hypothesis,
        changeAxis: input.change_axis,
        champion: input.champion,
        challenger: input.challenger,
        gates: input.gates,
        status: "running",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        observations: [],
        evaluation,
      });
      await this.munin.write(
        namespace,
        STATE_KEY,
        JSON.stringify(state),
        statusTags(state),
        undefined,
        "internal",
      );
      return { state, reused: false };
    });
  }

  async read(principal: string, experimentId: string): Promise<LearningExperimentState> {
    const entry = await this.munin.read(namespaceFor(principal, experimentId), STATE_KEY);
    if (!entry) {
      throw new LearningStoreError("not-found", `experiment ${experimentId} not found`);
    }
    const state = parseState(entry.content);
    this.assertOwner(state, principal);
    return state;
  }

  async readChampion(principal: string, scope: string): Promise<LearningChampionState | null> {
    const entry = await this.munin.read(championNamespaceFor(principal, scope), STATE_KEY);
    if (!entry) return null;
    const champion = parseChampion(entry.content);
    if (champion.ownerPrincipal !== principal) {
      throw new LearningStoreError("forbidden", "champion belongs to another principal");
    }
    return champion;
  }

  async observe(
    principal: string,
    rawObservation: LearningObservationInput,
  ): Promise<{ state: LearningExperimentState; reused: boolean }> {
    const observation = learningObservationSchema.parse(rawObservation);
    const namespace = namespaceFor(principal, observation.experiment_id);
    return this.withLock(namespace, async () => {
      for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt++) {
        const entry = await this.munin.read(namespace, STATE_KEY);
        if (!entry) {
          throw new LearningStoreError(
            "not-found",
            `experiment ${observation.experiment_id} not found`,
          );
        }
        const current = parseState(entry.content);
        this.assertOwner(current, principal);
        if (current.status !== "running") {
          throw new LearningStoreError(
            "invalid-state",
            `experiment is ${current.status}; terminal evidence cannot be rewritten`,
          );
        }

        const existingRun = current.observations.find(
          (candidate) => candidate.run_id === observation.run_id,
        );
        if (existingRun) {
          const {
            recorded_at: _recordedAt,
            recorded_by: _recordedBy,
            ...comparable
          } = existingRun;
          if (stable(comparable) !== stable(observation)) {
            throw new LearningStoreError(
              "conflict",
              `run_id ${observation.run_id} already exists with different evidence`,
            );
          }
          return { state: current, reused: true };
        }
        if (
          current.observations.some(
            (candidate) =>
              candidate.sample_id === observation.sample_id && candidate.arm === observation.arm,
          )
        ) {
          throw new LearningStoreError(
            "conflict",
            `sample ${observation.sample_id} already has a ${observation.arm} observation`,
          );
        }
        if (current.observations.length >= 400) {
          throw new LearningStoreError("capacity", "experiment reached the 400-observation cap");
        }

        const expectedFingerprint =
          observation.arm === "champion"
            ? current.champion.fingerprint
            : current.challenger.fingerprint;
        if (observation.configuration_fingerprint !== expectedFingerprint) {
          throw new LearningStoreError(
            "conflict",
            `${observation.arm} observation fingerprint does not match the experiment contract`,
          );
        }

        const timestamp = this.now().toISOString();
        const recorded: RecordedLearningObservation = {
          ...observation,
          recorded_at: timestamp,
          recorded_by: principal,
        };
        const observations = [...current.observations, recorded];
        const evaluation = evaluateLearningExperiment({
          observations,
          gates: current.gates,
          now: this.now,
        });
        const status: LearningExperimentState["status"] =
          evaluation.decision === "promotion-ready"
            ? "promotion-ready"
            : evaluation.decision === "reject"
              ? "rejected"
              : "running";
        const next = learningExperimentStateSchema.parse({
          ...current,
          status,
          revision: current.revision + 1,
          updatedAt: timestamp,
          observations,
          evaluation,
        });

        try {
          await this.munin.write(
            namespace,
            STATE_KEY,
            JSON.stringify(next),
            statusTags(next),
            entry.updated_at,
            "internal",
          );
          return { state: next, reused: false };
        } catch (err) {
          if (attempt === MAX_MUTATION_ATTEMPTS - 1) throw err;
          // A competing writer won the CAS. Re-read and fold once more.
        }
      }
      throw new LearningStoreError("conflict", "experiment update lost repeated CAS races");
    });
  }

  async rate(
    principal: string,
    rawRating: LearningExperimentRate,
  ): Promise<{ state: LearningExperimentState; reused: boolean }> {
    const rating = learningExperimentRateSchema.parse(rawRating);
    const namespace = namespaceFor(principal, rating.experiment_id);
    return this.withLock(namespace, async () => {
      for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt++) {
        const entry = await this.munin.read(namespace, STATE_KEY);
        if (!entry) {
          throw new LearningStoreError(
            "not-found",
            `experiment ${rating.experiment_id} not found`,
          );
        }
        const current = parseState(entry.content);
        this.assertOwner(current, principal);
        if (current.status !== "running") {
          throw new LearningStoreError(
            "invalid-state",
            `experiment is ${current.status}; terminal evidence cannot be rewritten`,
          );
        }

        const index = current.observations.findIndex(
          (candidate) => candidate.run_id === rating.run_id,
        );
        if (index === -1) {
          throw new LearningStoreError(
            "not-found",
            `run_id ${rating.run_id} is not recorded in experiment ${rating.experiment_id}`,
          );
        }
        const existing = current.observations[index]!;
        if (existing.product_outcome !== "unrated") {
          const effectiveReviewSeconds =
            rating.human_review_seconds ?? existing.human_review_seconds;
          if (
            existing.product_outcome === rating.product_outcome &&
            existing.human_review_seconds === effectiveReviewSeconds
          ) {
            return { state: current, reused: true };
          }
          throw new LearningStoreError(
            "conflict",
            `run_id ${rating.run_id} already has a different product rating`,
          );
        }

        const timestamp = this.now().toISOString();
        const rated: RecordedLearningObservation = {
          ...existing,
          product_outcome: rating.product_outcome,
          ...(rating.human_review_seconds !== undefined
            ? { human_review_seconds: rating.human_review_seconds }
            : {}),
          product_rated_at: timestamp,
          product_rated_by: principal,
        };
        const observations = [...current.observations];
        observations[index] = rated;
        const evaluation = evaluateLearningExperiment({
          observations,
          gates: current.gates,
          now: this.now,
        });
        const status: LearningExperimentState["status"] =
          evaluation.decision === "promotion-ready"
            ? "promotion-ready"
            : evaluation.decision === "reject"
              ? "rejected"
              : "running";
        const next = learningExperimentStateSchema.parse({
          ...current,
          status,
          revision: current.revision + 1,
          updatedAt: timestamp,
          observations,
          evaluation,
        });

        try {
          await this.munin.write(
            namespace,
            STATE_KEY,
            JSON.stringify(next),
            statusTags(next),
            entry.updated_at,
            "internal",
          );
          return { state: next, reused: false };
        } catch (err) {
          if (attempt === MAX_MUTATION_ATTEMPTS - 1) throw err;
        }
      }
      throw new LearningStoreError("conflict", "experiment rating lost repeated CAS races");
    });
  }

  async promote(
    principal: string,
    rawPromotion: LearningExperimentPromote,
  ): Promise<{ state: LearningExperimentState; champion: LearningChampionState; reused: boolean }> {
    const promotion = learningExperimentPromoteSchema.parse(rawPromotion);
    const namespace = namespaceFor(principal, promotion.experiment_id);
    return this.withLock(namespace, async () => {
      const entry = await this.munin.read(namespace, STATE_KEY);
      if (!entry) {
        throw new LearningStoreError(
          "not-found",
          `experiment ${promotion.experiment_id} not found`,
        );
      }
      const current = parseState(entry.content);
      this.assertOwner(current, principal);
      if (promotion.configuration_fingerprint !== current.challenger.fingerprint) {
        throw new LearningStoreError(
          "conflict",
          "promotion fingerprint does not match the evaluated challenger",
        );
      }
      if (current.status === "promoted") {
        if (current.promotion?.appliedRef !== promotion.applied_ref) {
          throw new LearningStoreError(
            "conflict",
            "experiment was already promoted with a different applied_ref",
          );
        }
        const champion = await this.readChampion(principal, current.scope);
        if (!champion) {
          throw new LearningStoreError("invalid-state", "promoted experiment has no champion pointer");
        }
        return { state: current, champion, reused: true };
      }
      if (current.status !== "promotion-ready") {
        throw new LearningStoreError(
          "invalid-state",
          `experiment is ${current.status}; only promotion-ready evidence can be promoted`,
        );
      }

      const championNamespace = championNamespaceFor(principal, current.scope);
      const championEntry = await this.munin.read(championNamespace, STATE_KEY);
      if (!championEntry) {
        throw new LearningStoreError("invalid-state", "experiment scope has no champion pointer");
      }
      const previousChampion = parseChampion(championEntry.content);
      let nextChampion: LearningChampionState;
      const timestamp = this.now().toISOString();
      if (previousChampion.configuration.fingerprint === current.champion.fingerprint) {
        nextChampion = learningChampionStateSchema.parse({
          schemaVersion: 1,
          scope: current.scope,
          ownerPrincipal: principal,
          configuration: current.challenger,
          sourceExperimentId: current.experimentId,
          appliedRef: promotion.applied_ref,
          promotedAt: timestamp,
          promotedBy: principal,
        });
        await this.munin.write(
          championNamespace,
          STATE_KEY,
          JSON.stringify(nextChampion),
          ["learning:champion", `type:${current.taskType}`],
          championEntry.updated_at,
          "internal",
        );
      } else if (
        previousChampion.configuration.fingerprint === current.challenger.fingerprint &&
        previousChampion.sourceExperimentId === current.experimentId
      ) {
        // Recovery after a crash/CAS loss between champion-pointer and
        // experiment-state writes: the monotonic move already happened.
        nextChampion = previousChampion;
      } else {
        throw new LearningStoreError(
          "conflict",
          "scope champion changed since this experiment started; refusing stale promotion",
        );
      }

      const next = learningExperimentStateSchema.parse({
        ...current,
        status: "promoted",
        revision: current.revision + 1,
        updatedAt: timestamp,
        promotion: {
          appliedRef: promotion.applied_ref,
          promotedAt: timestamp,
          promotedBy: principal,
        },
      });
      await this.munin.write(
        namespace,
        STATE_KEY,
        JSON.stringify(next),
        statusTags(next),
        entry.updated_at,
        "internal",
      );
      return { state: next, champion: nextChampion, reused: false };
    });
  }

  private async ensureChampionBaseline(
    principal: string,
    input: LearningExperimentCreate,
  ): Promise<void> {
    const namespace = championNamespaceFor(principal, input.scope);
    const existing = await this.munin.read(namespace, STATE_KEY);
    if (existing) {
      const champion = parseChampion(existing.content);
      if (champion.ownerPrincipal !== principal) {
        throw new LearningStoreError("forbidden", "champion belongs to another principal");
      }
      if (champion.configuration.fingerprint !== input.champion.fingerprint) {
        throw new LearningStoreError(
          "conflict",
          "experiment champion does not match the current champion for this scope",
        );
      }
      return;
    }
    const timestamp = this.now().toISOString();
    const champion = learningChampionStateSchema.parse({
      schemaVersion: 1,
      scope: input.scope,
      ownerPrincipal: principal,
      configuration: input.champion,
      sourceExperimentId: null,
      appliedRef: `seed:${input.champion.fingerprint}`,
      promotedAt: timestamp,
      promotedBy: principal,
    });
    await this.munin.write(
      namespace,
      STATE_KEY,
      JSON.stringify(champion),
      ["learning:champion", `type:${input.task_type}`],
      undefined,
      "internal",
    );
  }

  private assertOwner(state: LearningExperimentState, principal: string): void {
    if (state.ownerPrincipal !== principal) {
      // Principal-scoped namespaces make this unreachable without corrupt state,
      // but preserve the explicit authorization boundary in case storage moves.
      throw new LearningStoreError("forbidden", "experiment belongs to another principal");
    }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}
