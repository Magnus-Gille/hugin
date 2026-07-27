/**
 * Deterministic, proposal-only producer for gille-roster-proposal-v2 (Hugin #337).
 *
 * This module has no transport, credential, apply, arming, or configuration-write
 * capability. The Hugin-owned composition supplies the outer Ed25519 issuer;
 * callers never provide a trust root or an actuator capability.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { canonicalizeJcs } from "../jcs.js";
import {
  AUTONOMY_PROPOSAL_POLICY_EPOCH_ID,
  AUTONOMY_PROPOSAL_SIGNER_KEY_ID,
  autonomyProposalOwnershipRegistry,
  autonomyProposalPolicyAuthority,
  canonicalAutonomyProposalDigest,
  parseAutonomyProposalReceipt,
} from "./proposal-receipts.js";

export const GILLE_ROSTER_PROPOSAL_CONTRACT_VERSION = "gille-roster-proposal-v2" as const;
export const HUGIN_ROSTER_PROVENANCE_VERSION = "hugin-roster-provenance-v1" as const;
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
  /** Exact closed W4 receipt emitted by Hugin's internal proposal boundary. */
  sourceProposal: unknown;
  /** Current observed Gille base; Gille independently anchors it at admission. */
  sourceCurrentBase: { revision: string; digest: Digest };
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
  provenance: HuginRosterProvenance;
  candidate: { entries: GilleRosterWireEntry[]; roster_digest: Digest };
  delta: { operation: Operation; model_id: string; backend: Backend; backend_capability_digest: Digest };
  evidence: { schema_epoch: typeof GILLE_ROSTER_PROPOSAL_SCHEMA_EPOCH; policy_epoch: typeof GILLE_ROSTER_PROPOSAL_POLICY_EPOCH; freshness_seconds: number };
  canary: GilleRosterWireCanary; requested_bounds: { max_changed_entries: 1 };
  requested_operations: ["admit", "arm"]; created_at: string; expires_at: string; proposal_digest: Digest;
};
export type HuginRosterProvenance = {
  schema_version: typeof HUGIN_ROSTER_PROVENANCE_VERSION;
  source_receipt: Record<string, unknown>;
  source_receipt_digest: Digest;
  source_base: { revision: string; digest: Digest };
  proposal_content_digest: Digest;
  candidate_digest: Digest;
  experiment_ref: string;
  evidence_fingerprints: Digest[];
  policy_epoch: { id: "grimnir-adr-008-v2"; constitution_id: "grimnir-autonomy-v2"; constitution_digest: Digest };
  constitution_digest: Digest;
  principal_id: typeof GILLE_ROSTER_PROPOSAL_PRINCIPAL;
  issuer: { key_id: "hugin-roster-provenance"; algorithm: "Ed25519" };
  signature: { algorithm: "Ed25519"; value_base64: string };
};
export interface GilleRosterProvenanceIssuer {
  keyId: "hugin-roster-provenance";
  /** Deployment-only PKCS#8 PEM; never a request field or repository artifact. */
  privateKeyPem: string;
}
export interface GilleRosterProposalProducerDependencies {
  provenanceIssuer: GilleRosterProvenanceIssuer | null;
}
const defaultDependencies: GilleRosterProposalProducerDependencies = { provenanceIssuer: null };
export type GilleRosterWireEntry = { model_id: string; alias: string; artifact_digest: Digest; quantization: string; template_digest: Digest; context_length: number; serving_config_digest: Digest; evidence_identity_hash: Digest; restore_descriptor_ref: Digest; restore_descriptor_digest: Digest };
export type GilleRosterWireCanary = { operation: Operation; model_id: string; expected_state: "served" | "absent"; fallback_model_id: string | null; registry_id: string; registry_version: string; registry_digest: Digest; max_requests: number; duration_seconds: number; max_concurrency: 1 };

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

