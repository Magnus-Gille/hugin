import { describe, it, expect } from "vitest";
import {
  parseReposFromQueryResponse,
  parseFixableCount,
  filterEligibleRepos,
} from "../src/dep-bump-eligibility.js";

// ── parseReposFromQueryResponse ───────────────────────────────────────────────

describe("parseReposFromQueryResponse", () => {
  it("returns empty array for empty/null input", () => {
    expect(parseReposFromQueryResponse(null)).toEqual([]);
    expect(parseReposFromQueryResponse({})).toEqual([]);
  });

  it("returns empty array when no results", () => {
    const resp = {
      result: {
        content: [{ text: JSON.stringify({ results: [] }) }],
      },
    };
    expect(parseReposFromQueryResponse(resp)).toEqual([]);
  });

  it("extracts repo slugs from security/repos/<repo> namespaces", () => {
    const resp = {
      result: {
        content: [
          {
            text: JSON.stringify({
              results: [
                { namespace: "security/repos/hugin", key: "audit" },
                { namespace: "security/repos/munin-memory", key: "audit" },
                { namespace: "security/repos/heimdall", key: "audit" },
              ],
            }),
          },
        ],
      },
    };
    expect(parseReposFromQueryResponse(resp)).toEqual([
      "heimdall",
      "hugin",
      "munin-memory",
    ]);
  });

  it("deduplicates repos appearing multiple times", () => {
    const resp = {
      result: {
        content: [
          {
            text: JSON.stringify({
              results: [
                { namespace: "security/repos/hugin", key: "audit" },
                { namespace: "security/repos/hugin", key: "audit-summary" },
              ],
            }),
          },
        ],
      },
    };
    expect(parseReposFromQueryResponse(resp)).toEqual(["hugin"]);
  });

  it("ignores namespaces that don't match the pattern", () => {
    const resp = {
      result: {
        content: [
          {
            text: JSON.stringify({
              results: [
                { namespace: "security/repos/hugin", key: "audit" },
                { namespace: "security/scan-metadata", key: "last-run" },
                { namespace: "projects/hugin", key: "status" },
                // deeper path should not match
                { namespace: "security/repos/hugin/sub", key: "x" },
              ],
            }),
          },
        ],
      },
    };
    expect(parseReposFromQueryResponse(resp)).toEqual(["hugin"]);
  });

  it("handles malformed text field gracefully", () => {
    const resp = {
      result: { content: [{ text: "not json" }] },
    };
    expect(parseReposFromQueryResponse(resp)).toEqual([]);
  });
});

// ── parseFixableCount ─────────────────────────────────────────────────────────

describe("parseFixableCount", () => {
  it("returns 0 for null/empty input", () => {
    expect(parseFixableCount(null)).toBe(0);
    expect(parseFixableCount({})).toBe(0);
  });

  it("returns 0 when found is false", () => {
    const resp = {
      result: {
        content: [
          {
            text: JSON.stringify({ found: false, content: "" }),
          },
        ],
      },
    };
    expect(parseFixableCount(resp)).toBe(0);
  });

  it("parses fixable count from JSON content field", () => {
    const auditContent = JSON.stringify({
      vulnerabilities: 3,
      fixable: 2,
      critical: 1,
    });
    const resp = {
      result: {
        content: [
          {
            text: JSON.stringify({ found: true, content: auditContent }),
          },
        ],
      },
    };
    expect(parseFixableCount(resp)).toBe(2);
  });

  it("parses fixable count from plain text pattern 'fixable: N'", () => {
    const auditContent = "3 vulnerabilities found\nfixable: 2\n1 needs --force";
    const resp = {
      result: {
        content: [
          {
            text: JSON.stringify({ found: true, content: auditContent }),
          },
        ],
      },
    };
    expect(parseFixableCount(resp)).toBe(2);
  });

  it("returns 0 when fixable is 0 in JSON", () => {
    const auditContent = JSON.stringify({ vulnerabilities: 1, fixable: 0 });
    const resp = {
      result: {
        content: [
          {
            text: JSON.stringify({ found: true, content: auditContent }),
          },
        ],
      },
    };
    expect(parseFixableCount(resp)).toBe(0);
  });

  it("returns 0 when no fixable field present", () => {
    const auditContent = "no vulnerabilities found";
    const resp = {
      result: {
        content: [
          {
            text: JSON.stringify({ found: true, content: auditContent }),
          },
        ],
      },
    };
    expect(parseFixableCount(resp)).toBe(0);
  });

  it("handles malformed text field gracefully", () => {
    const resp = {
      result: { content: [{ text: "BROKEN JSON {{{" }] },
    };
    expect(parseFixableCount(resp)).toBe(0);
  });
});

// ── filterEligibleRepos ───────────────────────────────────────────────────────

describe("filterEligibleRepos", () => {
  it("returns repos with fixable > 0", () => {
    const repos = ["hugin", "munin-memory", "heimdall"];
    const counts = new Map([
      ["hugin", 3],
      ["munin-memory", 0],
      ["heimdall", 1],
    ]);
    expect(filterEligibleRepos(repos, counts)).toEqual(["hugin", "heimdall"]);
  });

  it("returns empty array when all counts are 0", () => {
    const repos = ["hugin", "munin-memory"];
    const counts = new Map([
      ["hugin", 0],
      ["munin-memory", 0],
    ]);
    expect(filterEligibleRepos(repos, counts)).toEqual([]);
  });

  it("treats missing count as 0 (repo not in map)", () => {
    const repos = ["hugin", "unknown-repo"];
    const counts = new Map([["hugin", 2]]);
    expect(filterEligibleRepos(repos, counts)).toEqual(["hugin"]);
  });

  it("returns empty array for empty repo list", () => {
    expect(filterEligibleRepos([], new Map())).toEqual([]);
  });
});
