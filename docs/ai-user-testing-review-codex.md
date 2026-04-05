# Hugin AI User Testing Review (Codex)

## Metadata

- **Repo:** `hugin`
- **Branch tested:** `main`
- **Commit tested:** `55195cfb9a764e34e72b4b4f5f4ba6d6b555bbe1`
- **Package version:** `0.1.0`
- **Date tested:** `2026-04-05`
- **Local time window:** `2026-04-05 09:47:00 CEST` to `2026-04-05 09:52:04 CEST`
- **Codex CLI version:** `codex-cli 0.118.0`
- **Node version in test shell:** `v25.9.0`
- **Automated baseline:** `npm test` -> 154 tests passed across 17 files; `npm run build` -> passed
- **Review scope:** repo-local user testing and artifact inspection only; I did **not** submit live tasks to Munin or run the Pi service against production state

## Agents Used

- **Primary operator:** this Codex CLI session
- **Small model pass:** `gpt-5.4-mini`, reasoning effort `low`
- **Large model pass:** `gpt-5.4`, reasoning effort `xhigh`

## Method

1. Read local project state from `STATUS.md`, `README.md`, and `AGENTS.md`.
2. Verified the repo baseline with `npm test` and `npm run build`.
3. Performed hands-on artifact checks from an AI-agent perspective:
   - rendered a sample human-readable `result`
   - parsed a valid and invalid `approval-decision`
   - compiled a sample pipeline locally
4. Ran two independent AI-user-testing passes with different model sizes/effort settings and compared where the weaker model got stuck versus what the stronger model could recover by reading deeper source/tests.

## Hands-On Notes

### 1. First pipeline authoring attempt failed for an AI-plausible reason

My first locally compiled demo pipeline used:

```markdown
Phase: deploy
  Runtime: codex
```

That failed with:

```text
Error: Phase "deploy" uses unknown runtime "codex"
```

Changing it to:

```markdown
Phase: deploy
  Runtime: codex-spawn
```

worked immediately.

This is a real AI-user issue, not a theoretical one: standalone tasks use `codex`, but pipeline phases use runtime IDs like `codex-spawn`, `claude-sdk`, `ollama-pi`, and `ollama-laptop`. That distinction exists in code and deep design docs, but not in the primary operator schema.

### 2. Approval artifacts are strict and safe, but not easy to author

A valid `approval-decision` JSON parsed cleanly. An intentionally incomplete JSON document returned `null`. That is the right safety behavior, but it means the approval contract must be taught precisely or weaker agents will produce inert artifacts.

### 3. Result formatting is good once you know where to look

The rendered markdown `result` is clean and predictable, and the structured sibling artifact is better still. The implementation is strong here; the main issue is discoverability rather than design.

## What Worked Well

- **The core task contract is AI-friendly.** Markdown metadata plus a dedicated `### Prompt` section is much easier for an agent to author than raw JSON. The basic shape is legible and copy-pastable.
- **The safety model is serious.** `Context-refs`, sensitivity ceilings, and gated side effects all behave like real operator controls rather than soft conventions.
- **Artifacts are better than the docs suggest.** The combination of `result`, `result-structured`, and pipeline `summary` gives a strong recovery surface for agents and downstream systems.

## Primary AI-UX Findings

### High

1. **The README hello-world path is a trap.**
   - The quick example omits `Submitted by:`.
   - The dispatcher defaults missing submitter to `unknown`.
   - Unknown submitters are rejected by the allowlist.
   - A smaller model copying the README literally is likely to create a task that fails immediately.
   - Evidence: `README.md`, `src/index.ts` (`parseSubmittedByField`, submitter allowlist check).

2. **`Runtime: pipeline` is not presented as a first-class public interface.**
   - `AGENTS.md` documents task runtime as `claude | codex | ollama`.
   - The implementation and tests clearly support `Runtime: pipeline`.
   - An AI reading only the primary docs can miss one of Hugin’s main capabilities.
   - Evidence: `AGENTS.md`, `src/index.ts`, `tests/pipeline-compiler.test.ts`.

