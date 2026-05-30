import { describe, it, expect, vi } from "vitest";
import {
  classifyTask,
  classifierHash,
  effectiveSensitivityCeiling,
  loadActiveClassifiers,
} from "../../src/skill/task-classifier.js";
import type { TaskClassifier } from "../../src/skill/task-classifier-schema.js";
import type { MuninClient } from "../../src/munin-client.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const H = (c: string) => c.repeat(64).slice(0, 64);

// These classifiers use weights that sum to 1.0 per classifier so that
// a single rule match produces confidence == that rule's weight directly.
// Threshold is set below the weight of any single rule that should match,
// so the shouldClassify prompts clear it.
const coderClassifier: TaskClassifier = {
  schemaVersion: 1,
  classId: "coding-task",
  version: 1,
  classifierHash: H("a"),
  predicate: {
    kind: "rule",
    // Weights sum to 1.0; any single rule match produces its weight as confidence.
    rules: [
      { match: "write a function", weight: 0.5 },
      { match: "implement",        weight: 0.4 },
      { match: "fix the bug",      weight: 0.1 },
    ],
    confidenceThreshold: 0.35, // below min single-rule weight (0.4), so any strong match passes
    topTwoMargin: 0.1,
  },
  hardNegatives: [
    { input: "explain the difference between X and Y", why: "educational, not coding" },
  ],
  contraindications: ["do not write code", "read-only analysis"],
  shouldClassify: [
    { input: "please implement a sorting function in TypeScript" },
    { input: "write a function that parses JSON" },
  ],
  shouldNotClassify: [
    { input: "explain the difference between TCP and UDP" },
    { input: "summarize this document" },
  ],
  sensitivityCeiling: "internal",
};

const docsClassifier: TaskClassifier = {
  schemaVersion: 1,
  classId: "documentation-task",
  version: 1,
  classifierHash: H("b"),
  predicate: {
    kind: "rule",
    // Weights sum to 1.0.
    rules: [
      { match: "write documentation", weight: 0.5 },
      { match: "document the api",    weight: 0.4 },
      { match: "summarize",           weight: 0.1 },
    ],
    confidenceThreshold: 0.35,
    topTwoMargin: 0.1,
  },
  hardNegatives: [
    { input: "write code", why: "implementation, not documentation" },
  ],
  contraindications: [],
  shouldClassify: [
    { input: "write documentation for the auth module" },
    { input: "document the api endpoints" },
  ],
  shouldNotClassify: [
    { input: "implement a login function" },
  ],
  sensitivityCeiling: "public",
};

// ---------------------------------------------------------------------------
// classifyTask: shouldClassify inputs
// ---------------------------------------------------------------------------

