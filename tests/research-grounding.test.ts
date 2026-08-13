import { describe, expect, it } from "vitest";
import {
  buildStructuredTaskResult,
} from "../src/task-result-schema.js";
import {
  canonicalResearchUrl,
  buildResearchGroundingAttestation,
  parseResearchGroundingAttestation,
  validateResearchGroundingAttestation,
  extractMarkdownLinks,
  isSafePublicResearchUrl,
} from "../src/research-grounding.js";

describe("research grounding evidence (#377)", () => {
  it("is additive structured metadata and never carries fetched bodies", () => {
    const result = buildStructuredTaskResult({
      schemaVersion: 1,
      taskId: "grounded",
      taskNamespace: "tasks/grounded",
      lifecycle: "completed",
      outcome: "completed",
      runtime: "research",
      executor: "research-pi-m5",
      resultSource: "research-pi-m5",
      exitCode: 0,
      completedAt: "2026-08-13T07:00:00Z",
      bodyKind: "response",
      bodyText: "answer",
      researchGrounding: {
        version: 1,
        accepted: true,
        requiredSearches: 1,
        requiredFetches: 3,
        successfulSearches: 1,
        uniqueSuccessfulFetches: [
          { urlSha256: "a".repeat(64), contentSha256: "1".repeat(64) },
          { urlSha256: "b".repeat(64), contentSha256: "2".repeat(64) },
          { urlSha256: "c".repeat(64), contentSha256: "3".repeat(64) },
        ],
        artifactUrlSha256: { report: ["a".repeat(64), "b".repeat(64), "c".repeat(64)] },
      },
    });
    expect(result.researchGrounding?.uniqueSuccessfulFetches).toHaveLength(3);
    expect(JSON.stringify(result.researchGrounding)).not.toContain("body");
    expect(JSON.stringify(result.researchGrounding)).not.toContain("example.com");
  });

  it("projects ephemeral exact URLs into digest-only durable metadata", () => {
    const attestation = buildResearchGroundingAttestation({
      version: 1,
      accepted: true,
      requiredSearches: 1,
      requiredFetches: 3,
      successfulSearches: 1,
      uniqueSuccessfulFetches: [
        { url: "https://example.com/a?secret=query-value", contentSha256: "a".repeat(64) },
        { url: "https://example.com/b", contentSha256: "b".repeat(64) },
        { url: "https://example.com/c", contentSha256: "c".repeat(64) },
      ],
      artifactUrls: { report: ["https://example.com/a?secret=query-value", "https://example.com/b", "https://example.com/c"] },
    });
    expect(JSON.stringify(attestation)).not.toContain("secret");
    expect(JSON.stringify(attestation)).not.toContain("example.com");
  });

  it("accepts only valid accepted durable attestations for recovery", () => {
    const valid = JSON.stringify({
      version: 1,
      accepted: true,
      requiredSearches: 1,
      requiredFetches: 3,
      successfulSearches: 1,
      uniqueSuccessfulFetches: [
        { urlSha256: "a".repeat(64), contentSha256: "b".repeat(64) },
        { urlSha256: "c".repeat(64), contentSha256: "d".repeat(64) },
        { urlSha256: "e".repeat(64), contentSha256: "f".repeat(64) },
      ],
      artifactUrlSha256: { report: ["a".repeat(64), "c".repeat(64), "e".repeat(64)] },
    });
    expect(parseResearchGroundingAttestation(valid)?.accepted).toBe(true);
    expect(validateResearchGroundingAttestation(JSON.parse(valid), ["report"])?.accepted).toBe(true);
    expect(validateResearchGroundingAttestation(JSON.parse(valid), ["reading"])).toBeNull();
    expect(parseResearchGroundingAttestation("not-json")).toBeNull();
    expect(parseResearchGroundingAttestation(valid.replace('"accepted":true', '"accepted":false'))).toBeNull();
  });

  it.each([
    ["duplicate fetched URL digest", {
      uniqueSuccessfulFetches: [
        { urlSha256: "a".repeat(64), contentSha256: "b".repeat(64) },
        { urlSha256: "a".repeat(64), contentSha256: "c".repeat(64) },
        { urlSha256: "e".repeat(64), contentSha256: "f".repeat(64) },
      ], artifactUrlSha256: { report: ["a".repeat(64), "a".repeat(64), "e".repeat(64)] },
    }],
    ["empty artifact map", {
      uniqueSuccessfulFetches: [
        { urlSha256: "a".repeat(64), contentSha256: "b".repeat(64) },
        { urlSha256: "c".repeat(64), contentSha256: "d".repeat(64) },
        { urlSha256: "e".repeat(64), contentSha256: "f".repeat(64) },
      ], artifactUrlSha256: {},
    }],
    ["non-fetched citation digest", {
      uniqueSuccessfulFetches: [
        { urlSha256: "a".repeat(64), contentSha256: "b".repeat(64) },
        { urlSha256: "c".repeat(64), contentSha256: "d".repeat(64) },
        { urlSha256: "e".repeat(64), contentSha256: "f".repeat(64) },
      ], artifactUrlSha256: { report: ["a".repeat(64), "c".repeat(64), "9".repeat(64)] },
    }],
  ])("rejects %s in accepted durable metadata", (_label, overrides) => {
    const base = {
      version: 1, accepted: true, requiredSearches: 1, requiredFetches: 3, successfulSearches: 1,
      uniqueSuccessfulFetches: [], artifactUrlSha256: {},
    };
    expect(parseResearchGroundingAttestation(JSON.stringify({ ...base, ...overrides }))).toBeNull();
  });

  it("normalizes fragments but rejects private and credential-bearing URLs", () => {
    expect(canonicalResearchUrl("https://example.com/a#section")).toBe("https://example.com/a");
    expect(isSafePublicResearchUrl("https://example.com/a")).toBe(true);
    expect(isSafePublicResearchUrl("http://127.0.0.1/a")).toBe(false);
    expect(isSafePublicResearchUrl("https://user:pass@example.com/a")).toBe(false);
    for (const address of [
      "[::ffff:127.0.0.1]",
      "[::ffff:10.0.0.1]",
      "[::]",
      "[::1]",
      "[fe80::1]",
      "[fd00::1]",
      "[ff02::1]",
    ]) expect(isSafePublicResearchUrl(`http://${address}/a`)).toBe(false);
    expect(isSafePublicResearchUrl("https://[2001:4860:4860::8888]/a")).toBe(true);
  });

  it("extracts markdown links rather than accepting source names as evidence", () => {
    expect(extractMarkdownLinks("[Example](https://example.com/a) source-name")).toEqual(["https://example.com/a"]);
    expect(extractMarkdownLinks("Example source-name only")).toEqual([]);
  });
});