3. **Pipeline runtime names are inconsistent with standalone runtime names.**
   - Standalone task: `codex`
   - Pipeline phase: `codex-spawn`
   - This caused my first hands-on pipeline compile to fail.
   - Strong models can recover by reading `src/pipeline-ir.ts` or deep docs. Weak models will not.
   - Evidence: `src/pipeline-ir.ts`, `src/pipeline-compiler.ts`, `docs/hugin-v2-pipeline-orchestrator.md`.

4. **Approval is implemented, but the operator contract is still too implicit.**
   - `approval-decision` must match an exact JSON schema.
   - Invalid or mismatched artifacts are ignored except for logs.
   - `STATUS.md` already notes that operator-facing approval docs/tooling are still needed.
   - Evidence: `src/pipeline-gates.ts`, `src/index.ts`, `STATUS.md`.

### Medium

5. **The best machine-readable outputs are under-documented.**
   - Primary docs tell agents to read `result`.
   - The implementation also writes `result-structured`.
   - Pipeline operators additionally need `summary`.
   - A weaker model will scrape markdown because it does not know better.
   - Evidence: `README.md`, `AGENTS.md`, `src/index.ts`, `src/task-result-schema.ts`, `src/pipeline-summary.ts`.

6. **Sensitivity is a real authoring concern, but it is not taught as one.**
   - Quick-start docs omit `Sensitivity:`.
   - Execution can still reject a task after inferring sensitivity from prompt/context/refs.
   - That is a correct safety posture, but the AI-user experience will feel surprising unless you teach the field up front.
   - Evidence: `README.md`, `src/index.ts`, `src/sensitivity.ts`.

7. **The documented path contract is misleading.**
   - Docs say raw absolute paths are passed through unchanged.
   - Code rejects paths outside `/home/magnus/` and falls back to `/home/magnus/workspace`.
   - That creates silent context drift for an autonomous agent.
   - Evidence: `AGENTS.md`, `src/index.ts`.

8. **Some engineering docs are stale enough to mislead agents.**
   - `docs/phase4-human-gates-engineering-plan.md` says Phase 4 is “Planned, not implemented”.
   - `STATUS.md` says Phase 4 is done and live-validated.
   - `docs/phase5-sensitivity-classification-engineering-plan.md` says `src/index.ts` does not parse standalone `Sensitivity:`, but the current code does.
   - A strong model can resolve the conflict. A weaker model may anchor on the stale doc and form the wrong mental model.
   - Evidence: `docs/phase4-human-gates-engineering-plan.md`, `docs/phase5-sensitivity-classification-engineering-plan.md`, `STATUS.md`, `src/index.ts`.

## Small vs Large Model Behavior

### Small model (`gpt-5.4-mini`, low)

- Stayed close to the README/AGENTS happy path.
- Immediately noticed the `Submitted by:` trap and the missing discoverability of `result-structured`.
- Was more likely to treat docs literally and miss advanced capabilities hidden in source/tests.

### Large model (`gpt-5.4`, xhigh)

- Reconstructed the missing operator contract from source and tests.
- Correctly inferred that pipelines, approvals, `result-structured`, and `summary` are all first-class in practice.
- Could work around the documentation gaps, but only by doing reverse-engineering work that the product should not require.

### Interpretation

Hugin is in a better state for **strong operator models** than for **small or opportunistic agent users**. The implementation is substantially ahead of the operator-facing documentation. That is the dominant usability pattern I saw.

## Most Important Recommendation

Write one short operator cookbook for agents and humans with copy-paste examples for:

- a minimal standalone task that actually passes the submitter allowlist
- an `ollama` task with `Context-refs` and `Sensitivity:`
- a `Runtime: pipeline` example using the real phase runtime IDs
- the exact `approval-decision` JSON shape
- a “which artifact to read” table for `result`, `result-structured`, `summary`, and `approval-request`

If you do only one thing for AI-agent usability, do that. It closes more real friction than more internal planning notes or more tests.

## Bottom Line

Hugin’s implementation feels strong, deliberate, and much more production-shaped than the top-level docs make it look. The current AI-user problem is not that the system is vague; it is that the **best parts are partially hidden**. Strong models can dig them out. Small models will hit avoidable first-run failures and miss advanced workflows unless the public operator contract is tightened.
