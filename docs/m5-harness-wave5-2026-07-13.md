# M5 harness wave 5 — one-shot vs code loop (2026-07-13)

## Result

Wave 5 is negative but decision-useful evidence. On three real tickets and six matched bounded
subtasks, M5 one-shot produced no acceptable patch (three no-local-attempt escalations and three
repo-incompatible local diffs). The code harness completed one narrow, single-file schema edit but
did not complete any multi-file or corpus task. Codex completed the production patches in draft PRs
[hugin#193](https://github.com/Magnus-Gille/hugin/pull/193),
[hugin#194](https://github.com/Magnus-Gille/hugin/pull/194), and
[gille-inference#246](https://github.com/Magnus-Gille/gille-inference/pull/246).

This does **not** support routing general code tickets to either M5 path today. It does support a
narrow harness lane for tiny, explicitly seeded, mechanically checked single-file edits — still
behind L1 review.

## Campaign shape

Tickets:

1. Hugin #190/#183 — complete Munin enumeration and starvation-free FIFO claiming.
2. Hugin #191 — mirror the additive `draft` / `conversation` task taxonomy.
3. gille-inference #158 — ground-truth triage/review scout probes and misconfiguration diagnostics.

The Hugin one-shot calls used structured parent ids `m5h-2026-07:hugin#190`,
`m5h-2026-07:hugin#191`, and `m5h-2026-07:gille-inference#158`. `code_loop_start` has no structured
`parent_task_id` field; each harness instruction therefore carried the same logical parent prefix,
and this report is the durable work-id mapping. That API gap should not be hidden by pretending the
field exists.

All one-shot calls had one attempt, a deterministic `containsAll` acceptance contract, and were
rated through `hugin_rate` after L1 inspection. No M5 output was merged.

## One-shot plane

| Parent / subtask | Hugin task | Local result | Wall | L1 rating |
|---|---|---:|---:|---|
| hugin#191 schema | `mcp-m5-fd85dca2ba96d709f4aa327c` | routing-table frontier escalation; no local attempt/output | <1s runtime | redo / escalated |
| hugin#190 pagination | `mcp-m5-0e792acdac73b4532da30b48` | Mellum partial (1/3 verifier strings); fabricated Python paths mixed with Vitest | 14s | redo / discarded |
| hugin#190 dispatcher | `mcp-m5-9f1acd7417c228867b4f772f` | routing-table frontier escalation; no local attempt/output | <1s | redo / escalated |
| gi#158 triage | `mcp-m5-c511d5acbd57c903a01fee96` | Mellum failed 0/3; nonexistent paths and repeated empty diff headers | 72s | redo / discarded |
| gi#158 review corpus | `mcp-m5-e28b968877948a6a770c2e4a` | Mellum partial 2/4; placeholder `modelScout` paths, no real probes | 10s | redo / discarded |
| gi#158 diagnostics | `mcp-m5-e2bea3c430ad31eacdf5bd8a` | routing-table frontier escalation; no local attempt/output | <1s | redo / escalated |

The one-shot path was fast, but it had no repository files. Its local model invented plausible
project structure and even mixed languages. Substring acceptance correctly avoided calling those
responses passes, but it cannot make an ungrounded diff applicable.

## Harness plane

Official leaves used seeded repository files, a protected deterministic check, and hard caps. The
reported turn count is the harness's actual iteration counter.

| Parent / subtask | Work id | Result | Wall / turns | Source files changed | Check |
|---|---|---|---:|---:|---|
| hugin#190 pagination | `cl-20260713-029bcbf3` | cap-exceeded | 47.7s / 13 | 0 | not run |
| hugin#190 dispatcher | `cl-20260713-f4d804c4` | cap-exceeded | 80.9s / 13 | 0 | not run |
| hugin#191 schema | `cl-20260713-3d3ec05f` | completed | 40.6s / 10 | 1 | pass |
| gi#158 triage corpus | `cl-20260713-44cc62f1` | cap-exceeded | 40.6s / 13 | 0 | not run |
| gi#158 review corpus | `cl-20260713-3341385e` | cap-exceeded | 189.7s / 11 | 0 | not run |
| gi#158 diagnostics | `cl-20260713-9edd2871` | cap-exceeded | 40.7s / 13 | 0 | not run |

The successful schema leaf made the correct minimal two-line addition to
`src/broker/types.ts`; its protected check passed. It did not add the ticket's MCP and HTTP
regressions, so the leaf is **partial ticket value**, not a shippable #191 solution. A setup run that
included both test suites (`cl-20260713-53f6e04e`) hit the 600s cap after seven turns and changed
only generated npm/vitest files; it is excluded from the six official leaves but retained as
multi-file setup evidence.

## Comparison

| Dimension | One-shot | Code harness |
|---|---|---|
| Repository grounding | none; invented paths in all three local attempts | real seeded files |
| Accepted ticket output | 0/6 | 0/6 complete tickets; 1/6 useful narrow partial |
| Latency | 0–72s runtime | 41–190s official leaves; setup run 604s |
| Iteration | one completion only | 10–13 turns (7 in long setup run) |
| Multi-file evidence | invalid fabricated diffs | no successful multi-file change |
| Failure mode | fast escalation or confident repo hallucination | spends turns inspecting/planning, reaches turn/wall cap before editing |
| Verification | output-only substring verifier + L1 rating | protected local check, but only one leaf reached it |

The harness is better grounded, but grounding alone did not make it an effective multi-file coding
agent. Its successful envelope was roughly: one source file, one obvious additive edit, a tiny
protected check, and no test authoring. The failure envelope includes 365–5,907-line source files,
multi-file integration, and new evaluation corpora.

## Decision

- Keep M5 one-shot disabled for code-edit tasks; the current frontier gap escalation is safer than
  accepting repo-free diffs.
- Keep the harness experimental and explicit-only. Candidate use: one small seeded file, a fully
  local mechanical check, short caps, and mandatory L1 diff review.
- Do not claim multi-file harness capability from this wave.
- Before wave 6, fix harness hygiene so generated `.npm` / `.vite` files are ignored, add a native
  campaign parent field to `code_loop_start`, and instrument time-by-phase (inspect/edit/check).
- Re-test multi-file work only after the loop can reliably make an edit before exhausting its cap.

## Production outcomes

M5 results were evidence only. The actual fixes were independently implemented and verified:

- Hugin #190 + residual #183: PR #193; 98 files / 1,662 tests green.
- Hugin #191: PR #194; 97 files / 1,661 tests green.
- gille-inference #158: PR #246; typecheck and 144 files / 2,369 tests green.

No merge or deployment was performed by this wave.
