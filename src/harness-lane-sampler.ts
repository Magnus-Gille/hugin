/**
 * Standing harness-lane sampler (hugin#267).
 *
 * hugin#192 was a one-off campaign that hand-picked a few tickets and ran
 * BOTH the one-shot broker lane and the M5 harness lane (`code_loop` /
 * `opencode`) on matched sub-tasks, then graded both by hand. That produced
 * the first real evidence that the harness lane exists at all, but a single
 * campaign is a snapshot, not continuous improvement: nothing keeps sampling
 * new evidence once the campaign ends.
 *
 * This module is the deterministic decision at the center of the standing
 * lane: given one eligible bounded coding sub-task, decide — reproducibly,
 * with no side effects and no execution — whether it *additionally* gets
 * sampled into the harness lane for shadow evidence-gathering. It never
 * executes anything and never changes production routing; see
 * `src/harness-lane-executor.ts` for the wiring that acts on this decision.
 *
 * Determinism is the whole point: the same task (same natural key) must
 * always land on the same lane, on every call, on every process, forever
 * (until a deliberate `HARNESS_LANE_SAMPLER_VERSION` bump reshuffles
 * assignments on purpose). That is what makes the harvest reproducible and
 * idempotent — replaying or re-inspecting a task can never flip its lane.
 */

import { createHash } from "node:crypto";
import type { TaskType } from "./broker/task-type-metadata.js";

/** Bump this when the sampling function itself changes on purpose (e.g. a
 * different hash construction) — it is folded into the digest input, so a
 * version bump is a deliberate, auditable re-shuffle of every assignment
 * rather than a silent one. */
export const HARNESS_LANE_SAMPLER_VERSION = "v1" as const;

/**
 * `HUGIN_HARNESS_LANE_FRACTION` — fraction in `[0, 1]` of ELIGIBLE bounded
 * coding sub-tasks to additionally sample into the harness lane for shadow
 * evidence-gathering.
 *
 * Absent, empty, or `"0"` means the standing lane is fully OFF: every
 * eligible task still resolves to the one-shot lane (today's status quo).
 * That is the default — the lane ships shadowed until a human raises the
 * fraction above 0 after reviewing the rolling comparison this ticket
 * produces (`npm run report:harness-comparison`).
 *
 * Any value that does not parse as a finite number in `[0, 1]` is treated as
 * a SAMPLER MALFUNCTION, not silently coerced to "off" or thrown at the
 * caller: `decideHarnessLane` fails closed to the one-shot lane (the safe,
 * already-shipping default) and stamps the decision with
 * `reason: "sampler-malfunction"` so the misconfiguration stays visible in
 * evidence instead of masquerading as a clean 0% fraction.
 */
export const HARNESS_LANE_FRACTION_ENV = "HUGIN_HARNESS_LANE_FRACTION";

/**
 * Task types where an agentic tool-loop plausibly matters: multi-file code
 * edits. hugin#192's one datapoint found the harness's only known soft spot
 * is import/export wiring across files — exactly what these types cover.
 * Judgment/one-shot types (`extract`, `classify`, `qa-factual`, `summarize`,
 * ...) are deliberately excluded: a one-shot classification gives an agentic
 * loop nothing to inspect, edit, or iterate against, so routing it through a
 * harness would only add latency for zero signal.
 */
export const HARNESS_LANE_ELIGIBLE_TASK_TYPES = [
  "code-implement",
  "code-edit",
  "unit-test-gen",
] as const;
export type HarnessLaneEligibleTaskType = (typeof HARNESS_LANE_ELIGIBLE_TASK_TYPES)[number];

// Compile-time proof the eligible list is actually a subset of the canonical
// task-type taxonomy — a typo here would otherwise silently never match.
const _eligibleIsTaskTypeSubset: readonly TaskType[] = HARNESS_LANE_ELIGIBLE_TASK_TYPES;
void _eligibleIsTaskTypeSubset;

const ELIGIBLE_TASK_TYPE_SET: ReadonlySet<string> = new Set(HARNESS_LANE_ELIGIBLE_TASK_TYPES);

export function isHarnessLaneEligibleTaskType(taskType: string): taskType is HarnessLaneEligibleTaskType {
  return ELIGIBLE_TASK_TYPE_SET.has(taskType);
}

export type LaneKind = "one-shot" | "harness";

export type LaneDecisionReason =
  | "not-eligible-task-type"
  | "fraction-zero-or-absent"
  | "sampled-one-shot"
  | "sampled-harness"
  | "sampler-malfunction";

export interface HarnessLaneDecision {
  lane: LaneKind;
  eligible: boolean;
  /** The effective fraction actually applied. Always `0` when off, ineligible,
   * or malfunctioning. */
  fraction: number;
  reason: LaneDecisionReason;
  /** Present only when `reason === "sampler-malfunction"` — human-readable,
   * content-blind (never echoes task content, only the env/hash fault). */
  malfunctionDetail?: string;
  /** Hex digest of the sampled natural key. Empty only in the (defensive,
   * practically unreachable) case where digesting itself threw. */
  keyDigestHex: string;
  samplerVersion: typeof HARNESS_LANE_SAMPLER_VERSION;
}

