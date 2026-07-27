/**
 * Proposal-only autonomy receipt boundary (hugin#329).
 *
 * This module intentionally has no configuration adapter, executor, reload, or
 * deployment dependency. A valid receipt records a content-blind suggestion
 * for its named owner; W4.2 owns any future R-exact application controller.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalizeJcs } from "../jcs.js";
import { MuninWriteRejectedError, type MuninClient } from "../munin-client.js";
import { decodeSecret, type KeyStore } from "../task-signing.js";

const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const opaqueRef = z.string().regex(/^ref:[a-z][a-z0-9-]{2,120}$/);
const revision = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/);
const targetId = z.string().regex(/^[a-z][a-z0-9-]{2,80}$/);

export const AUTONOMY_PROPOSAL_SCHEMA_VERSION = "v1" as const;
export const AUTONOMY_PROPOSAL_POLICY_EPOCH_ID = "grimnir-adr-008-v1" as const;
export const AUTONOMY_PROPOSAL_SIGNER_KEY_ID = "hugin-autonomy-proposer" as const;
export const AUTONOMY_PROPOSAL_REGISTRY_VERSION = "v1" as const;

/** Exact authority adopted by Grimnir ADR-008/W0, never caller-selected. */
export const autonomyProposalPolicyAuthority = Object.freeze({
  id: AUTONOMY_PROPOSAL_POLICY_EPOCH_ID,
  constitutionId: "grimnir-autonomy-v1",
  constitutionDigest: "sha256:51efdb78c4524780919649f285862543db8b38a6a3a07894f0fad8bdab40fc6c",
});

/** Closed registry: broad learning axes never create an implicit apply right. */
const proposalTargets = [
  { id: "hugin-orin-macro-routing", axis: "macro-routing", owner: "hugin", huginOwned: true },
  { id: "hugin-agent-prompt", axis: "prompt", owner: "hugin", huginOwned: true },
  { id: "hugin-agent-harness", axis: "harness", owner: "hugin", huginOwned: true },
  { id: "hugin-tool-policy", axis: "tool-policy", owner: "hugin", huginOwned: true },
  { id: "gille-micro-routing", axis: "micro-routing", owner: "gille-inference", huginOwned: false },
  { id: "gille-served-model-roster", axis: "served-model-roster", owner: "gille-inference", huginOwned: false },
  { id: "gille-tool-policy", axis: "tool-policy", owner: "gille-inference", huginOwned: false },
  { id: "brokkr-no-reboot-maintenance", axis: "no-reboot-security-bugfix-maintenance", owner: "brokkr", huginOwned: false },
] as const;
const protectedTargetIds = ["hugin-logging", "hugin-test-harness", "gille-model", "gille-model-config"] as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256Digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const ownershipRegistryUnsigned = {
  kind: "hugin-autonomy-proposal-ownership-registry",
  version: AUTONOMY_PROPOSAL_REGISTRY_VERSION,
  policyAuthority: autonomyProposalPolicyAuthority,
  targets: proposalTargets,
  protectedTargetIds,
};
export const autonomyProposalOwnershipRegistry = deepFreeze({
  ...ownershipRegistryUnsigned,
  digest: sha256Digest(canonicalizeJcs(ownershipRegistryUnsigned)),
});
export const proposalTargetRegistry = autonomyProposalOwnershipRegistry.targets;

type ProposalTarget = (typeof proposalTargetRegistry)[number];

