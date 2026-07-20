/**
 * Hugin-side export bridge to gille-inference's experiment-outcome import
 * contract (gille-inference#8, `POST /admin/experiments/import`, shipped in
 * gille-inference#34's `src/homeserver/experiment-import.ts`). Owned by the
 * cadence (#266); the wire types here are a Hugin-side mirror of gille's own
 * `experimentOutcomeBundleWireSchema` -- kept in lockstep by hand since the
 * two repositories do not share a types package.
 *
 * Scope boundary: this module only ever calls the *import* endpoint with a
 * bundle built from evidence the caller supplies -- it never fabricates
 * evidence and never re-implements any part of the store, proposer, or
 * packager. See experiment-cadence.ts for how a concluded
 * `LearningExperimentState` becomes a bundle.
 *
 * Documented limitation (do not "fix" by inventing content): gille's wire
 * contract requires each arm to carry `prompt` (a non-empty string) and a
 * nine-field `evidenceIdentity` bundle (model/config/task/prompt/harness/
 * taxonomy/verifier-rubric/sampling/tool-policy digests). Hugin's own
 * `LearningExperimentState`/`RecordedLearningObservation`
 * (experiment-schema.ts) are deliberately CONTENT-BLIND -- they carry
 * `PromptRef`/`HarnessRef` *digests*, never raw prompt bytes, by design (see
 * that file's module doc comment). There is today no Hugin-owned durable
 * store this module can read raw prompt text or the full nine-field identity
 * bundle back out of without crossing that content-blindness boundary on
 * purpose. Rather than invent placeholder content (which
 * `assertAdmissibleEvidenceIdentity` on gille's side is specifically designed
 * to catch and reject as a placeholder/fictional value anyway), this module
 * takes an optional, explicitly pluggable `GilleOutcomeEvidenceResolver` --
 * when none is configured (today's reality), the cadence tick records
 * `"skipped: evidence-resolver-not-configured"` rather than silently
 * fabricating a bundle or silently declining to try.
 */

import { z } from "zod";
import { resolveGatewayRootUrl } from "../orchestrator/provider-config.js";
import type {
  LearningExperimentState,
  RecordedLearningObservation,
} from "./experiment-schema.js";

// ─── Wire schema (mirrors gille-inference's experimentOutcomeBundleWireSchema) ──

const identityOriginSchema = z.enum([
  "learning-task-stamp",
  "server-observed",
  "operator-declared",
]);
export type IdentityOrigin = z.infer<typeof identityOriginSchema>;

const identityUnknownReasonSchema = z.enum([
  "not-applicable",
  "not-observed",
  "legacy",
  "producer-error",
  "policy-unavailable",
]);
export type IdentityUnknownReason = z.infer<typeof identityUnknownReasonSchema>;

const SHA256_DIGEST = /^(sha256:)?[a-f0-9]{64}$/;

export const identityFieldSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("digest"),
    id: z.string().min(1),
    version: z.string().min(1),
    digest: z.string().regex(SHA256_DIGEST, "digest must be sha256:<64 lowercase hex>"),
    origin: identityOriginSchema,
  }).strict(),
  z.object({ kind: z.literal("label"), label: z.string().min(1), origin: identityOriginSchema }).strict(),
  z.object({
    kind: z.literal("unknown"),
    reason: identityUnknownReasonSchema,
    detail: z.string().min(1).optional(),
  }).strict(),
]);
export type IdentityField = z.infer<typeof identityFieldSchema>;

const EVIDENCE_LANES = [
  "chat",
  "mcp-ask",
  "delegate",
  "delegate-disagreement",
  "delegate-shadow",
  "code-loop",
] as const;
const evidenceLaneWireSchema = z.union([z.enum(EVIDENCE_LANES), z.literal("unknown")]);

export const evidenceIdentityWireSchema = z.object({
  modelArtifact: identityFieldSchema,
  configEpoch: identityFieldSchema,
  logicalTask: identityFieldSchema,
  renderedPrompt: identityFieldSchema,
  harness: identityFieldSchema,
  taxonomyVersion: identityFieldSchema,
  verifierRubric: identityFieldSchema,
  sampling: identityFieldSchema,
  toolPolicy: identityFieldSchema,
  lane: evidenceLaneWireSchema,
}).strict();
export type EvidenceIdentityWire = z.infer<typeof evidenceIdentityWireSchema>;

