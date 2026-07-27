/**
 * Deterministic, proposal-only producer for gille-roster-proposal-v1 (Hugin #336).
 *
 * This module has no transport, credential, apply, arming, or configuration-write
 * capability.  The caller supplies only content-addressed identities; the emitted
 * payload is intended for the route-scoped `service:hugin` admission endpoint.
 */
import { createHash } from "node:crypto";
import { canonicalizeJcs } from "../jcs.js";
import {
  AUTONOMY_PROPOSAL_POLICY_EPOCH_ID,
  canonicalAutonomyProposalDigest,
  type AutonomyProposalReceipt,
} from "./proposal-receipts.js";

export const GILLE_ROSTER_PROPOSAL_CONTRACT_VERSION = "gille-roster-proposal-v1" as const;
export const GILLE_ROSTER_PROPOSAL_SERIALIZER_VERSION = "hugin-roster-proposal-v1" as const;
export const GILLE_ROSTER_PROPOSAL_PRINCIPAL = "service:hugin" as const;
export const GILLE_ROSTER_PROPOSAL_AXIS = "served-model-roster" as const;
export const GILLE_ROSTER_PROPOSAL_SCHEMA_EPOCH = "gille-roster-admission-schema-v1" as const;
export const GILLE_ROSTER_PROPOSAL_POLICY_EPOCH = "grimnir-autonomy-v2" as const;

type Digest = `sha256:${string}`;
type Operation = "load" | "unload" | "reload-config";
type Backend = "llamaswap" | "lmstudio";
const id = /^[a-z][a-z0-9._:-]{2,127}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface GilleRosterEntryInput {
  modelId: string; alias: string; artifactDigest: Digest; quantization: string;
  templateDigest: Digest; contextLength: number; servingConfigDigest: Digest;
  evidenceIdentityHash: Digest; restoreDescriptorRef: Digest; restoreDescriptorDigest: Digest;
}
export interface GilleRosterProposalInput {
  proposalId: string; idempotencyKey: string; producerInstanceId: string;
  /** The existing adapter-neutral, proposal-only W4 decision seam. */
  sourceProposal: AutonomyProposalReceipt;
  baseline: { catalogueDigest: Digest; rosterDigest: Digest };
  candidateEntries: readonly GilleRosterEntryInput[];
  delta: { operation: Operation; modelId: string; backend: Backend; backendCapabilityDigest: Digest };
  evidenceFreshnessSeconds: number;
  canary: {
    operation: Operation; modelId: string; expectedState: "served" | "absent";
    fallbackModelId: string | null; registryId: string; registryVersion: string;
    registryDigest: Digest; maxRequests: number; durationSeconds: number; maxConcurrency: 1;
  };
  createdAt: string; expiresAt: string;
}

export type GilleRosterProposal = {
  contract_version: typeof GILLE_ROSTER_PROPOSAL_CONTRACT_VERSION;
  proposal_id: string; idempotency_key: string;
  producer: { component: "hugin"; instance_id: string; serializer_version: typeof GILLE_ROSTER_PROPOSAL_SERIALIZER_VERSION };
  expected_transport_principal_id: typeof GILLE_ROSTER_PROPOSAL_PRINCIPAL;
  axis: typeof GILLE_ROSTER_PROPOSAL_AXIS;
  baseline: { catalogue_digest: Digest; roster_digest: Digest };
  candidate: { entries: Array<Record<string, unknown>>; roster_digest: Digest };
  delta: { operation: Operation; model_id: string; backend: Backend; backend_capability_digest: Digest };
  evidence: { schema_epoch: typeof GILLE_ROSTER_PROPOSAL_SCHEMA_EPOCH; policy_epoch: typeof GILLE_ROSTER_PROPOSAL_POLICY_EPOCH; freshness_seconds: number };
  canary: Record<string, unknown>; requested_bounds: { max_changed_entries: 1 };
  requested_operations: ["admit", "arm"]; created_at: string; expires_at: string; proposal_digest: Digest;
};

