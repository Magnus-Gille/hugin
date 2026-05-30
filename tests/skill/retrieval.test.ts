/**
 * Tests for src/skill/retrieval.ts — fail-closed abstention contract.
 *
 * All Munin interactions use a fake client; no network calls.
 *
 * Covered branches:
 *   1. munin-down — health() returns false
 *   2. munin-down — health() throws
 *   3. munin-down — query() throws (after health passes)
 *   4. below-threshold — no candidates after hard-negative filtering
 *   5. below-threshold — top score < confidenceThreshold
 *   6. ambiguous-top-two — top1 − top2 < topTwoMarginThreshold
 *   7. hard-negative excluded — a row that would otherwise win is dropped
 *      because its hardNegatives contains the promptDigest; a different
 *      row without a hard-negative match is returned instead
 *   8. not-selectable — bindingState is "stale" (not "active")
 *   9. selected — clean happy path
 *  10. schema round-trip — ProceduralRetrievalRowSchema parse + serialise
 */

import { describe, it, expect } from "vitest";
import { retrieveProcedure } from "../../src/skill/retrieval.js";
import type { RetrievalConfig } from "../../src/skill/retrieval.js";
import {
  proceduralRetrievalRowSchema,
  type ProceduralRetrievalRow,
} from "../../src/skill/retrieval-schema.js";
import type { MuninQueryResult } from "../../src/munin-client.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROFILE_HASH = "a".repeat(64);
const BINDING_ID = "binding-001";
const TASK_CLASS_ID = "fix-imports";

/** A minimal valid ProceduralRetrievalRow. */
const BASE_ROW: ProceduralRetrievalRow = {
  schemaVersion: 1,
  skillId: "import-normaliser",
  profileId: "pi-local-30b-v1",
  profileHash: PROFILE_HASH,
  taskClassId: TASK_CLASS_ID,
  triggerPhrases: ["normalise imports", "fix imports", "sort imports"],
  requiredInputs: ["filePath"],
  requiredTools: ["Bash"],
  contraindications: [],
  hardNegatives: ["unrelated-digest-xyz"],
  egressClass: "local",
  expectedArtifacts: ["patch"],
  evalConfidence: 0.9,
  knownFailureModes: [],
  bindingId: BINDING_ID,
  bindingState: "active",
};

const DEFAULT_CFG: RetrievalConfig = {
  confidenceThreshold: 0.5,
  topTwoMarginThreshold: 0.1,
};

const TASK = {
  promptDigest: "normalise imports in src/index.ts",
  taskClassId: TASK_CLASS_ID,
  sensitivity: "internal" as const,
};

/** Build a MuninQueryResult whose content_preview is the serialised row. */
function makeQueryResult(
  row: ProceduralRetrievalRow,
  muninScore?: number,
): MuninQueryResult & { score?: number } {
  return {
    id: `skills/${row.skillId}`,
    namespace: "skills",
    key: `${row.skillId}/retrieval`,
    entry_type: "memory",
    content_preview: JSON.stringify(row),
    tags: [
      "procedural-retrieval",
      `skill:${row.skillId}`,
      `task-class:${row.taskClassId}`,
      `route-state:${row.bindingState}`,
    ],
    created_at: "2026-05-29T10:00:00Z",
    updated_at: "2026-05-29T10:00:00Z",
    ...(muninScore !== undefined ? { score: muninScore } : {}),
  };
}

