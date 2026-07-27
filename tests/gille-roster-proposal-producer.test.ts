import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GILLE_ROSTER_PROPOSAL_PRINCIPAL,
  serializeGilleRosterProposal,
  type GilleRosterProposalInput,
} from "../src/autonomy/gille-roster-proposal-producer.js";
import {
  canonicalAutonomyProposalDigest,
  autonomyProposalOwnershipRegistry,
  type AutonomyProposalReceipt,
} from "../src/autonomy/proposal-receipts.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function input(): GilleRosterProposalInput {
  const sourceUnsigned = {
    schemaVersion: "v1" as const, proposalId: "proposal-w5-hugin-fixture", experimentRef: "ref:w5-roster-fixture",
    evidenceFingerprints: [digest("9")], targetId: "gille-served-model-roster", axis: "served-model-roster",
    owner: "gille-inference" as const, disposition: "proposal-only" as const,
    ownershipRegistry: { version: "v1" as const, digest: autonomyProposalOwnershipRegistry.digest },
    base: { revision: "main", digest: digest("8") },
    candidateContentDigest: "sha256:b6dec2e4284218939a3398ae48ae7b8fd5fedcdec9fea5a38d7caf68c2792314",
    expiresAt: "2026-07-27T16:00:00Z",
    policyEpoch: { id: "grimnir-adr-008-v2" as const, constitutionId: "grimnir-autonomy-v2" as const, constitutionDigest: "sha256:836aba8abbc48e05294dac301354ec6b1aa21307b992db78202342ce29aa8dc1" as const },
    signerKeyId: "hugin-autonomy-proposer" as const,
  };
  const sourceProposal = { ...sourceUnsigned, canonicalProposalDigest: canonicalAutonomyProposalDigest(sourceUnsigned), signature: `v1:hugin-autonomy-proposer:${"0".repeat(64)}` } as AutonomyProposalReceipt;
  return {
    proposalId: "proposal-w5-hugin-fixture",
    idempotencyKey: "idem:w5:hugin-fixture",
    producerInstanceId: "hugin:test-fixture",
    sourceProposal,
    baseline: { catalogueDigest: digest("1"), rosterDigest: digest("2") },
    candidateEntries: [{
      modelId: "qwen-main", alias: "qwen-main", artifactDigest: digest("a"),
      quantization: "q4-k-m", templateDigest: digest("b"), contextLength: 8192,
      servingConfigDigest: digest("c"), evidenceIdentityHash: digest("d"),
      restoreDescriptorRef: digest("e"), restoreDescriptorDigest: digest("f"),
    }],
    delta: { operation: "load", modelId: "qwen-main", backend: "llamaswap", backendCapabilityDigest: digest("7") },
    evidenceFreshnessSeconds: 3600,
    canary: {
      operation: "load", modelId: "qwen-main", expectedState: "served", fallbackModelId: null,
      registryId: "canary:load:qwen-main", registryVersion: "version:v1", registryDigest: digest("3"),
      maxRequests: 5, durationSeconds: 600, maxConcurrency: 1,
    },
    createdAt: "2026-07-27T14:58:00Z", expiresAt: "2026-07-27T16:00:00Z",
  };
}

describe("gille roster proposal producer", () => {
  it("emits byte-identical canonical payloads bound to the Hugin principal", () => {
    const first = serializeGilleRosterProposal(input());
    const second = serializeGilleRosterProposal(input());
    expect(first.bytes).toBe(second.bytes);
    expect(first.proposal.expected_transport_principal_id).toBe(GILLE_ROSTER_PROPOSAL_PRINCIPAL);
    expect(first.proposal.candidate.roster_digest).toMatch(/^sha256:/);
    expect(first.proposal.proposal_digest).toMatch(/^sha256:/);
  });

  it("rejects a desired roster whose aliases cannot satisfy the consumer's dual ordering rule", () => {
    const invalid = input();
    invalid.candidateEntries = [
      { ...invalid.candidateEntries[0]!, modelId: "alpha", alias: "zulu" },
      { ...invalid.candidateEntries[0]!, modelId: "bravo", alias: "alpha" },
    ];
    expect(() => serializeGilleRosterProposal(invalid)).toThrow(/model_id and alias/i);
  });

  it("pins the positive cross-repository fixture to real serializer bytes", () => {
    const bytes = serializeGilleRosterProposal(input()).bytes;
    const fixture = readFileSync(new URL("./fixtures/gille-roster-proposal-v1-positive.json", import.meta.url), "utf8").trimEnd();
    expect(fixture).toBe(bytes);
    expect(createHash("sha256").update(fixture, "utf8").digest("hex"))
      .toBe("da6c86260246755688dcc0a409fa2678b869ce4a05cecd7f62fec2018651a96e");
  });
});
