import { describe, expect, it } from "vitest";
import {
  gradeFixture,
  runEvalSuite,
  assertIndependentOracle,
  type PerFixtureResult,
} from "../src/skill/eval-runner.js";
import type { Oracle, Fixture, RetrievalFixture, EvalSuite } from "../src/skill/eval-suite-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const independentTestOracle: Oracle = {
  id: "o-test",
  kind: "test-suite",
  independent: true,
  ref: "tests/grader.sh",
};

const independentSchemaOracle: Oracle = {
  id: "o-schema",
  kind: "schema-validator",
  independent: true,
  ref: "schema.json",
};

const dependentOracle: Oracle = {
  id: "o-dep",
  kind: "snapshot-diff",
  independent: false,
  ref: "snapshots/",
};

const judgeOracle: Oracle = {
  id: "o-judge",
  kind: "judge-model",
  independent: false,
  ref: "judge:gpt-4o",
};

const judgeIndependentOracle: Oracle = {
  id: "o-judge-ind",
  kind: "judge-model",
  independent: true,
  ref: "judge:external",
};

function fixture(id: string, input: unknown, expected: unknown): Fixture {
  return { id, input, expected, allowedNondeterminism: [] };
}

function minimalSuite(
  overrides: Partial<EvalSuite> = {},
): EvalSuite {
  return {
    schemaVersion: 1,
    evalSuiteId: "suite-runner-test",
    evalSuiteHash: "a".repeat(64),
    skillId: "skill-test",
    taskClassId: "tc-test",
    oracles: [independentTestOracle],
    judgeIsAdvisoryOnly: true as const,
    fixtures: {
      positive: [fixture("pos-1", "in", "out")],
      negative: [fixture("neg-1", "bad", null)],
      retrieval: [{ id: "ret-1", input: "query", shouldSelect: true }],
      mutation: [fixture("mut-1", "mutated", "different")],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// assertIndependentOracle
// ---------------------------------------------------------------------------

describe("assertIndependentOracle", () => {
  it("does not throw when a suite has an independent oracle", () => {
    const suite = minimalSuite();
    expect(() => assertIndependentOracle(suite)).not.toThrow();
  });

  it("throws when no oracle is independent", () => {
    const suite = minimalSuite({ oracles: [dependentOracle] });
    expect(() => assertIndependentOracle(suite)).toThrow(
      "at least one independent oracle required",
    );
  });

  it("throws for an empty oracle array", () => {
    const suite = minimalSuite({ oracles: [] });
    expect(() => assertIndependentOracle(suite)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// gradeFixture — basic pass/fail
// ---------------------------------------------------------------------------

describe("gradeFixture — basic verdicts", () => {
  it("returns pass when output matches expected", () => {
    const f = fixture("f1", "input", "expected-output");
    const result = gradeFixture(f, "expected-output", [independentTestOracle]);
    expect(result.outcome).toBe("pass");
    expect(result.fixtureId).toBe("f1");
    expect(result.oracleId).toBe("o-test");
  });

  it("returns fail when output does not match expected", () => {
    const f = fixture("f1", "input", "expected-output");
    const result = gradeFixture(f, "wrong-output", [independentTestOracle]);
    expect(result.outcome).toBe("fail");
    expect(result.fixtureId).toBe("f1");
  });

  it("returns abstain when no oracles are provided", () => {
    const f = fixture("f1", "input", "out");
    const result = gradeFixture(f, "out", []);
    expect(result.outcome).toBe("abstain");
    expect(result.oracleId).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// gradeFixture — failure stage recording
// ---------------------------------------------------------------------------

describe("gradeFixture — caughtAtStage recording", () => {
  it("records 'tests' stage for test-suite oracle failure", () => {
    const f = fixture("f1", "in", "out");
    const result = gradeFixture(f, "wrong", [independentTestOracle]);
    expect(result.outcome).toBe("fail");
    expect(result.caughtAtStage).toBe("tests");
  });

  it("records 'schema' stage for schema-validator oracle failure", () => {
    const f = fixture("f1", "in", "out");
    const result = gradeFixture(f, "wrong", [independentSchemaOracle]);
    expect(result.outcome).toBe("fail");
    expect(result.caughtAtStage).toBe("schema");
  });

  it("records 'preflight' stage for static-analyzer oracle failure", () => {
    const staticOracle: Oracle = {
      id: "o-static",
      kind: "static-analyzer",
      independent: true,
      ref: "linter",
    };
    const f = fixture("f1", "in", "out");
    const result = gradeFixture(f, "wrong", [staticOracle]);
    expect(result.outcome).toBe("fail");
    expect(result.caughtAtStage).toBe("preflight");
  });

  it("records 'tests' stage for snapshot-diff oracle failure", () => {
    const f = fixture("f1", "in", "out");
    const result = gradeFixture(f, "wrong", [dependentOracle]);
    expect(result.outcome).toBe("fail");
    expect(result.caughtAtStage).toBe("tests");
  });

  it("does not set caughtAtStage on pass", () => {
    const f = fixture("f1", "in", "out");
    const result = gradeFixture(f, "out", [independentTestOracle]);
    expect(result.outcome).toBe("pass");
    expect(result.caughtAtStage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// gradeFixture — judge-model is advisory only
// ---------------------------------------------------------------------------

describe("gradeFixture — judge-model advisory rule", () => {
  it("abstains when the only oracle is a judge-model (cannot decide alone)", () => {
    const f = fixture("f1", "in", "out");
    const result = gradeFixture(f, "wrong", [judgeOracle]);
    // Judge alone can never decide pass or fail.
    expect(result.outcome).toBe("abstain");
    expect(result.oracleId).toBe("o-judge");
  });

  it("abstains even on a match when only judge oracles are present", () => {
    const f = fixture("f1", "in", "out");
    const result = gradeFixture(f, "out", [judgeOracle]);
    expect(result.outcome).toBe("abstain");
  });

  it("uses non-judge oracle for verdict when both types are present", () => {
    const f = fixture("f1", "in", "out");
    const result = gradeFixture(f, "wrong", [judgeOracle, independentTestOracle]);
    // The non-judge oracle is authoritative.
    expect(result.outcome).toBe("fail");
    expect(result.oracleId).toBe("o-test");
  });

  it("non-judge independent oracle is preferred over non-independent oracle", () => {
    const f = fixture("f1", "in", "out");
    // dependentOracle is non-independent, independentTestOracle is independent.
    const result = gradeFixture(f, "wrong", [dependentOracle, independentTestOracle]);
    expect(result.oracleId).toBe("o-test");
    expect(result.outcome).toBe("fail");
  });

  it("records the judge oracle id in abstain result", () => {
    const f = fixture("f1", "in", "out");
    const result = gradeFixture(f, "out", [judgeOracle]);
    expect(result.oracleId).toBe("o-judge");
  });
});

// ---------------------------------------------------------------------------
// runEvalSuite — injected executor, no real model
// ---------------------------------------------------------------------------

describe("runEvalSuite — injected executor", () => {
  it("produces metrics and perFixtureResults for a passing suite", async () => {
    const suite = minimalSuite();
    // Injected executor: always returns the expected output for Fixture,
    // and true for RetrievalFixture.
    const runFixture = async (f: Fixture | RetrievalFixture) => {
      if ("shouldSelect" in f) {
        // RetrievalFixture: return boolean matching shouldSelect.
        return f.shouldSelect;
      }
      return (f as Fixture).expected;
    };

    const result = await runEvalSuite(suite, runFixture);

    expect(result.metrics.sampleSize).toBe(4); // pos + neg + ret + mut = 4
    expect(result.metrics.passRate).toBe(1);
    expect(result.perFixtureResults.length).toBe(4);
    for (const r of result.perFixtureResults) {
      expect(r.outcome).toBe("pass");
    }
  });

  it("produces a failing result for a fixture that returns wrong output", async () => {
    const suite = minimalSuite();
    const runFixture = async (f: Fixture | RetrievalFixture) => {
      // Always return "wrong" for Fixture, mismatch shouldSelect for retrieval.
      if ("shouldSelect" in f) return !f.shouldSelect;
      return "wrong";
    };

    const result = await runEvalSuite(suite, runFixture);

    expect(result.metrics.passRate).toBe(0);
    for (const r of result.perFixtureResults) {
      expect(r.outcome).toBe("fail");
    }
  });

  it("records caughtAtStage on failing fixtures", async () => {
    const suite = minimalSuite();
    const runFixture = async (f: Fixture | RetrievalFixture) => {
      if ("shouldSelect" in f) return f.shouldSelect; // retrieval passes
      return "wrong";
    };

    const result = await runEvalSuite(suite, runFixture);

    const failingResults = result.perFixtureResults.filter(
      (r) => r.outcome === "fail",
    );
    for (const r of failingResults) {
      expect(r.caughtAtStage).toBeDefined();
    }
  });

  it("records retrieval failure stage as 'retrieval'", async () => {
    const suite = minimalSuite();
    const runFixture = async (f: Fixture | RetrievalFixture) => {
      if ("shouldSelect" in f) return !f.shouldSelect; // retrieval fails
      return (f as Fixture).expected; // other fixtures pass
    };

    const result = await runEvalSuite(suite, runFixture);

    const retrievalResult = result.perFixtureResults.find(
      (r) => r.fixtureId === "ret-1",
    );
    expect(retrievalResult?.outcome).toBe("fail");
    expect(retrievalResult?.caughtAtStage).toBe("retrieval");
  });

  it("throws if the suite has no independent oracle", async () => {
    const suite = minimalSuite({ oracles: [dependentOracle] });
    const runFixture = async () => "out";
    await expect(runEvalSuite(suite, runFixture)).rejects.toThrow(
      "at least one independent oracle required",
    );
  });

  it("computes metrics from mixed pass/fail results", async () => {
    // Suite with 2 positive, 1 negative, 1 retrieval, 1 mutation = 5 fixtures.
    const suite = minimalSuite({
      fixtures: {
        positive: [
          fixture("pos-1", "in", "out"),
          fixture("pos-2", "in2", "out2"),
        ],
        negative: [fixture("neg-1", "bad", null)],
        retrieval: [{ id: "ret-1", input: "q", shouldSelect: true }],
        mutation: [fixture("mut-1", "mutated", "different")],
      },
    });

    // Pass pos-1, fail pos-2, pass neg-1, pass ret-1, fail mut-1.
    const runFixture = async (f: Fixture | RetrievalFixture) => {
      if ("shouldSelect" in f) return f.shouldSelect;
      const fx = f as Fixture;
      if (fx.id === "pos-2" || fx.id === "mut-1") return "wrong";
      return fx.expected;
    };

    const result = await runEvalSuite(suite, runFixture);

    expect(result.metrics.sampleSize).toBe(5);
    // 3 pass (pos-1, neg-1, ret-1), 2 fail (pos-2, mut-1)
    expect(result.metrics.passRate).toBeCloseTo(3 / 5);
    expect(result.perFixtureResults.length).toBe(5);
  });

  it("records abstentionRate when judge-only oracles are present", async () => {
    // Suite with only a judge oracle — all fixtures will abstain.
    const suite = minimalSuite({
      oracles: [judgeIndependentOracle], // independent judge to pass assertIndependentOracle
    });

    const runFixture = async (f: Fixture | RetrievalFixture) => {
      if ("shouldSelect" in f) return (f as RetrievalFixture).shouldSelect;
      return (f as Fixture).expected;
    };

    const result = await runEvalSuite(suite, runFixture);

    // All fixtures go through gradeFixture with only a judge oracle.
    // The non-retrieval fixtures will abstain (judge-only); retrieval fixtures
    // use the judge oracle id but the logic directly passes/fails them.
    // Retrieval fixtures don't go through gradeFixture, they go through
    // runAndGradeRetrieval which directly evaluates boolean match.
    expect(result.metrics.sampleSize).toBe(4);
    // Retrieval passes (shouldSelect matches), non-retrieval fixtures abstain.
    const abstainCount = result.perFixtureResults.filter(
      (r) => r.outcome === "abstain",
    ).length;
    expect(abstainCount).toBeGreaterThan(0);
    expect(result.metrics.abstentionRate).toBeGreaterThan(0);
  });

  it("runs all four fixture kinds", async () => {
    const suite = minimalSuite();
    const visitedIds: string[] = [];

    const runFixture = async (f: Fixture | RetrievalFixture) => {
      visitedIds.push(f.id);
      if ("shouldSelect" in f) return f.shouldSelect;
      return (f as Fixture).expected;
    };

    await runEvalSuite(suite, runFixture);

    expect(visitedIds).toContain("pos-1");
    expect(visitedIds).toContain("neg-1");
    expect(visitedIds).toContain("ret-1");
    expect(visitedIds).toContain("mut-1");
  });
});

// ---------------------------------------------------------------------------
// refs.ts — contentHash and sha256HexSchema
// ---------------------------------------------------------------------------

describe("refs.ts — contentHash and sha256HexSchema", () => {
  it("contentHash produces a 64-char hex string", async () => {
    const { contentHash } = await import("../src/skill/refs.js");
    const h = contentHash("hello world");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("contentHash is deterministic for identical input", async () => {
    const { contentHash } = await import("../src/skill/refs.js");
    expect(contentHash("test")).toBe(contentHash("test"));
  });

  it("contentHash differs for different inputs", async () => {
    const { contentHash } = await import("../src/skill/refs.js");
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });

  it("sha256HexSchema accepts a valid hash", async () => {
    const { sha256HexSchema } = await import("../src/skill/refs.js");
    expect(() => sha256HexSchema.parse("a".repeat(64))).not.toThrow();
  });

  it("sha256HexSchema rejects invalid hash", async () => {
    const { sha256HexSchema } = await import("../src/skill/refs.js");
    expect(() => sha256HexSchema.parse("short")).toThrow();
    expect(() => sha256HexSchema.parse("Z".repeat(64))).toThrow(); // uppercase not allowed
  });
});
