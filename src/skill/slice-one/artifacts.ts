/**
 * artifacts.ts — the authored slice-one artifacts for #84.
 *
 * Slice-one skill: **markdown frontmatter normalization** (see
 * `frontmatter-normalize.ts`). This module is the in-repo source of truth for
 * the four content-addressed artifacts the skill-distillation modules expect:
 *
 *   1. procedure package   → src/skill/procedure-package-schema.ts
 *   2. compiled profile    → src/skill/profile-compiler.ts (compileProfile)
 *   3. task classifier     → src/skill/task-classifier-schema.ts
 *   4. eval suite          → src/skill/eval-suite-schema.ts
 *
 * plus a draft RouteBinding pinning them by content hash. Everything is built
 * with the shared canonical hashing in refs.ts so the hashes are reproducible.
 *
 * IMPORTANT — fail-closed by construction: the RouteBinding here is authored in
 * `draft` state, NOT `active`. Driving it to `active` (and standing up the real
 * local cell) is a deliberate human go-live step. Until then, the skill lane
 * fails closed to the cloud auto-router even when HUGIN_SKILL_LANE=on. These
 * artifacts exist so that the wiring + eval gate can be exercised offline, not
 * so that local routing silently turns on.
 */

import { contentHash } from "../refs.js";
import {
  procedurePackageSchema,
  type ProcedurePackage,
} from "../procedure-package-schema.js";
import { compileProfile, type PiLocal30bProfile } from "../profile-compiler.js";
import {
  taskClassifierSchema,
  type TaskClassifier,
} from "../task-classifier-schema.js";
import { evalSuiteSchema, type EvalSuite } from "../eval-suite-schema.js";
import {
  routeBindingSchema,
  type RouteBinding,
} from "../route-binding-schema.js";
import type { TupleRef } from "../refs.js";

export const SLICE_ONE_SKILL_ID = "markdown-frontmatter-normalization";
export const SLICE_ONE_TASK_CLASS_ID = "md-frontmatter-normalization";
export const SLICE_ONE_EVAL_SUITE_ID = "eval-md-frontmatter-normalization-v1";
export const SLICE_ONE_BINDING_ID = "md-frontmatter-normalization-binding";

// A fixed prompt digest used in the retrieval hard-negative fixtures so the row
// authoring + tests agree. Real dispatch passes the live prompt digest.
export const SLICE_ONE_HARD_NEGATIVE_DIGEST =
  "normalize the import ordering in this typescript file";

// ---------------------------------------------------------------------------
// 1. Procedure package
// ---------------------------------------------------------------------------

const PROCEDURE_PACKAGE_RAW: ProcedurePackage = {
  schemaVersion: 1,
  skillId: SLICE_ONE_SKILL_ID,
  title: "Normalize markdown YAML frontmatter",
  taskClassId: SLICE_ONE_TASK_CLASS_ID,
  inputSchema: { document: { type: "string" } },
  outputSchema: { document: { type: "string" } },
  toolAllowlist: ["read_file", "write_file"],
  steps: [
    {
      id: "read-document",
      instruction:
        "Read the markdown document. Confirm it opens with a `---` fenced YAML frontmatter block.",
      checkpoint:
        "The document text is loaded and a frontmatter block is detected at the start.",
    },
    {
      id: "normalize-block",
      instruction:
        "Sort the frontmatter keys ascending, emit `key: value` with a single space after the colon, " +
        "quote only values that require it, and render lists as `  - item` lines. Leave the body after " +
        "the closing `---` byte-for-byte unchanged.",
      checkpoint:
        "Keys are sorted; spacing/quoting is canonical; the body after the closing fence is unchanged.",
    },
    {
      id: "write-document",
      instruction: "Write the normalized document back.",
      checkpoint: "File written; the body bytes after the frontmatter are identical to the input.",
    },
  ],
  examples: [
    {
      input: { document: "---\nb: 2\na: 1\n---\nbody\n" },
      output: { document: '---\na: "1"\nb: "2"\n---\nbody\n' },
    },
  ],
  antiExamples: [
    {
      input: { document: "# Just a heading\n\nNo frontmatter here.\n" },
      why: "The document has no frontmatter block; this skill must abstain, never invent one.",
    },
    {
      input: { document: "---\nnested:\n  a: 1\n---\n" },
      why: "Nested maps are outside the supported subset; abstain rather than mangle.",
    },
  ],
  abortConditions: [
    "The document does not start with a `---` frontmatter fence.",
    "The frontmatter block is unterminated (no closing `---`).",
    "The frontmatter contains nested maps, multi-line scalars, anchors, or flow maps (outside the supported subset).",
  ],
  contraindications: [
    "do not modify the body",
    "leave frontmatter as-is",
  ],
  egressClass: "local",
  evalSuiteId: SLICE_ONE_EVAL_SUITE_ID,
};

