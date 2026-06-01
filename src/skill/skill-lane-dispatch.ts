/**
 * skill-lane-dispatch.ts — the dispatcher-facing integration point for the
 * local-skill lane (#84). This is the thin, independently-testable seam between
 * Hugin's poll/execute loop in src/index.ts and the pure fail-closed selection
 * orchestrator in skill-lane.ts.
 *
 * Contract (load-bearing, fail-closed):
 *   - `enabled: false` ⇒ this function returns `null` WITHOUT touching Munin or
 *     the skill modules. The dispatcher then proceeds with its existing cloud
 *     auto-router exactly as before. (Default `HUGIN_SKILL_LANE=off`.)
 *   - `enabled: true` ⇒ it calls `selectSkillRoute`. Until an authored slice-one
 *     RouteBinding is driven to `active` against a real local cell (a deliberate
 *     human go-live step), `selectSkillRoute` always returns `fallthrough`, so
 *     this function returns the audit `SkillRoute` but NEVER a local execution
 *     directive. The dispatcher records the audit record and still routes cloud.
 *
 * Returning `null` vs a `fallthrough` SkillRoute lets the caller distinguish
 * "lane not consulted" from "lane consulted and abstained" for telemetry, while
 * both paths execute identically (cloud).
 */

import type { MuninClient } from "../munin-client.js";
import type { Sensitivity } from "./refs.js";
import type { SkillRoute } from "../task-result-schema.js";
import {
  selectSkillRoute,
  type SkillLaneConfig,
  type SkillLaneDeps,
  type SkillLaneOutcome,
} from "./skill-lane.js";

/** Default retrieval thresholds for the lane. Conservative (fail-closed). */
export const DEFAULT_SKILL_LANE_RETRIEVAL = {
  confidenceThreshold: 0.5,
  topTwoMarginThreshold: 0.1,
} as const;

/**
 * Compute a stable prompt digest for retrieval / hard-negative matching.
 *
 * The retrieval and classifier engines match trigger phrases / rules as
 * case-insensitive substrings of this digest, so the digest is simply the
 * prompt with collapsed whitespace, lowercased. Deterministic + dependency-free.
 */
export function computePromptDigest(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface SkillLaneDispatchInput {
  prompt: string;
  /** Independently-computed effective sensitivity (NEVER derived from class). */
  sensitivity: Sensitivity;
}

export interface SkillLaneDispatchResult {
  /** The audit record to attach to the structured result (always present). */
  skillRoute: SkillRoute;
  /**
   * True only when a fully verified, drift-free, sensitivity-cleared `active`
   * binding was selected. Slice-one ships no active binding, so this is `false`
   * in production until go-live. When true, the caller would dispatch local;
   * the actual local executor is a separate go-live step.
   */
  selectedLocal: boolean;
  /** The raw lane outcome, for callers that need the binding. */
  outcome: SkillLaneOutcome;
}

/**
 * Consult the local-skill lane for a task. Returns `null` when the lane is
 * disabled (the dispatcher proceeds unchanged — a true no-op). Otherwise returns
 * the audit record + whether a local route was selected.
 *
 * `deps` is injectable for tests; production uses the module defaults, whose
 * `recomputeTupleHashes` returns `null` (no authored live cell ⇒ cannot verify
 * drift ⇒ fail-closed ⇒ always `fallthrough`).
 */
export async function consultSkillLane(
  input: SkillLaneDispatchInput,
  munin: MuninClient,
  opts: { enabled: boolean; retrieval?: SkillLaneConfig["retrieval"] },
  deps: Partial<SkillLaneDeps> = {},
): Promise<SkillLaneDispatchResult | null> {
  if (!opts.enabled) return null;

  const cfg: SkillLaneConfig = {
    enabled: true,
    retrieval: opts.retrieval ?? { ...DEFAULT_SKILL_LANE_RETRIEVAL },
  };

  const outcome = await selectSkillRoute(
    {
      prompt: input.prompt,
      promptDigest: computePromptDigest(input.prompt),
      sensitivity: input.sensitivity,
    },
    munin,
    cfg,
    deps,
  );

  return {
    skillRoute: outcome.skillRoute,
    selectedLocal: outcome.kind === "selected",
    outcome,
  };
}
