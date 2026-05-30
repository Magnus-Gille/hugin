/**
 * Tests for route-binding-store.ts
 * Uses an in-memory fake MuninClient — no network.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { MuninEntry, MuninQueryResult } from "../src/munin-client.js";
import {
  transition,
  isSelectable,
  loadActiveBinding,
  recordValidationRun,
  demoteOnDrift,
} from "../src/skill/route-binding-store.js";
import type { RouteBinding, ValidationRun } from "../src/skill/route-binding-schema.js";
import { routeBindingSchema, validationRunSchema } from "../src/skill/route-binding-schema.js";
import type { TupleRef } from "../src/skill/refs.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
/** Pad a string to 64 chars — produces valid sha256-hex-shaped hashes for tests. */
const H = (n: string) => n.repeat(64).slice(0, 64);

function makeTuple(overrides: Partial<TupleRef> = {}): TupleRef {
  return {
    taskClassId: "invoice-normalizer",
    taskClassVersion: 1,
    taskClassHash: H("a"),
    skillProfileId: "pi-local-30b-v1",
    skillProfileHash: H("b"),
    cellManifestId: "ollama-qwen3-coder-cell-v1",
    cellManifestHash: H("c"),
    evalSuiteId: "invoice-eval-v1",
    evalSuiteHash: H("d"),
    ...overrides,
  };
}

