/**
 * Task submission signing and verification.
 *
 * Protects against submitter spoofing: the `Submitted by:` field is
 * plain text, so any agent with Munin write access to `tasks/*` can
 * impersonate a trusted submitter. Signing binds the critical task
 * metadata (submitter, runtime, prompt, context-refs) to a shared
 * secret that only the claimed submitter knows.
 *
 * v1 design — HMAC-SHA256 with per-submitter shared secrets:
 *   - Signature field embedded in task body: `**Signature:** v1:<keyId>:<hex>`
 *   - Canonical payload: newline-delimited, sorted `key=value` pairs
 *     over the security-critical fields (see CANONICAL_FIELDS below)
 *   - Comparison is constant-time via crypto.timingSafeEqual
 *
 * Policy enforcement lives in the dispatcher. This module is pure:
 * given a SigningParams + Signature + KeyStore, it returns a
 * VerificationResult. The caller decides whether to warn or reject.
 *
 * See docs/security/task-signing.md.
 */

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";

export const SIGNATURE_VERSION = "v1" as const;

export interface SigningParams {
  taskId: string;
  submitter: string;
  submittedAt: string;
  runtime: string;
  prompt: string;
  contextRefs?: string[];
}

export interface ParsedSignature {
  version: string;
  keyId: string;
  hex: string;
}

export type VerificationStatus =
  | "valid"
  | "invalid"
  | "missing"
  | "unknown-signer"
  | "submitter-mismatch"
  | "malformed"
  | "unsupported-version"
  | "expired"
  | "future-skew";

/**
 * Status recorded in task provenance. `unverified` is deliberately distinct
 * from `valid`: policy=off means Hugin did not authenticate the signature.
 * `internal-exempt` and `unverifiable` describe policy exceptions, not proof
 * of the claimed identity.
 */
export const TASK_SIGNATURE_STATUSES = [
  "valid",
  "invalid",
  "missing",
  "unknown-signer",
  "submitter-mismatch",
  "malformed",
  "unsupported-version",
  "expired",
  "future-skew",
  "unverified",
  "internal-exempt",
  "unverifiable",
] as const;
export type TaskSignatureStatus = (typeof TASK_SIGNATURE_STATUSES)[number];

export const SIGNING_POLICIES = ["off", "warn", "require"] as const;

export interface VerificationResult {
  status: VerificationStatus;
  keyId?: string;
  reason?: string;
}

export interface TaskSubmissionProvenance {
  claimedSubmitter: string;
  verifiedSubmitter: string | null;
  policy: SigningPolicy;
  signatureStatus: TaskSignatureStatus;
  keyId: string | null;
}

export interface TaskSignatureAssessment {
  status: TaskSignatureStatus;
  keyId?: string;
  reason?: string;
}

/** Convert a signature assessment into the stable result-structured shape. */
export function buildTaskSubmissionProvenance(
  claimedSubmitter: string,
  policy: SigningPolicy,
  assessment: TaskSignatureAssessment,
): TaskSubmissionProvenance {
  return {
    claimedSubmitter,
    verifiedSubmitter:
      assessment.status === "valid" && assessment.keyId ? claimedSubmitter : null,
    policy,
    signatureStatus: assessment.status,
    keyId: assessment.keyId ?? null,
  };
}

/** `require` accepts a valid signature plus Hugin's existing internal exemption. */
export function signingPolicyRejects(
  policy: SigningPolicy,
  status: TaskSignatureStatus,
): boolean {
  return policy === "require" && status !== "valid" && status !== "internal-exempt";
}

export interface VerifyOptions {
  /** Maximum age in seconds for a valid signature. Set to 0 to disable the check.
   *  Default: 0 (disabled) at the function level — the dispatcher supplies the
   *  configured window (HUGIN_SIGNING_MAX_AGE_S). */
  maxAgeS?: number;
  /** Tolerance in seconds for submitted-at timestamps in the future (clock skew). Default: 60. */
  futureToleranceS?: number;
}

export type KeyStore = Record<string, string>;

/**
 * Canonical payload construction. Ordering and formatting must be stable
 * across submitters and Hugin or signatures will not match.
 *
 * Rules:
 *   - Each value is trimmed and stripped of embedded \n and \r.
 *   - Missing values serialize as an empty string for their field.
 *   - Fields are sorted by key and joined with `\n`.
 *   - Payload ends with a trailing newline (so empty vs. missing-last-field
 *     is unambiguous when inspected as text).
 */
