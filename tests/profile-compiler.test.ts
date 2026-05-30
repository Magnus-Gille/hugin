import { describe, it, expect } from "vitest";
import {
  validatePackage,
  compileProfile,
  profileHash,
  type PiLocal30bProfile,
} from "../src/skill/profile-compiler.js";
import type { ProcedurePackage } from "../src/skill/procedure-package-schema.js";
import { contentHash } from "../src/skill/refs.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_PACKAGE: ProcedurePackage = {
  schemaVersion: 1,
  skillId: "test-normalize-imports",
  title: "Normalize TypeScript imports",
  taskClassId: "ts-import-normalization",
  inputSchema: { file: { type: "string" } },
  outputSchema: { patch: { type: "string" } },
  toolAllowlist: ["read_file", "write_file"],
  steps: [
    {
      id: "read-source",
      instruction: "Read the target TypeScript file.",
      checkpoint: "File content is loaded into context.",
    },
    {
      id: "apply-patch",
      instruction: "Normalize import order and write the patched file.",
      checkpoint: "File written; no syntax errors introduced.",
    },
  ],
  examples: [
    {
      input: { file: "src/index.ts" },
      output: { patch: "--- a/src/index.ts\n+++ b/src/index.ts\n..." },
    },
  ],
  antiExamples: [
    {
      input: { file: "package.json" },
      why: "This skill is for TypeScript files only; JSON files must not be modified.",
    },
  ],
  abortConditions: [
    "The file contains syntax errors before modification.",
    "The file is larger than 500 lines.",
  ],
  contraindications: [],
  egressClass: "local",
  evalSuiteId: "eval-ts-import-normalization-v1",
};

// ---------------------------------------------------------------------------
// validatePackage
// ---------------------------------------------------------------------------

