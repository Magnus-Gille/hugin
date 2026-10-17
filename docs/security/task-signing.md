# Cryptographic Task Signing

**Status:** Hugin v2 implementation; producer migration pending
**Issue:** [#11](https://github.com/Magnus-Gille/hugin/issues/11)
**Relates to:** `lethal-trifecta-assessment.md` §7.5 (Priority 2)

## Why

`Submitted by:` is a plain text field in the task body. Any agent with Munin
write access to `tasks/*` can impersonate a trusted submitter by setting
`Submitted by: claude-desktop` and pass the existing allowlist check. A task
signature authenticates the claimed submitter and the complete task document.

## Scheme (v2)

**Algorithm:** HMAC-SHA256 with per-submitter shared secrets.

**Why HMAC instead of Ed25519?** Grimnir is a closed personal system with all
submitters under one operator. Symmetric keys are simpler to deploy and rotate.
Upgrade to Ed25519 later if submitters leave operator control.

**Signature format:** one standalone metadata line before the first
`### Prompt` or `### Pipeline` marker:

```markdown
- **Signature:** v2:<keyId>:<hex-hmac>
```

- `v2` is the scheme version.
- `keyId` identifies the key. It usually equals the submitter name
  (`Codex-desktop`, `ratatoskr`, etc.) and can include a rotation suffix such
  as `Codex-desktop-2026q2`.
- `hex-hmac` is the 64-character lowercase HMAC-SHA256 digest.

**Canonical payload** (the exact newline-delimited text passed to HMAC):

```
submitted-at=<iso-8601>
submitter=<submittedBy>
task-body-sha256=<sha256>
task-id=<taskId>
version=v2
```

Fields are sorted by key and end with a newline. The body hash is SHA-256 of
the entire UTF-8 task document after converting CRLF to LF. For one
well-formed standalone metadata Signature line, the signature value is replaced
by the fixed text `__HUGIN_SIGNATURE_VALUE__`; the line's exact position,
spelling, and all other body content and whitespace remain significant. Thus
moving the line or changing `- **Signature:**` to another spelling invalidates
the HMAC. The first `### Prompt` or `### Pipeline` line ends the metadata
prefix: Signature-looking text inside the prompt or pipeline body remains
signed content and cannot provide authentication. Duplicate or malformed
metadata Signature lines fail verification. A task without either section
marker is unsupported and fails signing explicitly.

For an unsigned task, the canonical representation includes a placeholder
Signature line immediately before the blank line preceding the first section
marker, or directly before that marker when no blank line is present. Producers
should insert or replace the real line with the exported
`setTaskSignature(taskBody, signature)` helper in `src/task-signing.ts`. It
uses that deterministic insertion slot and replaces existing signature values
without moving or respelling their line. Do not insert the raw CLI output at a
different position or spell the field differently.

The full body binds runtime, prompt, context and context refs, permissions,
capabilities, sensitivity, model, fallback, delivery/artifact declarations,
pipeline metadata, and fields Hugin may add in the future. The task ID,
submitter, and submitted-at value are also bound as separate canonical fields.
Munin lifecycle tags are outside the task document and are not authenticated by
this scheme.

`Runtime: auto` is part of the signed document. Hugin verifies the submitted
body before routing and does not substitute the selected runtime into the
signed content.

**Key-to-submitter binding.** Verification rejects with `submitter-mismatch`
unless `keyId` equals the claimed submitter or is a rotation alias beginning
`<submitter>-`. A signer holding any configured key cannot mint signatures
for another submitter.

The canonical payload rules are mirrored between `src/task-signing.ts` and
`scripts/sign-task.mjs`. `tests/task-signing.test.ts` invokes the helper and
compares its signature with the in-process implementation, including an
existing signature line whose position is retained.

**Version migration:** v1 signatures are unsupported. They never establish a
verified identity and never satisfy `require`; Hugin does not fall back to v1
verification. Producers must migrate to v2 before a verifier running under
`require` is upgraded, or before `require` is first enabled.
The Ratatoskr producer update is an external rollout dependency and is not part
of this Hugin change.

## Policy modes

Set `HUGIN_SIGNING_POLICY` on the Pi:

| Policy | Effect |
|--------|--------|
| `off` (default) | Do not verify. Results record `signatureStatus: "unverified"`, `verifiedSubmitter: null`, and any parseable claimed `keyId`; this is never authenticated identity. |
| `warn` | Verify present signatures and log missing, invalid, unknown-signer, submitter-mismatch, unsupported-version, malformed, expired, or future-skewed signatures. Never rejects. |
| `require` | Reject tasks without a valid v2 signature from a known signer. Pipeline parent tasks remain rejected because their dispatch path is not admitted by this verifier. Unsigned internally generated tasks are also rejected; `Submitted by: hugin` never grants an exemption. |

An unrecognised value (for example, `requrie`) fails startup rather than
silently falling back to `off`.

Rollout:

1. Verify the current signing policy and inventory every required producer.
   Do not lower the policy to deploy this change.
2. Prepare the complete-task signing helper or an equivalent v2 producer for
   each submitter, including Ratatoskr. If `require` is active, coordinate the
   verifier and producer migration so required submissions remain authenticated;
   do not deploy either incompatible side on its own.
3. Where `warn` is already the authorized policy, resolve unsupported or invalid
   signatures before moving to enforcement. Validate v2 producer/verifier
   compatibility in an isolated test environment when `require` is active.
4. When enabling `require` for the first time, verify every required producer
   under v2 and require a clean warning log for at least 72 hours. This patch
   does not change the configured policy or authorize a policy downgrade.

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

`verifiedSubmitter` is non-null only after a valid v2 HMAC check. Policy `off`,
a missing, invalid, expired, future-skewed, mismatched, unsupported-version, or
malformed signature and pipeline limitations leave it null. Historical
`internal-exempt` results remain readable but never authenticate an identity. Hugin also appends the same fields to the task lifecycle log as
a `[provenance]` record. The field is optional in the schema only so historical
schemaVersion 1 results remain readable; current dispatcher writers always
populate it.

## Keys

Keys are loaded at Hugin startup from either:

- **`HUGIN_SUBMITTER_KEYS`** — inline JSON, for example
  `{"Codex-desktop":"<hex>", "ratatoskr":"<hex>"}`.
- **`HUGIN_SUBMITTER_KEYS_FILE`** — path to a JSON file with the same shape.
  It takes precedence over the inline variable when both are set.

**Secret format:** 64-character hex (32 bytes) is the production contract.
Base64 with at least 16 decoded bytes is accepted for convenience. Raw UTF-8 is
a testing fallback only; do not deploy non-hex secrets.

Generate a key once per submitter:

```bash
openssl rand -hex 32
# or: node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
```

Distribute the secret to the submitter through a secure channel. The submitter
stores it as `HUGIN_SIGNING_SECRET`. Never commit secrets to the repository or
log them.

## Registering the `claude-code` keyId (laptop signing)

The laptop `claude-code` submitter reads its secret from the macOS Keychain via
`scripts/hugin-sign`. One-time setup binds the same hex secret to the laptop
Keychain and the Pi's `HUGIN_SUBMITTER_KEYS`.

```bash
# Install hugin-sign onto PATH once, from the Hugin repository root.
ln -sf "$PWD/scripts/hugin-sign" ~/.local/bin/hugin-sign

# Generate the secret directly into the Keychain.
security add-generic-password -s hugin-signing -a claude-code -U -w "$(openssl rand -hex 32)"
```

Once the verifier has the same key, `hugin-sign` can supply the secret to the
v2 helper. The `keyId` must equal the task's `Submitted by` value or use a
`<submitter>-<rotation>` suffix.

## Registering a non-Claude tenant keyId

Use a tenant's own stable identity as both `Submitted by` and `keyId`; never
reuse another tenant's signer. For example, to provision `codex-cli`:

1. Generate a dedicated 32-byte secret on the tenant host and store it in that
   tenant's credential store or environment as `HUGIN_SIGNING_SECRET`.
2. Add the same secret under the exact `codex-cli` key in the Pi's
   `HUGIN_SUBMITTER_KEYS` (or its keys file) and add `codex-cli` to
   `HUGIN_ALLOWED_SUBMITTERS`.
3. Sign the complete task file with `--key-id codex-cli`; rotation keys may use
   `codex-cli-<rotation>` while retaining `Submitted by: codex-cli` in the
   document.
4. Validate under `warn` until the lifecycle log and
   `result-structured.provenance` report `verifiedSubmitter: "codex-cli"`, then
   include that tenant in the readiness decision for `require`.

Transfer the shared secret through a secure channel. Never put it into task
content, logs, or repository files.

## Signing a task (submitter side)

Create the complete task document with its final metadata and prompt. Sign the
whole file; the helper reads `Submitted by` and `Submitted at` from that same
metadata prefix. It requires both `--task-file` and `--task-id` and does not
invent a current timestamp.

```bash
HUGIN_SIGNING_SECRET=$(hugin-sign) node scripts/sign-task.mjs \
  --task-file /tmp/task.md \
  --task-id 20260420-180000-a1b2 \
  --key-id claude-code
# → v2:claude-code:abcdef1234...
```

Insert or replace the output with `setTaskSignature()` so it occupies the
canonical slot and retains that slot after signing. The helper inserts the line
before the blank line preceding the first prompt or pipeline marker (or
directly before the marker when no blank line is present). Do not move or
respell the line after signing, and do not alter any other body content or
whitespace:

```markdown
## Task: Example

- **Runtime:** auto
- **Submitted by:** Codex-desktop
- **Submitted at:** 2026-04-20T18:00:00Z
- **Context-refs:** projects/hugin/status, meta/conventions/status
- **Signature:** v2:Codex-desktop:abcdef1234...

### Prompt
Do the thing.
```

## Threat model

**What this defends against:**

- A compromised agent with Munin write access spoofing `Submitted by:` to
  impersonate a trusted submitter.
- Changing any task-document field, including newly introduced fields, after
  it has been signed.
- Replaying a captured signature against a different task ID.
- Replacing prompt text or adding prompt content that resembles a Signature
  field; prompt text remains body content and cannot act as the signature.
- Moving the metadata Signature line or changing its spelling after signing;
  the canonical hash preserves both.

**What this does not defend against:**

- **Key compromise.** An attacker controlling a submitter host with its key can
  sign arbitrary tasks. Use short-lived keys and rotate on suspicion.
- **Replay of the same task document.** A signature with the same task ID,
  submitter, submitted-at value, and body remains valid until its freshness
  window expires. Munin's UUID-per-task-id is the de-facto nonce.
- **Munin lifecycle tags.** Tags are not part of the task document and are not
  covered by this signature scheme.
- **Pipeline parent execution.** The current dispatcher continues to reject
  pipeline parents under `require`; v2 signing alone does not enable them.
  Unsigned internally generated child tasks are also rejected. Their claimed
  `Submitted by: hugin` identity cannot grant an exemption.
- **Submitter allowlist bypass.** Signing is checked after the submitter
  allowlist; both layers must pass.

## Submitter rollout status

| Submitter | Status | Notes |
|-----------|--------|-------|
| Ratatoskr | ⚠️ v2 migration required | Existing producer signs v1; update in the owning Ratatoskr repository is a rollout dependency before `require`. |
| `/submit-task` skill (claude-code) | ⚠️ needs producer migration and key registration | The skill must sign a complete task file with v2 and call `hugin-sign`; verification also requires a `claude-code` key in the Pi's `HUGIN_SUBMITTER_KEYS`. Until then, submissions are not authenticated. |
| claude-desktop / claude-web / claude-mobile | ⬜ deferred | No shell access to run the helper. Needs a Munin-side v2 signer or a chat-host delegate before `require` is safe. |
| Codex CLI (codex-desktop / codex-web / codex-mobile) | ⬜ deferred | Codex submits via `memory_write` MCP and needs a v2 CLI wrapper or MCP signing tool. |

## Known follow-ups

- Migrate Ratatoskr and other submitters to v2 in their owning repositories.
- Add a separately reviewed pipeline-parent admission and verification path if
  signed pipeline submissions are needed.
- Consider an Ed25519 upgrade if signing becomes cross-operator.
