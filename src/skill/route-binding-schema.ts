import { z } from "zod";
import {
  sha256HexSchema,
  lifecycleStateSchema,
  failureKindSchema,
  failureStageSchema,
  egressClassSchema,
  tupleRefSchema,
  calibratedMetricsSchema,
  sensitivitySchema,
} from "./refs.js";

// Re-export the shared types that callers of this module commonly need.
export {
  lifecycleStateSchema,
  tupleRefSchema,
  calibratedMetricsSchema,
  sensitivitySchema,
};
export type { LifecycleState, TupleRef, CalibratedMetrics, Sensitivity } from "./refs.js";

// --- FallbackPolicy -------------------------------------------------------
// Decided PRE-execution (not post-failure under recovery pressure).
// Reuses the existing registry policy axes (egress / zdr / provider).
export const fallbackPolicySchema = z.object({
  /** Whether a cloud runtime is permitted at all for this class. */
  cloudAllowed: z.boolean(),
  /** Whether Hugin may auto-escalate to cloud on local failure without approval. */
  autoEscalateAllowed: z.boolean(),
  /** Whether a human must approve before cloud fallback is triggered. */
  requiresUserApproval: z.boolean(),
  /** Mirrors RuntimeDefinition.zdrRequired — zero-data-residency constraint. */
  zdrRequired: z.boolean(),
  /** Mirrors the runtime-registry Egress axis. */
  egressClass: egressClassSchema,
  /**
   * Soft cap on spend per task for cloud fallback.
   * Absent = no cap. Router may still apply registry-level limits.
   */
  maxCloudCostUsd: z.number().nonnegative().optional(),
  /** Ordered list of runtime IDs to try for cloud fallback. */
  fallbackProviderSet: z.array(z.string().min(1)).default([]),
  /** Failure kinds that should trigger a cloud fallback (others → fail hard). */
  fallbackOnFailureKinds: z.array(failureKindSchema).default([]),
});
export type FallbackPolicy = z.infer<typeof fallbackPolicySchema>;

// --- RouteBinding ---------------------------------------------------------
// The *only* selectable object in the skill-distillation system.
// Immutable rows + mutable active pointer (state tag + activeValidationRunHash).
// All referenced artifacts are pinned by content hash — drift auto-demotes to stale.
export const routeBindingSchema = z.object({
  schemaVersion: z.literal(1),
  bindingId: z.string().min(1),
  /** Monotonically increasing version counter within a bindingId. */
  version: z.number().int().nonnegative(),
  /** Current lifecycle position. Only `active` bindings are selectable. */
  state: lifecycleStateSchema,
  /** Content-addressed references to all four artifacts this binding pins. */
  tuple: tupleRefSchema,
  /** Pre-execution routing policy. Never modified post-failure. */
  fallbackPolicy: fallbackPolicySchema,
  /**
   * Calibrated metrics from the binding's active ValidationRun.
   * Absent until the binding reaches >= shadow state (requires at least one run).
   */
  metrics: calibratedMetricsSchema.optional(),
  /**
   * sha256 of the ValidationRun that promoted this binding to its current state.
   * Used as an immutable provenance link; must match a write-once run record.
   */
  activeValidationRunHash: sha256HexSchema.optional(),
  /**
   * min(cell trust ceiling, classifier confidence floor, eval suite quality floor).
   * Router checks this against the task's effective sensitivity; binding is
   * not selectable if the task exceeds this ceiling.
   */
  effectiveSensitivityCeiling: sensitivitySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  notes: z.string().optional(),
});
export type RouteBinding = z.infer<typeof routeBindingSchema>;

// --- ValidationRun --------------------------------------------------------
// Write-once, content-addressed evidence record.
// runHash = sha256 over the full reproducibility envelope below.
export const validationRunSchema = z.object({
  schemaVersion: z.literal(1),
  /** sha256 over the canonical JSON of everything below this field. */
  runHash: sha256HexSchema,
  bindingId: z.string().min(1),
  /** Artifact hashes pinned at run time — must match the binding's tuple. */
  tuple: tupleRefSchema,

  // --- Full reproducibility envelope (critique C05) -----------------------
  /** sha256 of the grader code / grader artifact used. */
  graderHash: z.string(),
  /** sha256 of the prompt template used for each fixture. */
  promptHash: z.string(),
  harnessName: z.string(),
  harnessVersion: z.string(),
  wrapperName: z.string(),
  wrapperVersion: z.string(),
  /** Exact model identifier string (e.g. "qwen3-coder-30b-instruct"). */
  modelId: z.string(),
  /** sha256 or OCI digest of the GGUF / ONNX / safetensors file. */
  modelFileHash: z.string(),
  /** e.g. "Q4_K_M", "fp16", "int8" */
  quantization: z.string(),
  contextCap: z.number().int().positive(),
  /** e.g. "native-thinking", "forced-think-false", "openai-compat" */
  thinkingFormat: z.string(),
  toolCallParserResult: z.enum(["pass", "fail", "skipped"]),
  os: z.string(),
  /** e.g. "pi5-8gb", "laptop-m3" */
  hardwareClass: z.string(),
  memoryCapMb: z.number().int(),
  /** sha256 over the tool environment manifest (MCP versions, tool allowlist). */
  toolEnvManifestHash: z.string(),
  executionTimeoutMs: z.number().int(),
  stepBudget: z.number().int(),

  // --- Results ------------------------------------------------------------
  /** Aggregate metrics across all fixtures in this run. */
  metrics: calibratedMetricsSchema,
  perFixtureResults: z.array(
    z.object({
      fixtureId: z.string(),
      outcome: z.enum(["pass", "fail", "abstain"]),
      /** Which pipeline stage surfaced this failure (absent for passes). */
      caughtAtStage: failureStageSchema.optional(),
      /** Which oracle rendered the verdict. */
      oracleId: z.string(),
    }),
  ),
  ranAt: z.string(),
  /**
   * Always true — ValidationRuns are write-once; this literal prevents
   * accidental mutation and is checked at deserialization.
   */
  immutable: z.literal(true),
});
export type ValidationRun = z.infer<typeof validationRunSchema>;