export type GilleRosterProposalBinding = {
  source_receipt_digest: Digest;
  source_base: { revision: string; digest: Digest };
  baseline_identity_digest: Digest;
  experiment_ref: string;
  evidence_fingerprints_digest: Digest;
  policy_epoch_digest: Digest;
  constitution_digest: Digest;
  provenance_digest: Digest;
};
export function combinedGilleRosterBaselineDigest(baseline: { catalogueDigest: Digest; rosterDigest: Digest }): Digest {
  return rosterDigest({ schema_version: "gille-roster-combined-baseline-v1", catalogue_digest: baseline.catalogueDigest, roster_digest: baseline.rosterDigest });
}
export function serializeGilleRosterProposal(
  input: GilleRosterProposalInput,
  dependencies: GilleRosterProposalProducerDependencies = defaultDependencies,
): { proposal: GilleRosterProposal; bytes: string; binding: GilleRosterProposalBinding } {
  if (!dependencies.provenanceIssuer || dependencies.provenanceIssuer.keyId !== "hugin-roster-provenance") {
    throw new Error("Hugin roster provenance issuer is unconfigured");
  }
  for (const [field, value] of [["proposal_id", input.proposalId], ["idempotency_key", input.idempotencyKey], ["producer.instance_id", input.producerInstanceId], ["delta.model_id", input.delta.modelId], ["canary.model_id", input.canary.modelId], ["canary.registry_id", input.canary.registryId], ["canary.registry_version", input.canary.registryVersion]] as const) assertId(value, field);
  for (const [field, value] of [["baseline.catalogue_digest", input.baseline.catalogueDigest], ["baseline.roster_digest", input.baseline.rosterDigest], ["delta.backend_capability_digest", input.delta.backendCapabilityDigest], ["canary.registry_digest", input.canary.registryDigest]] as const) assertDigest(value, field);
  assertUtc(input.createdAt, "created_at"); assertUtc(input.expiresAt, "expires_at");
  if (Date.parse(input.expiresAt) <= Date.parse(input.createdAt) || Date.parse(input.expiresAt) - Date.parse(input.createdAt) > 86_400_000) throw new Error("invalid proposal lifetime");
  if (input.candidateEntries.length < 1 || input.candidateEntries.length > 64) throw new Error("invalid desired roster size");
  if (!Number.isInteger(input.evidenceFreshnessSeconds) || input.evidenceFreshnessSeconds < 1 || input.evidenceFreshnessSeconds > 86_400) throw new Error("invalid evidence freshness");
  if (!Number.isInteger(input.canary.maxRequests) || input.canary.maxRequests < 1 || input.canary.maxRequests > 10 || !Number.isInteger(input.canary.durationSeconds) || input.canary.durationSeconds < 1 || input.canary.durationSeconds > 3600 || input.canary.maxConcurrency !== 1) throw new Error("invalid canary bounds");
  if (input.canary.operation !== input.delta.operation || input.canary.modelId !== input.delta.modelId || (input.delta.operation === "unload" ? input.canary.expectedState !== "absent" || input.canary.fallbackModelId === null : input.canary.expectedState !== "served" || input.canary.fallbackModelId !== null)) throw new Error("incoherent canary");
  assertInteropOrder(input.candidateEntries);
  const entries: GilleRosterWireEntry[] = input.candidateEntries.map((entry) => {
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
  let source;
  try {
    source = parseAutonomyProposalReceipt(input.sourceProposal);
  } catch {
    throw new Error("source R-exact proposal receipt has invalid closed shape");
  }
  const { signature: _signature, canonicalProposalDigest: _sourceDigest, ...sourceUnsigned } = source;
  if (
    source.proposalId !== input.proposalId
    || source.targetId !== "gille-served-model-roster"
    || source.axis !== GILLE_ROSTER_PROPOSAL_AXIS
    || source.owner !== "gille-inference"
    || source.disposition !== "proposal-only"
    || source.policyEpoch.id !== AUTONOMY_PROPOSAL_POLICY_EPOCH_ID
    || canonicalizeJcs(source.policyEpoch) !== canonicalizeJcs(autonomyProposalPolicyAuthority)
    || canonicalizeJcs(source.ownershipRegistry) !== canonicalizeJcs({
      version: autonomyProposalOwnershipRegistry.version,
      digest: autonomyProposalOwnershipRegistry.digest,
    })
    || source.signerKeyId !== AUTONOMY_PROPOSAL_SIGNER_KEY_ID
    || source.expiresAt !== input.expiresAt
    || source.base.revision !== input.sourceCurrentBase.revision
    || source.base.digest !== input.sourceCurrentBase.digest
    || source.base.digest !== combinedGilleRosterBaselineDigest(input.baseline)
    || source.canonicalProposalDigest !== canonicalAutonomyProposalDigest(sourceUnsigned)
  ) throw new Error("source R-exact proposal receipt is not an exact gille roster binding");
  if (source.candidateContentDigest !== unsigned.candidate.roster_digest) {
    throw new Error("source R-exact proposal candidate digest does not bind the desired roster");
  }
  const candidateEvidence = [...new Set(entries.map((entry) => entry.evidence_identity_hash))].sort();
  if (
    canonicalizeJcs(source.evidenceFingerprints) !== canonicalizeJcs(candidateEvidence)
    || canonicalizeJcs(source.evidenceFingerprints) !== canonicalizeJcs([...source.evidenceFingerprints].sort())
  ) throw new Error("source R-exact proposal receipt evidence does not exactly bind the desired roster");
  const candidateIds = new Set(entries.map((entry) => entry.model_id));
  if ((input.delta.operation === "load" && !candidateIds.has(input.delta.modelId)) || (input.delta.operation === "unload" && candidateIds.has(input.delta.modelId)) || (input.delta.operation === "reload-config" && !candidateIds.has(input.delta.modelId)) ) {
    throw new Error("delta operation is inconsistent with candidate roster");
  }
  const sourceReceiptDigest = rosterDigest(source);
  const unsignedProvenance = {
    schema_version: HUGIN_ROSTER_PROVENANCE_VERSION,
    source_receipt: source,
    source_receipt_digest: sourceReceiptDigest,
    source_base: { revision: source.base.revision, digest: source.base.digest as Digest },
    proposal_content_digest: rosterDigest(unsigned),
    candidate_digest: unsigned.candidate.roster_digest,
    experiment_ref: source.experimentRef,
    evidence_fingerprints: candidateEvidence,
    policy_epoch: {
      id: source.policyEpoch.id,
      constitution_id: source.policyEpoch.constitutionId,
      constitution_digest: source.policyEpoch.constitutionDigest as Digest,
    },
    constitution_digest: source.policyEpoch.constitutionDigest as Digest,
    principal_id: GILLE_ROSTER_PROPOSAL_PRINCIPAL,
    issuer: { key_id: dependencies.provenanceIssuer.keyId, algorithm: "Ed25519" as const },
  };
  let privateKey;
  try { privateKey = createPrivateKey(dependencies.provenanceIssuer.privateKeyPem); }
  catch { throw new Error("Hugin roster provenance issuer is invalid"); }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Hugin roster provenance issuer must be Ed25519");
  }
  const provenance: HuginRosterProvenance = {
    ...unsignedProvenance,
    signature: {
      algorithm: "Ed25519",
      value_base64: sign(null, Buffer.from(canonicalizeJcs(unsignedProvenance)), privateKey).toString("base64"),
    },
  };
  const binding: GilleRosterProposalBinding = {
    source_receipt_digest: sourceReceiptDigest,
    source_base: { revision: source.base.revision, digest: source.base.digest as Digest },
    baseline_identity_digest: rosterDigest({ source_base: source.base, baseline: input.baseline }),
    experiment_ref: source.experimentRef,
    evidence_fingerprints_digest: rosterDigest(source.evidenceFingerprints),
    policy_epoch_digest: rosterDigest(source.policyEpoch),
    constitution_digest: autonomyProposalPolicyAuthority.constitutionDigest as Digest,
    provenance_digest: rosterDigest(provenance),
  };
  const proposal: GilleRosterProposal = { ...unsigned, provenance, proposal_digest: rosterDigest({ ...unsigned, provenance }) };
  return { proposal, bytes: canonicalizeJcs(proposal), binding };
}
