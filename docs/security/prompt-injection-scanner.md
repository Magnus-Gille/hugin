# Prompt-Injection Scanner for Context-Refs

**Status:** shipped
**Issue:** [#10](https://github.com/Magnus-Gille/hugin/issues/10)
**Relates to:** `lethal-trifecta-assessment.md` §7.4 (Priority 2)

## What it does

Every Munin entry fetched via a task's `Context-refs:` field is scanned for
known prompt-injection patterns before it is injected into the model prompt.
Detections are surfaced to the caller and enforced per the configured
policy.

The scanner lives in `src/prompt-injection-scanner.ts` and is wired into
`resolveContextRefs` in `src/context-loader.ts`. It is a pure,
regex-driven detective control — no model calls, no external dependencies.

## Patterns

| ID | Severity | What it catches |
|----|----------|-----------------|
| `instruction-override` | high | `ignore previous instructions`, `disregard the above rules`, `forget your prior directives`, `override the system prompt` |
| `system-block` | high | Fake turn markers: `### SYSTEM:`, `<\|system\|>`, `<\|im_start\|>`, `[SYSTEM]`, `<system>` |
| `exfil-command` | high | Outbound HTTP commands: `curl https://…`, `wget https://…`, `fetch("https://…")`, `Invoke-WebRequest` |
| `role-hijack` | medium | `you are now`, `from now on, you…`, `act as`, `pretend to be`, `roleplay as` |
| `credential-read` | medium | Read-like verbs paired with `.env`, `.ssh/`, `id_rsa`, `credentials.json`, `*_API_KEY` |
| `hidden-unicode` | medium | Zero-width chars (`U+200B–U+200F`), BOM, bidirectional overrides (`U+202A–U+202E`, `U+2066–U+2069`) |

The scanner returns the worst severity observed plus every distinct match
with a short snippet for log forensics.

## Policy modes

Set `HUGIN_INJECTION_POLICY` to control enforcement. Default: `warn`.

| Policy | Threshold | Effect |
|--------|-----------|--------|
| `off` | — | Disable scanner; ref content is injected as-is. |
| `warn` | medium | Flagged refs are injected with a prepended warning banner instructing the model to treat the content as untrusted data. |
| `block` | high | Flagged refs are replaced with a quarantine notice (`[quarantined: …]`). Task proceeds with remaining refs. |
| `fail` | high | Task is rejected with a security-policy error. No runtime is invoked. |

The `warn` default is chosen to be detective-only and non-breaking: every
flagged entry shows up in logs and task output without interrupting
scheduled work. Upgrade to `block` or `fail` once the false-positive rate
on real traffic is understood.

## Observables

- **Logs:** `[injection] ref=<ref> severity=<s> policy=<p> patterns=[…]` is
  emitted by `resolveContextRefs` for each flagged ref.
- **Ollama journal:** each ollama task's journal entry gains
  `injection_policy`, `injection_max_severity`, and
  `context_refs_quarantined`.
- **Task failure:** policy=`fail` tasks are rejected with reason
  `Task rejected by HUGIN_INJECTION_POLICY=fail: context-ref "…" matched
  <severity>-severity prompt-injection patterns […]`, visible in the
  human-readable `result` doc and `result-structured`.

## Limitations

- **Regex-based, not semantic.** A creative attacker can paraphrase past
  the patterns (e.g., "please override what you were told before"). This
  is a first-line filter, not a complete defense.
- **No task-prompt scanning.** The scanner runs against Munin context
  only. Prompts submitted directly in `### Prompt` are out of scope for
  this PR.
- **No auto-tuning.** The pattern list is static. Revisit after a few
  weeks of logs to trim false positives and add observed real-world
  payloads.

## What this doesn't address

- **Task prompt injection** — tasks submitted by a compromised agent can
  still carry adversarial instructions in the prompt itself. Issue #11
  (cryptographic task signing) addresses submitter authenticity.
- **Repo content injection** — poisoned `CLAUDE.md` or source comments
  inside a target repo are not scanned; this remains a known gap (see
  Scenario B in the trifecta assessment).
- **Exfiltration at runtime** — a model that does follow an injected
  instruction can still exfiltrate via curl/git/HTTP. Issue #13 tracks
  exfiltration pattern detection in task results.
