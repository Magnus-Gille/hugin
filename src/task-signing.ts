/**
 * Task submission signing and verification.
 *
 * Protects against submitter spoofing: the `Submitted by:` field is
 * plain text, so any agent with Munin write access to `tasks/*` can
 * impersonate a trusted submitter. Signing binds the complete task
 * document and task identity to a shared secret that only
 * the claimed submitter knows.
 *
 * v2 design — HMAC-SHA256 with per-submitter shared secrets:
 *   - Signature field embedded in task body: `**Signature:** v2:<keyId>:<hex>`
 *   - Canonical payload binds the SHA-256 of the complete task body, the
 *     task ID, submitter, and submitted-at timestamp.
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

export const SIGNATURE_VERSION = "v2" as const;

export interface SigningParams {
  taskId: string;
  submitter: string;
  submittedAt: string;
  taskBody: string;
}

export interface TaskSigningMetadata {
  submitter: string | null;
  submittedAt: string | null;
}

export type SignatureFieldInspection =
  | { status: "missing" }
  | { status: "valid"; raw: string }
  | { status: "malformed"; reason: string };

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
 * `unverifiable` describes a scheme limitation, not proof of identity.
 * `internal-exempt` is retained only to parse historical results; the current
 * dispatcher does not produce or accept it under `require`.
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

/** `require` accepts only a valid signature. */
export function signingPolicyRejects(
  policy: SigningPolicy,
  status: TaskSignatureStatus,
): boolean {
  return policy === "require" && status !== "valid";
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
 * across submitters and Hugin or signatures will not match. The whole task
 * body is normalized from CRLF to LF, then hashed byte-for-byte as UTF-8.
 * The value of exactly one well-formed standalone Signature line is replaced
 * by a fixed marker; its position, spelling, and all other body bytes remain
 * significant. Unsigned bodies use the deterministic insertion slot exposed
 * by setTaskSignature.
 */
export function buildCanonicalPayload(params: SigningParams): string {
  const taskBody = canonicalizeTaskBody(params.taskBody);

  const fields: Record<string, string> = {
    "task-body-sha256": sha256Hex(taskBody),
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

/** Insert or replace the standalone metadata Signature line in its canonical slot. */
export function setTaskSignature(content: string, signature: string): string {
  if (!/^\S+$/.test(signature) || !parseSignature(signature)) {
    throw new Error("signature must be one parseable, whitespace-free value");
  }
  return applyTaskSignatureValue(content, signature);
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
 * Inspect only standalone Signature lines in the metadata prefix before the
 * first ### Prompt or ### Pipeline marker. Signature-looking prompt text is
 * never authentication material.
 */
export function inspectSignatureField(content: string): SignatureFieldInspection {
  const lines = normalizeTaskBody(content).split("\n");
  const boundary = findTaskSectionBoundary(lines);
  if (boundary < 0) {
    return { status: "malformed", reason: "task body is missing a ### Prompt or ### Pipeline section" };
  }
  const prefix = lines.slice(0, boundary);
  const candidates: string[] = [];
  for (const line of prefix) {
    if (/^[ \t]*(?:-[ \t]*)?\*\*Signature(?::\*\*|\*\*)/i.test(line)) {
      candidates.push(line);
    }
  }

  if (candidates.length === 0) return { status: "missing" };
  if (candidates.length > 1) {
    return { status: "malformed", reason: "duplicate metadata Signature lines" };
  }

  const match = candidates[0].match(/^(?:- )?\*\*Signature:\*\* (\S+)$/i);
  if (!match || !parseSignature(match[1])) {
    return { status: "malformed", reason: "malformed metadata Signature line" };
  }
  return { status: "valid", raw: match[1] };
}

/** Extract a well-formed standalone metadata signature, or null otherwise. */
export function extractSignatureField(content: string): string | null {
  const inspection = inspectSignatureField(content);
  return inspection.status === "valid" ? inspection.raw : null;
}

/** Derive identity and freshness metadata from the same document prefix the dispatcher parses. */
export function extractTaskSigningMetadata(content: string): TaskSigningMetadata {
  const lines = normalizeTaskBody(content).split("\n");
  const boundary = findTaskSectionBoundary(lines);
  const prefix = lines.slice(0, boundary < 0 ? lines.length : boundary).join("\n");
  const submitter = prefix.match(
    /^[ \t]*(?:-[ \t]*)?\*\*Submitted by:\*\*[ \t]*(.+)$/im,
  )?.[1]?.trim();
  const submittedAt = prefix.match(
    /^[ \t]*(?:-[ \t]*)?\*\*Submitted at:\*\*[ \t]*(.+)$/im,
  )?.[1]?.trim();
  return {
    submitter: submitter || null,
    submittedAt: submittedAt || null,
  };
}

export function verifyTaskSignature(
  params: SigningParams,
  keys: KeyStore,
  opts: VerifyOptions = {},
): VerificationResult {
  const inspection = inspectSignatureField(params.taskBody);
  if (inspection.status === "missing") return { status: "missing" };
  if (inspection.status === "malformed") {
    return { status: "malformed", reason: inspection.reason };
  }

  const parsed = parseSignature(inspection.raw);
  if (!parsed) return { status: "malformed", reason: "unparseable signature field" };

  const metadata = extractTaskSigningMetadata(params.taskBody);
  if (!metadata.submitter || !metadata.submittedAt) {
    return {
      status: "invalid",
      keyId: parsed.keyId,
      reason: "task body is missing Submitted by or Submitted at metadata",
    };
  }
  if (metadata.submitter !== params.submitter || metadata.submittedAt !== params.submittedAt) {
    return {
      status: "invalid",
      keyId: parsed.keyId,
      reason: "signing metadata does not match the task body",
    };
  }

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

function normalizeTaskBody(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function findTaskSectionBoundary(lines: string[]): number {
  return lines.findIndex((line) => /^###[ \t]*(?:Prompt|Pipeline)[ \t]*$/i.test(line));
}

const SIGNATURE_VALUE_MARKER = "__HUGIN_SIGNATURE_VALUE__";

interface RawTaskLine {
  text: string;
  start: number;
  end: number;
  terminator: string;
}

function splitRawTaskLines(content: string): RawTaskLine[] {
  const lines: RawTaskLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    if (newline < 0) {
      lines.push({ text: content.slice(start), start, end: content.length, terminator: "" });
      return lines;
    }
    const end = newline > start && content[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({
      text: content.slice(start, end),
      start,
      end,
      terminator: content.slice(end, newline + 1),
    });
    start = newline + 1;
  }
  if (content.length === 0 || content.endsWith("\n")) {
    lines.push({ text: "", start: content.length, end: content.length, terminator: "" });
  }
  return lines;
}

function applyTaskSignatureValue(content: string, signature: string): string {
  const inspection = inspectSignatureField(content);
  if (inspection.status === "malformed") throw new Error(inspection.reason);

  const lines = splitRawTaskLines(content);
  const lineTexts = lines.map((line) => line.text);
  const boundary = findTaskSectionBoundary(lineTexts);
  if (boundary < 0) {
    throw new Error("task body is missing a ### Prompt or ### Pipeline section");
  }

  if (inspection.status === "valid") {
    const signatureLineIndex = lineTexts.findIndex(
      (line, index) => index < boundary && /^[ \t]*(?:-[ \t]*)?\*\*Signature(?::\*\*|\*\*)/i.test(line),
    );
    const line = lines[signatureLineIndex];
    const match = line?.text.match(/^((?:- )?\*\*Signature:\*\* )(\S+)$/i);
    if (!line || !match) throw new Error("metadata Signature line could not be replaced");
    const valueStart = line.start + match[1].length;
    const valueEnd = line.start + line.text.length;
    return `${content.slice(0, valueStart)}${signature}${content.slice(valueEnd)}`;
  }

  // Put the new field immediately before the blank line that separates
  // metadata from the section marker, when present. Otherwise put it directly
  // before the marker. This is the only supported insertion slot.
  const insertionIndex = boundary > 0 && lineTexts[boundary - 1] === ""
    ? boundary - 1
    : boundary;
  const insertionPoint = lines[insertionIndex]?.start ?? content.length;
  const precedingLine = lines[insertionIndex - 1];
  const sectionLine = lines[boundary];
  const newline = precedingLine?.terminator || sectionLine?.terminator || "\n";
  const inserted = `- **Signature:** ${signature}${newline}`;
  return `${content.slice(0, insertionPoint)}${inserted}${content.slice(insertionPoint)}`;
}

function canonicalizeTaskBody(content: string): string {
  return normalizeTaskBody(applyTaskSignatureValue(content, SIGNATURE_VALUE_MARKER));
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
