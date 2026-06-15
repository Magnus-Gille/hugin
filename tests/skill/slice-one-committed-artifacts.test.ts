import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  sliceOnePackage,
  sliceOneProfile,
  sliceOneClassifier,
  sliceOneEvalSuite,
  sliceOneDraftBinding,
  sliceOneTuple,
  SLICE_ONE_BINDING_ID,
} from "../../src/skill/slice-one/artifacts.js";

// The committed JSON under skills/ is the reviewable, content-addressed source
// the design doc designates as the git source of truth. The runtime constants in
// artifacts.ts are what the code uses. This test pins them together so a change
// to one without regenerating the other fails CI (drift guard). Regenerate via
// `node` against dist/skill/slice-one/artifacts.js (see PR description).

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(here, "../../skills");

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(skillsDir, rel), "utf8"));
}

describe("committed slice-one artifacts match the runtime constants (#84 drift guard)", () => {
  it("package.json matches sliceOnePackage", () => {
    expect(readJson("markdown-frontmatter-normalization/package.json")).toEqual(
      sliceOnePackage,
    );
  });

  it("profiles/pi-local-30b.json matches the compiled profile", () => {
    expect(
      readJson("markdown-frontmatter-normalization/profiles/pi-local-30b.json"),
    ).toEqual(sliceOneProfile);
  });

  it("eval/suite.json matches the eval suite", () => {
    expect(readJson("markdown-frontmatter-normalization/eval/suite.json")).toEqual(
      sliceOneEvalSuite,
    );
  });

  it("_classifier/<classId>.json matches the classifier", () => {
    expect(readJson("_classifier/md-frontmatter-normalization.json")).toEqual(
      sliceOneClassifier,
    );
  });

  it("the committed route-binding is DRAFT and pins the authored tuple", () => {
    const committed = readJson(
      `markdown-frontmatter-normalization/route-bindings/${SLICE_ONE_BINDING_ID}.json`,
    ) as { binding: unknown; tuple: unknown };
    expect(committed.binding).toEqual(sliceOneDraftBinding);
    expect(committed.tuple).toEqual(sliceOneTuple);
    expect((committed.binding as { state: string }).state).toBe("draft");
  });
});