/** Build a fake MuninClient. */
function makeMunin(opts: {
  healthy?: boolean;
  healthThrows?: boolean;
  queryThrows?: boolean;
  results?: MuninQueryResult[];
}) {
  return {
    async health(): Promise<boolean> {
      if (opts.healthThrows) throw new Error("connection refused");
      return opts.healthy ?? true;
    },
    async query(_args: unknown): Promise<{ results: MuninQueryResult[]; total: number }> {
      if (opts.queryThrows) throw new Error("query failed");
      return { results: opts.results ?? [], total: opts.results?.length ?? 0 };
    },
  } as unknown as import("../../src/munin-client.js").MuninClient;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("retrieveProcedure", () => {
  // ── 1. munin-down: health returns false ─────────────────────────────────────
  it("returns munin-down when health() returns false", async () => {
    const outcome = await retrieveProcedure(
      TASK,
      makeMunin({ healthy: false }),
      DEFAULT_CFG,
    );
    expect(outcome).toEqual({ kind: "unavailable", reason: "munin-down" });
  });

  // ── 2. munin-down: health() throws ──────────────────────────────────────────
  it("returns munin-down when health() throws", async () => {
    const outcome = await retrieveProcedure(
      TASK,
      makeMunin({ healthThrows: true }),
      DEFAULT_CFG,
    );
    expect(outcome).toEqual({ kind: "unavailable", reason: "munin-down" });
  });

  // ── 3. munin-down: query() throws ───────────────────────────────────────────
  it("returns munin-down when query() throws after health passes", async () => {
    const outcome = await retrieveProcedure(
      TASK,
      makeMunin({ healthy: true, queryThrows: true }),
      DEFAULT_CFG,
    );
    expect(outcome).toEqual({ kind: "unavailable", reason: "munin-down" });
  });

  // ── 4. below-threshold: empty candidate set ──────────────────────────────────
  it("returns below-threshold when Munin returns no results", async () => {
    const outcome = await retrieveProcedure(
      TASK,
      makeMunin({ results: [] }),
      DEFAULT_CFG,
    );
    expect(outcome).toEqual({ kind: "abstain", reason: "below-threshold" });
  });

  // ── 5. below-threshold: score < confidenceThreshold ─────────────────────────
  it("returns below-threshold when top score is below confidenceThreshold", async () => {
    // Use a promptDigest that does not match any triggerPhrases → score = 0
    const task = { ...TASK, promptDigest: "completely unrelated task description" };
    const outcome = await retrieveProcedure(
      task,
      makeMunin({ results: [makeQueryResult(BASE_ROW)] }),
      { confidenceThreshold: 0.5, topTwoMarginThreshold: 0.1 },
    );
    expect(outcome).toEqual({ kind: "abstain", reason: "below-threshold" });
  });

  // ── 6. ambiguous-top-two ─────────────────────────────────────────────────────
  it("returns ambiguous-top-two when top1 and top2 are within margin", async () => {
    // Give both rows explicit scores that are close together.
    const result1 = makeQueryResult(BASE_ROW, 0.8);
    const row2: ProceduralRetrievalRow = {
      ...BASE_ROW,
      skillId: "import-normaliser-v2",
      profileId: "pi-local-30b-v2",
      profileHash: "b".repeat(64),
    };
    const result2 = makeQueryResult(row2, 0.75); // gap = 0.05 < threshold 0.1

    const outcome = await retrieveProcedure(
      TASK,
      makeMunin({ results: [result1, result2] }),
      { confidenceThreshold: 0.5, topTwoMarginThreshold: 0.1 },
    );
    expect(outcome).toEqual({ kind: "abstain", reason: "ambiguous-top-two" });
  });

  // ── 7. hard-negative excluded ────────────────────────────────────────────────
  it("excludes the row that matches a hardNegative; the other row wins", async () => {
    // row1 has the incoming promptDigest in its hardNegatives → must be dropped.
    const row1: ProceduralRetrievalRow = {
      ...BASE_ROW,
      skillId: "import-normaliser-lookalike",
      hardNegatives: [TASK.promptDigest], // exact match → excluded
    };
    // row2 is the legitimate match (does NOT have the digest in hardNegatives).
    const row2: ProceduralRetrievalRow = {
      ...BASE_ROW,
      skillId: "import-normaliser",
    };

    // Give row1 a higher Munin score so it would win without hard-negative exclusion.
    const result1 = makeQueryResult(row1, 0.95);
    const result2 = makeQueryResult(row2, 0.8);

    const outcome = await retrieveProcedure(
      TASK,
      makeMunin({ results: [result1, result2] }),
      { confidenceThreshold: 0.5, topTwoMarginThreshold: 0.1 },
    );

    // row1 must be excluded; row2 is the only remaining candidate.
    expect(outcome.kind).toBe("selected");
    if (outcome.kind === "selected") {
      expect(outcome.row.skillId).toBe("import-normaliser");
    }
  });

  // ── 8. not-selectable: stale bindingState ────────────────────────────────────
  it("returns not-selectable when bindingState is stale", async () => {
    const staleRow: ProceduralRetrievalRow = {
      ...BASE_ROW,
      bindingState: "stale",
    };
    const outcome = await retrieveProcedure(
      TASK,
      makeMunin({ results: [makeQueryResult(staleRow, 0.9)] }),
      DEFAULT_CFG,
    );
    expect(outcome).toEqual({ kind: "not-selectable", reason: "stale-or-quarantined" });
  });

  // Confirm other non-active states also trigger not-selectable.
  it("returns not-selectable when bindingState is quarantined", async () => {
    const quarantinedRow: ProceduralRetrievalRow = {
      ...BASE_ROW,
      bindingState: "quarantined",
    };
    const outcome = await retrieveProcedure(
      TASK,
      makeMunin({ results: [makeQueryResult(quarantinedRow, 0.9)] }),
      DEFAULT_CFG,
    );
    expect(outcome).toEqual({ kind: "not-selectable", reason: "stale-or-quarantined" });
  });

  // ── 9. selected: clean happy path ────────────────────────────────────────────
  it("returns selected with row and score on the happy path", async () => {
    const outcome = await retrieveProcedure(
      TASK,
      makeMunin({ results: [makeQueryResult(BASE_ROW, 0.9)] }),
      DEFAULT_CFG,
    );
    expect(outcome.kind).toBe("selected");
    if (outcome.kind === "selected") {
      expect(outcome.row.skillId).toBe("import-normaliser");
      expect(outcome.score).toBeCloseTo(0.9);
    }
  });

  // ── trigger-phrase fallback scoring (no Munin score) ─────────────────────────
  it("falls back to trigger-phrase score when Munin score is absent", async () => {
    // TASK.promptDigest = "normalise imports in src/index.ts"
    // BASE_ROW.triggerPhrases = ["normalise imports", "fix imports", "sort imports"]
    // "normalise imports" matches → score = 1/3 ≈ 0.333
    const outcome = await retrieveProcedure(
      TASK,
      // No muninScore passed — content_preview only
      makeMunin({ results: [makeQueryResult(BASE_ROW)] }),
      { confidenceThreshold: 0.3, topTwoMarginThreshold: 0.0 },
    );
    // 1/3 ≈ 0.333 > 0.3 → selected
    expect(outcome.kind).toBe("selected");
  });
});

// ── Schema round-trip ─────────────────────────────────────────────────────────
describe("proceduralRetrievalRowSchema round-trip", () => {
  it("parses a valid row and re-serialises to the same shape", () => {
    const parsed = proceduralRetrievalRowSchema.parse(BASE_ROW);
    expect(parsed).toEqual(BASE_ROW);
  });

  it("rejects a row with empty triggerPhrases", () => {
    const bad = { ...BASE_ROW, triggerPhrases: [] };
    const result = proceduralRetrievalRowSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a row with empty hardNegatives", () => {
    const bad = { ...BASE_ROW, hardNegatives: [] };
    const result = proceduralRetrievalRowSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid profileHash (not 64 hex chars)", () => {
    const bad = { ...BASE_ROW, profileHash: "tooshort" };
    const result = proceduralRetrievalRowSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an evalConfidence outside [0, 1]", () => {
    const bad = { ...BASE_ROW, evalConfidence: 1.5 };
    const result = proceduralRetrievalRowSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown bindingState", () => {
    const bad = { ...BASE_ROW, bindingState: "promoted" };
    const result = proceduralRetrievalRowSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts all valid lifecycleState values", () => {
    for (const state of ["draft", "candidate", "shadow", "active", "stale", "quarantined", "disabled"] as const) {
      const row = { ...BASE_ROW, bindingState: state };
      const result = proceduralRetrievalRowSchema.safeParse(row);
      expect(result.success).toBe(true);
    }
  });
});