describe("validatePackage", () => {
  it("accepts a valid minimal package", () => {
    const pkg = validatePackage(MINIMAL_PACKAGE);
    expect(pkg.skillId).toBe("test-normalize-imports");
  });

  it("rejects a package with zero steps (schema min(1))", () => {
    expect(() =>
      validatePackage({ ...MINIMAL_PACKAGE, steps: [] }),
    ).toThrow();
  });

  it("rejects a package with zero antiExamples (schema min(1))", () => {
    expect(() =>
      validatePackage({ ...MINIMAL_PACKAGE, antiExamples: [] }),
    ).toThrow();
  });

  it("rejects a package with zero examples (schema min(1))", () => {
    expect(() =>
      validatePackage({ ...MINIMAL_PACKAGE, examples: [] }),
    ).toThrow();
  });

  it("rejects a package with zero abortConditions (schema min(1))", () => {
    expect(() =>
      validatePackage({ ...MINIMAL_PACKAGE, abortConditions: [] }),
    ).toThrow();
  });

  it("rejects a package with duplicate step ids (structural check)", () => {
    expect(() =>
      validatePackage({
        ...MINIMAL_PACKAGE,
        steps: [
          { id: "step-a", instruction: "A", checkpoint: "A done" },
          { id: "step-a", instruction: "B", checkpoint: "B done" },
        ],
      }),
    ).toThrow(/duplicate step ids/);
  });

  it("rejects a package with an empty toolAllowlist (structural check)", () => {
    expect(() =>
      validatePackage({ ...MINIMAL_PACKAGE, toolAllowlist: [] }),
    ).toThrow(/toolAllowlist must be non-empty/);
  });

  it("applies default [] for contraindications", () => {
    const raw = { ...MINIMAL_PACKAGE };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (raw as any).contraindications;
    const pkg = validatePackage(raw);
    expect(pkg.contraindications).toEqual([]);
  });

  it("rejects missing required fields", () => {
    expect(() => validatePackage({ schemaVersion: 1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// compileProfile — determinism + correctness
// ---------------------------------------------------------------------------

describe("compileProfile — determinism", () => {
  it("same package → identical profile across repeated calls", () => {
    const p1 = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    const p2 = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(p1).toEqual(p2);
  });

  it("same package → identical profileHash across repeated calls", () => {
    const h1 = compileProfile(MINIMAL_PACKAGE, "pi-local-30b").profileHash;
    const h2 = compileProfile(MINIMAL_PACKAGE, "pi-local-30b").profileHash;
    expect(h1).toBe(h2);
  });

  it("different package content → different profileHash", () => {
    const altered = validatePackage({
      ...MINIMAL_PACKAGE,
      title: "A different title that changes the hash",
    });
    const h1 = compileProfile(MINIMAL_PACKAGE, "pi-local-30b").profileHash;
    const h2 = compileProfile(altered, "pi-local-30b").profileHash;
    expect(h1).not.toBe(h2);
  });

  it("changing only one step instruction changes the hash", () => {
    const altered = validatePackage({
      ...MINIMAL_PACKAGE,
      steps: [
        { ...MINIMAL_PACKAGE.steps[0], instruction: "Modified instruction" },
        MINIMAL_PACKAGE.steps[1],
      ],
    });
    const h1 = compileProfile(MINIMAL_PACKAGE, "pi-local-30b").profileHash;
    const h2 = compileProfile(altered, "pi-local-30b").profileHash;
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// profileHash — self-consistency invariant
// ---------------------------------------------------------------------------

describe("profileHash", () => {
  it("profileHash(compileProfile(pkg)) equals profile.profileHash", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profileHash(profile)).toBe(profile.profileHash);
  });

  it("profileHash is a 64-char sha256 hex string", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.profileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mutating the profile after compilation changes the recomputed hash", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    const mutated: PiLocal30bProfile = {
      ...profile,
      systemPreamble: "Mutated preamble — drift detected",
    };
    // The embedded profileHash still matches the original; the recomputed one does not.
    expect(profileHash(mutated)).not.toBe(profile.profileHash);
    // But the embedded field is unchanged (we didn't update it).
    expect(mutated.profileHash).toBe(profile.profileHash);
  });
});

// ---------------------------------------------------------------------------
// compileProfile — content correctness
// ---------------------------------------------------------------------------

describe("compileProfile — output structure", () => {
  it("carries input/output schemas from the package", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.inputSchema).toEqual(MINIMAL_PACKAGE.inputSchema);
    expect(profile.outputSchema).toEqual(MINIMAL_PACKAGE.outputSchema);
  });

  it("carries toolAllowlist from the package", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.toolAllowlist).toEqual(MINIMAL_PACKAGE.toolAllowlist);
  });

  it("maps steps to stepList with {id, prompt, checkpointAssertion}", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.stepList).toHaveLength(2);
    expect(profile.stepList[0]).toMatchObject({
      id: "read-source",
      prompt: MINIMAL_PACKAGE.steps[0].instruction,
      checkpointAssertion: MINIMAL_PACKAGE.steps[0].checkpoint,
    });
  });

  it("carries examples and antiExamples", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.examples).toEqual(MINIMAL_PACKAGE.examples);
    expect(profile.antiExamples).toEqual(MINIMAL_PACKAGE.antiExamples);
  });

  it("carries abortConditions", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.abortConditions).toEqual(MINIMAL_PACKAGE.abortConditions);
  });

  it("sets a positive integer maxContextChars default", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.maxContextChars).toBeGreaterThan(0);
    expect(Number.isInteger(profile.maxContextChars)).toBe(true);
  });

  it("defaults perStepGraderHooks to []", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.perStepGraderHooks).toEqual([]);
  });

  it("sets sourcePackageHash to contentHash of the package", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.sourcePackageHash).toBe(contentHash(MINIMAL_PACKAGE));
  });

  it("derives expectedArtifacts from outputSchema keys when present", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    // outputSchema has key "patch"
    expect(profile.expectedArtifacts).toContain("patch");
  });

  it("carries egressClass from the package", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.egressClass).toBe("local");
  });

  it("builds a non-empty systemPreamble mentioning the skill title and allowlist", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.systemPreamble).toContain(MINIMAL_PACKAGE.title);
    expect(profile.systemPreamble).toContain("read_file");
  });

  it("sets profileId to '<skillId>:pi-local-30b'", () => {
    const profile = compileProfile(MINIMAL_PACKAGE, "pi-local-30b");
    expect(profile.profileId).toBe("test-normalize-imports:pi-local-30b");
  });
});