export function buildCanonicalPayload(params: SigningParams): string {
  const promptSha = sha256Hex(canonicalizePrompt(params.prompt));
  const contextRefsSha = params.contextRefs?.length
    ? sha256Hex(canonicalizeContextRefs(params.contextRefs))
    : "";

  const fields: Record<string, string> = {
    "context-refs-sha256": contextRefsSha,
    "prompt-sha256": promptSha,
    runtime: sanitizeValue(params.runtime),
    "submitted-at": sanitizeValue(params.submittedAt),
    submitter: sanitizeValue(params.submitter),
    "task-id": sanitizeValue(params.taskId),
    version: SIGNATURE_VERSION,
  };

  return (
    Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("\n") + "\n"
  );
}

export function signTask(
  params: SigningParams,
  keyId: string,
  secretHex: string,
): string {
  const secret = decodeSecret(secretHex);
  const payload = buildCanonicalPayload(params);
  const hex = createHmac("sha256", secret).update(payload).digest("hex");
  return `${SIGNATURE_VERSION}:${keyId}:${hex}`;
}

export function parseSignature(raw: string | undefined | null): ParsedSignature | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length !== 3) return null;
  const [version, keyId, hex] = parts;
  if (!version || !keyId || !hex) return null;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  return { version, keyId, hex: hex.toLowerCase() };
}

/**
 * Extract a signature line from a task body. Matches:
 *   `- **Signature:** v1:<keyId>:<hex>` or `**Signature:** v1:<keyId>:<hex>`.
 * Returns null when no signature line is present.
 */
export function extractSignatureField(content: string): string | null {
  const match = content.match(/\*\*Signature:\*\*\s*(\S+)/i);
  return match?.[1]?.trim() || null;
}

export function verifyTaskSignature(
  params: SigningParams,
  signatureRaw: string | null | undefined,
  keys: KeyStore,
  opts: VerifyOptions = {},
): VerificationResult {
  if (!signatureRaw) return { status: "missing" };

  const parsed = parseSignature(signatureRaw);
  if (!parsed) return { status: "malformed", reason: "unparseable signature field" };

  if (parsed.version !== SIGNATURE_VERSION) {
    return {
      status: "unsupported-version",
      keyId: parsed.keyId,
      reason: `unsupported signature version "${parsed.version}" (expected ${SIGNATURE_VERSION})`,
    };
  }

  const secretHex = keys[parsed.keyId];
  if (!secretHex) {
    return {
      status: "unknown-signer",
      keyId: parsed.keyId,
      reason: `no signing key configured for "${parsed.keyId}"`,
    };
  }

  // Bind keyId to the claimed submitter. A signer with any configured key
  // must not be able to mint signatures impersonating a different
  // submitter. The keyId must either equal the submitter name or be a
  // rotation alias of the form `<submitter>-<rotation>` (e.g.
  // `Codex-desktop-2026q2`). This is enforced *before* HMAC comparison
  // so unknown rotation shapes surface clearly in logs.
  if (!keyIdMatchesSubmitter(parsed.keyId, params.submitter)) {
    return {
      status: "submitter-mismatch",
      keyId: parsed.keyId,
      reason: `keyId "${parsed.keyId}" is not authorized to sign for submitter "${params.submitter}"`,
    };
  }

  const expectedHex = signTask(params, parsed.keyId, secretHex).split(":")[2];
  const actual = Buffer.from(parsed.hex, "hex");
  const expected = Buffer.from(expectedHex, "hex");

  if (actual.length !== expected.length) {
    return { status: "invalid", keyId: parsed.keyId, reason: "signature length mismatch" };
  }
  if (!timingSafeEqual(actual, expected)) {
    return { status: "invalid", keyId: parsed.keyId, reason: "signature does not match" };
  }

  // Age check — only evaluated after HMAC passes to avoid timing leaks.
  // Default maxAgeS is 0 (disabled) when called without opts; callers that
  // want enforcement pass an explicit maxAgeS (e.g. from HUGIN_SIGNING_MAX_AGE_S).
  const maxAgeS = opts.maxAgeS ?? 0;
  const futureToleranceS = opts.futureToleranceS ?? 60;

  if (maxAgeS > 0) {
    const submittedMs = Date.parse(params.submittedAt);
    if (Number.isNaN(submittedMs)) {
      return {
        status: "invalid",
        keyId: parsed.keyId,
        reason: "submitted-at is not a valid ISO date",
      };
    }
    const ageS = (Date.now() - submittedMs) / 1000;
    if (ageS > maxAgeS) {
      return {
        status: "expired",
        keyId: parsed.keyId,
        reason: `signature expired: submitted-at is ${Math.round(ageS)}s ago (max ${maxAgeS}s)`,
      };
    }
    if (ageS < -futureToleranceS) {
      return {
        status: "future-skew",
        keyId: parsed.keyId,
        reason: `signature from the future: submitted-at is ${Math.round(-ageS)}s ahead (tolerance ${futureToleranceS}s)`,
      };
    }
  }

  return { status: "valid", keyId: parsed.keyId };
}