export const verifierIdentityWireSchema = z.object({
  name: z.string().min(1),
  independent: z.boolean(),
  mode: z.enum(["deterministic", "human", "calibrated-judge", "advisory-judge"]),
  calibrationEvidenceId: z.string().min(1).nullish(),
}).strict();
export type VerifierIdentityWire = z.infer<typeof verifierIdentityWireSchema>;

export const exposureIdentityWireSchema = z.object({
  contaminationStatus: z.enum(["clean", "contaminated", "coverage-incomplete"]),
}).strict();
export type ExposureIdentityWire = z.infer<typeof exposureIdentityWireSchema>;

export const reviewIdentityWireSchema = z.object({
  ratingId: z.string().min(1),
  reviewerId: z.string().min(1),
  independent: z.boolean(),
  productOutcome: z.enum(["accepted", "rejected", "conflicted", "unrated"]),
  reasonDigest: z.string().min(1),
  ratedAt: z.string().min(1),
}).strict();
export type ReviewIdentityWire = z.infer<typeof reviewIdentityWireSchema>;

const outcomeWireSchema = z.enum(["pass", "partial", "fail", "error", "unverified"]);
const errorClassWireSchema = z.enum(["empty", "truncated", "timeout", "parse", "infra"]);

export const armOutcomeWireSchema = z.object({
  armId: z.string().min(1),
  sampleId: z.string().min(1),
  taskType: z.string().min(1),
  modelId: z.string().min(1),
  nodeId: z.enum(["m5", "orin"]).optional(),
  outcome: outcomeWireSchema,
  errorClass: errorClassWireSchema.nullish(),
  score: z.number().nullish(),
  latencyMs: z.number().nullish(),
  prompt: z.string().min(1),
  evidenceIdentity: evidenceIdentityWireSchema.optional(),
  verifier: verifierIdentityWireSchema.optional(),
  exposure: exposureIdentityWireSchema.optional(),
  review: reviewIdentityWireSchema.nullish(),
  policyEpoch: z.string().min(1),
  recordedAt: z.string().min(1),
  expiresAt: z.string().min(1).nullish(),
  supersedesRunId: z.string().min(1).nullish(),
  policyQualifiesPartial: z.boolean().optional(),
}).strict();
export type ArmOutcomeWire = z.infer<typeof armOutcomeWireSchema>;

export const experimentOutcomeBundleWireSchema = z.object({
  experimentId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["completed", "failed", "inconclusive"]),
  arms: z.array(armOutcomeWireSchema).min(1),
}).strict();
export type HuginExperimentOutcomeBundle = z.infer<typeof experimentOutcomeBundleWireSchema>;

// ─── Evidence resolution (caller-supplied; see module doc comment) ─────────────

/**
 * Per-(arm, sample) evidence Hugin does not durably carry on
 * `RecordedLearningObservation` today. A resolver returning `null` for a
 * given observation means "cannot honestly resolve this" -- the caller MUST
 * treat that as an exclusion, never substitute a placeholder.
 */
export interface GilleOutcomeArmEvidence {
  prompt: string;
  evidenceIdentity: EvidenceIdentityWire;
  verifier: VerifierIdentityWire;
  exposure: ExposureIdentityWire;
  review?: ReviewIdentityWire | null;
  policyEpoch: string;
  nodeId?: "m5" | "orin";
  expiresAt?: string | null;
}

export interface GilleOutcomeEvidenceResolver {
  resolveArmEvidence(input: {
    experiment: LearningExperimentState;
    observation: RecordedLearningObservation;
  }): Promise<GilleOutcomeArmEvidence | null>;
}

/**
 * Build the export bundle for one concluded experiment. Pairs observations by
 * `sample_id` (same pairing rule `experiment-evaluator.ts` uses) and resolves
 * each arm's extra evidence via the caller-supplied resolver. Samples the
 * resolver cannot honestly resolve are DROPPED from the bundle (never
 * substituted) and returned separately so the caller can record the gap. A
 * `null` return means no sample resolved at all -- there is nothing
 * admissible to export this tick.
 */
