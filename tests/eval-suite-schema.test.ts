import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  evalSuiteSchema,
  oracleSchema,
  fixtureSchema,
  retrievalFixtureSchema,
  type EvalSuite,
  type Oracle,
} from "../src/skill/eval-suite-schema.js";

// ---------------------------------------------------------------------------
// Minimal valid building blocks
// ---------------------------------------------------------------------------

const independentOracle: Oracle = {
  id: "o-independent",
  kind: "test-suite",
  independent: true,
  ref: "tests/skill-grader.sh",
};

const dependentOracle: Oracle = {
  id: "o-dependent",
  kind: "schema-validator",
  independent: false,
  ref: "schemas/output.json",
};

const judgeOracle: Oracle = {
  id: "o-judge",
  kind: "judge-model",
  independent: false,
  ref: "judge:gpt-4o",
};

const positiveFixture = { id: "pos-1", input: "hello", expected: "world" };
const negativeFixture = { id: "neg-1", input: "bad input", expected: null };
const retrievalFixture = { id: "ret-1", input: "normalize imports", shouldSelect: true };
const mutationFixture = { id: "mut-1", input: "mutated", expected: "different" };

function minimalSuite(overrides: Partial<EvalSuite> = {}): unknown {
  return {
    schemaVersion: 1,
    evalSuiteId: "suite-test-001",
    evalSuiteHash: "a".repeat(64),
    skillId: "skill-import-norm",
    taskClassId: "tc-import-norm",
    oracles: [independentOracle],
    judgeIsAdvisoryOnly: true as const,
    fixtures: {
      positive: [positiveFixture],
      negative: [negativeFixture],
      retrieval: [retrievalFixture],
      mutation: [mutationFixture],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Oracle schema
// ---------------------------------------------------------------------------

describe("oracleSchema", () => {
  it("accepts all valid oracle kinds", () => {
    const kinds: Oracle["kind"][] = [
      "test-suite",
      "schema-validator",
      "snapshot-diff",
      "static-analyzer",
      "judge-model",
    ];
    for (const kind of kinds) {
      expect(() =>
        oracleSchema.parse({ id: "o1", kind, independent: true, ref: "x" }),
      ).not.toThrow();
    }
  });

  it("rejects unknown kind", () => {
    expect(() =>
      oracleSchema.parse({ id: "o1", kind: "linter", independent: true, ref: "x" }),
    ).toThrow();
  });

  it("independent flag is a plain boolean", () => {
    const result = oracleSchema.parse({
      id: "o1",
      kind: "test-suite",
      independent: false,
      ref: "x",
    });
    expect(result.independent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fixtureSchema
// ---------------------------------------------------------------------------

describe("fixtureSchema", () => {
  it("defaults allowedNondeterminism to []", () => {
    const f = fixtureSchema.parse({ id: "f1", input: "x", expected: "y" });
    expect(f.allowedNondeterminism).toEqual([]);
  });

  it("accepts explicit allowedNondeterminism", () => {
    const f = fixtureSchema.parse({
      id: "f1",
      input: "x",
      expected: "y",
      allowedNondeterminism: ["timestamp", "uuid"],
    });
    expect(f.allowedNondeterminism).toEqual(["timestamp", "uuid"]);
  });
});

// ---------------------------------------------------------------------------
// retrievalFixtureSchema
// ---------------------------------------------------------------------------

describe("retrievalFixtureSchema", () => {
  it("accepts shouldSelect true and false", () => {
    const pos = retrievalFixtureSchema.parse({ id: "r1", input: "query", shouldSelect: true });
    const neg = retrievalFixtureSchema.parse({ id: "r2", input: "query", shouldSelect: false });
    expect(pos.shouldSelect).toBe(true);
    expect(neg.shouldSelect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evalSuiteSchema — independent oracle refine
// ---------------------------------------------------------------------------

describe("evalSuiteSchema — independent oracle rule", () => {
  it("accepts a suite with at least one independent oracle", () => {
    const suite = minimalSuite();
    expect(() => evalSuiteSchema.parse(suite)).not.toThrow();
  });

  it("rejects a suite with only non-independent oracles", () => {
    const suite = minimalSuite({ oracles: [dependentOracle] });
    expect(() => evalSuiteSchema.parse(suite)).toThrow(
      "at least one independent oracle required",
    );
  });

  it("rejects a suite with only judge-model oracles (judge is also non-independent by convention)", () => {
    // judge-model oracles are never independent in the anti-Goodhart model.
    const suite = minimalSuite({ oracles: [judgeOracle] });
    expect(() => evalSuiteSchema.parse(suite)).toThrow(
      "at least one independent oracle required",
    );
  });

  it("accepts a suite with a mix where one oracle is independent", () => {
    const suite = minimalSuite({ oracles: [dependentOracle, independentOracle, judgeOracle] });
    expect(() => evalSuiteSchema.parse(suite)).not.toThrow();
  });

  it("rejects an empty oracle array", () => {
    const suite = minimalSuite({ oracles: [] });
    expect(() => evalSuiteSchema.parse(suite)).toThrow(
      "at least one independent oracle required",
    );
  });
});

// ---------------------------------------------------------------------------
// evalSuiteSchema — judgeIsAdvisoryOnly must be literal true
// ---------------------------------------------------------------------------

describe("evalSuiteSchema — judgeIsAdvisoryOnly invariant", () => {
  it("accepts judgeIsAdvisoryOnly: true", () => {
    const suite = minimalSuite();
    const parsed = evalSuiteSchema.parse(suite);
    expect(parsed.judgeIsAdvisoryOnly).toBe(true);
  });

  it("rejects judgeIsAdvisoryOnly: false (z.literal(true) enforcement)", () => {
    // z.literal(true) means false is not a valid value.
    const suite = minimalSuite({ judgeIsAdvisoryOnly: false as unknown as true });
    expect(() => evalSuiteSchema.parse(suite)).toThrow();
  });

  it("rejects missing judgeIsAdvisoryOnly", () => {
    const raw = minimalSuite() as Record<string, unknown>;
    delete raw["judgeIsAdvisoryOnly"];
    expect(() => evalSuiteSchema.parse(raw)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// evalSuiteSchema — four fixture kinds each require min(1)
// ---------------------------------------------------------------------------

describe("evalSuiteSchema — fixture kinds all required min(1)", () => {
  const fixtureKinds = ["positive", "negative", "retrieval", "mutation"] as const;

  for (const kind of fixtureKinds) {
    it(`rejects suite with empty ${kind} fixtures`, () => {
      const base = minimalSuite() as Record<string, unknown>;
      base["fixtures"] = {
        ...(base["fixtures"] as object),
        [kind]: [],
      };
      expect(() => evalSuiteSchema.parse(base)).toThrow();
    });

    it(`rejects suite with missing ${kind} fixtures`, () => {
      const base = minimalSuite() as Record<string, unknown>;
      const fixtures = { ...(base["fixtures"] as Record<string, unknown>) };
      delete fixtures[kind];
      base["fixtures"] = fixtures;
      expect(() => evalSuiteSchema.parse(base)).toThrow();
    });
  }

  it("accepts a suite with exactly one fixture of each kind", () => {
    const suite = minimalSuite();
    const parsed = evalSuiteSchema.parse(suite);
    expect(parsed.fixtures.positive.length).toBe(1);
    expect(parsed.fixtures.negative.length).toBe(1);
    expect(parsed.fixtures.retrieval.length).toBe(1);
    expect(parsed.fixtures.mutation.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// evalSuiteHash must be a 64-char hex string
// ---------------------------------------------------------------------------

describe("evalSuiteSchema — evalSuiteHash validation", () => {
  it("rejects a non-hex hash", () => {
    const suite = minimalSuite({ evalSuiteHash: "not-a-hash" });
    expect(() => evalSuiteSchema.parse(suite)).toThrow();
  });

  it("rejects a too-short hash", () => {
    const suite = minimalSuite({ evalSuiteHash: "abc123" });
    expect(() => evalSuiteSchema.parse(suite)).toThrow();
  });

  it("accepts a valid 64-char hex hash", () => {
    const suite = minimalSuite({ evalSuiteHash: "f".repeat(64) });
    expect(() => evalSuiteSchema.parse(suite)).not.toThrow();
  });
});