function rosterDigest(value: unknown): Digest {
  return `sha256:${createHash("sha256").update(canonicalizeJcs(value), "utf8").digest("hex")}`;
}
function assertId(value: string, field: string): void { if (!id.test(value)) throw new Error(`invalid ${field}`); }
function assertDigest(value: string, field: string): void { if (!digest.test(value)) throw new Error(`invalid ${field}`); }
function assertUtc(value: string, field: string): void {
  if (!utc.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().replace(".000Z", "Z") !== value) throw new Error(`invalid ${field}`);
}

/**
 * The consumer validates both sequences independently: candidate model IDs and
 * candidate aliases must each be lexicographically ordered. We reject an input
 * that cannot meet both rules rather than reordering a desired roster silently.
 */
function assertInteropOrder(entries: readonly GilleRosterEntryInput[]): void {
  const models = entries.map((entry) => entry.modelId);
  const aliases = entries.map((entry) => entry.alias);
  if (new Set(models).size !== models.length || new Set(aliases).size !== aliases.length) throw new Error("desired roster has duplicate model_id or alias");
  if ([...models].sort().join("\0") !== models.join("\0") || [...aliases].sort().join("\0") !== aliases.join("\0")) {
    throw new Error("desired roster must be canonical ordered by both model_id and alias for gille interop");
  }
}

