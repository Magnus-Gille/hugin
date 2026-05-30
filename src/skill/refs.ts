import { createHash } from "node:crypto";
import { z } from "zod";
import { sensitivitySchema, type Sensitivity } from "../sensitivity.js";

// Shared foundation for the eval-gated skill-distillation system (issues #79–#84,
// design: docs/design/skill-distillation-implementation.md). Every artifact type
// (RouteBinding, TaskClassifier, SkillPackage/Profile, EvalSuite, ValidationRun)
// references the others by id + content hash, so they MUST agree on:
//   - a single canonical-JSON hashing scheme (so a profile/binding/run hash is
//     stable and drift detection works), and
//   - the shared enums / sub-schemas below.
// This module is the one place those live; the per-artifact modules import here.

export { sensitivitySchema };
export type { Sensitivity };

// --- Canonical JSON + content hashing -------------------------------------
// Deterministic: object keys sorted recursively, no insignificant whitespace,
// arrays preserved in order. `undefined` members are dropped (JSON semantics).
// The same input value ALWAYS produces the same string → the same sha256, which
// is what lets A2 drift-detection compare a stored tuple hash to a recomputed one.
export function canonicalJSONString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue; // mirror JSON.stringify drop-undefined
    out[key] = canonicalize(v);
  }
  return out;
}

/** sha256 (hex) over the canonical JSON of `value`. Stable + reproducible. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJSONString(value)).digest("hex");
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
export const sha256HexSchema = z.string().regex(SHA256_HEX, "expected 64-char sha256 hex");

// --- Shared enums ---------------------------------------------------------

// RouteBinding / classifier lifecycle. `active` is gated on Hugin #77 (now fixed)
// for any Hugin-integrated evidence; offline-fixture states are not.
export const lifecycleStateSchema = z.enum([
  "draft",
  "candidate",
  "shadow",
  "active",
  "stale",
  "quarantined",
  "disabled",
]);
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;

// Why a local-lane attempt failed (recorded in calibrated metrics + validation runs).
export const failureKindSchema = z.enum([
  "retrieval-miss",
  "classification-wrong",
  "preflight",
  "parser",
  "schema",
  "tests",
  "timeout",
  "grader",
  "delivery",
  "infra",
]);
export type FailureKind = z.infer<typeof failureKindSchema>;

// The pipeline STAGE at which a fixture failure surfaced (anti-Goodhart, A6) —
// turns "local is flaky" into "profile vX fails retrieval-negative Z".
export const failureStageSchema = z.enum([
  "retrieval",
  "classification",
  "preflight",
  "parser",
  "schema",
  "tests",
  "timeout",
  "grader",
]);
export type FailureStage = z.infer<typeof failureStageSchema>;

// Trust/egress class of a cell or skill — mirrors the runtime-registry policy axis.
export const egressClassSchema = z.enum(["local", "subscription", "third-party"]);
export type EgressClass = z.infer<typeof egressClassSchema>;

// --- Shared sub-schemas ---------------------------------------------------

// Content-addressed references: a RouteBinding never inlines the artifacts it
// binds — it pins them by (id, version?, hash). Drift = a current hash no longer
// matching the pinned hash → the binding fail-closes to `stale`.
export const tupleRefSchema = z.object({
  taskClassId: z.string().min(1),
  taskClassVersion: z.number().int().nonnegative(),
  taskClassHash: sha256HexSchema,
  skillProfileId: z.string().min(1),
  skillProfileHash: sha256HexSchema,
  cellManifestId: z.string().min(1),
  cellManifestHash: sha256HexSchema,
  evalSuiteId: z.string().min(1),
  evalSuiteHash: sha256HexSchema,
});
export type TupleRef = z.infer<typeof tupleRefSchema>;

// Calibrated metrics from a binding's active ValidationRun — NOT a boolean and
// NOT live telemetry. The partial-pass / latency texture is decisive (C-debate).
export const calibratedMetricsSchema = z.object({
  passRate: z.number().min(0).max(1),
  sampleSize: z.number().int().positive(),
  p50DurationSeconds: z.number().nonnegative(),
  p95DurationSeconds: z.number().nonnegative(),
  failureKindHistogram: z.record(failureKindSchema, z.number().int().nonnegative()),
  abstentionRate: z.number().min(0).max(1),
});
export type CalibratedMetrics = z.infer<typeof calibratedMetricsSchema>;

/**
 * Whether two tuple refs pin the same content (all four artifact hashes match).
 * The core of fail-closed drift detection: compare a binding's pinned tuple to
 * the tuple recomputed from current artifact content.
 */
export function tupleHashesMatch(a: TupleRef, b: TupleRef): boolean {
  return (
    a.taskClassHash === b.taskClassHash &&
    a.skillProfileHash === b.skillProfileHash &&
    a.cellManifestHash === b.cellManifestHash &&
    a.evalSuiteHash === b.evalSuiteHash
  );
}