/**
 * Load the keystore from HUGIN_SUBMITTER_KEYS (JSON string) or
 * HUGIN_SUBMITTER_KEYS_FILE (path to JSON). File takes precedence if set.
 *
 * Expected shape: `{"<keyId>": "<hex-or-base64-secret>"}`.
 * Invalid JSON or missing files log a warning and return an empty store.
 */
export function loadKeyStoreFromEnv(env: NodeJS.ProcessEnv = process.env): KeyStore {
  const filePath = env.HUGIN_SUBMITTER_KEYS_FILE?.trim();
  if (filePath) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return parseKeyStoreJson(raw, `file ${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[signing] failed to load HUGIN_SUBMITTER_KEYS_FILE (${filePath}): ${msg}`);
      return {};
    }
  }

  const inline = env.HUGIN_SUBMITTER_KEYS?.trim();
  if (inline) {
    return parseKeyStoreJson(inline, "HUGIN_SUBMITTER_KEYS");
  }

  return {};
}

/** Exported so other HMAC-keystore surfaces (e.g. hugin#237's external
 * receipt producer keys) reuse the same tolerant-parse/warn-and-empty
 * behaviour instead of re-implementing it. */
export function parseKeyStoreJson(raw: string, source: string): KeyStore {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[signing] ${source}: expected JSON object of {keyId: secret}, ignoring`);
      return {};
    }
    const out: KeyStore = {};
    for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" || !value.trim()) continue;
      out[keyId.trim()] = value.trim();
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[signing] ${source} is not valid JSON: ${msg}`);
    return {};
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function canonicalizeContextRefs(refs: string[]): string {
  return refs
    .map((r) => r.trim())
    .filter(Boolean)
    .sort()
    .join("\n");
}

function sanitizeValue(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

/**
 * A signer's keyId must equal the claimed principal name or be a rotation
 * alias `<principal>-<rotation>` (e.g. `codex-cli-2026q3`). Exported so other
 * authenticated-intake surfaces with the same rotation-alias shape (e.g. the
 * external task-receipt producer keystore, hugin#237) reuse one aliasing rule
 * instead of re-deriving it.
 */
export function keyIdMatchesSubmitter(keyId: string, submitter: string): boolean {
  if (!keyId || !submitter) return false;
  if (keyId === submitter) return true;
  return keyId.startsWith(`${submitter}-`);
}

/**
 * Normalize a prompt the same way on both sides of the signature. The task
 * body in Munin may carry trailing whitespace from editors or CRLF line
 * endings; the submitter helper reads the prompt from a file. Collapsing to
 * `.trim()` matches what parseTask() uses when extracting the prompt.
 */
export function canonicalizePrompt(raw: string): string {
  return raw.trim();
}

/**
 * Accepts hex (64 chars) or base64 secrets. Falls back to UTF-8 bytes for
 * arbitrary strings — useful for tests and non-production config. HMAC
 * accepts any byte length, but short secrets weaken the guarantee.
 */
/** Exported so other HMAC-keystore surfaces (e.g. hugin#237's external
 * receipt producer keys) accept the same hex/base64/utf8 secret shapes. */
export function decodeSecret(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length >= 32) {
    return Buffer.from(trimmed, "hex");
  }
  // Accept base64 only when it clearly looks like base64 and decodes cleanly.
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 24) {
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length >= 16) return decoded;
    } catch {
      // fall through
    }
  }
  return Buffer.from(trimmed, "utf8");
}

/**
 * Parse a non-negative integer env var, falling back to the given default for
 * unset, blank, negative, or non-integer values. Unlike parsePositiveIntEnv in
 * src/index.ts this accepts 0, which callers use to disable a window/limit.
 * Strict parse: "30s" (partial parseInt match) is rejected and returns the
 * fallback so a misconfigured value cannot accidentally reduce a window to 30.
 */
export function parseNonNegativeIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const trimmed = raw.trim();
  if (trimmed === "" || String(parseInt(trimmed, 10)) !== trimmed) return fallback;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export type SigningPolicy = (typeof SIGNING_POLICIES)[number];

/**
 * Parse HUGIN_SIGNING_POLICY. Unset or blank → "off". Any other value that
 * isn't one of the three canonical modes throws — a security control must
 * never silently degrade to off because of a typo.
 */
export function parseSigningPolicy(value: string | undefined | null): SigningPolicy {
  if (value === undefined || value === null) return "off";
  const raw = value.trim().toLowerCase();
  if (raw === "") return "off";
  if (raw === "off" || raw === "warn" || raw === "require") return raw;
  throw new Error(
    `invalid HUGIN_SIGNING_POLICY "${value}" — expected one of: off, warn, require`,
  );
}
