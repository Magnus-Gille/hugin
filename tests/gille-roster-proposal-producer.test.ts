import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalizeJcs } from "../src/jcs.js";
import {
  GILLE_ROSTER_PROPOSAL_PRINCIPAL,
  combinedGilleRosterBaselineDigest,
  serializeGilleRosterProposal,
  type GilleRosterProposalInput,
} from "../src/autonomy/gille-roster-proposal-producer.js";
import {
  autonomyProposalOwnershipRegistry,
  createAutonomyProposalReceipt,
} from "../src/autonomy/proposal-receipts.js";
import {
  applyRosterFixtureMutations,
  parseRosterAdversarialManifest,
} from "./helpers/gille-roster-proposal-fixtures.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const SECRET = "d".repeat(64);
const canonicalDigest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalizeJcs(value)).digest("hex")}`;
const issuerKeys = generateKeyPairSync("ed25519");
const testDependencies = {
  provenanceIssuer: {
    keyId: "hugin-roster-provenance" as const,
    privateKeyPem: issuerKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  },
};
const serialize = (value: GilleRosterProposalInput) => serializeGilleRosterProposal(value, testDependencies);

function expectSelfBound(payload: Record<string, unknown>): void {
  const candidate = payload.candidate as { entries: unknown[]; roster_digest: string };
  expect(candidate.roster_digest).toBe(canonicalDigest({ entries: candidate.entries }));
  const { proposal_digest: proposalDigest, ...unsigned } = payload;
  expect(proposalDigest).toBe(canonicalDigest(unsigned));
}

function input(): GilleRosterProposalInput {
  const baseline = { catalogueDigest: digest("1"), rosterDigest: digest("2") };
  const sourceBase = { revision: "epoch-gille-fixture", digest: combinedGilleRosterBaselineDigest(baseline) };
  const sourceProposal = createAutonomyProposalReceipt({
    proposalId: "proposal-w5-hugin-fixture", experimentRef: "ref:w5-roster-fixture",
    evidenceFingerprints: [digest("d")], targetId: "gille-served-model-roster",
    base: sourceBase,
    candidateContentDigest: "sha256:b6dec2e4284218939a3398ae48ae7b8fd5fedcdec9fea5a38d7caf68c2792314",
    expiresAt: "2026-07-27T16:00:00Z",
    signerKeyId: "hugin-autonomy-proposer",
  }, SECRET);
  return {
    proposalId: "proposal-w5-hugin-fixture",
    idempotencyKey: "idem:w5:hugin-fixture",
    producerInstanceId: "hugin:test-fixture",
    sourceProposal,
    sourceCurrentBase: sourceBase,
    baseline,
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
  it("fails closed without the Hugin composition-owned Ed25519 issuer", () => {
    expect(() => serializeGilleRosterProposal(input())).toThrow(/issuer is unconfigured/);
  });

  it("rejects a composition key that is not Ed25519", () => {
    const nonEd25519 = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => serializeGilleRosterProposal(input(), {
      provenanceIssuer: {
        keyId: "hugin-roster-provenance",
        privateKeyPem: nonEd25519.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
    })).toThrow(/must be Ed25519/);
  });

  it("emits byte-identical canonical payloads bound to the Hugin principal", () => {
    const first = serialize(input());
    const second = serialize(input());
    expect(first.bytes).toBe(second.bytes);
    expect(first.proposal.expected_transport_principal_id).toBe(GILLE_ROSTER_PROPOSAL_PRINCIPAL);
    expect(first.proposal.candidate.roster_digest).toMatch(/^sha256:/);
    expect(first.proposal.proposal_digest).toMatch(/^sha256:/);
    expect(first.binding.source_receipt_digest).toMatch(/^sha256:/);
    expect(first.binding.baseline_identity_digest).toMatch(/^sha256:/);
    expect(first.binding.constitution_digest).toBeDefined();
    const { signature, ...unsignedProvenance } = first.proposal.provenance;
    expect(verify(
      null,
      Buffer.from(canonicalizeJcs(unsignedProvenance)),
      issuerKeys.publicKey,
      Buffer.from(signature.value_base64, "base64"),
    )).toBe(true);
  });

  it("rejects a delta whose candidate presence contradicts its operation", () => {
    const bad = input(); bad.delta = { ...bad.delta, operation: "unload" }; bad.canary = { ...bad.canary, operation: "unload", expectedState: "absent", fallbackModelId: "fallback" };
    expect(() => serialize(bad)).toThrow(/delta operation/i);
  });

  it.each([
    ["stale base", (value: GilleRosterProposalInput) => { value.sourceCurrentBase = { revision: "other", digest: digest("0") as `sha256:${string}` }; }],
    ["candidate digest", (value: GilleRosterProposalInput) => { value.sourceProposal = { ...(value.sourceProposal as Record<string, unknown>), candidateContentDigest: digest("0") }; }],
    ["canary", (value: GilleRosterProposalInput) => { value.canary = { ...value.canary, modelId: "other-model" }; }],
    ["lifetime", (value: GilleRosterProposalInput) => { value.expiresAt = "2026-07-29T14:58:00Z"; }],
    ["redundant milliseconds", (value: GilleRosterProposalInput) => { value.createdAt = "2026-07-27T14:58:00.000Z"; }],
  ])("rejects %s before producing a proposal", (_name, mutate) => {
    const value = input(); mutate(value); expect(() => serialize(value)).toThrow();
  });

  it("rejects a desired roster whose aliases cannot satisfy the consumer's dual ordering rule", () => {
    const invalid = input();
    invalid.candidateEntries = [
      { ...invalid.candidateEntries[0]!, modelId: "alpha", alias: "zulu" },
      { ...invalid.candidateEntries[0]!, modelId: "bravo", alias: "alpha" },
    ];
    expect(() => serialize(invalid)).toThrow(/model_id and alias/i);
  });

  it("rejects source receipts with the wrong ownership registry or policy authority", () => {
    const wrongRegistry = input();
    wrongRegistry.sourceProposal = {
      ...(wrongRegistry.sourceProposal as Record<string, unknown>),
      ownershipRegistry: { version: "v1", digest: digest("0") },
    };
    expect(() => serialize(wrongRegistry)).toThrow(/source R-exact proposal/i);

    const wrongPolicy = input();
    const source = wrongPolicy.sourceProposal as Record<string, unknown>;
    wrongPolicy.sourceProposal = {
      ...source,
      policyEpoch: {
        ...(source.policyEpoch as Record<string, unknown>),
        constitutionDigest: digest("0"),
      },
    };
    expect(() => serialize(wrongPolicy)).toThrow(/source R-exact proposal/i);

    const openShape = input();
    openShape.sourceProposal = {
      ...(openShape.sourceProposal as Record<string, unknown>),
      unexpected: true,
    };
    expect(() => serialize(openShape)).toThrow(/invalid closed shape/i);
  });

  it("pins the positive cross-repository fixture to real serializer bytes", () => {
    const dynamic = serialize(input()).proposal;
    const fixture = readFileSync(new URL("./fixtures/gille-roster-proposal-v2-positive.json", import.meta.url), "utf8");
    const publicKeyPem = readFileSync(new URL("./fixtures/hugin-roster-provenance-v1-test-public.pem", import.meta.url), "utf8");
    const staticProposal = JSON.parse(fixture) as typeof dynamic;
    const { signature, ...unsignedProvenance } = staticProposal.provenance;
    expect(verify(
      null,
      Buffer.from(canonicalizeJcs(unsignedProvenance)),
      publicKeyPem,
      Buffer.from(signature.value_base64, "base64"),
    )).toBe(true);
    expect(staticProposal.provenance.proposal_content_digest).toBe(dynamic.provenance.proposal_content_digest);
    expect(staticProposal.provenance.source_receipt_digest).toBe(dynamic.provenance.source_receipt_digest);
    expectSelfBound(staticProposal as unknown as Record<string, unknown>);
    expect(createHash("sha256").update(fixture, "utf8").digest("hex"))
      .toBe("949662966436bc2d4322d147b6b3f6541ee67a53b97f0007310dd18fa84fb9da");
  });

  it("loads, byte-verifies, and mechanically applies every adversarial case", () => {
    const sourceBytes = readFileSync(new URL("./fixtures/gille-roster-proposal-v2-positive.json", import.meta.url), "utf8");
    const manifest = parseRosterAdversarialManifest(JSON.parse(readFileSync(
      new URL("./fixtures/gille-roster-proposal-v2-adversarial.json", import.meta.url), "utf8",
    )));
    expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(manifest.source_bytes_sha256);
    const source = JSON.parse(sourceBytes) as Record<string, unknown>;
    const outputs = new Map(manifest.cases.map((fixtureCase) => [
      fixtureCase.name,
      applyRosterFixtureMutations(source, fixtureCase.mutations),
    ]));
    expect([...outputs.keys()]).toEqual([
      "source-receipt-digest-tamper", "source-base-tamper", "candidate-digest-tamper",
      "evidence-set-tamper", "policy-tamper", "principal-tamper",
      "proposal-content-digest-tamper", "envelope-signature-tamper",
    ]);
    expect((outputs.get("source-receipt-digest-tamper")!.provenance as { source_receipt_digest: string }).source_receipt_digest).toBe(digest("0"));
    expect((outputs.get("source-base-tamper")!.provenance as { source_base: { digest: string } }).source_base.digest).toBe(digest("0"));
    expect((outputs.get("candidate-digest-tamper")!.provenance as { candidate_digest: string }).candidate_digest).toBe(digest("0"));
    expect((outputs.get("evidence-set-tamper")!.provenance as { evidence_fingerprints: string[] }).evidence_fingerprints).toEqual([digest("0")]);
    expect((outputs.get("policy-tamper")!.provenance as { constitution_digest: string }).constitution_digest).toBe(digest("0"));
    expect((outputs.get("principal-tamper")!.provenance as { principal_id: string }).principal_id).toBe("service:other");
    expect((outputs.get("proposal-content-digest-tamper")!.provenance as { proposal_content_digest: string }).proposal_content_digest).toBe(digest("0"));
    expect((outputs.get("envelope-signature-tamper")!.provenance as { signature: { value_base64: string } }).signature.value_base64).toBe("AA==");
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