export async function buildOutcomeExportBundle(
  experiment: LearningExperimentState,
  runId: string,
  resolver: GilleOutcomeEvidenceResolver,
): Promise<{ bundle: HuginExperimentOutcomeBundle | null; unresolvedSamples: string[] }> {
  const arms: ArmOutcomeWire[] = [];
  const unresolvedSamples: string[] = [];
  for (const observation of experiment.observations) {
    const evidence = await resolver.resolveArmEvidence({ experiment, observation });
    if (!evidence) {
      unresolvedSamples.push(`${observation.arm}:${observation.sample_id}`);
      continue;
    }
    const outcome: ArmOutcomeWire["outcome"] =
      observation.quality_outcome === "infra-error" ? "error" : observation.quality_outcome;
    arms.push(armOutcomeWireSchema.parse({
      armId: observation.arm,
      sampleId: observation.sample_id,
      taskType: experiment.taskType,
      modelId: observation.arm === "champion" ? experiment.champion.model.id : experiment.challenger.model.id,
      ...(evidence.nodeId ? { nodeId: evidence.nodeId } : {}),
      outcome,
      score: observation.verifier_score ?? null,
      latencyMs: observation.latency_ms ?? null,
      prompt: evidence.prompt,
      evidenceIdentity: evidence.evidenceIdentity,
      verifier: evidence.verifier,
      exposure: evidence.exposure,
      review: evidence.review ?? null,
      policyEpoch: evidence.policyEpoch,
      recordedAt: observation.recorded_at,
      expiresAt: evidence.expiresAt ?? null,
    }));
  }
  if (arms.length === 0) return { bundle: null, unresolvedSamples };
  const status: HuginExperimentOutcomeBundle["status"] =
    experiment.status === "promotion-ready" ? "completed" : "inconclusive";
  return {
    bundle: experimentOutcomeBundleWireSchema.parse({
      experimentId: experiment.experimentId,
      runId,
      status,
      arms,
    }),
    unresolvedSamples,
  };
}

// ─── Import result (mirrors gille's ExperimentImportResult) ─────────────────────

const armImportResultSchema = z.object({
  armId: z.string(),
  sampleId: z.string(),
  status: z.enum(["imported", "idempotent-noop", "rejected"]),
  delegationId: z.string().optional(),
  shadow: z.boolean().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
}).passthrough();

const importResultSchema = z.object({
  experimentId: z.string(),
  runId: z.string(),
  arms: z.array(armImportResultSchema),
}).passthrough();

export type GilleOutcomeArmImportResult = z.infer<typeof armImportResultSchema>;
export type GilleOutcomeImportResult = z.infer<typeof importResultSchema>;

export interface GilleOutcomeExportPort {
  exportOutcome(bundle: HuginExperimentOutcomeBundle): Promise<GilleOutcomeImportResult>;
}

export class GilleOutcomeExportError extends Error {
  constructor(public readonly code: string) {
    super(`gille experiment-outcome export failed (${code})`);
    this.name = "GilleOutcomeExportError";
  }
}

/** Resolve the owner-only admin import endpoint, mirroring m5-task-exposure.ts's `resolveTaskExposureLookupEndpoint`. */
export function resolveExperimentOutcomeExportEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new GilleOutcomeExportError("invalid-gateway-url");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/" && parsed.pathname !== "/v1" && parsed.pathname !== "/v1/") {
    throw new GilleOutcomeExportError("invalid-gateway-url");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new GilleOutcomeExportError("invalid-gateway-url");
  }
  const resolved = resolveGatewayRootUrl({ HOMESERVER_GATEWAY_URL: parsed.origin });
  if (!resolved.ok) throw new GilleOutcomeExportError("invalid-gateway-url");
  return `${resolved.baseUrl}/admin/experiments/import`;
}

/** Real HTTP client for gille-inference#8's import endpoint. Never invoked unless a caller wires it in. */
export function createGilleOutcomeExportClient(input: {
  gatewayBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): GilleOutcomeExportPort {
  const endpoint = resolveExperimentOutcomeExportEndpoint(input.gatewayBaseUrl);
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new GilleOutcomeExportError("missing-api-key");
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new GilleOutcomeExportError("invalid-timeout");
  }

  return {
    async exportOutcome(bundle: HuginExperimentOutcomeBundle): Promise<GilleOutcomeImportResult> {
      const parsedBundle = experimentOutcomeBundleWireSchema.parse(bundle);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(parsedBundle),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timer);
        if (controller.signal.aborted) throw new GilleOutcomeExportError("timeout");
        throw new GilleOutcomeExportError("network-error");
      }
      clearTimeout(timer);
      if (response.status === 400) throw new GilleOutcomeExportError("malformed-bundle");
      if (!response.ok) throw new GilleOutcomeExportError(`http-${response.status}`);
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new GilleOutcomeExportError("invalid-json");
      }
      const parsed = importResultSchema.safeParse(json);
      if (!parsed.success) throw new GilleOutcomeExportError("invalid-response");
      return parsed.data;
    },
  };
}
