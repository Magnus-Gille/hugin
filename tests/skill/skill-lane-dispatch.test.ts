import { describe, it, expect } from "vitest";
import {
  consultSkillLane,
  computePromptDigest,
} from "../../src/skill/skill-lane-dispatch.js";
import type { MuninClient } from "../../src/munin-client.js";
import type { SkillLaneDeps } from "../../src/skill/skill-lane.js";

describe("computePromptDigest", () => {
  it("collapses whitespace and lowercases (stable, deterministic)", () => {
    expect(computePromptDigest("  Normalize   the\nFrontmatter ")).toBe(
      "normalize the frontmatter",
    );
  });
});

describe("consultSkillLane (#84 dispatcher seam, fail-closed)", () => {
  it("flag OFF ⇒ returns null and never touches Munin (true no-op)", async () => {
    // A Munin client whose every method throws — if the lane touched it we'd see it.
    const munin = new Proxy(
      {},
      {
        get() {
          return () => {
            throw new Error("Munin must not be called when the lane is disabled");
          };
        },
      },
    ) as unknown as MuninClient;

    const result = await consultSkillLane(
      { prompt: "Normalize the frontmatter", sensitivity: "internal" },
      munin,
      { enabled: false },
    );
    expect(result).toBeNull();
  });

  it("flag ON + no active binding ⇒ fall-through audit record, NOT a local route", async () => {
    // Classifier + retrieval succeed, but no active binding exists → fail-closed.
    const deps: Partial<SkillLaneDeps> = {
      loadActiveClassifiers: async () => [{} as never],
      classifyTask: () => ({ kind: "classified", classId: "fmt", confidence: 0.9 }),
      retrieveProcedure: async () => ({ kind: "selected", row: {} as never, score: 0.9 }),
      loadActiveBinding: async () => null, // <-- the production reality for slice-one
    };

    const result = await consultSkillLane(
      { prompt: "Normalize the frontmatter", sensitivity: "internal" },
      {} as MuninClient,
      { enabled: true },
      deps,
    );

    expect(result).not.toBeNull();
    expect(result!.selectedLocal).toBe(false);
    expect(result!.skillRoute.abstained).toBe(true);
    expect(result!.skillRoute.abstainReason).toBe("no-active-binding");
    expect(result!.skillRoute.classId).toBe("fmt");
  });

  it("flag ON + default deps ⇒ fails closed because drift cannot be verified (no live cell)", async () => {
    // With the DEFAULT recomputeTupleHashes (returns null) the lane cannot prove
    // no-drift even if a binding were active — exactly the slice-one posture.
    const deps: Partial<SkillLaneDeps> = {
      loadActiveClassifiers: async () => [{} as never],
      classifyTask: () => ({ kind: "classified", classId: "fmt", confidence: 0.9 }),
      retrieveProcedure: async () => ({ kind: "selected", row: {} as never, score: 0.9 }),
      loadActiveBinding: async () => ({
        bindingId: "b",
        version: 1,
        state: "active",
      }) as never,
      // recomputeTupleHashes intentionally omitted → default returns null.
    };

    const result = await consultSkillLane(
      { prompt: "Normalize the frontmatter", sensitivity: "internal" },
      {} as MuninClient,
      { enabled: true },
      deps,
    );

    expect(result!.selectedLocal).toBe(false);
    expect(result!.skillRoute.abstainReason).toBe("cannot-verify-drift");
  });

  it("a Munin error during consultation is surfaced as a fall-through, never a throw to the caller's no-op contract", async () => {
    // selectSkillRoute swallows Munin errors into a fallthrough; consultSkillLane
    // therefore returns a result (not null, not a throw) so the dispatcher records
    // the abstain and proceeds to cloud.
    const deps: Partial<SkillLaneDeps> = {
      loadActiveClassifiers: async () => {
        throw new Error("munin down");
      },
    };
    const result = await consultSkillLane(
      { prompt: "x", sensitivity: "internal" },
      {} as MuninClient,
      { enabled: true },
      deps,
    );
    expect(result!.selectedLocal).toBe(false);
    expect(result!.skillRoute.abstainReason).toBe("munin-error");
  });

  it("flag ON selects local ONLY when an active, drift-free, cleared binding is verifiable (the go-live shape)", async () => {
    // This proves the seam CAN select local — but only under conditions that do
    // not exist in the repo (an active binding + a recompute that matches). It
    // documents exactly what go-live must arrange.
    const { sliceOneTuple } = await import(
      "../../src/skill/slice-one/artifacts.js"
    );
    const binding = {
      schemaVersion: 1 as const,
      bindingId: "go-live-binding",
      version: 1,
      state: "active" as const,
      tuple: sliceOneTuple,
      fallbackPolicy: {
        cloudAllowed: true,
        autoEscalateAllowed: true,
        requiresUserApproval: false,
        zdrRequired: false,
        egressClass: "local" as const,
        fallbackProviderSet: [],
        fallbackOnFailureKinds: [],
      },
      effectiveSensitivityCeiling: "internal" as const,
      createdAt: "t0",
      updatedAt: "t1",
    };
    const deps: Partial<SkillLaneDeps> = {
      loadActiveClassifiers: async () => [{} as never],
      classifyTask: () => ({ kind: "classified", classId: "fmt", confidence: 0.9 }),
      retrieveProcedure: async () => ({ kind: "selected", row: {} as never, score: 0.9 }),
      loadActiveBinding: async () => binding as never,
      recomputeTupleHashes: async () => sliceOneTuple, // matches → no drift
    };
    const result = await consultSkillLane(
      { prompt: "Normalize the frontmatter", sensitivity: "internal" },
      {} as MuninClient,
      { enabled: true },
      deps,
    );
    expect(result!.selectedLocal).toBe(true);
    expect(result!.skillRoute.bindingId).toBe("go-live-binding");
  });
});
