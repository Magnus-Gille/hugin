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
const signerId = z.string().regex(/^[a-z][a-z0-9-]{2,80}$/);

export const AUTONOMY_PROPOSAL_SCHEMA_VERSION = "v1" as const;
export const AUTONOMY_PROPOSAL_POLICY_EPOCH_ID = "grimnir-adr-008-v1" as const;
export const AUTONOMY_PROPOSAL_SIGNER_KEY_ID = "hugin-autonomy-proposer" as const;

/** Closed registry: broad learning axes never create an implicit apply right. */
export const proposalTargetRegistry = [
  { id: "hugin-orin-macro-routing", axis: "routing", owner: "hugin", huginOwned: true },
  { id: "hugin-agent-prompt", axis: "agent-prompt", owner: "hugin", huginOwned: true },
  { id: "hugin-agent-harness", axis: "agent-harness", owner: "hugin", huginOwned: true },
  { id: "hugin-tool-policy", axis: "tool-policy", owner: "hugin", huginOwned: true },
  { id: "gille-micro-routing", axis: "routing", owner: "gille-inference", huginOwned: false },
  { id: "gille-served-model-roster", axis: "served-model-roster", owner: "gille-inference", huginOwned: false },
  { id: "gille-tool-policy", axis: "tool-policy", owner: "gille-inference", huginOwned: false },
  { id: "brokkr-no-reboot-maintenance", axis: "no-reboot-security-bugfix-maintenance", owner: "brokkr", huginOwned: false },
  { id: "hugin-logging", axis: "logging", owner: "hugin", huginOwned: false, protected: true },
  { id: "hugin-test-harness", axis: "test-harness", owner: "hugin", huginOwned: false, protected: true },
  { id: "gille-model", axis: "model", owner: "gille-inference", huginOwned: false, protected: true },
  { id: "gille-model-config", axis: "model-config", owner: "gille-inference", huginOwned: false, protected: true },
] as const;

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
  base: z.object({ revision, digest: sha256 }).strict(),
  candidateContentDigest: sha256,
  expiresAt: z.string().datetime({ offset: true }),
  policyEpoch: z.object({ id: z.literal(AUTONOMY_PROPOSAL_POLICY_EPOCH_ID), digest: sha256 }).strict(),
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
  policyEpoch: z.object({ id: z.literal(AUTONOMY_PROPOSAL_POLICY_EPOCH_ID), digest: sha256 }).strict(),
  signerKeyId: z.literal(AUTONOMY_PROPOSAL_SIGNER_KEY_ID),
}).strict();
export type AutonomyProposalInput = z.infer<typeof proposalInputSchema>;

type TargetLookup = ProposalTarget | undefined;
function targetFor(id: string): TargetLookup {
  return proposalTargetRegistry.find((candidate) => candidate.id === id);
}

function requireTarget(id: string): ProposalTarget {
  const target = targetFor(id);
  if (!target) throw new Error("unknown-target");
  if ("protected" in target && target.protected) throw new Error("protected-target");
  return target;
}

function signingBody(receipt: Omit<AutonomyProposalReceipt, "signature" | "canonicalProposalDigest">): string {
  return canonicalizeJcs(receipt);
}

function sha256Digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
    base: parsedInput.base,
    candidateContentDigest: parsedInput.candidateContentDigest,
    expiresAt: parsedInput.expiresAt,
    policyEpoch: parsedInput.policyEpoch,
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
  policyEpochDigest: string;
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
  if (!target) return { status: "rejected", reason: "unknown-target" };
  if (("protected" in target && target.protected)) return { status: "rejected", reason: "protected-target" };
  if (receipt.axis !== target.axis || receipt.owner !== target.owner) return { status: "rejected", reason: "owner-mismatch" };
  if (Date.parse(receipt.expiresAt) <= options.now().getTime()) return { status: "rejected", reason: "expired" };
  if (receipt.policyEpoch.digest !== options.policyEpochDigest) return { status: "rejected", reason: "policy-epoch-mismatch" };
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