const proposalReceiptSchema = z.object({
  schemaVersion: z.literal(AUTONOMY_PROPOSAL_SCHEMA_VERSION),
  proposalId: targetId,
  experimentRef: opaqueRef,
  evidenceFingerprints: z.array(sha256).min(1).max(32),
  targetId,
  axis: z.string().min(1).max(80),
  owner: z.enum(["hugin", "gille-inference", "brokkr"]),
  /** Receipts are never authority to mutate; this is deliberately constant. */
  disposition: z.literal("proposal-only"),
  ownershipRegistry: z.object({
    version: z.literal(AUTONOMY_PROPOSAL_REGISTRY_VERSION),
    digest: sha256,
  }).strict(),
  base: z.object({ revision, digest: sha256 }).strict(),
  candidateContentDigest: sha256,
  expiresAt: z.string().datetime({ offset: true }),
  policyEpoch: z.object({
    id: z.literal(AUTONOMY_PROPOSAL_POLICY_EPOCH_ID),
    constitutionId: z.literal(autonomyProposalPolicyAuthority.constitutionId),
    constitutionDigest: z.literal(autonomyProposalPolicyAuthority.constitutionDigest),
  }).strict(),
  canonicalProposalDigest: sha256,
  signerKeyId: z.literal(AUTONOMY_PROPOSAL_SIGNER_KEY_ID),
  signature: z.string().regex(/^v1:[a-z][a-z0-9-]{2,80}:[a-f0-9]{64}$/),
}).strict();

export type AutonomyProposalReceipt = z.infer<typeof proposalReceiptSchema>;
const proposalInputSchema = z.object({
  proposalId: targetId,
  experimentRef: opaqueRef,
  evidenceFingerprints: z.array(sha256).min(1).max(32),
  targetId,
  base: z.object({ revision, digest: sha256 }).strict(),
  candidateContentDigest: sha256,
  expiresAt: z.string().datetime({ offset: true }),
  signerKeyId: z.literal(AUTONOMY_PROPOSAL_SIGNER_KEY_ID),
}).strict();
export type AutonomyProposalInput = z.infer<typeof proposalInputSchema>;

type TargetLookup = ProposalTarget | undefined;
function targetFor(id: string): TargetLookup {
  return proposalTargetRegistry.find((candidate) => candidate.id === id);
}

function requireTarget(id: string): ProposalTarget {
  const target = targetFor(id);
  if (!target) throw new Error(protectedTargetIds.includes(id as typeof protectedTargetIds[number]) ? "protected-target" : "unknown-target");
  return target;
}

function signingBody(receipt: Omit<AutonomyProposalReceipt, "signature" | "canonicalProposalDigest">): string {
  return canonicalizeJcs(receipt);
}

export function canonicalAutonomyProposalDigest(
  receipt: Omit<AutonomyProposalReceipt, "signature" | "canonicalProposalDigest">,
): string {
  return sha256Digest(signingBody(receipt));
}