describe("classifyTask — shouldClassify inputs classify to the right class", () => {
  it("classifies a prompt matching coderClassifier.shouldClassify[0]", () => {
    const result = classifyTask(
      "please implement a sorting function in TypeScript",
      [coderClassifier],
    );
    expect(result.kind).toBe("classified");
    if (result.kind === "classified") {
      expect(result.classId).toBe("coding-task");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("classifies a prompt matching coderClassifier.shouldClassify[1]", () => {
    const result = classifyTask(
      "write a function that parses JSON",
      [coderClassifier],
    );
    expect(result.kind).toBe("classified");
    if (result.kind === "classified") {
      expect(result.classId).toBe("coding-task");
    }
  });

  it("classifies a docs prompt to docsClassifier", () => {
    const result = classifyTask(
      "write documentation for the auth module",
      [docsClassifier],
    );
    expect(result.kind).toBe("classified");
    if (result.kind === "classified") {
      expect(result.classId).toBe("documentation-task");
    }
  });
});

// ---------------------------------------------------------------------------
// classifyTask: shouldNotClassify inputs
// ---------------------------------------------------------------------------

describe("classifyTask — shouldNotClassify inputs abstain or pick different class", () => {
  it("abstains or picks wrong class for coderClassifier.shouldNotClassify[0]", () => {
    const result = classifyTask(
      "explain the difference between TCP and UDP",
      [coderClassifier],
    );
    // Either abstains or does not classify to coding-task
    if (result.kind === "classified") {
      expect(result.classId).not.toBe("coding-task");
    } else {
      expect(result.kind).toBe("abstain");
    }
  });

  it("abstains or picks wrong class for coderClassifier.shouldNotClassify[1]", () => {
    const result = classifyTask("summarize this document", [coderClassifier]);
    if (result.kind === "classified") {
      expect(result.classId).not.toBe("coding-task");
    } else {
      expect(result.kind).toBe("abstain");
    }
  });
});

// ---------------------------------------------------------------------------
// classifyTask: hard-negative / contraindication exclusion
// ---------------------------------------------------------------------------

describe("classifyTask — hard-negative and contraindication exclusion", () => {
  it("hard-negative input scores 0 (cannot classify to that class)", () => {
    // The coderClassifier hard-negative pattern appears in this prompt
    const result = classifyTask(
      "explain the difference between X and Y",
      [coderClassifier],
    );
    // Must NOT classify to coding-task
    if (result.kind === "classified") {
      expect(result.classId).not.toBe("coding-task");
    }
    // If only one classifier, should abstain since hard-negative zeroed it out
    const singleResult = classifyTask(
      "explain the difference between X and Y",
      [coderClassifier],
    );
    expect(singleResult.kind).toBe("abstain");
  });

  it("contraindication in prompt zeroes out that classifier", () => {
    // "do not write code" is a contraindication for coderClassifier
    const result = classifyTask(
      "implement a function (do not write code, just describe it)",
      [coderClassifier],
    );
    // Should NOT classify to coding-task because contraindication matched
    if (result.kind === "classified") {
      expect(result.classId).not.toBe("coding-task");
    }
  });

  it("hard-negative on docsClassifier prevents docs classification", () => {
    // "write code" is a hard-negative for docsClassifier
    const result = classifyTask(
      "write code for the auth module",
      [docsClassifier],
    );
    // docsClassifier should score 0 due to hard-negative
    if (result.kind === "classified") {
      expect(result.classId).not.toBe("documentation-task");
    }
  });
});

// ---------------------------------------------------------------------------
// classifyTask: below-threshold abstain
// ---------------------------------------------------------------------------

describe("classifyTask — below-threshold abstain", () => {
  it("abstains with below-threshold when no rules match", () => {
    const result = classifyTask(
      "what is the weather like today",
      [coderClassifier],
    );
    expect(result.kind).toBe("abstain");
    if (result.kind === "abstain") {
      expect(result.reason).toBe("below-threshold");
    }
  });

  it("abstains below-threshold for a classifier with high threshold and partial match", () => {
    // Classifier has 4 rules summing to 1.0; only the weakest (weight=0.1) matches.
    // Score = 0.1/1.0 = 0.1 < threshold 0.4 → abstain below-threshold.
    const strictClassifier: TaskClassifier = {
      ...coderClassifier,
      classId: "strict-class",
      classifierHash: H("c"),
      predicate: {
        kind: "rule",
        rules: [
          { match: "strongly specific phrase xyz", weight: 0.4 },
          { match: "another specific phrase abc", weight: 0.3 },
          { match: "yet another phrase def",      weight: 0.2 },
          { match: "function",                    weight: 0.1 },
        ],
        confidenceThreshold: 0.4, // requires a strong rule to match; only "function" hits
        topTwoMargin: 0.0,
      },
    };
    // "define a function" only matches "function" (weight 0.1) → 0.1/1.0 = 0.1 < 0.4
    const result = classifyTask("define a function", [strictClassifier]);
    expect(result.kind).toBe("abstain");
    if (result.kind === "abstain") {
      expect(result.reason).toBe("below-threshold");
    }
  });
});

// ---------------------------------------------------------------------------
// classifyTask: ambiguous-top-two abstain
// ---------------------------------------------------------------------------

describe("classifyTask — ambiguous-top-two abstain", () => {
  it("abstains ambiguous-top-two when two classifiers score very close", () => {
    // Build two classifiers that both match the same prompt with identical weight
    const classifierA: TaskClassifier = {
      ...coderClassifier,
      classId: "class-a",
      classifierHash: H("d"),
      predicate: {
        kind: "rule",
        rules: [{ match: "analyze the system", weight: 1.0 }],
        confidenceThreshold: 0.1,
        topTwoMargin: 0.2, // requires 0.2 margin; tied inputs will abstain
      },
    };
    const classifierB: TaskClassifier = {
      ...coderClassifier,
      classId: "class-b",
      classifierHash: H("e"),
      predicate: {
        kind: "rule",
        rules: [{ match: "analyze the system", weight: 1.0 }],
        confidenceThreshold: 0.1,
        topTwoMargin: 0.2,
      },
    };
    const result = classifyTask("analyze the system performance", [classifierA, classifierB]);
    // Both match "analyze the system" equally → ambiguous-top-two
    expect(result.kind).toBe("abstain");
    if (result.kind === "abstain") {
      expect(result.reason).toBe("ambiguous-top-two");
    }
  });
});

// ---------------------------------------------------------------------------
// effectiveSensitivityCeiling — SECURITY TESTS
// ---------------------------------------------------------------------------

describe("effectiveSensitivityCeiling — security invariant: can only constrain, never raise", () => {
  it("returns min of classifier ceiling, cell trust ceiling, task sensitivity", () => {
    // classifier=private, cell=internal, task=public → public (most restrictive)
    expect(effectiveSensitivityCeiling("private", "internal", "public")).toBe("public");
  });

  it("classifier ceiling=private, task=internal → internal (cannot raise beyond task)", () => {
    // classifier says private is OK, but task is only internal
    expect(effectiveSensitivityCeiling("private", "private", "internal")).toBe("internal");
  });

  it("cell=public is the binding floor — returns public regardless of others", () => {
    expect(effectiveSensitivityCeiling("private", "public", "private")).toBe("public");
    expect(effectiveSensitivityCeiling("internal", "public", "internal")).toBe("public");
  });

  it("task=public → result is always public regardless of classifier/cell", () => {
    expect(effectiveSensitivityCeiling("private", "private", "public")).toBe("public");
    expect(effectiveSensitivityCeiling("internal", "internal", "public")).toBe("public");
  });

  it("all three equal → returns that value", () => {
    expect(effectiveSensitivityCeiling("internal", "internal", "internal")).toBe("internal");
    expect(effectiveSensitivityCeiling("private", "private", "private")).toBe("private");
    expect(effectiveSensitivityCeiling("public", "public", "public")).toBe("public");
  });

  it("result never EXCEEDS any single input (exhaustive over all triples)", () => {
    const levels = ["public", "internal", "private"] as const;
    const ORDER = { public: 0, internal: 1, private: 2 };
    for (const classifierCeil of levels) {
      for (const cellTrust of levels) {
        for (const taskSens of levels) {
          const result = effectiveSensitivityCeiling(classifierCeil, cellTrust, taskSens);
          // The result must be <= ALL three inputs on the lattice
          expect(ORDER[result]).toBeLessThanOrEqual(ORDER[classifierCeil]);
          expect(ORDER[result]).toBeLessThanOrEqual(ORDER[cellTrust]);
          expect(ORDER[result]).toBeLessThanOrEqual(ORDER[taskSens]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// classifierHash — stable
// ---------------------------------------------------------------------------

describe("classifierHash — stable across calls", () => {
  it("produces a 64-char hex hash", () => {
    const h = classifierHash(coderClassifier);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable (same input → same hash)", () => {
    expect(classifierHash(coderClassifier)).toBe(classifierHash(coderClassifier));
  });

  it("different classifiers produce different hashes", () => {
    expect(classifierHash(coderClassifier)).not.toBe(classifierHash(docsClassifier));
  });

  it("is key-order independent (canonical JSON)", () => {
    // Create a copy with differently-ordered keys to verify canonical hashing
    const reordered: TaskClassifier = {
      version: coderClassifier.version,
      classId: coderClassifier.classId,
      schemaVersion: coderClassifier.schemaVersion,
      classifierHash: coderClassifier.classifierHash,
      predicate: coderClassifier.predicate,
      hardNegatives: coderClassifier.hardNegatives,
      contraindications: coderClassifier.contraindications,
      shouldClassify: coderClassifier.shouldClassify,
      shouldNotClassify: coderClassifier.shouldNotClassify,
      sensitivityCeiling: coderClassifier.sensitivityCeiling,
    };
    expect(classifierHash(coderClassifier)).toBe(classifierHash(reordered));
  });
});

// ---------------------------------------------------------------------------
// loadActiveClassifiers — reads from Munin
// ---------------------------------------------------------------------------

describe("loadActiveClassifiers — Munin integration", () => {
  it("returns empty array when Munin has no active classifiers", async () => {
    const fakeMunin = {
      query: vi.fn().mockResolvedValue({ results: [], total: 0 }),
    } as unknown as MuninClient;

    const result = await loadActiveClassifiers(fakeMunin);
    expect(result).toEqual([]);
  });

  it("reads and validates classifier entries from Munin", async () => {
    const validClassifier: TaskClassifier = {
      schemaVersion: 1,
      classId: "test-class",
      version: 1,
      classifierHash: H("f"),
      predicate: {
        kind: "rule",
        rules: [{ match: "test prompt", weight: 1.0 }],
        confidenceThreshold: 0.5,
        topTwoMargin: 0.1,
      },
      hardNegatives: [{ input: "ignore this", why: "test" }],
      contraindications: [],
      shouldClassify: [{ input: "run the test" }],
      shouldNotClassify: [{ input: "summarize" }],
      sensitivityCeiling: "internal",
    };

    const fakeMunin = {
      query: vi.fn().mockResolvedValue({
        results: [
          {
            namespace: "routes/_classifier",
            key: "test-class/active",
            content_preview: "",
            tags: ["active"],
            id: "1",
            entry_type: "state",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        total: 1,
      }),
      // loadActiveClassifiers uses readBatch (not read) to fetch full content
      readBatch: vi.fn().mockResolvedValue([
        {
          found: true,
          namespace: "routes/_classifier",
          key: "test-class/active",
          content: JSON.stringify(validClassifier),
          tags: ["active"],
          id: "1",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ]),
    } as unknown as MuninClient;

    const result = await loadActiveClassifiers(fakeMunin);
    expect(result).toHaveLength(1);
    expect(result[0].classId).toBe("test-class");
  });

  it("skips invalid entries silently (does not throw)", async () => {
    const fakeMunin = {
      query: vi.fn().mockResolvedValue({
        results: [
          {
            namespace: "routes/_classifier",
            key: "bad-class/active",
            content_preview: "",
            tags: ["active"],
            id: "2",
            entry_type: "state",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        total: 1,
      }),
      readBatch: vi.fn().mockResolvedValue([
        {
          found: true,
          namespace: "routes/_classifier",
          key: "bad-class/active",
          content: JSON.stringify({ invalid: "data" }),
          tags: ["active"],
          id: "2",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ]),
    } as unknown as MuninClient;

    const result = await loadActiveClassifiers(fakeMunin);
    expect(result).toEqual([]);
  });
});
