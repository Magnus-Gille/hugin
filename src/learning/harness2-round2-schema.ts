/**
 * Content-blind preregistration contract for the Harness² round-2 pilot.
 *
 * This module only validates frozen identifiers and resource controls and
 * derives a deterministic cell list. It never runs a model, verifier, or
 * network call, and a frozen protocol is not evidence of qualification.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  configurationChangedAxes,
  learningExperimentCreateSchema,
  learningExperimentGatesSchema,
  learningConfigurationSchema,
} from "./experiment-schema.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const repository = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/);
const solModelIdentifier = z.string().regex(/^gpt-[0-9]+\.[0-9]+-sol$/);
const immutableVersion = z.string().min(1).max(120).refine(
  isImmutableVersion,
  "version identifiers must be immutable",
);
function isImmutableVersion(value: string): boolean {
  return !/(?:latest|current|mutable|floating|head|working-tree|main|master|develop|development|trunk|default|tip)/i.test(value)
    && !/^refs\/heads\//i.test(value);
}

export const HARNESS2_ROUND2_ARMS = [
  "PiFresh",
  "HarnessFresh",
  "PiLearned",
  "HarnessLearned",
] as const;
export type Harness2Round2Arm = typeof HARNESS2_ROUND2_ARMS[number];

export const harness2Round2ArmSchema = z.enum(HARNESS2_ROUND2_ARMS);
const guidanceSchema = z.enum(["fresh", "learned"]);

export const harness2Round2TaskSchema = z.object({
  id: identifier,
  holdout: z.boolean(),
  repository,
  base_sha: gitSha,
  task_sha: gitSha,
  verifier_sha: gitSha,
}).strict();
export type Harness2Round2Task = z.infer<typeof harness2Round2TaskSchema>;

export const harness2Round2ResourceCapsSchema = z.object({
  input_tokens: z.number().int().positive().max(10_000_000),
  output_tokens: z.number().int().positive().max(10_000_000),
  cache_read_tokens: z.number().int().nonnegative().max(10_000_000),
  cache_write_tokens: z.number().int().nonnegative().max(10_000_000),
  total_reported_tokens: z.number().int().positive().max(40_000_000),
  wall_time_ms: z.number().int().positive().max(86_400_000),
  attempts: z.number().int().positive().max(100),
}).strict().superRefine((value, ctx) => {
  const expected = value.input_tokens + value.output_tokens + value.cache_read_tokens + value.cache_write_tokens;
  if (value.total_reported_tokens !== expected) {
    ctx.addIssue({ code: "custom", path: ["total_reported_tokens"], message: "total reported tokens must include input, output, cache-read, and cache-write tokens" });
  }
});
export type Harness2Round2ResourceCaps = z.infer<typeof harness2Round2ResourceCapsSchema>;

const learningConfigurationShape = learningConfigurationSchema;

export const harness2Round2ArmRecordSchema = z.object({
  name: harness2Round2ArmSchema,
  guidance: guidanceSchema,
  provider: z.literal("openai"),
  model: solModelIdentifier,
  effort: z.literal("high"),
  auth_route: z.literal("subscription"),
  resource_caps: harness2Round2ResourceCapsSchema,
  configuration: learningConfigurationShape,
}).strict();
export type Harness2Round2ArmRecord = z.infer<typeof harness2Round2ArmRecordSchema>;

export const harness2Round2PrimaryCriterionSchema = z.object({
  id: identifier,
  status: z.literal("frozen"),
  oracle_sha: sha256,
  known_bad_sha: sha256,
  known_good_sha: sha256,
}).strict();

const learnedArtifactSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({
    status: z.literal("frozen"),
    sha256,
    source_task_ids: z.array(identifier).min(1),
  }).strict(),
]);
export const harness2Round2LearnedArtifactSchema = learnedArtifactSchema;

const protocolShape = {
  protocol_id: identifier,
  phase: z.enum(["draft", "frozen"]),
  admission_stage: z.enum(["fresh", "transfer"]),
  protocol_sha256: sha256.optional(),
  fresh_tasks: z.array(harness2Round2TaskSchema).length(3),
  holdout_tasks: z.array(harness2Round2TaskSchema).length(2),
  repeats: z.literal(3),
  arms: z.array(harness2Round2ArmRecordSchema).length(4),
  resources: harness2Round2ResourceCapsSchema,
  primary_criteria: z.array(harness2Round2PrimaryCriterionSchema).min(1),
  learned_artifact: learnedArtifactSchema,
};

function equal(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function issue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

function validateCommon(value: z.infer<z.ZodObject<typeof protocolShape>>, ctx: z.RefinementCtx): void {
  const allTasks = [...value.fresh_tasks, ...value.holdout_tasks];
  const ids = new Set<string>();
  const bindings = new Set<string>();
  for (const [index, task] of allTasks.entries()) {
    if (ids.has(task.id)) issue(ctx, [index < 3 ? "fresh_tasks" : "holdout_tasks", index < 3 ? index : index - 3, "id"], "task IDs must be unique across fresh and holdout sets");
    ids.add(task.id);
    const binding = `${task.repository}:${task.base_sha}:${task.task_sha}`;
    if (bindings.has(binding)) issue(ctx, ["fresh_tasks"], "task bindings must not collide");
    bindings.add(binding);
  }
  value.fresh_tasks.forEach((task, index) => {
    if (task.holdout) issue(ctx, ["fresh_tasks", index, "holdout"], "fresh tasks must not be marked holdout");
  });
  value.holdout_tasks.forEach((task, index) => {
    if (!task.holdout) issue(ctx, ["holdout_tasks", index, "holdout"], "holdout tasks must be marked holdout");
  });

  const expectedCaps = value.resources;
  for (const [index, arm] of value.arms.entries()) {
    if (!equal(arm.resource_caps, expectedCaps)) issue(ctx, ["arms", index, "resource_caps"], "all arms must use the shared resource caps");
    const expectedGuidance = arm.name.endsWith("Learned") ? "learned" : "fresh";
    if (arm.guidance !== expectedGuidance) issue(ctx, ["arms", index, "guidance"], "arm guidance does not match its preregistered arm");
    if (arm.model !== value.arms[0]?.model) issue(ctx, ["arms", index, "model"], "all arms must pin the same model");
    if (arm.configuration.model.provider !== "openai" || arm.configuration.model.runtime !== "subscription" || arm.configuration.model.id !== arm.model || arm.configuration.model.id !== value.arms[0]?.configuration.model.id) {
      issue(ctx, ["arms", index, "configuration", "model"], "all configurations must pin the same OpenAI model");
    }
    if (arm.configuration.model.config.reasoning !== "high") issue(ctx, ["arms", index, "configuration", "model", "config", "reasoning"], "all configurations must pin high reasoning");
    const versionFields = [
      arm.configuration.prompt.version,
      arm.configuration.harness.version,
      arm.configuration.harness.contextStrategy,
      arm.configuration.harness.toolPolicyVersion,
      arm.configuration.logging.schemaVersion,
      arm.configuration.testHarness.version,
      arm.configuration.testHarness.oracleVersion,
      arm.configuration.testHarness.holdoutRevision,
      arm.configuration.routing.version,
      arm.configuration.model.config.quantization,
      arm.configuration.model.config.templateVersion,
    ];
    if (versionFields.some((version) => version !== undefined && !isImmutableVersion(version))) issue(ctx, ["arms", index, "configuration"], "configuration version identifiers must be immutable");
  }

  const names = value.arms.map((arm) => arm.name);
  for (const name of HARNESS2_ROUND2_ARMS) {
    if (names.filter((candidate) => candidate === name).length !== 1) issue(ctx, ["arms"], `arm ${name} must occur exactly once`);
  }

  const criteriaIds = new Set<string>();
  for (const [index, criterion] of value.primary_criteria.entries()) {
    if (criteriaIds.has(criterion.id)) issue(ctx, ["primary_criteria", index, "id"], "primary criterion IDs must be unique");
    criteriaIds.add(criterion.id);
    if (criterion.known_bad_sha === criterion.known_good_sha) issue(ctx, ["primary_criteria", index], "known-bad and known-good fixtures must differ");
  }

  const artifact = value.learned_artifact;
  if (artifact.status === "frozen") {
    const freshIds = new Set(value.fresh_tasks.map((task) => task.id));
    const sourceIds = new Set<string>();
    for (const [index, taskId] of artifact.source_task_ids.entries()) {
      if (sourceIds.has(taskId)) issue(ctx, ["learned_artifact", "source_task_ids", index], "learned source task IDs must be unique");
      sourceIds.add(taskId);
      if (!freshIds.has(taskId)) issue(ctx, ["learned_artifact", "source_task_ids", index], "learned guidance may not use holdout task IDs");
    }
    for (const [index, arm] of value.arms.entries()) {
      if (arm.name.endsWith("Learned") && arm.configuration.prompt.sha256 !== artifact.sha256) {
        issue(ctx, ["arms", index, "configuration", "prompt", "sha256"], "learned prompt hash must equal the frozen learned artifact hash");
      }
    }
  }

  const byName = new Map(value.arms.map((arm) => [arm.name, arm]));
  const contrasts: Array<[Harness2Round2Arm, Harness2Round2Arm, "agent-harness" | "agent-prompt"]> = [
    ["PiFresh", "HarnessFresh", "agent-harness"],
    ["PiLearned", "HarnessLearned", "agent-harness"],
    ["PiFresh", "PiLearned", "agent-prompt"],
    ["HarnessFresh", "HarnessLearned", "agent-prompt"],
  ];
  for (const [championName, challengerName, axis] of contrasts) {
    const champion = byName.get(championName)?.configuration;
    const challenger = byName.get(challengerName)?.configuration;
    if (!champion || !challenger) continue;
    if (axis === "agent-prompt" && artifact.status === "pending" && (value.phase === "draft" || value.admission_stage === "fresh")) {
      const changed = configurationChangedAxes(champion, challenger);
      if (changed.length !== 1 || changed[0] !== "agent-prompt") {
        issue(ctx, ["arms"], `${championName}/${challengerName} pending contrast may change only agent-prompt; observed ${changed.join(", ") || "none"}`);
      }
      continue;
    }
    const result = learningExperimentCreateSchema.safeParse({
      experiment_id: `round2-${championName}-${challengerName}`.toLowerCase(),
      scope: "harness2-round2",
      task_type: "code-edit",
      hypothesis: "linked one-axis contrast",
      change_axis: axis,
      champion,
      challenger,
      gates: learningExperimentGatesSchema.parse({ primaryMetric: "quality-rate" }),
    });
    if (!result.success) issue(ctx, ["arms"], `${championName}/${challengerName} must satisfy the existing one-axis configuration validator: ${result.error.message}`);
  }
}

function validateFrozen(value: z.infer<z.ZodObject<typeof protocolShape>>, ctx: z.RefinementCtx): void {
  if (value.admission_stage === "transfer" && value.learned_artifact.status !== "frozen") issue(ctx, ["learned_artifact"], "frozen transfer admission requires a hashed learned artifact");
  const expected = computeHarness2Round2ProtocolHash(value);
  if (value.protocol_sha256 !== expected) issue(ctx, ["protocol_sha256"], `protocol hash mismatch; expected ${expected}`);
}

export const harness2Round2DraftSchema = z.object({ ...protocolShape, phase: z.literal("draft") }).strict().superRefine(validateCommon);
export const harness2Round2FrozenSchema = z.object({ ...protocolShape, phase: z.literal("frozen"), protocol_sha256: sha256 }).strict().superRefine((value, ctx) => {
  validateCommon(value, ctx);
  validateFrozen(value, ctx);
});
export const harness2Round2ProtocolSchema = z.union([harness2Round2DraftSchema, harness2Round2FrozenSchema]);
export type Harness2Round2Protocol = z.infer<typeof harness2Round2ProtocolSchema>;

export function validateHarness2Round2Protocol(input: unknown) {
  return harness2Round2ProtocolSchema.safeParse(input);
}

export interface Harness2Round2Cell {
  cell_id: string;
  phase: "fresh" | "transfer";
  task_id: string;
  repository: string;
  base_sha: string;
  task_sha: string;
  verifier_sha: string;
  repeat: number;
  arm: Harness2Round2Arm;
}

export interface Harness2Round2Schedule {
  fresh: Harness2Round2Cell[];
  transfer: Harness2Round2Cell[];
}

function cells(tasks: Harness2Round2Task[], arms: readonly Harness2Round2Arm[], phase: "fresh" | "transfer"): Harness2Round2Cell[] {
  return tasks.flatMap((task, taskIndex) => Array.from({ length: 3 }, (_, repeat) => {
    const offset = (taskIndex + repeat) % arms.length;
    const orderedArms = [...arms.slice(offset), ...arms.slice(0, offset)];
    return orderedArms.map((arm) => ({
    cell_id: `${phase}:${task.id}:r${repeat + 1}:${arm}`,
    phase,
    task_id: task.id,
    repository: task.repository,
    base_sha: task.base_sha,
    task_sha: task.task_sha,
    verifier_sha: task.verifier_sha,
    repeat: repeat + 1,
    arm,
    }));
  }).flat());
}

export function createHarness2Round2Schedule(protocol: Harness2Round2Protocol): Harness2Round2Schedule {
  return {
    fresh: cells(protocol.fresh_tasks, ["PiFresh", "HarnessFresh"], "fresh"),
    transfer: cells(protocol.holdout_tasks, HARNESS2_ROUND2_ARMS, "transfer"),
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeHarness2Round2Protocol(protocol: Harness2Round2Protocol | z.infer<z.ZodObject<typeof protocolShape>>): string {
  const { protocol_sha256: _protocolHash, ...payload } = protocol as Record<string, unknown>;
  return stable(payload);
}

export function computeHarness2Round2ProtocolHash(protocol: Harness2Round2Protocol | z.infer<z.ZodObject<typeof protocolShape>>): string {
  return createHash("sha256").update(canonicalizeHarness2Round2Protocol(protocol)).digest("hex");
}
