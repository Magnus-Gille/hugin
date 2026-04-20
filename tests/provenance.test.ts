import { describe, expect, it } from "vitest";
import {
  detectProvenance,
  externalProvenanceBanner,
  parseExternalPolicy,
  provenanceReason,
} from "../src/provenance.js";

describe("detectProvenance", () => {
  it("returns external when source:external tag is present", () => {
    expect(detectProvenance(["source:external"], "projects/foo")).toBe("external");
  });

  it("returns external for entries under signals/", () => {
    expect(detectProvenance([], "signals/telegram")).toBe("external");
    expect(detectProvenance(undefined, "signals")).toBe("external");
  });

  it("returns trusted for everything else", () => {
    expect(detectProvenance([], "projects/hugin")).toBe("trusted");
    expect(detectProvenance(["source:internal"], "meta/conventions")).toBe("trusted");
    expect(detectProvenance(undefined, "people/magnus")).toBe("trusted");
  });

  it("does not confuse similarly-named namespaces", () => {
    expect(detectProvenance([], "signal")).toBe("trusted");
    expect(detectProvenance([], "signalssss")).toBe("trusted");
  });
});

describe("parseExternalPolicy", () => {
  it("parses all supported modes", () => {
    expect(parseExternalPolicy("allow")).toBe("allow");
    expect(parseExternalPolicy("warn")).toBe("warn");
    expect(parseExternalPolicy("block")).toBe("block");
    expect(parseExternalPolicy("fail")).toBe("fail");
    expect(parseExternalPolicy("WARN")).toBe("warn");
    expect(parseExternalPolicy(" block ")).toBe("block");
  });

  it("defaults to warn when unset", () => {
    expect(parseExternalPolicy(undefined)).toBe("warn");
    expect(parseExternalPolicy("")).toBe("warn");
    expect(parseExternalPolicy("   ")).toBe("warn");
  });

  it("throws on unknown values rather than silently defaulting", () => {
    expect(() => parseExternalPolicy("strict")).toThrow(/HUGIN_EXTERNAL_POLICY/);
  });
});

describe("externalProvenanceBanner", () => {
  it("includes the reason in the banner", () => {
    const banner = externalProvenanceBanner("tag source:external");
    expect(banner).toMatch(/external source/);
    expect(banner).toMatch(/tag source:external/);
    expect(banner).toMatch(/untrusted/);
  });
});

describe("provenanceReason", () => {
  it("reports the tag when present", () => {
    expect(provenanceReason(["source:external"], "projects/foo")).toMatch(
      /tag source:external/,
    );
  });

  it("reports the signals namespace when present", () => {
    expect(provenanceReason([], "signals/telegram")).toBe("namespace signals/telegram");
  });

  it("combines both reasons when both apply", () => {
    const reason = provenanceReason(["source:external"], "signals/x");
    expect(reason).toMatch(/tag source:external/);
    expect(reason).toMatch(/namespace signals\/x/);
  });

  it("returns 'unspecified' when neither signal is present", () => {
    expect(provenanceReason([], "projects/foo")).toBe("unspecified");
  });
});
