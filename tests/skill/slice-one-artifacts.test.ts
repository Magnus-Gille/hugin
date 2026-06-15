import { describe, it, expect } from "vitest";
import {
  sliceOnePackage,
  sliceOneProfile,
  sliceOneClassifier,
  sliceOneEvalSuite,
  sliceOneTuple,
  sliceOneDraftBinding,
  SLICE_ONE_TASK_CLASS_ID,
  SLICE_ONE_HARD_NEGATIVE_DIGEST,
} from "../../src/skill/slice-one/artifacts.js";
import {
  normalizeFrontmatter,
  gradeFrontmatter,
} from "../../src/skill/slice-one/frontmatter-normalize.js";
import { classifyTask } from "../../src/skill/task-classifier.js";
import { profileHash } from "../../src/skill/profile-compiler.js";
import { runEvalSuite, gradeFixture } from "../../src/skill/eval-runner.js";
import { contentHash } from "../../src/skill/refs.js";
import type { Fixture, RetrievalFixture } from "../../src/skill/eval-suite-schema.js";

describe("slice-one authored artifacts (#84)", () => {
  it("the procedure package compiles to a self-consistent profile hash", () => {
    expect(profileHash(sliceOneProfile)).toBe(sliceOneProfile.profileHash);
    expect(sliceOneProfile.skillId).toBe(sliceOnePackage.skillId);
  });

  it("the classifier hash is self-consistent (content address over a zeroed hash field)", () => {
    const recomputed = contentHash({
      ...sliceOneClassifier,
      classifierHash: "0".repeat(64),
    });
    expect(recomputed).toBe(sliceOneClassifier.classifierHash);
  });

  it("the eval suite hash is self-consistent", () => {
    const recomputed = contentHash({
      ...sliceOneEvalSuite,
      evalSuiteHash: "0".repeat(64),
    });
    expect(recomputed).toBe(sliceOneEvalSuite.evalSuiteHash);
  });

  it("the tuple pins the profile, classifier and eval-suite by their real hashes", () => {
    expect(sliceOneTuple.skillProfileHash).toBe(sliceOneProfile.profileHash);
    expect(sliceOneTuple.taskClassHash).toBe(sliceOneClassifier.classifierHash);
    expect(sliceOneTuple.evalSuiteHash).toBe(sliceOneEvalSuite.evalSuiteHash);
    expect(sliceOneTuple.taskClassId).toBe(SLICE_ONE_TASK_CLASS_ID);
  });

  it("the authored RouteBinding is DRAFT — never active in the repo (fail-closed by construction)", () => {
    // This is load-bearing: if someone authors an `active` binding into the repo
    // the lane could route local in production. Slice-one ships draft only.
    expect(sliceOneDraftBinding.state).toBe("draft");
  });
});

describe("slice-one classifier routing (#84)", () => {
  it("classifies a frontmatter-normalization prompt to the slice-one class", () => {
    const r = classifyTask(
      "Normalize the YAML frontmatter in this markdown file.",
      [sliceOneClassifier],
    );
    expect(r.kind).toBe("classified");
    if (r.kind === "classified") expect(r.classId).toBe(SLICE_ONE_TASK_CLASS_ID);
  });

  it("does NOT route a TS import-normalization prompt here (hard negative)", () => {
    const r = classifyTask(SLICE_ONE_HARD_NEGATIVE_DIGEST, [sliceOneClassifier]);
    // Hard negative zeroes the score → below threshold → abstain.
    expect(r.kind).toBe("abstain");
  });

  it("abstains on an unrelated prompt", () => {
    const r = classifyTask("Summarize this article in three sentences.", [
      sliceOneClassifier,
    ]);
    expect(r.kind).toBe("abstain");
  });
});

describe("slice-one eval suite passes its deterministic grader (#84 offline gate)", () => {
  it("every fixture passes when executed by the real normalizer", async () => {
    // The injected executor runs the authored normalizer for content fixtures and
    // the authored classifier for retrieval fixtures — exactly the offline shadow
    // contract (no model, no cell, no Munin).
    const result = await runEvalSuite(
      sliceOneEvalSuite,
      async (fixture: Fixture | RetrievalFixture) => {
        if ("shouldSelect" in fixture) {
          const cls = classifyTask(fixture.input, [sliceOneClassifier]);
          return cls.kind === "classified";
        }
        const out = normalizeFrontmatter(
          (fixture.input as { document: string }),
        );
        // The runner's gradeFixture compares JSON-equality of output vs expected.
        // For content fixtures we hand it the canonical string / abstain sentinel
        // that exactly matches the fixture.expected shape.
        return out.ok ? out.document : { abstain: true, reason: out.reason };
      },
    );

    expect(result.metrics.passRate).toBe(1);
    expect(result.perFixtureResults.every((r) => r.outcome === "pass")).toBe(true);
  });

  it("a mutated output fails the grader (anti-Goodhart: grader is not trivially satisfiable)", () => {
    const fixture = sliceOneEvalSuite.fixtures.positive[0];
    const out = normalizeFrontmatter(fixture.input as { document: string });
    const mutated = out.ok ? out.document.replace("body", "TAMPERED") : "";
    const verdict = gradeFrontmatter(
      { ok: true, document: mutated },
      fixture.expected,
    );
    expect(verdict.pass).toBe(false);
  });

  it("gradeFixture (the runner oracle) agrees with the authored expected on a positive fixture", () => {
    const fixture = sliceOneEvalSuite.fixtures.positive[0];
    const out = normalizeFrontmatter(fixture.input as { document: string });
    const r = gradeFixture(
      fixture,
      out.ok ? out.document : { abstain: true, reason: out.reason },
      sliceOneEvalSuite.oracles,
    );
    expect(r.outcome).toBe("pass");
  });
});