/** The validated slice-one procedure package. */
export const sliceOnePackage: ProcedurePackage =
  procedurePackageSchema.parse(PROCEDURE_PACKAGE_RAW);

/** The compiled pi-local-30b profile (content-addressed). */
export const sliceOneProfile: PiLocal30bProfile = compileProfile(
  sliceOnePackage,
  "pi-local-30b",
);

// ---------------------------------------------------------------------------
// 2. Task classifier
// ---------------------------------------------------------------------------

const CLASSIFIER_BODY = {
  schemaVersion: 1 as const,
  classId: SLICE_ONE_TASK_CLASS_ID,
  version: 1,
  // Placeholder; replaced by the self-consistent hash below.
  classifierHash: "0".repeat(64),
  predicate: {
    kind: "rule" as const,
    rules: [
      { match: "frontmatter", weight: 3 },
      { match: "front matter", weight: 3 },
      { match: "yaml header", weight: 3 },
      { match: "normalize", weight: 1 },
    ],
    // A clear "normalize the frontmatter" prompt matches frontmatter(3)+normalize(1)
    // out of total weight 10 → 0.4, which must clear the threshold. A bare
    // "normalize" prompt (weight 1/10 = 0.1) must not. Hard negatives zero the
    // score regardless. The margin is moot for a single classifier but is kept
    // strict so adding a sibling class later cannot silently create ambiguity.
    confidenceThreshold: 0.4,
    topTwoMargin: 0.15,
  },
  hardNegatives: [
    {
      input: "normalize the import",
      why: "Import normalization is a different (TS) skill; the word 'normalize' alone must not route here.",
    },
    {
      input: "json config",
      why: "JSON config files have no YAML frontmatter; this is a look-alike.",
    },
  ],
  contraindications: ["do not modify the frontmatter"],
  shouldClassify: [
    { input: "Normalize the YAML frontmatter in this markdown file." },
    { input: "Please clean up and normalize the front matter block." },
  ],
  shouldNotClassify: [
    { input: "Normalize the import ordering in this TypeScript file." },
    { input: "Summarize this article in three sentences." },
  ],
  sensitivityCeiling: "internal" as const,
};

function buildClassifier(): TaskClassifier {
  // Hash the body with a zeroed hash field (self-consistent content address).
  const hash = contentHash({ ...CLASSIFIER_BODY, classifierHash: "0".repeat(64) });
  return taskClassifierSchema.parse({ ...CLASSIFIER_BODY, classifierHash: hash });
}

export const sliceOneClassifier: TaskClassifier = buildClassifier();

// ---------------------------------------------------------------------------
// 3. Eval suite
// ---------------------------------------------------------------------------