export function signAutonomyProposalReceipt(
  receipt: Omit<AutonomyProposalReceipt, "signature">,
  secretHex: string,
): string {
  const secret = decodeSecret(secretHex);
  const body = canonicalizeJcs(receipt);
  return `v1:${receipt.signerKeyId}:${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function createAutonomyProposalReceipt(input: AutonomyProposalInput, secretHex: string): AutonomyProposalReceipt {
  const parsedInput = proposalInputSchema.parse(input);
  const target = requireTarget(parsedInput.targetId);
  const body = {
    schemaVersion: AUTONOMY_PROPOSAL_SCHEMA_VERSION,
    proposalId: parsedInput.proposalId,
    experimentRef: parsedInput.experimentRef,
    evidenceFingerprints: parsedInput.evidenceFingerprints,
    targetId: parsedInput.targetId,
    axis: target.axis,
    owner: target.owner,
    disposition: "proposal-only" as const,
    ownershipRegistry: {
      version: autonomyProposalOwnershipRegistry.version,
      digest: autonomyProposalOwnershipRegistry.digest,
    },
    base: parsedInput.base,
    candidateContentDigest: parsedInput.candidateContentDigest,
    expiresAt: parsedInput.expiresAt,
    policyEpoch: autonomyProposalPolicyAuthority,
    signerKeyId: parsedInput.signerKeyId,
  };
  const canonicalProposalDigest = canonicalAutonomyProposalDigest(body);
  return proposalReceiptSchema.parse({
    ...body,
    canonicalProposalDigest,
    signature: signAutonomyProposalReceipt({ ...body, canonicalProposalDigest }, secretHex),
  });
}

export type ProposalValidationOptions = {
  now: () => Date;
  currentBase: { revision: string; digest: string };
};

export type ProposalVerification = { status: "valid" } | { status: "rejected"; reason: string };

export function verifyAutonomyProposalReceipt(
  raw: unknown,
  keys: KeyStore,
  options: ProposalValidationOptions,
): ProposalVerification {
  const parsed = proposalReceiptSchema.safeParse(raw);
  if (!parsed.success) return { status: "rejected", reason: "invalid-receipt" };
  const receipt = parsed.data;
  const target = targetFor(receipt.targetId);
  if (!target) return { status: "rejected", reason: protectedTargetIds.includes(receipt.targetId as typeof protectedTargetIds[number]) ? "protected-target" : "unknown-target" };
  if (receipt.axis !== target.axis || receipt.owner !== target.owner) return { status: "rejected", reason: "owner-mismatch" };
  if (receipt.ownershipRegistry.version !== autonomyProposalOwnershipRegistry.version || receipt.ownershipRegistry.digest !== autonomyProposalOwnershipRegistry.digest) {
    return { status: "rejected", reason: "ownership-registry-mismatch" };
  }
  if (receipt.policyEpoch.id !== autonomyProposalPolicyAuthority.id || receipt.policyEpoch.constitutionId !== autonomyProposalPolicyAuthority.constitutionId || receipt.policyEpoch.constitutionDigest !== autonomyProposalPolicyAuthority.constitutionDigest) {
    return { status: "rejected", reason: "policy-epoch-mismatch" };
  }
  let nowMs: number;
  try {
    nowMs = options.now().getTime();
  } catch {
    return { status: "rejected", reason: "invalid-verifier-clock" };
  }
  if (!Number.isFinite(nowMs)) return { status: "rejected", reason: "invalid-verifier-clock" };
  if (Date.parse(receipt.expiresAt) <= nowMs) return { status: "rejected", reason: "expired" };
  if (receipt.base.revision !== options.currentBase.revision || receipt.base.digest !== options.currentBase.digest) {
    return { status: "rejected", reason: "stale-or-mismatched-base" };
  }
  const { signature, canonicalProposalDigest, ...body } = receipt;
  if (canonicalAutonomyProposalDigest(body) !== canonicalProposalDigest) return { status: "rejected", reason: "digest-mismatch" };
  const key = keys[receipt.signerKeyId];
  if (!key || !signature.startsWith(`v1:${receipt.signerKeyId}:`)) return { status: "rejected", reason: "invalid-signature" };
  const expected = signAutonomyProposalReceipt({ ...body, canonicalProposalDigest }, key);
  const actualHex = signature.split(":")[2];
  const expectedHex = expected.split(":")[2];
  if (!actualHex || !expectedHex || actualHex.length !== expectedHex.length || !timingSafeEqual(Buffer.from(actualHex, "hex"), Buffer.from(expectedHex, "hex"))) {
    return { status: "rejected", reason: "invalid-signature" };
  }
  return { status: "valid" };
}

function storageLocation(receipt: AutonomyProposalReceipt): { namespace: string; key: string } {
  return {
    namespace: `autonomy/hugin/proposals/${receipt.proposalId}`,
    key: "receipt",
  };
}

export async function storeAutonomyProposalReceipt(
  munin: MuninClient,
  raw: unknown,
  keys: KeyStore,
  options: ProposalValidationOptions,
): Promise<{ status: "stored"; replay: boolean; receipt: AutonomyProposalReceipt } | ProposalVerification> {
  const verified = verifyAutonomyProposalReceipt(raw, keys, options);
  if (verified.status !== "valid") return verified;
  const receipt = proposalReceiptSchema.parse(raw);
  const { namespace, key } = storageLocation(receipt);
  const content = canonicalizeJcs(receipt);
  try {
    await munin.write(namespace, key, content, ["autonomy:proposal", `owner:${receipt.owner}`, `axis:${receipt.axis}`], undefined, "internal", true);
    return { status: "stored", replay: false, receipt };
  } catch (error) {
    if (!(error instanceof MuninWriteRejectedError) || error.conflictReason !== "already_exists") throw error;
    const existing = await munin.read(namespace, key);
    if (!existing || existing.content !== content) return { status: "rejected", reason: "identity-conflict" };
    return { status: "stored", replay: true, receipt };
  }
}
