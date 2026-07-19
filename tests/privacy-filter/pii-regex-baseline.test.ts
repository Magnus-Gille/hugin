import { describe, expect, it } from "vitest";
import { regexBaselineDetector } from "../../src/privacy-filter/pii-regex-baseline.js";
import type { PiiLabel } from "../../src/privacy-filter/pii-types.js";

const detect = (t: string) => regexBaselineDetector.detect(t);
const labelsFor = (t: string, surface: string): PiiLabel[] =>
  detect(t)
    .filter((s) => s.text === surface)
    .map((s) => s.label);

describe("pii-regex-baseline — structured PII (should be strong)", () => {
  it("detects emails", () => {
    expect(labelsFor("write to anna.lindqvist@example.se today", "anna.lindqvist@example.se")).toContain(
      "private_email",
    );
  });

  it("detects http(s) URLs", () => {
    const t = "see https://drive.example.com/file/d/1aZ/view?token=8fe2 for the deck";
    const urls = detect(t).filter((s) => s.label === "private_url");
    expect(urls.length).toBe(1);
    expect(urls[0].text).toContain("https://drive.example.com");
  });

  it("detects ISO and written dates", () => {
    const t = "kickoff 2026-06-03 and ship 1 Jul 2026";
    const dates = detect(t).filter((s) => s.label === "private_date").map((s) => s.text);
    expect(dates).toContain("2026-06-03");
    expect(dates.some((d) => /Jul 2026/.test(d))).toBe(true);
  });

  it("detects a Swedish personnummer as account_number", () => {
    expect(labelsFor("personnummer 850417-2381 noted", "850417-2381")).toContain("account_number");
  });

  it("detects an IBAN as account_number", () => {
    const t = "IBAN SE3550000000054910000003 on file";
    const accts = detect(t).filter((s) => s.label === "account_number");
    expect(accts.length).toBeGreaterThanOrEqual(1);
  });

  it("detects well-known secret shapes", () => {
    const ghToken = "gh" + "p_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78";
    const accessKey = "AK" + "IA4Z9QXWPLMN72BVTQ";
    expect(detect(`token ${ghToken} leaked`).some((s) => s.label === "secret")).toBe(true);
    expect(detect(`key ${accessKey} hardcoded`).some((s) => s.label === "secret")).toBe(true);
  });

  it("detects a phone number", () => {
    expect(detect("call (415) 555-0173 now").some((s) => s.label === "private_phone")).toBe(true);
  });
});

describe("pii-regex-baseline — structured rules pre-empt noisy heuristics", () => {
  it("does not double-claim characters across labels", () => {
    const t = "mail anna@example.se on 2026-06-03";
    const spans = detect(t);
    // No two spans overlap.
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
    }
  });
});

describe("pii-regex-baseline — unstructured PII (illustratively weak)", () => {
  it("catches TitleCase multi-word names but is known to over/under-fire", () => {
    // It SHOULD catch this two-word name…
    expect(detect("met Alex Example today").some((s) => s.label === "private_person")).toBe(true);
    // …and it predictably MISSES a lowercase mononym — the regex ceiling that
    // motivates a learned model (documented in the README).
    expect(detect("ping from kasia").some((s) => s.label === "private_person")).toBe(false);
  });
});

describe("pii-regex-baseline — credential vocabulary is NOT a secret", () => {
  it("does not flag prose discussing api keys / passwords as a secret", () => {
    const t = "rotate the API key handling and hash every password before the bearer token check";
    expect(detect(t).some((s) => s.label === "secret")).toBe(false);
  });
});
