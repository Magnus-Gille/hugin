# Hugin — Status

**Last session:** 2026-05-31
**Branch:** feat/56-opf-pii-eval-harness (PR #96 open, not yet merged)

## Completed This Session (2026-05-31)

### Stale PR cleanup
- **Closed PR #62** (stale since Apr 24): verified it was fully superseded by `finalizeTaskCompletion` in `src/task-helpers.ts` (the `// --- Atomic task completion (#57) ---` section). Issue #57 was already closed. Left a comment explaining the supersession.

### #56 OPF eval — fully executed and concluded
Complete end-to-end on the Pi. Two commits on `feat/56-opf-pii-eval-harness`, PR #96 open.

**Harness built** (`src/privacy-filter/`, `eval/privacy-filter/`, scripts):
- `pii-types` — OPF 8-label taxonomy
- `pii-regex-baseline` — first span-level PII detector Hugin has had
- `opf-output` — parses OPF redaction + predictions JSONL
- `pii-scorer` — P/R/F1 under exact/relaxed/detection, per-label, clean FP
- `fixtures.ts` + generator script — 24 labelled Grimnir-shaped examples (EN+SV) + 10 clean probes, in OPF's native eval format, all PII fabricated
- `run-pii-eval.ts` + `bench-opf.sh` — orchestrator + host benchmark script
- 31 new tests; full suite 925 green; tsc strict clean

**Pi execution** (connected directly via SSH):
- OPF installed in isolated venv; 2.8 GB model downloaded
- Found + fixed blocker: Pi 5 A76 lacks bf16 → mkldnn hard-error → `torch.backends.mkldnn.enabled=False` fix
- Ran `opf eval` over 24 fixtures + 10 clean examples
- Pi scratch dir cleaned post-eval (~7.4 GB reclaimed)

**Results / verdict** (`docs/security/privacy-filter-evaluation.md`):

| Detector | Typed F1 | Detection R | Clean FP |
|---|---|---|---|
| regex-baseline | **90.0%** | 93.0% | 10% |
| opf | 86.5% | 90.1% | 10% |
| regex ∪ opf | 80.0%¹ | **98.6%** | 20% |

- OPF wins on free-form **addresses** (40%→100%); loses on dates + Swedish account IDs
- Latency: 44 s load, 8.8 tok/s, 324 s for 10 KB → inline on Pi **ruled out**
- **Verdict: reject OPF-replaces-regex**; keep regex inline; OPF earns async person/address role on a faster host if/when one exists

¹ Union precision understated by scorer (doesn't merge overlapping spans); 98.6% detection recall is the meaningful number.

## Open Issues (unchanged)
- **#84** skill-distillation go-live capstone: infrastructure-gated (needs real ollama Qwen3-Coder-30B cell on Pi + authored slice-one content)
- **#56** evaluated + verdict reached (PR #96 pending merge)

## PRs
- **#96** feat(eval): OPF PII harness + Pi results — open, ready to merge

## Next Steps
1. Merge PR #96 (close #56 as "evaluated: rejected for now")
2. **#84 go-live**: wire `selectSkillRoute` into dispatch; author slice-one skill content + cell; stand up Qwen3-Coder-30B on Pi
3. Update `~/.claude/skills/research-spike/SKILL.md` (delivery deployed+verified; mentioned in prior session notes)
4. Enable broker on Pi

## Key state
- Branch `feat/56-opf-pii-eval-harness` has 2 commits since main; PR #96 open
- `main` is clean at `fadc0f4`
- src/skill/ system on main (fail-closed); HUGIN_SKILL_LANE=off until go-live
- Pi: Hugin @ main, worker_id `hugin-huginmunin`, bubblewrap installed; scratch clean
- OPF findings: `docs/security/privacy-filter-evaluation.md`; raw Pi artifacts: `eval/privacy-filter/results/huginmunin/`
- Gotcha: Agent `isolation:worktree` branches from `main`, not the current local branch
