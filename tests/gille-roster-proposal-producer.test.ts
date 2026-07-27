import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalizeJcs } from "../src/jcs.js";
import {
  GILLE_ROSTER_PROPOSAL_PRINCIPAL,
  serializeGilleRosterProposal,
  type GilleRosterProposalInput,
} from "../src/autonomy/gille-roster-proposal-producer.js";
import {
  autonomyProposalOwnershipRegistry,
  createAutonomyProposalReceipt,
  verifyAutonomyProposalReceipt,
} from "../src/autonomy/proposal-receipts.js";
import {
  applyRosterFixtureMutations,
  parseRosterAdversarialManifest,
} from "./helpers/gille-roster-proposal-fixtures.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const SECRET = "d".repeat(64);
const KEYS = { "hugin-autonomy-proposer": SECRET };
const canonicalDigest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalizeJcs(value)).digest("hex")}`;

function expectSelfBound(payload: Record<string, unknown>): void {
  const candidate = payload.candidate as { entries: unknown[]; roster_digest: string };
  expect(candidate.roster_digest).toBe(canonicalDigest({ entries: candidate.entries }));
  const { proposal_digest: proposalDigest, ...unsigned } = payload;
  expect(proposalDigest).toBe(canonicalDigest(unsigned));
}

function input(): GilleRosterProposalInput {
  const sourceProposal = createAutonomyProposalReceipt({
    proposalId: "proposal-w5-hugin-fixture", experimentRef: "ref:w5-roster-fixture",
    evidenceFingerprints: [digest("9")], targetId: "gille-served-model-roster",
    base: { revision: "main", digest: digest("8") },
    candidateContentDigest: "sha256:b6dec2e4284218939a3398ae48ae7b8fd5fedcdec9fea5a38d7caf68c2792314",
    expiresAt: "2026-07-27T16:00:00Z",
    signerKeyId: "hugin-autonomy-proposer",
  }, SECRET);
  expect(verifyAutonomyProposalReceipt(sourceProposal, KEYS, {
    now: () => new Date("2026-07-27T15:00:00Z"),
    currentBase: sourceProposal.base,
  })).toEqual({ status: "valid" });
  return {
    proposalId: "proposal-w5-hugin-fixture",
    idempotencyKey: "idem:w5:hugin-fixture",
    producerInstanceId: "hugin:test-fixture",
    sourceProposal,
    sourceReceiptKeys: KEYS,
    sourceCurrentBase: sourceProposal.base,
    sourceNow: () => new Date("2026-07-27T15:00:00Z"),
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
  it("uses a real, cryptographically valid W4 proposal receipt", () => {
    const source = input().sourceProposal;
    expect(verifyAutonomyProposalReceipt(source, KEYS, {
      now: () => new Date("2026-07-27T15:00:00Z"),
      currentBase: (source as { base: { revision: string; digest: string } }).base,
    })).toEqual({ status: "valid" });
  });

  it("emits byte-identical canonical payloads bound to the Hugin principal", () => {
    const first = serializeGilleRosterProposal(input());
    const second = serializeGilleRosterProposal(input());
    expect(first.bytes).toBe(second.bytes);
    expect(first.proposal.expected_transport_principal_id).toBe(GILLE_ROSTER_PROPOSAL_PRINCIPAL);
    expect(first.proposal.candidate.roster_digest).toMatch(/^sha256:/);
    expect(first.proposal.proposal_digest).toMatch(/^sha256:/);
    expect(first.binding.source_receipt_digest).toMatch(/^sha256:/);
    expect(first.binding.baseline_identity_digest).toMatch(/^sha256:/);
  });

  it("rejects a delta whose candidate presence contradicts its operation", () => {
    const bad = input(); bad.delta = { ...bad.delta, operation: "unload" }; bad.canary = { ...bad.canary, operation: "unload", expectedState: "absent", fallbackModelId: "fallback" };
    expect(() => serializeGilleRosterProposal(bad)).toThrow(/delta operation/i);
  });

  it.each([
    ["stale base", (value: GilleRosterProposalInput) => { value.sourceCurrentBase = { revision: "other", digest: digest("0") as `sha256:${string}` }; }],
    ["expired source", (value: GilleRosterProposalInput) => { value.sourceNow = () => new Date("2026-07-27T17:00:00Z"); }],
    ["candidate digest", (value: GilleRosterProposalInput) => { value.sourceProposal = { ...(value.sourceProposal as Record<string, unknown>), candidateContentDigest: digest("0") }; }],
    ["canary", (value: GilleRosterProposalInput) => { value.canary = { ...value.canary, modelId: "other-model" }; }],
    ["lifetime", (value: GilleRosterProposalInput) => { value.expiresAt = "2026-07-29T14:58:00Z"; }],
    ["redundant milliseconds", (value: GilleRosterProposalInput) => { value.createdAt = "2026-07-27T14:58:00.000Z"; }],
  ])("rejects %s before producing a proposal", (_name, mutate) => {
    const value = input(); mutate(value); expect(() => serializeGilleRosterProposal(value)).toThrow();
  });

  it("rejects a desired roster whose aliases cannot satisfy the consumer's dual ordering rule", () => {
    const invalid = input();
    invalid.candidateEntries = [
      { ...invalid.candidateEntries[0]!, modelId: "alpha", alias: "zulu" },
      { ...invalid.candidateEntries[0]!, modelId: "bravo", alias: "alpha" },
    ];
    expect(() => serializeGilleRosterProposal(invalid)).toThrow(/model_id and alias/i);
  });

  it("rejects source receipts with the wrong ownership registry or policy authority", () => {
    const wrongRegistry = input();
    wrongRegistry.sourceProposal = {
      ...(wrongRegistry.sourceProposal as Record<string, unknown>),
      ownershipRegistry: { version: "v1", digest: digest("0") },
    };
    expect(() => serializeGilleRosterProposal(wrongRegistry)).toThrow(/source R-exact proposal/i);

    const wrongPolicy = input();
    const source = wrongPolicy.sourceProposal as Record<string, unknown>;
    wrongPolicy.sourceProposal = {
      ...source,
      policyEpoch: {
        ...(source.policyEpoch as Record<string, unknown>),
        constitutionDigest: digest("0"),
      },
    };
    expect(() => serializeGilleRosterProposal(wrongPolicy)).toThrow(/source R-exact proposal/i);

    const openShape = input();
    openShape.sourceProposal = {
      ...(openShape.sourceProposal as Record<string, unknown>),
      unexpected: true,
    };
    expect(() => serializeGilleRosterProposal(openShape)).toThrow(/not authenticated/i);
    const wrongKey = input();
    wrongKey.sourceReceiptKeys = { "hugin-autonomy-proposer": "e".repeat(64) };
    expect(() => serializeGilleRosterProposal(wrongKey)).toThrow(/not authenticated: invalid-signature/i);
  });

  it("pins the positive cross-repository fixture to real serializer bytes", () => {
    const bytes = serializeGilleRosterProposal(input()).bytes;
    const fixture = readFileSync(new URL("./fixtures/gille-roster-proposal-v1-positive.json", import.meta.url), "utf8");
    expect(fixture).toBe(`${bytes}\n`);
    expect(createHash("sha256").update(fixture, "utf8").digest("hex"))
      .toBe("834b3f77fecd0a6d7ed969a2d5fd0f7bade7e9dffdeb472d93286c76c49388cb");
  });

  it("loads, byte-verifies, and mechanically applies every adversarial case", () => {
    const sourceBytes = readFileSync(new URL("./fixtures/gille-roster-proposal-v1-positive.json", import.meta.url), "utf8");
    const manifest = parseRosterAdversarialManifest(JSON.parse(readFileSync(
      new URL("./fixtures/gille-roster-proposal-v1-adversarial.json", import.meta.url), "utf8",
    )));
    expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(manifest.source_bytes_sha256);
    const source = JSON.parse(sourceBytes) as Record<string, unknown>;
    const outputs = new Map(manifest.cases.map((fixtureCase) => [
      fixtureCase.name,
      applyRosterFixtureMutations(source, fixtureCase.mutations),
    ]));
    expect([...outputs.keys()]).toEqual([
      "malformed-dual-ordering", "identity-mismatch", "proposal-digest-mismatch",
      "expired", "wrong-route-principal",
    ]);
    const ordering = outputs.get("malformed-dual-ordering")!;
    expect((ordering.candidate as { entries: Array<{ model_id: string; alias: string }> }).entries
      .map(({ model_id, alias }) => [model_id, alias])).toEqual([["alpha", "zulu"], ["bravo", "alpha"]]);
    expectSelfBound(ordering);
    expect(((outputs.get("identity-mismatch")!.candidate as { entries: Array<{ artifact_digest: string }> }).entries[0]?.artifact_digest)).toBe(digest("0"));
    expectSelfBound(outputs.get("identity-mismatch")!);
    const digestMismatch = outputs.get("proposal-digest-mismatch")!;
    expect(digestMismatch.proposal_digest).toBe(digest("0"));
    const { proposal_digest: mismatchDigest, ...mismatchUnsigned } = digestMismatch;
    expect(mismatchDigest).not.toBe(canonicalDigest(mismatchUnsigned));
    expect(outputs.get("expired")!.expires_at).toBe("2026-07-27T14:58:00Z");
    expectSelfBound(outputs.get("expired")!);
    expect(outputs.get("wrong-route-principal")!.expected_transport_principal_id).toBe("service:other");
    expectSelfBound(outputs.get("wrong-route-principal")!);
  });

  it("rejects malformed fixture manifests, paths, and operations", () => {
    expect(() => parseRosterAdversarialManifest({ fixture_version: "wrong" })).toThrow();
    expect(() => parseRosterAdversarialManifest({
      fixture_version: "hugin-gille-roster-proposal-adversarial-v1", source: "gille-roster-proposal-v1-positive.json",
      source_bytes_sha256: "0".repeat(64), cases: [{ name: "bad", mutations: [{ op: "remove", path: "/axis", value: null }] }],
    })).toThrow();
    expect(() => applyRosterFixtureMutations({ axis: "x" }, [{ op: "replace", path: "axis", value: "y" }])).toThrow();
    expect(() => applyRosterFixtureMutations({ axis: "x" }, [{ op: "replace", path: "/missing", value: "y" }])).toThrow();
  });
});
