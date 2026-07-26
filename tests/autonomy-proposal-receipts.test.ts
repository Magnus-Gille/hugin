import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient } from "../src/munin-client.js";
import {
  createAutonomyProposalReceipt,
  proposalTargetRegistry,
  signAutonomyProposalReceipt,
  storeAutonomyProposalReceipt,
  verifyAutonomyProposalReceipt,
  type AutonomyProposalReceipt,
  type AutonomyProposalInput,
} from "../src/autonomy/proposal-receipts.js";

const SECRET = "d".repeat(64);
const KEYS = { "hugin-autonomy-proposer": SECRET };
const now = () => new Date("2026-07-26T14:00:00.000Z");
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

class MemoryMunin {
  entries = new Map<string, { content: string; updated_at: string }>();
  writes = 0;
  async read(namespace: string, key: string) {
    const entry = this.entries.get(`${namespace}/${key}`);
    return entry ? { ...entry, namespace, key, found: true } : null;
  }
  async write(namespace: string, key: string, content: string, _tags?: string[], _expected?: string, _classification?: string, createIfAbsent?: boolean) {
    const id = `${namespace}/${key}`;
    const existing = this.entries.get(id);
    if (createIfAbsent && existing) {
      throw new MuninWriteRejectedError(namespace, key, { error: "conflict", conflict_reason: "already_exists" });
    }
    this.writes += 1;
    this.entries.set(id, { content, updated_at: `2026-07-26T14:00:0${this.writes}.000Z` });
    return { ok: true, status: existing ? "updated" : "created" };
  }
}

function input(): AutonomyProposalInput {
  return {
    proposalId: "autonomy-proposal-329-a",
    experimentRef: "ref:experiment-329-a",
    evidenceFingerprints: [digest("evidence-a")],
    targetId: "hugin-orin-macro-routing",
    base: { revision: "b700c05", digest: digest("base-a") },
    candidateContentDigest: digest("candidate-a"),
    expiresAt: "2026-07-26T15:00:00.000Z",
    policyEpoch: { id: "grimnir-adr-008-v1", digest: digest("adr-008") },
    signerKeyId: "hugin-autonomy-proposer",
  };
}

function proposal(overrides: Partial<AutonomyProposalReceipt> = {}) {
  return createAutonomyProposalReceipt({ ...input(), ...overrides }, SECRET);
}

describe("autonomy proposal receipts", () => {
  it("is an immutable, signed content-blind proposal even for a Hugin-owned target", () => {
    const receipt = proposal();
    expect(receipt.disposition).toBe("proposal-only");
    expect(receipt.owner).toBe("hugin");
    expect(verifyAutonomyProposalReceipt(receipt, KEYS, { now, policyEpochDigest: digest("adr-008"), currentBase: receipt.base })).toEqual({ status: "valid" });
    expect(JSON.stringify(receipt)).not.toContain("prompt");
    expect(JSON.stringify(receipt)).not.toContain("candidate-a");
  });

  it("replays byte-identical receipts and rejects divergent identity content", async () => {
    const munin = new MemoryMunin() as unknown as MuninClient;
    const first = proposal();
    expect(await storeAutonomyProposalReceipt(munin, first, KEYS, { now, policyEpochDigest: digest("adr-008"), currentBase: first.base })).toMatchObject({ status: "stored", replay: false });
    expect(await storeAutonomyProposalReceipt(munin, first, KEYS, { now, policyEpochDigest: digest("adr-008"), currentBase: first.base })).toMatchObject({ status: "stored", replay: true });
    const divergent = proposal({ candidateContentDigest: digest("different") });
    expect(await storeAutonomyProposalReceipt(munin, divergent, KEYS, { now, policyEpochDigest: digest("adr-008"), currentBase: divergent.base })).toMatchObject({ status: "rejected", reason: "identity-conflict" });
    expect(munin.writes).toBe(1);
  });

  it.each([
    ["gille-micro-routing", "gille-inference"],
    ["gille-served-model-roster", "gille-inference"],
    ["brokkr-no-reboot-maintenance", "brokkr"],
    ["gille-tool-policy", "gille-inference"],
  ])("keeps cross-owner %s proposal-only and has no apply surface", (targetId, owner) => {
    const receipt = proposal({ targetId });
    expect(receipt.owner).toBe(owner);
    expect(receipt.disposition).toBe("proposal-only");
    expect(proposalTargetRegistry.find((target) => target.id === targetId)?.huginOwned).toBe(false);
  });

  it.each([
    ["hugin-logging", "protected-target"],
    ["hugin-test-harness", "protected-target"],
    ["gille-model", "protected-target"],
    ["gille-model-config", "protected-target"],
    ["unknown-target", "unknown-target"],
  ])("fails closed for %s", (targetId, reason) => {
    expect(() => proposal({ targetId })).toThrow(reason);
  });

  it("refuses raw configuration fields and an unassigned signer before any durable write", () => {
    expect(() => createAutonomyProposalReceipt({
      ...input(),
      candidateContent: "never persist this prompt or configuration",
    } as unknown as Parameters<typeof createAutonomyProposalReceipt>[0], SECRET)).toThrow();
    expect(() => proposal({ signerKeyId: "some-other-signer" as "hugin-autonomy-proposer" })).toThrow();
  });

  it("rejects stale evidence, epoch/base/owner mismatch, and invalid signatures before persistence", async () => {
    const munin = new MemoryMunin() as unknown as MuninClient;
    const receipt = proposal();
    expect(verifyAutonomyProposalReceipt(receipt, KEYS, { now, policyEpochDigest: digest("wrong"), currentBase: receipt.base })).toMatchObject({ reason: "policy-epoch-mismatch" });
    expect(verifyAutonomyProposalReceipt(receipt, KEYS, { now, policyEpochDigest: digest("adr-008"), currentBase: { ...receipt.base, digest: digest("other") } })).toMatchObject({ reason: "stale-or-mismatched-base" });
    expect(verifyAutonomyProposalReceipt({ ...receipt, owner: "gille-inference" }, KEYS, { now, policyEpochDigest: digest("adr-008"), currentBase: receipt.base })).toMatchObject({ reason: "owner-mismatch" });
    expect(verifyAutonomyProposalReceipt({ ...receipt, signature: `v1:hugin-autonomy-proposer:${"0".repeat(64)}` }, KEYS, { now, policyEpochDigest: digest("adr-008"), currentBase: receipt.base })).toMatchObject({ reason: "invalid-signature" });
    const expired = proposal({ expiresAt: "2026-07-26T13:59:59.000Z" });
    expect(await storeAutonomyProposalReceipt(munin, expired, KEYS, { now, policyEpochDigest: digest("adr-008"), currentBase: expired.base })).toMatchObject({ status: "rejected", reason: "expired" });
    expect(munin.writes).toBe(0);
  });
});