// Canonical fixtures: input document → expected canonical document (string), or
// the abstain sentinel for negative/abort cases. The grader in
// frontmatter-normalize.ts scores these by exact match.
const EVAL_SUITE_BODY = {
  schemaVersion: 1 as const,
  evalSuiteId: SLICE_ONE_EVAL_SUITE_ID,
  evalSuiteHash: "0".repeat(64), // placeholder, replaced below
  skillId: SLICE_ONE_SKILL_ID,
  taskClassId: SLICE_ONE_TASK_CLASS_ID,
  oracles: [
    {
      id: "exact-match-normalizer",
      kind: "snapshot-diff" as const,
      // Independent: the oracle is a pure exact-string comparison, not a
      // judge model and not authored to rubber-stamp a model's output.
      independent: true,
      ref: "src/skill/slice-one/frontmatter-normalize.ts#gradeFrontmatter",
    },
  ],
  judgeIsAdvisoryOnly: true as const,
  fixtures: {
    positive: [
      {
        id: "pos-reorder-and-quote",
        input: { document: "---\nb: 2\na: 1\n---\nbody\n" },
        expected: '---\na: "1"\nb: "2"\n---\nbody\n',
        allowedNondeterminism: [],
      },
      {
        id: "pos-list-and-spacing",
        input: { document: "---\ntags:  [x, y]\ntitle:Hello\n---\n# Body\n" },
        expected: "---\ntags:\n  - x\n  - y\ntitle: Hello\n---\n# Body\n",
        allowedNondeterminism: [],
      },
    ],
    negative: [
      {
        id: "neg-no-frontmatter",
        input: { document: "# Heading\n\nNo frontmatter.\n" },
        expected: { abstain: true, reason: "no-frontmatter" },
        allowedNondeterminism: [],
      },
      {
        id: "neg-nested-map",
        input: { document: "---\nnested:\n  a: 1\n---\n" },
        expected: { abstain: true, reason: "unsupported-frontmatter" },
        allowedNondeterminism: [],
      },
    ],
    retrieval: [
      {
        id: "ret-positive",
        input: "Normalize the YAML frontmatter in this markdown file.",
        shouldSelect: true,
      },
      {
        id: "ret-hard-negative-imports",
        input: SLICE_ONE_HARD_NEGATIVE_DIGEST,
        shouldSelect: false,
      },
    ],
    mutation: [
      {
        id: "mut-body-must-not-change",
        // Same frontmatter but a perturbed body; a grader that ignored the body
        // would wrongly pass against the pos-reorder expected output.
        input: { document: "---\nb: 2\na: 1\n---\nMUTATED body\n" },
        expected: '---\na: "1"\nb: "2"\n---\nMUTATED body\n',
        allowedNondeterminism: [],
      },
    ],
  },
};

function buildEvalSuite(): EvalSuite {
  const hash = contentHash({ ...EVAL_SUITE_BODY, evalSuiteHash: "0".repeat(64) });
  return evalSuiteSchema.parse({ ...EVAL_SUITE_BODY, evalSuiteHash: hash });
}

export const sliceOneEvalSuite: EvalSuite = buildEvalSuite();

// ---------------------------------------------------------------------------
// 4. Tuple + RouteBinding (authored in `draft` — NOT active)
// ---------------------------------------------------------------------------

/**
 * The content-addressed tuple pinning the four slice-one artifacts. This is the
 * value `recomputeTupleHashes` would return for a live binding; tests use it to
 * exercise the selectable path without a real cell.
 */
export const sliceOneTuple: TupleRef = {
  taskClassId: SLICE_ONE_TASK_CLASS_ID,
  taskClassVersion: sliceOneClassifier.version,
  taskClassHash: sliceOneClassifier.classifierHash,
  skillProfileId: sliceOneProfile.profileId,
  skillProfileHash: sliceOneProfile.profileHash,
  // No real cell manifest exists yet; this is a placeholder content hash over a
  // declared (not deployed) cell descriptor. Go-live replaces it with the hash
  // of the actually-deployed local cell manifest.
  cellManifestId: "ollama-qwen3-coder-30b-local",
  cellManifestHash: contentHash({
    cellManifestId: "ollama-qwen3-coder-30b-local",
    declaredOnly: true,
    note: "placeholder — replaced at go-live by the deployed cell manifest hash",
  }),
  evalSuiteId: SLICE_ONE_EVAL_SUITE_ID,
  evalSuiteHash: sliceOneEvalSuite.evalSuiteHash,
};

/**
 * The slice-one RouteBinding — DRAFT. Not selectable (only `active` bindings
 * are). Authored here so the artifact shape is reviewable and the wiring tests
 * can construct an `active` variant from it explicitly. Production must never
 * see this in `active` state until go-live.
 */
export const sliceOneDraftBinding: RouteBinding = routeBindingSchema.parse({
  schemaVersion: 1,
  bindingId: SLICE_ONE_BINDING_ID,
  version: 1,
  state: "draft",
  tuple: sliceOneTuple,
  fallbackPolicy: {
    cloudAllowed: true,
    autoEscalateAllowed: true,
    requiresUserApproval: false,
    zdrRequired: false,
    egressClass: "local",
    fallbackProviderSet: [],
    fallbackOnFailureKinds: ["parser", "schema", "tests", "timeout", "infra"],
  },
  effectiveSensitivityCeiling: "internal",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  notes:
    "Slice-one (#84) authored binding. DRAFT — go-live drives draft→candidate→shadow→active " +
    "with a real ValidationRun against a deployed local cell. See docs.",
});