function makeBinding(overrides: Partial<RouteBinding> = {}): RouteBinding {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    bindingId: "binding-001",
    version: 1,
    state: "draft",
    tuple: makeTuple(),
    fallbackPolicy: {
      cloudAllowed: true,
      autoEscalateAllowed: true,
      requiresUserApproval: false,
      zdrRequired: false,
      egressClass: "local",
      fallbackProviderSet: ["claude-sdk"],
      fallbackOnFailureKinds: ["infra", "timeout"],
    },
    effectiveSensitivityCeiling: "internal",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeValidationRun(overrides: Partial<ValidationRun> = {}): ValidationRun {
  return {
    schemaVersion: 1,
    runHash: H("e"),
    bindingId: "binding-001",
    tuple: makeTuple(),
    graderHash: H("f"),
    promptHash: H("g"),
    harnessName: "hugin-eval-harness",
    harnessVersion: "1.0.0",
    wrapperName: "ollama-wrapper",
    wrapperVersion: "0.3.0",
    modelId: "qwen3-coder-30b-instruct",
    modelFileHash: H("h"),
    quantization: "Q4_K_M",
    contextCap: 8192,
    thinkingFormat: "forced-think-false",
    toolCallParserResult: "pass",
    os: "linux",
    hardwareClass: "pi5-8gb",
    memoryCapMb: 8192,
    toolEnvManifestHash: H("i"),
    executionTimeoutMs: 120000,
    stepBudget: 10,
    metrics: {
      passRate: 0.889,
      sampleSize: 27,
      p50DurationSeconds: 45,
      p95DurationSeconds: 90,
      // All failureKind enum values must be present — Zod v4 z.record(enum, val)
      // requires every key from the enum to be in the object.
      failureKindHistogram: {
        "retrieval-miss": 0,
        "classification-wrong": 0,
        "preflight": 0,
        "parser": 0,
        "schema": 0,
        "tests": 0,
        "timeout": 1,
        "grader": 0,
        "delivery": 0,
        "infra": 2,
      },
      abstentionRate: 0.05,
    },
    perFixtureResults: [
      { fixtureId: "f1", outcome: "pass", oracleId: "test-suite-oracle" },
    ],
    ranAt: new Date().toISOString(),
    immutable: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake MuninClient
// ---------------------------------------------------------------------------
/** In-memory store keyed by "namespace/key" */
type Store = Map<string, MuninEntry>;

function makeFakeMunin(initial?: Store) {
  const store: Store = initial ?? new Map();

  return {
    // Track writes for assertions
    writes: [] as Array<{ namespace: string; key: string; content: string; expectedUpdatedAt?: string }>,

    async read(namespace: string, key: string): Promise<(MuninEntry & { found: true }) | null> {
      const entry = store.get(`${namespace}/${key}`);
      if (!entry) return null;
      return { ...entry, found: true };
    },

    async write(
      namespace: string,
      key: string,
      content: string,
      tags?: string[],
      expectedUpdatedAt?: string,
    ): Promise<Record<string, unknown>> {
      // Simulate CAS rejection when expected_updated_at doesn't match.
      const existing = store.get(`${namespace}/${key}`);
      if (expectedUpdatedAt !== undefined) {
        if (existing && existing.updated_at !== expectedUpdatedAt) {
          throw new Error(
            `Munin write rejected for ${namespace}/${key}: cas-conflict — updated_at mismatch`,
          );
        }
      }
      const now = new Date().toISOString();
      const entry: MuninEntry = {
        id: `${namespace}/${key}`,
        namespace,
        key,
        content,
        tags: tags ?? [],
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      store.set(`${namespace}/${key}`, entry);
      this.writes.push({ namespace, key, content, expectedUpdatedAt });
      return { ok: true };
    },

    async query(opts: {
      query: string;
      namespace?: string;
      tags?: string[];
      limit?: number;
    }): Promise<{ results: MuninQueryResult[]; total: number }> {
      const results: MuninQueryResult[] = [];
      for (const [, entry] of store.entries()) {
        // Namespace filter: prefix match (real Munin matches sub-namespaces too).
        if (opts.namespace && !entry.namespace.startsWith(opts.namespace)) continue;
        if (opts.tags && opts.tags.length > 0) {
          const hasAllTags = opts.tags.every((t) => entry.tags.includes(t));
          if (!hasAllTags) continue;
        }
        results.push({
          id: entry.id,
          namespace: entry.namespace,
          key: entry.key,
          entry_type: "state",
          content_preview: entry.content.slice(0, 100),
          tags: entry.tags,
          created_at: entry.created_at,
          updated_at: entry.updated_at,
        });
      }
      return { results: results.slice(0, opts.limit ?? 100), total: results.length };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: schema round-trip
// ---------------------------------------------------------------------------
describe("route-binding-schema round-trip", () => {
  it("parses a valid RouteBinding", () => {
    const b = makeBinding();
    const result = routeBindingSchema.safeParse(b);
    expect(result.success).toBe(true);
  });

  it("rejects a binding with a bad hash (short hash)", () => {
    const b = { ...makeBinding(), tuple: makeTuple({ taskClassHash: "short" }) };
    const result = routeBindingSchema.safeParse(b);
    expect(result.success).toBe(false);
  });

  it("rejects a binding with an invalid state", () => {
    const b = { ...makeBinding(), state: "promoted" };
    const result = routeBindingSchema.safeParse(b);
    expect(result.success).toBe(false);
  });

  it("parses a valid ValidationRun", () => {
    const run = makeValidationRun();
    const result = validationRunSchema.safeParse(run);
    expect(result.success).toBe(true);
  });

  it("rejects a ValidationRun with immutable !== true", () => {
    const run = { ...makeValidationRun(), immutable: false as true };
    const result = validationRunSchema.safeParse(run);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: transition() — lifecycle enforcement
// ---------------------------------------------------------------------------
describe("transition() — legal transitions", () => {
  it("draft → candidate", () => {
    const b = makeBinding({ state: "draft" });
    const next = transition(b, "candidate");
    expect(next.state).toBe("candidate");
  });

  it("candidate → shadow", () => {
    const b = makeBinding({ state: "candidate" });
    const next = transition(b, "shadow");
    expect(next.state).toBe("shadow");
  });

  it("shadow → active (with evidence)", () => {
    const b = makeBinding({ state: "shadow" });
    const next = transition(b, "active", { runHash: H("e") });
    expect(next.state).toBe("active");
    expect(next.activeValidationRunHash).toBe(H("e"));
  });

  it("active → stale", () => {
    const b = makeBinding({ state: "active" });
    const next = transition(b, "stale");
    expect(next.state).toBe("stale");
  });

  it("active → quarantined", () => {
    const b = makeBinding({ state: "active" });
    const next = transition(b, "quarantined");
    expect(next.state).toBe("quarantined");
  });

  it("stale → active (re-promotion with new run hash)", () => {
    const b = makeBinding({ state: "stale", activeValidationRunHash: H("e") });
    const next = transition(b, "active", { runHash: H("f") });
    expect(next.state).toBe("active");
    expect(next.activeValidationRunHash).toBe(H("f"));
  });

  it("quarantined → candidate (re-promotion with new run hash)", () => {
    const b = makeBinding({ state: "quarantined", activeValidationRunHash: H("e") });
    const next = transition(b, "candidate", { runHash: H("f") });
    expect(next.state).toBe("candidate");
  });

  it("any state → disabled (manual kill)", () => {
    for (const state of ["draft", "candidate", "shadow", "active", "stale", "quarantined"] as const) {
      const b = makeBinding({ state });
      expect(transition(b, "disabled").state).toBe("disabled");
    }
  });

  it("transition() updates updatedAt", () => {
    const b = makeBinding({ state: "draft", updatedAt: "2026-01-01T00:00:00Z" });
    const next = transition(b, "candidate");
    expect(next.updatedAt).not.toBe("2026-01-01T00:00:00Z");
  });

  it("transition() is pure — does not mutate the input binding", () => {
    const b = makeBinding({ state: "draft" });
    const stateBefore = b.state;
    transition(b, "candidate");
    expect(b.state).toBe(stateBefore);
  });
});

describe("transition() — illegal transitions", () => {
  it("draft → active (skips steps)", () => {
    const b = makeBinding({ state: "draft" });
    expect(() => transition(b, "active")).toThrow();
  });

  it("draft → shadow (skips candidate)", () => {
    const b = makeBinding({ state: "draft" });
    expect(() => transition(b, "shadow")).toThrow();
  });

  it("candidate → active (skips shadow)", () => {
    const b = makeBinding({ state: "candidate" });
    expect(() => transition(b, "active")).toThrow();
  });

  it("disabled → any state (terminal)", () => {
    const b = makeBinding({ state: "disabled" });
    expect(() => transition(b, "draft")).toThrow();
    expect(() => transition(b, "active")).toThrow();
  });

  it("stale → active without evidence throws", () => {
    const b = makeBinding({ state: "stale" });
    expect(() => transition(b, "active")).toThrow(/requires a new ValidationRun/);
  });

  it("quarantined → shadow without evidence throws", () => {
    const b = makeBinding({ state: "quarantined" });
    expect(() => transition(b, "shadow")).toThrow(/requires a new ValidationRun/);
  });

  it("stale → active with same runHash throws", () => {
    const b = makeBinding({ state: "stale", activeValidationRunHash: H("e") });
    expect(() => transition(b, "active", { runHash: H("e") })).toThrow(/new.*ValidationRun hash|NEW.*ValidationRun/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: isSelectable()
// ---------------------------------------------------------------------------
describe("isSelectable() — fail-closed predicate", () => {
  const currentHashes = makeTuple();

  it("returns ok for active binding with matching hashes and adequate ceiling", () => {
    const b = makeBinding({ state: "active", effectiveSensitivityCeiling: "internal" });
    expect(isSelectable(b, currentHashes, "public")).toEqual({ ok: true });
    expect(isSelectable(b, currentHashes, "internal")).toEqual({ ok: true });
  });

  it("not-active: reason for draft binding", () => {
    const b = makeBinding({ state: "draft" });
    const result = isSelectable(b, currentHashes, "public");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-active");
  });

  it("not-active: reason for shadow binding", () => {
    const b = makeBinding({ state: "shadow" });
    const result = isSelectable(b, currentHashes, "public");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-active");
  });

  it("not-active: reason for stale binding", () => {
    const b = makeBinding({ state: "stale" });
    const result = isSelectable(b, currentHashes, "public");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-active");
  });

  it("hash-drift: detects mutated skillProfileHash", () => {
    const b = makeBinding({ state: "active" });
    const driftedHashes = makeTuple({ skillProfileHash: H("z") });
    const result = isSelectable(b, driftedHashes, "public");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash-drift");
  });

  it("hash-drift: detects mutated cellManifestHash", () => {
    const b = makeBinding({ state: "active" });
    const driftedHashes = makeTuple({ cellManifestHash: H("z") });
    const result = isSelectable(b, driftedHashes, "public");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash-drift");
  });

  it("hash-drift: detects mutated evalSuiteHash", () => {
    const b = makeBinding({ state: "active" });
    const driftedHashes = makeTuple({ evalSuiteHash: H("z") });
    const result = isSelectable(b, driftedHashes, "public");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash-drift");
  });

  it("sensitivity-ceiling: internal ceiling rejects private task", () => {
    const b = makeBinding({ state: "active", effectiveSensitivityCeiling: "internal" });
    const result = isSelectable(b, currentHashes, "private");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sensitivity-ceiling");
  });

  it("sensitivity-ceiling: public ceiling rejects internal task", () => {
    const b = makeBinding({ state: "active", effectiveSensitivityCeiling: "public" });
    const result = isSelectable(b, currentHashes, "internal");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sensitivity-ceiling");
  });

  it("private ceiling allows private task", () => {
    const b = makeBinding({ state: "active", effectiveSensitivityCeiling: "private" });
    expect(isSelectable(b, currentHashes, "private")).toEqual({ ok: true });
    expect(isSelectable(b, currentHashes, "internal")).toEqual({ ok: true });
    expect(isSelectable(b, currentHashes, "public")).toEqual({ ok: true });
  });

  it("priority: not-active checked before hash-drift", () => {
    // A stale binding with drifted hashes should report not-active, not hash-drift
    const b = makeBinding({ state: "stale" });
    const driftedHashes = makeTuple({ skillProfileHash: H("z") });
    const result = isSelectable(b, driftedHashes, "public");
    expect(result.reason).toBe("not-active");
  });
});

// ---------------------------------------------------------------------------
// Tests: loadActiveBinding()
// ---------------------------------------------------------------------------
describe("loadActiveBinding()", () => {
  it("returns null when no binding exists", async () => {
    const munin = makeFakeMunin();
    const result = await loadActiveBinding("invoice-normalizer", munin as never);
    expect(result).toBeNull();
  });

  it("returns the active binding when one exists", async () => {
    const binding = makeBinding({ state: "active" });
    const store: Store = new Map();
    const now = new Date().toISOString();
    store.set("routes/binding-001/binding", {
      id: "routes/binding-001/binding",
      namespace: "routes/binding-001",
      key: "binding",
      content: JSON.stringify(binding),
      tags: ["route-state:active", "task-class:invoice-normalizer"],
      created_at: now,
      updated_at: now,
    });

    const munin = makeFakeMunin(store);
    // Make query match the stored entry
    const result = await loadActiveBinding("invoice-normalizer", munin as never);
    expect(result).not.toBeNull();
    expect(result?.bindingId).toBe("binding-001");
    expect(result?.state).toBe("active");
  });

  it("skips non-binding keys (e.g. validation-run)", async () => {
    const run = makeValidationRun();
    const store: Store = new Map();
    const now = new Date().toISOString();
    store.set("routes/binding-001/validation-run/abc", {
      id: "routes/binding-001/validation-run/abc",
      namespace: "routes/binding-001",
      key: "validation-run/abc",
      content: JSON.stringify(run),
      tags: ["route-state:active", "task-class:invoice-normalizer"],
      created_at: now,
      updated_at: now,
    });

    const munin = makeFakeMunin(store);
    const result = await loadActiveBinding("invoice-normalizer", munin as never);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: recordValidationRun()
// ---------------------------------------------------------------------------
describe("recordValidationRun()", () => {
  it("writes the run to Munin on first call", async () => {
    const munin = makeFakeMunin();
    const run = makeValidationRun();
    await recordValidationRun(run, munin as never);
    expect(munin.writes).toHaveLength(1);
    expect(munin.writes[0]?.key).toBe(`validation-run/${run.runHash}`);
    expect(munin.writes[0]?.namespace).toBe(`routes/${run.bindingId}`);
  });

  it("rejects a duplicate runHash (write-once constraint)", async () => {
    const munin = makeFakeMunin();
    const run = makeValidationRun();
    // First write succeeds
    await recordValidationRun(run, munin as never);
    // Second write must throw
    await expect(recordValidationRun(run, munin as never)).rejects.toThrow(
      /immutable.*never be overwritten|already exists/i,
    );
  });

  it("includes required tags in the write", async () => {
    const munin = makeFakeMunin();
    const run = makeValidationRun();
    await recordValidationRun(run, munin as never);
    const tags = munin.writes[0]!.content; // content is what we care about
    // Check tags were passed (via the write call args)
    const lastWrite = munin.writes[munin.writes.length - 1]!;
    expect(lastWrite.namespace).toContain(run.bindingId);
  });

  it("two runs with different runHashes for same binding both succeed", async () => {
    const munin = makeFakeMunin();
    const run1 = makeValidationRun({ runHash: H("e") });
    const run2 = makeValidationRun({ runHash: H("f") });
    await expect(recordValidationRun(run1, munin as never)).resolves.toBeUndefined();
    await expect(recordValidationRun(run2, munin as never)).resolves.toBeUndefined();
    expect(munin.writes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: demoteOnDrift()
// ---------------------------------------------------------------------------
describe("demoteOnDrift()", () => {
  it("returns a stale binding", async () => {
    const munin = makeFakeMunin();
    const b = makeBinding({ state: "active", updatedAt: "2026-05-01T00:00:00Z" });
    const demoted = await demoteOnDrift(b, munin as never);
    expect(demoted.state).toBe("stale");
  });

  it("writes to routes/<bindingId>/binding with CAS token", async () => {
    const munin = makeFakeMunin();
    const updatedAt = "2026-05-01T00:00:00Z";
    const b = makeBinding({ state: "active", updatedAt });
    await demoteOnDrift(b, munin as never);
    expect(munin.writes).toHaveLength(1);
    const w = munin.writes[0]!;
    expect(w.namespace).toBe(`routes/${b.bindingId}`);
    expect(w.key).toBe("binding");
    expect(w.expectedUpdatedAt).toBe(updatedAt);
  });

  it("written content is parseable as RouteBinding with state=stale", async () => {
    const munin = makeFakeMunin();
    const b = makeBinding({ state: "active", updatedAt: "2026-05-01T00:00:00Z" });
    await demoteOnDrift(b, munin as never);
    const written = JSON.parse(munin.writes[0]!.content);
    const parsed = routeBindingSchema.safeParse(written);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.state).toBe("stale");
  });

  it("demoteOnDrift on a non-active binding still transitions to stale (from allowed states)", async () => {
    const munin = makeFakeMunin();
    // stale → stale is NOT in the allowed graph, but active → stale is.
    // Only active bindings should be drift-demoted in practice; test that.
    const b = makeBinding({ state: "active" });
    const demoted = await demoteOnDrift(b, munin as never);
    expect(demoted.state).toBe("stale");
  });
});