export function serializeGilleRosterProposal(input: GilleRosterProposalInput): { proposal: GilleRosterProposal; bytes: string } {
  for (const [field, value] of [["proposal_id", input.proposalId], ["idempotency_key", input.idempotencyKey], ["producer.instance_id", input.producerInstanceId], ["delta.model_id", input.delta.modelId], ["canary.model_id", input.canary.modelId], ["canary.registry_id", input.canary.registryId], ["canary.registry_version", input.canary.registryVersion]] as const) assertId(value, field);
  for (const [field, value] of [["baseline.catalogue_digest", input.baseline.catalogueDigest], ["baseline.roster_digest", input.baseline.rosterDigest], ["delta.backend_capability_digest", input.delta.backendCapabilityDigest], ["canary.registry_digest", input.canary.registryDigest]] as const) assertDigest(value, field);
  assertUtc(input.createdAt, "created_at"); assertUtc(input.expiresAt, "expires_at");
  if (Date.parse(input.expiresAt) <= Date.parse(input.createdAt) || Date.parse(input.expiresAt) - Date.parse(input.createdAt) > 86_400_000) throw new Error("invalid proposal lifetime");
  if (input.candidateEntries.length < 1 || input.candidateEntries.length > 64) throw new Error("invalid desired roster size");
  if (!Number.isInteger(input.evidenceFreshnessSeconds) || input.evidenceFreshnessSeconds < 1 || input.evidenceFreshnessSeconds > 86_400) throw new Error("invalid evidence freshness");
  if (!Number.isInteger(input.canary.maxRequests) || input.canary.maxRequests < 1 || input.canary.maxRequests > 10 || !Number.isInteger(input.canary.durationSeconds) || input.canary.durationSeconds < 1 || input.canary.durationSeconds > 3600 || input.canary.maxConcurrency !== 1) throw new Error("invalid canary bounds");
  if (input.canary.operation !== input.delta.operation || input.canary.modelId !== input.delta.modelId || (input.delta.operation === "unload" ? input.canary.expectedState !== "absent" || input.canary.fallbackModelId === null : input.canary.expectedState !== "served" || input.canary.fallbackModelId !== null)) throw new Error("incoherent canary");
  assertInteropOrder(input.candidateEntries);
  const entries = input.candidateEntries.map((entry) => {
    for (const [field, value] of [["model_id", entry.modelId], ["alias", entry.alias], ["quantization", entry.quantization]] as const) assertId(value, field);
    for (const [field, value] of [["artifact_digest", entry.artifactDigest], ["template_digest", entry.templateDigest], ["serving_config_digest", entry.servingConfigDigest], ["evidence_identity_hash", entry.evidenceIdentityHash], ["restore_descriptor_ref", entry.restoreDescriptorRef], ["restore_descriptor_digest", entry.restoreDescriptorDigest]] as const) assertDigest(value, field);
    if (!Number.isInteger(entry.contextLength) || entry.contextLength < 1 || entry.contextLength > 1_048_576) throw new Error("invalid context_length");
    return { model_id: entry.modelId, alias: entry.alias, artifact_digest: entry.artifactDigest, quantization: entry.quantization, template_digest: entry.templateDigest, context_length: entry.contextLength, serving_config_digest: entry.servingConfigDigest, evidence_identity_hash: entry.evidenceIdentityHash, restore_descriptor_ref: entry.restoreDescriptorRef, restore_descriptor_digest: entry.restoreDescriptorDigest };
  });
  const unsigned = {
    contract_version: GILLE_ROSTER_PROPOSAL_CONTRACT_VERSION, proposal_id: input.proposalId, idempotency_key: input.idempotencyKey,
    producer: { component: "hugin" as const, instance_id: input.producerInstanceId, serializer_version: GILLE_ROSTER_PROPOSAL_SERIALIZER_VERSION },
    expected_transport_principal_id: GILLE_ROSTER_PROPOSAL_PRINCIPAL, axis: GILLE_ROSTER_PROPOSAL_AXIS,
    baseline: { catalogue_digest: input.baseline.catalogueDigest, roster_digest: input.baseline.rosterDigest },
    candidate: { entries, roster_digest: rosterDigest({ entries }) },
    delta: { operation: input.delta.operation, model_id: input.delta.modelId, backend: input.delta.backend, backend_capability_digest: input.delta.backendCapabilityDigest },
    evidence: { schema_epoch: GILLE_ROSTER_PROPOSAL_SCHEMA_EPOCH, policy_epoch: GILLE_ROSTER_PROPOSAL_POLICY_EPOCH, freshness_seconds: input.evidenceFreshnessSeconds },
    canary: { operation: input.canary.operation, model_id: input.canary.modelId, expected_state: input.canary.expectedState, fallback_model_id: input.canary.fallbackModelId, registry_id: input.canary.registryId, registry_version: input.canary.registryVersion, registry_digest: input.canary.registryDigest, max_requests: input.canary.maxRequests, duration_seconds: input.canary.durationSeconds, max_concurrency: 1 as const },
    requested_bounds: { max_changed_entries: 1 as const }, requested_operations: ["admit", "arm"] as ["admit", "arm"], created_at: input.createdAt, expires_at: input.expiresAt,
  };
  const source = input.sourceProposal;
  const { signature: _signature, canonicalProposalDigest: _sourceDigest, ...sourceUnsigned } = source;
  if (
    source.proposalId !== input.proposalId
    || source.targetId !== "gille-served-model-roster"
    || source.axis !== GILLE_ROSTER_PROPOSAL_AXIS
    || source.owner !== "gille-inference"
    || source.disposition !== "proposal-only"
    || source.policyEpoch.id !== AUTONOMY_PROPOSAL_POLICY_EPOCH_ID
    || source.expiresAt !== input.expiresAt
    || source.canonicalProposalDigest !== canonicalAutonomyProposalDigest(sourceUnsigned)
  ) throw new Error("source R-exact proposal receipt is not an exact gille roster binding");
  if (source.candidateContentDigest !== unsigned.candidate.roster_digest) {
    throw new Error("source R-exact proposal candidate digest does not bind the desired roster");
  }
  const proposal = { ...unsigned, proposal_digest: rosterDigest(unsigned) } as GilleRosterProposal;
  return { proposal, bytes: canonicalizeJcs(proposal) };
}
