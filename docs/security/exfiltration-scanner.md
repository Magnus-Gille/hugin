# Exfiltration Scanner for Task Results

**Status:** shipped
**Issue:** [#13](https://github.com/Magnus-Gille/hugin/issues/13)
**Relates to:** `lethal-trifecta-assessment.md` §7.4 (Priority 2)

## What it does

Every finalized task result is scanned for patterns that suggest data
leakage before the result is written to Munin. Detections are logged,
optionally surface as `security:exfil-*` tags on the result entry, and
optionally cause the leaking spans to be redacted in both the
human-readable and structured result bodies.

The scanner lives in `src/exfiltration-scanner.ts` and is wired into the
result-write path in `src/index.ts`. It is a pure, regex-driven
detective control — no model calls, no external dependencies.

This is the symmetric counterpart to the prompt-injection scanner
(`src/prompt-injection-scanner.ts`): that one guards what the model is
fed; this one guards what the model emits.

## Patterns

| ID | Severity | What it catches |
|----|----------|-----------------|
| `private-key` | high | PEM headers: `-----BEGIN (RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP|ED25519|PRIVATE) [PRIVATE] KEY-----` |
| `api-key` | high | Common API-key shapes: Anthropic `sk-ant-...`, OpenAI `sk-…`/`sk-proj-…`, GitHub `ghp_`/`ghs_`/`gho_`/`ghu_`/`ghr_`, Slack `xox[baprs]-…`, AWS `AKIA…`, Google `AIza…`, and generic `Bearer <jwt>` |
| `exfil-command` | high | Outbound HTTP with payload: `curl -X POST` / `--data` / `--post-data` / `--upload-file`, `wget --post-data`, `Invoke-WebRequest … -Method POST`, `fetch('https://…', { method: 'POST' })` |
| `exfil-url` | medium | URLs with query parameters carrying sensitive keys (`?data=…`, `?token=…`, `?secret=…`, `?password=…`, `?access_token=…`, `?exfil=…`, etc.) |
| `base64-blob` | low | Contiguous base64-ish runs of ≥256 characters with no whitespace |

The scanner returns the worst severity observed plus every distinct
match with a short snippet for log forensics.

## Policy modes

Set `HUGIN_EXFIL_POLICY` to control enforcement. Default: `warn`.

| Policy | Effect |
|--------|--------|
| `off` | Disable scanner; result is written as-is. |
| `warn` | Scan and log findings; append a `### Security Scan` section to the human-readable result. Body is not modified. |
| `flag` | Same as `warn`, plus tag the result entry with `security:exfil-suspected` and `security:exfil-<severity>` so downstream alerting can filter on it. |
| `redact` | Same as `flag`, plus replace every matching span in both the markdown and structured result bodies with `[redacted: <pattern>]`. |

The `warn` default is detective-only and non-breaking. Upgrade to `flag`
once tagging is wired into alerts, and `redact` once the false-positive
rate on real traffic is understood.

## Observables

- **Logs:** `[exfil] task=<ns> severity=<s> policy=<p> patterns=[…] count=<n>` is
  emitted for every flagged task.
- **Result entry tags:** under `flag` or `redact`, `security:exfil-suspected`
  and `security:exfil-<severity>` are attached to the `result` entry.
- **Human-readable result:** a `### Security Scan` section is appended
  when any pattern matched, with severity, pattern ids, match count, and
  the policy that was applied.
- **Structured result:** under `redact`, `bodyText` and `errorMessage`
  carry the redacted string. No new schema fields — this is intentional
  for v1 to keep the schema stable.

## Limitations

- **Regex-based, not semantic.** A creative attacker can paraphrase past
  the patterns (for example, base64-encoding a key before writing it,
  or splitting a token across whitespace).
- **No input-prompt scanning.** The scanner only runs against the task
  output. Prompts are covered by the prompt-injection scanner.
- **No auto-tuning.** The pattern list is static. Revisit after a few
  weeks of logs to trim false positives and add observed real-world
  payloads.
- **Timeout partial results skipped.** When an SDK task times out and
  the dispatcher writes a partial result from the timeout handler
  before the main result-write path runs, the scanner does not run on
  that partial body. The main path still scans if a later write happens.
- **`base64-blob` is noisy.** Left at `low` on purpose so it does not
  dominate the severity rollup. Most real hits are model output or
  pasted diff hunks; upgrade the severity only after pattern
  fingerprints are in place.

## What this doesn't address

- **Out-of-band exfiltration** — a compromised runtime can still exfil
  via a side channel (DNS, Git push, a local file write). The scanner
  only sees what ends up in the task result body.
- **Input injection** — see `docs/security/prompt-injection-scanner.md`.
- **Submitter authenticity** — see `docs/security/task-signing.md`
  (issue #11).