export interface HarnessLaneTaskKey {
  /** Stable natural key identifying the eligible sub-task — the durable
   * Hugin taskId (or, for a sub-task inside a larger task, taskId plus a
   * stable sub-task discriminator baked in by the caller). Must be identical
   * on every call for the same logical task: the sampler has no memory of
   * its own, so reproducibility comes entirely from this key being stable. */
  taskId: string;
  taskType: string;
}

export interface HarnessLaneSamplerDeps {
  /** Defaults to `process.env`. Overridable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Hex-digest function, defaults to SHA-256. Overridable so a test can force
   * the "hash error" malfunction path deterministically without contriving an
   * actual crypto failure. */
  digest?: (input: string) => string;
}

function defaultDigest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function parseFraction(raw: string | undefined): { fraction: number } | { malfunction: string } {
  if (raw === undefined || raw.trim() === "") return { fraction: 0 };
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { malfunction: `${HARNESS_LANE_FRACTION_ENV}="${raw}" is not a finite number` };
  }
  if (value < 0 || value > 1) {
    return { malfunction: `${HARNESS_LANE_FRACTION_ENV}=${value} is outside the valid [0, 1] range` };
  }
  return { fraction: value };
}

/** Deterministic `[0, 1)` sample derived from the sampler version + natural
 * key. The first 8 hex chars of the digest become a uint32, scaled to the
 * unit interval — cheap, stable across processes/platforms, and independent
 * of insertion order or call count (no shared mutable state). */
function sampleUnitInterval(
  naturalKey: string,
  digest: (input: string) => string,
): { value: number; digestHex: string } {
  const digestHex = digest(`harness-lane-sampler:${HARNESS_LANE_SAMPLER_VERSION}\0${naturalKey}`);
  const uint32 = Number.parseInt(digestHex.slice(0, 8), 16);
  if (!Number.isFinite(uint32)) {
    throw new Error(`harness-lane sampler digest did not yield a usable prefix: "${digestHex.slice(0, 8)}"`);
  }
  return { value: uint32 / 0x1_0000_0000, digestHex };
}

/**
 * Decide, deterministically, which lane one eligible task's sub-task should
 * additionally run through. Never throws: a hash failure or malformed digest
 * is itself a "sampler malfunction" and falls back to the one-shot lane, same
 * as a bad env value.
 */
export function decideHarnessLane(
  key: HarnessLaneTaskKey,
  deps: HarnessLaneSamplerDeps = {},
): HarnessLaneDecision {
  const env = deps.env ?? process.env;
  const digest = deps.digest ?? defaultDigest;
  const naturalKey = `${key.taskType}\0${key.taskId}`;

  let keyDigestHex = "";
  let sample = 0;
  try {
    const sampled = sampleUnitInterval(naturalKey, digest);
    keyDigestHex = sampled.digestHex;
    sample = sampled.value;
  } catch (err) {
    return {
      lane: "one-shot",
      eligible: isHarnessLaneEligibleTaskType(key.taskType),
      fraction: 0,
      reason: "sampler-malfunction",
      malfunctionDetail: err instanceof Error ? err.message : String(err),
      keyDigestHex: "",
      samplerVersion: HARNESS_LANE_SAMPLER_VERSION,
    };
  }

  const eligible = isHarnessLaneEligibleTaskType(key.taskType);
  if (!eligible) {
    return {
      lane: "one-shot",
      eligible: false,
      fraction: 0,
      reason: "not-eligible-task-type",
      keyDigestHex,
      samplerVersion: HARNESS_LANE_SAMPLER_VERSION,
    };
  }

  const parsedFraction = parseFraction(env[HARNESS_LANE_FRACTION_ENV]);
  if ("malfunction" in parsedFraction) {
    return {
      lane: "one-shot",
      eligible: true,
      fraction: 0,
      reason: "sampler-malfunction",
      malfunctionDetail: parsedFraction.malfunction,
      keyDigestHex,
      samplerVersion: HARNESS_LANE_SAMPLER_VERSION,
    };
  }

  const { fraction } = parsedFraction;
  if (fraction <= 0) {
    return {
      lane: "one-shot",
      eligible: true,
      fraction,
      reason: "fraction-zero-or-absent",
      keyDigestHex,
      samplerVersion: HARNESS_LANE_SAMPLER_VERSION,
    };
  }

  const lane: LaneKind = sample < fraction ? "harness" : "one-shot";
  return {
    lane,
    eligible: true,
    fraction,
    reason: lane === "harness" ? "sampled-harness" : "sampled-one-shot",
    keyDigestHex,
    samplerVersion: HARNESS_LANE_SAMPLER_VERSION,
  };
}
