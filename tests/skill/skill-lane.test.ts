import { describe, it, expect } from "vitest";
import {
  selectSkillRoute,
  type SkillLaneConfig,
  type SkillLaneDeps,
} from "../../src/skill/skill-lane.js";
import type { MuninClient } from "../../src/munin-client.js";
import type { RouteBinding } from "../../src/skill/route-binding-schema.js";
import type { TupleRef } from "../../src/skill/refs.js";

const H = (c: string) => c.repeat(64).slice(0, 64);

const TUPLE: TupleRef = {
  taskClassId: "fmt",
  taskClassVersion: 1,
  taskClassHash: H("a"),
  skillProfileId: "p",
  skillProfileHash: H("b"),
  cellManifestId: "m",
  cellManifestHash: H("c"),
  evalSuiteId: "e",
  evalSuiteHash: H("d"),
};

const BINDING: RouteBinding = {
  schemaVersion: 1,
  bindingId: "fmt-binding",
  version: 3,
  state: "active",
  tuple: TUPLE,
  fallbackPolicy: {
    cloudAllowed: true,
    autoEscalateAllowed: true,
    requiresUserApproval: false,
    zdrRequired: false,
    egressClass: "local",
    fallbackProviderSet: [],
    fallbackOnFailureKinds: [],
  },
  effectiveSensitivityCeiling: "private",
  createdAt: "t0",
  updatedAt: "t1",
};

const munin = {} as MuninClient;
const cfg: SkillLaneConfig = {
  enabled: true,
  retrieval: { confidenceThreshold: 0.5, topTwoMarginThreshold: 0.1 },
};

// Dependency stubs for the happy path; each test overrides what it needs.
function happyDeps(): Partial<SkillLaneDeps> {
  return {
    loadActiveClassifiers: async () => [{} as never],
    classifyTask: () => ({ kind: "classified", classId: "fmt", confidence: 0.9 }),
    retrieveProcedure: async () => ({
      kind: "selected",
      row: {} as never,
      score: 0.9,
    }),
    loadActiveBinding: async () => BINDING,
    recomputeTupleHashes: async () => TUPLE, // matches → no drift
  };
}

describe("selectSkillRoute (#84 fail-closed orchestrator)", () => {
  it("selects when classify+retrieve+binding+selectability all pass", async () => {
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "internal" },
      munin,
      cfg,
      happyDeps(),
    );
    expect(r.kind).toBe("selected");
    expect(r.skillRoute.abstained).toBe(false);
    expect(r.skillRoute.bindingId).toBe("fmt-binding");
    expect(r.skillRoute.classId).toBe("fmt");
  });

  it("falls through when the lane is disabled", async () => {
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "internal" },
      munin,
      { ...cfg, enabled: false },
      happyDeps(),
    );
    expect(r.kind).toBe("fallthrough");
    expect(r.skillRoute.abstainReason).toBe("lane-disabled");
  });

  it("fails closed on a Munin error loading classifiers", async () => {
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "internal" },
      munin,
      cfg,
      { ...happyDeps(), loadActiveClassifiers: async () => { throw new Error("down"); } },
    );
    expect(r.kind).toBe("fallthrough");
    expect(r.skillRoute.abstainReason).toBe("munin-error");
  });

  it("falls through when no classifiers are active", async () => {
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "internal" },
      munin,
      cfg,
      { ...happyDeps(), loadActiveClassifiers: async () => [] },
    );
    expect(r.skillRoute.abstainReason).toBe("no-classifiers");
  });

  it("falls through on classifier abstain", async () => {
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "internal" },
      munin,
      cfg,
      { ...happyDeps(), classifyTask: () => ({ kind: "abstain", reason: "ambiguous-top-two" }) },
    );
    expect(r.skillRoute.abstainReason).toBe("classify:ambiguous-top-two");
  });

  it("falls through on retrieval abstain (records class)", async () => {
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "internal" },
      munin,
      cfg,
      { ...happyDeps(), retrieveProcedure: async () => ({ kind: "abstain", reason: "below-threshold" }) },
    );
    expect(r.skillRoute.abstainReason).toBe("retrieve:below-threshold");
    expect(r.skillRoute.classId).toBe("fmt");
  });

  it("fails closed when Munin is unavailable during retrieval", async () => {
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "internal" },
      munin,
      cfg,
      { ...happyDeps(), retrieveProcedure: async () => ({ kind: "unavailable", reason: "munin-down" }) },
    );
    expect(r.skillRoute.abstainReason).toBe("retrieve:munin-down");
  });

  it("falls through when no active binding exists", async () => {
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "internal" },
      munin,
      cfg,
      { ...happyDeps(), loadActiveBinding: async () => null },
    );
    expect(r.skillRoute.abstainReason).toBe("no-active-binding");
  });

  it("fails closed when drift cannot be verified (default recompute returns null)", async () => {
    const deps = happyDeps();
    delete deps.recomputeTupleHashes; // use default → null
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "internal" },
      munin,
      cfg,
      deps,
    );
    expect(r.kind).toBe("fallthrough");
    expect(r.skillRoute.abstainReason).toBe("cannot-verify-drift");
    expect(r.skillRoute.bindingId).toBe("fmt-binding");
  });

  it("fails closed on hash drift", async () => {
    const drifted: TupleRef = { ...TUPLE, skillProfileHash: H("f") };
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "internal" },
      munin,
      cfg,
      { ...happyDeps(), recomputeTupleHashes: async () => drifted },
    );
    expect(r.skillRoute.abstainReason).toBe("binding:hash-drift");
  });

  it("fails closed when the binding's sensitivity ceiling is below the task's", async () => {
    const r = await selectSkillRoute(
      { prompt: "p", promptDigest: "d", sensitivity: "private" },
      munin,
      cfg,
      { ...happyDeps(), loadActiveBinding: async () => ({ ...BINDING, effectiveSensitivityCeiling: "internal" }) },
    );
    expect(r.skillRoute.abstainReason).toBe("binding:sensitivity-ceiling");
  });
});
