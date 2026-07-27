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
  verifyAutonomyProposalReceipt,
} from "../src/autonomy/proposal-receipts.js";
import type { GilleRosterProposalProducerDependencies } from "../src/autonomy/gille-roster-proposal-producer.js";
import {
  applyRosterFixtureMutations,
  parseRosterAdversarialManifest,
} from "./helpers/gille-roster-proposal-fixtures.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const SECRET = "d".repeat(64);
const canonicalDigest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalizeJcs(value)).digest("hex")}`;
const issuerKeys = generateKeyPairSync("ed25519");
const sourceBase = {
  revision: "epoch-gille-fixture",
  digest: combinedGilleRosterBaselineDigest({
    catalogueDigest: "sha256:1ff21fa3c402abeacab4171f2097b83eeb4b13825f4726acaafe555da85979a5",
    rosterDigest: "sha256:9ca3c71e2c9318be86a3892ae9322b3f1465a0799fd57971f06ec71cc7861b2d",
  }),
};
const testDependencies: GilleRosterProposalProducerDependencies = {
  provenanceIssuer: {
    keyId: "hugin-roster-provenance" as const,
    privateKeyPem: issuerKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  },
  trustedW4KeyStore: { "hugin-autonomy-proposer": SECRET },
  currentBaseProvider: () => sourceBase,
  clock: () => new Date("2026-07-27T15:00:00Z"),
};
const serialize = (value: GilleRosterProposalInput, dependencies = testDependencies) => serializeGilleRosterProposal(value, dependencies);

function expectSelfBound(payload: Record<string, unknown>): void {
  const candidate = payload.candidate as { entries: unknown[]; roster_digest: string };
  expect(candidate.roster_digest).toBe(canonicalDigest({ entries: candidate.entries }));
  const { proposal_digest: proposalDigest, ...unsigned } = payload;
  expect(proposalDigest).toBe(canonicalDigest(unsigned));
}

function input(): GilleRosterProposalInput {
  const baseline = {
    catalogueDigest: "sha256:1ff21fa3c402abeacab4171f2097b83eeb4b13825f4726acaafe555da85979a5",
    rosterDigest: "sha256:9ca3c71e2c9318be86a3892ae9322b3f1465a0799fd57971f06ec71cc7861b2d",
  } as const;
  const sourceProposal = createAutonomyProposalReceipt({
    proposalId: "proposal-w5-hugin-fixture", experimentRef: "ref:w5-roster-fixture",
    evidenceFingerprints: ["sha256:cf684b8cf8dd4610970bafc6eaf3bdf1bf87c94b381bdde4a196b7d944114f02"], targetId: "gille-served-model-roster",
    base: sourceBase,
    candidateContentDigest: "sha256:1ad6724393504a0ddf6ab7ccf597131b128e9346cbeb2bfb07e9ac39dbf71590",
    expiresAt: "2026-07-27T16:00:00Z",
    signerKeyId: "hugin-autonomy-proposer",
  }, SECRET);
  return {
    proposalId: "proposal-w5-hugin-fixture",
    idempotencyKey: "idem:w5:hugin-fixture",
    producerInstanceId: "hugin:test-fixture",
    sourceProposal,
    baseline,
    candidateEntries: [{
      modelId: "qwen-main", alias: "qwen-main", artifactDigest: "sha256:c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c",
      quantization: "q4-k-m", templateDigest: "sha256:5cde0f1298f41f7d1c8b907a36992a7a513225a2615bd6e307bf1a9149b06b40", contextLength: 16384,
      servingConfigDigest: "sha256:9343a6dbeba1ae1c25c3723e534d3c0ca288efc9dc0ac20d09ea825c09b688cf", evidenceIdentityHash: "sha256:cf684b8cf8dd4610970bafc6eaf3bdf1bf87c94b381bdde4a196b7d944114f02",
      restoreDescriptorRef: "sha256:b3307805314132f07f6dfcb09e4c7ae14933a1fda71f4afdec6840b2bf74c4c9", restoreDescriptorDigest: "sha256:5d1c5ec3982c057d81e58436258049a8857f59ae17dd85c567e02f26898a5586",
    }],
    delta: { operation: "reload-config", modelId: "qwen-main", backend: "lmstudio", backendCapabilityDigest: "sha256:e00c58b2d358957a37579e58443aa3c0dfff48f7d38c124fc91188ae18f41e27" },
    evidenceFreshnessSeconds: 3600,
    canary: {
      operation: "reload-config", modelId: "qwen-main", expectedState: "served", fallbackModelId: null,
      registryId: "canary:reload-config:qwen-main", registryVersion: "version:v1", registryDigest: "sha256:2718367094fd0787fbe86d901e108ba37132602ee5105167ebbc4fe6db9a51c4",
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
      trustedW4KeyStore: testDependencies.trustedW4KeyStore,
      currentBaseProvider: testDependencies.currentBaseProvider,
      clock: testDependencies.clock,
    })).toThrow(/must be Ed25519/);
  });

  it.each([
    ["trusted W4 key store", { ...testDependencies, trustedW4KeyStore: null }],
    ["current-base provider", { ...testDependencies, currentBaseProvider: null }],
    ["protected clock", { ...testDependencies, clock: null }],
  ] as const)("fails closed without the composition-owned %s", (_name, dependencies) => {
    expect(() => serialize(input(), dependencies)).toThrow(/verifier dependency is unconfigured/);
  });

  it("fails closed when the protected current-base provider returns an invalid base", () => {
    expect(() => serialize(input(), {
      ...testDependencies,
      currentBaseProvider: () => ({ revision: "bad", digest: "not-a-digest" }),
    })).toThrow(/verifier dependency is invalid/);
  });

  it("fails closed when the trusted W4 key store lacks the fixed W4 signer", () => {
    expect(() => serialize(input(), {
      ...testDependencies,
      trustedW4KeyStore: {},
    })).toThrow(/source R-exact proposal receipt verification failed: invalid-signature/);
  });

  it("never outer-signs a parsed but fake-HMAC W4 receipt", () => {
    const value = input();
    value.sourceProposal = {
      ...(value.sourceProposal as Record<string, unknown>),
      signature: `v1:hugin-autonomy-proposer:${"0".repeat(64)}`,
    };
    expect(() => serialize(value)).toThrow(/source R-exact proposal receipt verification failed: invalid-signature/);
  });

  it("rejects an expired W4 receipt before outer signing", () => {
    expect(() => serialize(input(), {
      ...testDependencies,
      clock: () => new Date("2026-07-27T16:00:00Z"),
    })).toThrow(/source R-exact proposal receipt verification failed: expired/);
  });

  it("rejects an invalid composition-owned verifier clock", () => {
    expect(() => serialize(input(), {
      ...testDependencies,
      clock: () => new Date("invalid"),
    })).toThrow(/source R-exact proposal receipt verification failed: invalid-verifier-clock/);
  });

  it("rejects a valid receipt whose base is stale against the protected provider", () => {
    const value = input();
    value.sourceProposal = createAutonomyProposalReceipt({
      proposalId: value.proposalId,
      experimentRef: "ref:w5-roster-fixture",
      evidenceFingerprints: [value.candidateEntries[0]!.evidenceIdentityHash],
      targetId: "gille-served-model-roster",
      base: { revision: "epoch-gille-stale", digest: digest("0") },
      candidateContentDigest: "sha256:1ad6724393504a0ddf6ab7ccf597131b128e9346cbeb2bfb07e9ac39dbf71590",
      expiresAt: value.expiresAt,
      signerKeyId: "hugin-autonomy-proposer",
    }, SECRET);
    expect(() => serialize(value)).toThrow(/source R-exact proposal receipt verification failed: stale-or-mismatched-base/);
  });

  it("ignores a legacy caller-supplied base rather than letting it redefine provenance", () => {
    const value = input() as GilleRosterProposalInput & { sourceCurrentBase: { revision: string; digest: string } };
    value.sourceCurrentBase = { revision: "caller-substituted", digest: digest("0") };
    const { binding, proposal } = serialize(value);
    expect(binding.source_base).toEqual(sourceBase);
    expect(proposal.provenance.source_base).toEqual(sourceBase);
  });

  it("rejects a valid receipt whose evidence is not the requested roster evidence", () => {
    const value = input();
    value.sourceProposal = createAutonomyProposalReceipt({
      proposalId: value.proposalId,
      experimentRef: "ref:w5-roster-fixture",
      evidenceFingerprints: [digest("0")],
      targetId: "gille-served-model-roster",
      base: sourceBase,
      candidateContentDigest: "sha256:1ad6724393504a0ddf6ab7ccf597131b128e9346cbeb2bfb07e9ac39dbf71590",
      expiresAt: value.expiresAt,
      signerKeyId: "hugin-autonomy-proposer",
    }, SECRET);
    expect(() => serialize(value)).toThrow(/source R-exact proposal receipt evidence/);
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
    expect(() => serialize(openShape)).toThrow(/source R-exact proposal receipt verification failed: invalid-receipt/);
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
    expect(verifyAutonomyProposalReceipt(
      staticProposal.provenance.source_receipt,
      testDependencies.trustedW4KeyStore!,
      { currentBase: sourceBase, now: testDependencies.clock! },
    )).toEqual({ status: "valid" });
    expect(staticProposal.provenance.proposal_content_digest).toBe(dynamic.provenance.proposal_content_digest);
    expect(staticProposal.provenance.source_receipt_digest).toBe(dynamic.provenance.source_receipt_digest);
    expectSelfBound(staticProposal as unknown as Record<string, unknown>);
    expect(createHash("sha256").update(fixture, "utf8").digest("hex"))
      .toBe("f92f9226f6cc85c905b90d4cce4fa8dd4f150c0a534242aa5e6bdb4b96501d62");
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
      "source-receipt-digest-tamper", "source-receipt-signature-tamper", "source-base-tamper", "candidate-digest-tamper",
      "evidence-set-tamper", "policy-tamper", "principal-tamper",
      "proposal-content-digest-tamper", "envelope-signature-tamper",
    ]);
    expect((outputs.get("source-receipt-digest-tamper")!.provenance as { source_receipt_digest: string }).source_receipt_digest).toBe(digest("0"));
    expect((((outputs.get("source-receipt-signature-tamper")!.provenance as { source_receipt: { signature: string } }).source_receipt).signature)).toBe(`v1:hugin-autonomy-proposer:${"0".repeat(64)}`);
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
