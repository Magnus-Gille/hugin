# Cryptographic Task Signing

**Status:** Hugin-side verification shipped; submitter rollout pending
**Issue:** [#11](https://github.com/Magnus-Gille/hugin/issues/11)
**Relates to:** `lethal-trifecta-assessment.md` §7.5 (Priority 2)

## Why

`Submitted by:` is a plain text field in the task body. Any agent with
Munin write access to `tasks/*` can impersonate a trusted submitter by
setting `Submitted by: claude-desktop` and pass the existing allowlist
check. Signing binds the security-critical fields of a submission to a
shared secret that only the claimed submitter knows.

## Scheme (v1)

**Algorithm:** HMAC-SHA256 with per-submitter shared secrets.

**Why HMAC instead of Ed25519?** Grimnir is a closed personal system
with all submitters under one operator. Symmetric keys are simpler to
deploy and rotate. Upgrade to Ed25519 later if/when submitters leave
operator control.

**Signature format embedded in task body:**

```markdown
- **Signature:** v1:<keyId>:<hex-hmac>
```

- `v1` — scheme version
- `keyId` — identifies which key was used; typically the same as the
  submitter name (`Codex-desktop`, `ratatoskr`, etc.) but allows rotation
  (`Codex-desktop-2026q2`)
- `hex-hmac` — 64-char lowercase hex of the HMAC-SHA256 digest

**Canonical payload** (what actually gets hashed):

```
context-refs-sha256=<hex or empty>
prompt-sha256=<hex>
runtime=<runtime>
submitted-at=<iso-8601>
submitter=<submittedBy>
task-id=<taskId>
version=v1
```

- Fields sorted by key, newline-delimited, trailing newline
- Values are `\r\n`-stripped before signing — prevents
  canonicalisation attacks where an attacker smuggles a second field
  via an embedded newline
- `prompt-sha256` binds the exact prompt. The prompt is first
  canonicalised with `.trim()` on both sides (see `canonicalizePrompt`);
  otherwise trailing newlines in `--prompt-file` input break
  verification for every multi-line prompt
- `context-refs-sha256` binds the sorted ref list (prevents an
  attacker from adding a new client-confidential ref to a pre-signed
  task)

**`Runtime: auto` tasks** are signed with `runtime=auto`. The dispatcher
reads the literal declared runtime from the task body at verify time,
not the runtime the router later picks — otherwise auto-routed
submissions would never verify.

**Key-to-submitter binding.** `verifyTaskSignature` rejects with
`submitter-mismatch` unless the `keyId` equals the claimed submitter or
is a rotation alias of the form `<submitter>-<rotation>` (e.g.
`Codex-desktop-2026q2`). Without this, any signer holding a configured
key could mint signatures impersonating a different submitter.

The canonical-payload rules are mirrored between
`src/task-signing.ts` and `scripts/sign-task.mjs` — there is a test
(`tests/task-signing.test.ts` "cross-language drift guard") that
spawns the helper and asserts byte-for-byte equality with the Node
module.

## Policy modes

Set `HUGIN_SIGNING_POLICY` on the Pi:

| Policy | Effect |
|--------|--------|
| `off` (default) | Signature is not verified. Results record `signatureStatus: "unverified"`, `verifiedSubmitter: null`, and any parseable claimed `keyId`; this must never be interpreted as valid identity. Zero-breakage default for the rollout period. |
| `warn` | Verify when a signature is present; log missing / invalid / unknown-signer / submitter-mismatch / malformed. Never rejects. |
| `require` | Reject any task that is missing a valid signature from a known signer. Pipeline parent tasks are rejected (v1 cannot bind ### Pipeline bodies yet); internally-generated children (`Submitted by: hugin`) are exempted. |

An unrecognised value (typo such as `requrie`) fails startup rather
than silently falling back to `off`: a security control must never
degrade itself because of a misconfiguration.

Rollout plan:
1. Ship `off` (this PR)
2. Roll out signing helpers to every submitter
3. Flip Pi to `warn`, watch logs for stragglers
4. Flip to `require` once the log is clean for ≥72h

## Result provenance

Every current dispatcher terminal result, including pipeline parents, carries
an additive `provenance` object in `result-structured`:

```json
{
  "claimedSubmitter": "codex-cli",
  "verifiedSubmitter": "codex-cli",
  "policy": "require",
  "signatureStatus": "valid",
  "keyId": "codex-cli"
}
```

`verifiedSubmitter` is non-null only after a valid HMAC check. Policy `off`, a
missing/invalid/expired/future-skewed/mismatched signature, pipeline-v1
limitations, and the internal-Hugin exemption all leave it null. Hugin also
appends the same fields to the task lifecycle log as a `[provenance]` record.
The field is optional in the schema only so historical schemaVersion 1 results
remain readable; current dispatcher writers always populate it.

## Keys

Keys are loaded at Hugin startup from either:

- **`HUGIN_SUBMITTER_KEYS`** — inline JSON, e.g.
  `{"Codex-desktop":"<hex>", "ratatoskr":"<hex>"}`
- **`HUGIN_SUBMITTER_KEYS_FILE`** — path to a JSON file with the same
  shape. Takes precedence over the inline var when both are set.

**Secret format:** 64-char hex (32 bytes) is the production contract.
Base64 (≥16 decoded bytes) is accepted for convenience (e.g. copy-paste
from password managers). Raw UTF-8 is a last-resort fallback for local
testing only — do not deploy non-hex secrets.

**Key generation** (do once per submitter):

```bash
openssl rand -hex 32
# or: node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
```

Distribute the secret to the submitter by any secure channel (1Password
items, Bitwarden, sealed envelope, etc.). The submitter stores it as
the environment variable `HUGIN_SIGNING_SECRET`. **Never** commit secrets
to the repo or log them.

## Registering the `claude-code` keyId (laptop signing)

The laptop `claude-code` submitter signs without a Pi round-trip by reading its
secret from the macOS Keychain via `scripts/hugin-sign` (modelled on the
`m5-auth` / himalaya pattern — the secret lives once in the Keychain, never in a
dotfile or scratchpad). One-time setup binds the **same** hex secret to two
places: the laptop Keychain (signer side) and the Pi's `HUGIN_SUBMITTER_KEYS`
(verifier side).

```bash
# 0. Install hugin-sign onto PATH so it resolves as a bare command (once).
ln -sf "$PWD/scripts/hugin-sign" ~/.local/bin/hugin-sign   # run from the hugin repo root

# 1. Generate the secret and store it straight into the laptop Keychain (signer
#    side) — it is never echoed or left in a shell variable. `-U` upserts on rotation.
security add-generic-password -s hugin-signing -a claude-code -U -w "$(openssl rand -hex 32)"

# 2. Register the SAME secret on the Pi as the `claude-code` keyId (verifier side),
#    merging into the existing HUGIN_SUBMITTER_KEYS in /home/magnus/repos/hugin/.env,
#    then restart Hugin. An operator with Pi access reads the value back from the
#    Keychain at that moment (e.g. `hugin-sign`) — it never transits the repo or a log.
```

Once both sides hold the secret, `hugin-sign` returns it locally and
`sign-task.mjs --submitter claude-code --key-id claude-code` produces a
signature the Pi verifies. The `keyId` must equal the submitter (`claude-code`)
or be a `claude-code-<rotation>` alias.

## Registering a non-Claude tenant keyId

Use a tenant's own stable identity as both `Submitted by` and `keyId`; never
reuse another tenant's signer. For example, to provision `codex-cli`:

1. Generate a dedicated 32-byte secret on the tenant host and store it in that
   tenant's credential store or environment as `HUGIN_SIGNING_SECRET`.
2. Add the same secret under the exact `codex-cli` key in the Pi's
   `HUGIN_SUBMITTER_KEYS` (or its keys file) and add `codex-cli` to
   `HUGIN_ALLOWED_SUBMITTERS`.
3. Sign with `--submitter codex-cli --key-id codex-cli`; rotation keys may use
   `codex-cli-<rotation>` while retaining `Submitted by: codex-cli`.
4. Validate under `warn` until both the lifecycle log and
   `result-structured.provenance` report `verifiedSubmitter: "codex-cli"`, then
   include that tenant in the readiness decision for `require`.

Generate and transfer the shared secret through a secure channel; never print
it into task content, logs, or repository files.

## Signing a task (submitter side)

```bash
HUGIN_SIGNING_SECRET=$(hugin-sign) node scripts/sign-task.mjs \
  --task-id 20260420-180000-a1b2 \
  --submitter claude-code \
  --submitted-at 2026-04-20T18:00:00Z \
  --runtime claude \
  --prompt-file /tmp/prompt.md \
  --key-id claude-code
# → v1:claude-code:abcdef1234...

# Or, for any submitter with the secret already in env:
HUGIN_SIGNING_SECRET=<hex> node scripts/sign-task.mjs \
  --task-id 20260420-180000-a1b2 \
  --submitter Codex-desktop \
  --submitted-at 2026-04-20T18:00:00Z \
  --runtime claude \
  --prompt-file /tmp/prompt.md \
  --context-refs "projects/hugin/status,meta/conventions/status"
# → v1:Codex-desktop:abcdef1234...
```

Embed the output in the task body:

```markdown
## Task: Example

- **Runtime:** claude
- **Submitted by:** Codex-desktop
- **Submitted at:** 2026-04-20T18:00:00Z
- **Context-refs:** projects/hugin/status, meta/conventions/status
- **Signature:** v1:Codex-desktop:abcdef1234...

### Prompt
Do the thing.
```

## Threat model

**What this defends against:**
- A compromised agent with Munin write access spoofing `Submitted by:`
  to impersonate a trusted submitter
- Replay of a captured signature against a different task (the
  `task-id` binding prevents this within one Munin namespace)
- Prompt/context-ref swaps on an already-signed task

**What this does NOT defend against:**
- **Key compromise.** If the submitter's host is fully compromised,
  the attacker can sign arbitrary tasks. Use short-lived keys and
  rotate on suspicion.
- **Replay across time.** A signature with the same `task-id` +
  metadata is still valid forever. Munin's UUID-per-task-id is the
  de-facto nonce; if task-ids ever collide, this breaks.
- **Pipeline parent tasks.** The v1 canonical payload binds
  `prompt-sha256`; pipelines declare a `### Pipeline` body instead.
  `require` mode rejects pipeline parents until a pipeline-aware
  scheme ships. Internally-generated child phase tasks are
  dispatcher-trusted (exempt via `Submitted by: hugin`).
- **Submitter allowlist bypass.** Signing is checked *after* the
  submitter allowlist; both layers must pass. An invalid submitter
  with a valid signature still fails.

## Submitter rollout status

| Submitter | Status | Notes |
|-----------|--------|-------|
| Ratatoskr | ✅ wired | `src/task-signing.ts` + `RATATOSKR_SIGNING_SECRET`. Cross-drift test spawns `sign-task.mjs`. |
| `/submit-task` skill (claude-code) | ⚠️ needs key registration | This row previously claimed "✅ wired", but the laptop shell never set `HUGIN_SIGNING_SECRET`, so Step 7b's signing silently skipped (hugin#119). This repo adds `scripts/hugin-sign` (reads the secret from the macOS Keychain — service `hugin-signing`, account `claude-code`); the skill's Step 7b is updated to call it in a companion `claude-skills-private` PR. Even with both, verification requires a `claude-code` entry in the Pi's `HUGIN_SUBMITTER_KEYS` — see "Registering the claude-code keyId" below. Until that key is registered, submissions are unsigned (fine under `off`/`warn`). |
| claude-desktop / claude-web / claude-mobile | ⬜ deferred | No shell access to run the helper. Needs a Munin-side signer or a chat-host delegate before `require` is safe. |
| Codex CLI (codex-desktop / codex-web / codex-mobile) | ⬜ deferred | Codex submits via `memory_write` MCP — needs either a CLI wrapper or an MCP signing tool. |

## Known follow-ups

- Pipeline task signing — the `Runtime: pipeline` branch skips HMAC
  verification because its parsed fields differ; add a pipeline-aware
  canonical payload when pipeline submitters adopt signing.
- Optional Ed25519 upgrade path once signing is stable.
