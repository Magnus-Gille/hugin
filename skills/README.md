# skills/ — authored skill-distillation artifacts (source of truth)

This directory holds the **authored, reviewable, content-addressed** artifacts of
the eval-gated skill-distillation system (issues #79–#84). Munin holds runtime
*projections* (retrieval rows, active pointers, immutable validation runs); git
holds the authored source. Content hashes tie the two together.

## Layout

```
skills/
├── _classifier/<classId>.json                         # TaskClassifier (rule predicate + cases)
└── <skill-id>/
    ├── package.json                                    # ProcedurePackage (authored source)
    ├── profiles/pi-local-30b.json                      # compiled, content-addressed profile
    ├── eval/suite.json                                 # EvalSuite (positive/negative/retrieval/mutation)
    └── route-bindings/<binding-id>.json                # RouteBinding + pinned tuple
```

## slice-one (#84): `markdown-frontmatter-normalization`

The first end-to-end vertical. The procedure is **markdown YAML frontmatter
normalization** — fully deterministic and exact-match gradeable (no judge model).
The deterministic implementation + grader live at
`src/skill/slice-one/frontmatter-normalize.ts`; the four artifacts are authored as
TypeScript constants in `src/skill/slice-one/artifacts.ts` and serialized here.

### Fail-closed by construction

The committed `RouteBinding` is in **`draft`** state, never `active`. Only `active`
bindings are selectable by the lane (`src/skill/route-binding-store.ts#isSelectable`),
so these artifacts are a safe no-op in production even with `HUGIN_SKILL_LANE=on`.
The `cellManifestHash` is a placeholder over a *declared* (not deployed) local cell.

### Regenerating the JSON

The JSON files are generated from the runtime constants so the two cannot drift
(a test enforces equality — `tests/skill/slice-one-committed-artifacts.test.ts`):

```bash
npm run build
node -e '
  import("./dist/skill/slice-one/artifacts.js").then((a) => {
    const fs = require("node:fs");
    const w = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
    w("skills/markdown-frontmatter-normalization/package.json", a.sliceOnePackage);
    w("skills/markdown-frontmatter-normalization/profiles/pi-local-30b.json", a.sliceOneProfile);
    w("skills/markdown-frontmatter-normalization/eval/suite.json", a.sliceOneEvalSuite);
    w("skills/markdown-frontmatter-normalization/route-bindings/" + a.sliceOneDraftBinding.bindingId + ".json", { binding: a.sliceOneDraftBinding, tuple: a.sliceOneTuple });
    w("skills/_classifier/" + a.sliceOneClassifier.classId + ".json", a.sliceOneClassifier);
  });
'
```

## Go-live (human-only) — NOT done by this PR

To actually route frontmatter-normalization tasks to a local cell:

1. Stand up the real local cell (e.g. an ollama Qwen3-Coder-30B on the Pi) and
   pin its exact wrapper/model/quantization/context/thinking settings as a cell
   manifest; replace the placeholder `cellManifestHash` in the tuple.
2. Run the eval suite against that cell to produce a real `ValidationRun`
   (offline-fixture shadow first; Hugin-integrated shadow inherits #77).
3. Provide a real `recomputeTupleHashes` for the lane (loads the live artifacts
   and recomputes their hashes) so drift detection can pass.
4. Drive the binding `draft → candidate → shadow → active` with that run as
   evidence, and publish the Munin projections (retrieval row + active pointer).
5. Only then set `HUGIN_SKILL_LANE=on` in production. Even then, the dispatcher
   has no local executor wired yet — that is a further, separate step.
