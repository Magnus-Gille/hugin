import type { MuninClient } from "../munin-client.js";
import type { Sensitivity, TupleRef } from "./refs.js";
import type { SkillRoute } from "../task-result-schema.js";
import {
  classifyTask as defaultClassifyTask,
  loadActiveClassifiers as defaultLoadActiveClassifiers,
} from "./task-classifier.js";
import type { TaskClassifier, ClassifyResult } from "./task-classifier-schema.js";
import {
  retrieveProcedure as defaultRetrieveProcedure,
  type RetrievalConfig,
  type RetrievalOutcome,
} from "./retrieval.js";
import {
  loadActiveBinding as defaultLoadActiveBinding,
  isSelectable,
} from "./route-binding-store.js";
import type { RouteBinding } from "./route-binding-schema.js";

// Slice-one local-skill lane orchestrator (issue #84). Composes the five
// artifact modules into ONE fail-closed selection pre-step:
//
//   classify (A5) → retrieve (A4) → load active binding (A2) → selectability (A2)
//
// It is a composable PRE-STEP for the dispatcher, deliberately kept OUT of the
// pure `routeTask` (router.ts stays sync/Munin-free). Every path is fail-closed:
// anything short of a fully selectable, drift-free, sensitivity-cleared `active`
// binding returns `fallthrough` → the caller uses the existing cloud auto-router.
// Every outcome (including abstentions) yields a `skillRoute` audit record for
// `result-structured`.
//
// NOTE on scope: this is the *selection* contract. Actually EXECUTING a selected
// profile on a local cell (and grading/delivering the result) needs an authored
// slice-one procedure package + a real Pi cell/model, which do not exist yet — so
// `recomputeTupleHashes` defaults to returning `null` (cannot verify no-drift ⇒
// fail-closed ⇒ always fall through). The lane is therefore a safe no-op in
// production until slice-one content is authored; tests inject the dependencies
// to exercise the selected path. Wiring `selectSkillRoute` into the dispatcher's
// execute path is the remaining #84 step, gated on a real cell.

export interface SkillLaneConfig {
  /** Master switch (HUGIN_SKILL_LANE). Off ⇒ immediate fall-through. */
  enabled: boolean;
  retrieval: RetrievalConfig;
}

export interface SkillLaneDeps {
  loadActiveClassifiers: (munin: MuninClient) => Promise<TaskClassifier[]>;
  classifyTask: (prompt: string, classifiers: TaskClassifier[]) => ClassifyResult;
  retrieveProcedure: (
    task: { promptDigest: string; taskClassId: string; sensitivity: Sensitivity },
    munin: MuninClient,
    cfg: RetrievalConfig,
  ) => Promise<RetrievalOutcome>;
  loadActiveBinding: (
    taskClassId: string,
    munin: MuninClient,
  ) => Promise<RouteBinding | null>;
  /**
   * Recompute the CURRENT content hashes of a binding's referenced artifacts so
   * `isSelectable` can fail-close on drift. Returns `null` when the artifacts
   * cannot be loaded/verified — which is treated as not-selectable (fail-closed).
   * Default returns `null` (no authored artifacts yet).
   */
  recomputeTupleHashes: (binding: RouteBinding) => Promise<TupleRef | null>;
}

export interface SkillLaneTask {
  prompt: string;
  /** A stable digest of the prompt used for retrieval / hard-negative matching. */
  promptDigest: string;
  /** Independently-computed effective sensitivity (NEVER derived from the class). */
  sensitivity: Sensitivity;
}

export type SkillLaneOutcome =
  | { kind: "selected"; binding: RouteBinding; skillRoute: SkillRoute }
  | { kind: "fallthrough"; skillRoute: SkillRoute };

const DEFAULT_DEPS: SkillLaneDeps = {
  loadActiveClassifiers: defaultLoadActiveClassifiers,
  classifyTask: defaultClassifyTask,
  retrieveProcedure: defaultRetrieveProcedure,
  loadActiveBinding: defaultLoadActiveBinding,
  recomputeTupleHashes: async () => null,
};

function fallthrough(reason: string, extra?: Partial<SkillRoute>): SkillLaneOutcome {
  return {
    kind: "fallthrough",
    skillRoute: { abstained: true, abstainReason: reason, ...extra },
  };
}

/**
 * Decide whether the local-skill lane handles this task. Fail-closed: returns
 * `selected` ONLY for a fully verified, drift-free, sensitivity-cleared `active`
 * binding; every other condition (lane off, Munin error, classifier abstain,
 * retrieval abstain/unavailable/not-selectable, no binding, drift, ceiling) is a
 * `fallthrough` to the cloud auto-router, with the reason recorded.
 */
export async function selectSkillRoute(
  task: SkillLaneTask,
  munin: MuninClient,
  cfg: SkillLaneConfig,
  deps: Partial<SkillLaneDeps> = {},
): Promise<SkillLaneOutcome> {
  const d: SkillLaneDeps = { ...DEFAULT_DEPS, ...deps };

  if (!cfg.enabled) return fallthrough("lane-disabled");

  // 1. Classify (deterministic-first). Munin errors fail closed.
  let classifiers: TaskClassifier[];
  try {
    classifiers = await d.loadActiveClassifiers(munin);
  } catch {
    return fallthrough("munin-error");
  }
  if (classifiers.length === 0) return fallthrough("no-classifiers");

  const cls = d.classifyTask(task.prompt, classifiers);
  if (cls.kind === "abstain") {
    return fallthrough(`classify:${cls.reason}`);
  }
  const classId = cls.classId;
  const classConfidence = cls.confidence;

  // 2. Retrieve (own fail-closed contract). Munin errors fail closed.
  let retrieval: RetrievalOutcome;
  try {
    retrieval = await d.retrieveProcedure(
      { promptDigest: task.promptDigest, taskClassId: classId, sensitivity: task.sensitivity },
      munin,
      cfg.retrieval,
    );
  } catch {
    return fallthrough("munin-error", { classId, classConfidence });
  }
  if (retrieval.kind !== "selected") {
    return fallthrough(`retrieve:${retrieval.reason}`, { classId, classConfidence });
  }

  // 3. Load the active binding for the class.
  let binding: RouteBinding | null;
  try {
    binding = await d.loadActiveBinding(classId, munin);
  } catch {
    return fallthrough("munin-error", { classId, classConfidence });
  }
  if (!binding) return fallthrough("no-active-binding", { classId, classConfidence });

  // 4. Selectability — fail-closed on drift / state / sensitivity ceiling. The
  //    current artifact hashes must be recomputable; if not, we cannot prove the
  //    binding hasn't drifted, so we do NOT run local.
  let currentHashes: TupleRef | null;
  try {
    currentHashes = await d.recomputeTupleHashes(binding);
  } catch {
    currentHashes = null;
  }
  if (!currentHashes) {
    return fallthrough("cannot-verify-drift", {
      classId,
      classConfidence,
      bindingId: binding.bindingId,
      bindingVersion: binding.version,
    });
  }

  const sel = isSelectable(binding, currentHashes, task.sensitivity);
  if (!sel.ok) {
    return fallthrough(`binding:${sel.reason}`, {
      classId,
      classConfidence,
      bindingId: binding.bindingId,
      bindingVersion: binding.version,
    });
  }

  return {
    kind: "selected",
    binding,
    skillRoute: {
      abstained: false,
      classId,
      classConfidence,
      bindingId: binding.bindingId,
      bindingVersion: binding.version,
    },
  };
}
