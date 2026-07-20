/**
 * External task-receipt signing and verification (hugin#237).
 *
 * Mirrors `src/task-signing.ts`'s HMAC-SHA256 / sorted-canonical-payload /
 * keyId-rotation-alias scheme (see docs/security/task-signing.md) so the two
 * authenticated-intake surfaces stay recognisably the same shape, but keeps
 * its own keystore and canonical payload: a receipt producer is a different
 * trust domain from a task *submitter* (it authenticates a completed
 * external task/outcome fact, not a prompt Hugin is about to execute), and
 * the fields being bound differ accordingly. Reuses `task-signing.ts`'s
 * secret-decoding, keystore-JSON-parsing, and keyId/principal-aliasing
 * helpers directly rather than re-implementing them.
 *
 * Unlike task submission signing (which has an `off`/`warn`/`require`
 * rollout policy), receipt intake has no policy knob: this is a brand-new
 * authenticated-only surface, so verification is always mandatory — see
 * `src/external-receipt-intake.ts`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import {
  decodeSecret,
  keyIdMatchesSubmitter,
  parseKeyStoreJson,
  parseSignature,
  type KeyStore,
} from "./task-signing.js";
import type { ExternalReceiptEnvelope } from "./external-receipt-schema.js";

export const EXTERNAL_RECEIPT_SIGNATURE_VERSION = "v1" as const;

export type ExternalReceiptSignatureStatus =
  | "valid"
  | "invalid"
  | "missing"
  | "unknown-producer"
  | "producer-mismatch"
  | "malformed"
  | "unsupported-version"
  | "expired"
  | "future-skew";

export interface ExternalReceiptVerification {
  status: ExternalReceiptSignatureStatus;
  keyId?: string;
  reason?: string;
}

export interface ExternalReceiptVerifyOptions {
  /** Maximum age in seconds for `producedAt`, measured from now. 0 disables
   * the check (default) — callers that want enforcement pass the configured
   * window explicitly, same convention as `verifyTaskSignature`. */
  maxAgeS?: number;
  /** Tolerance in seconds for a `producedAt` that appears to be in the
   * future (clock skew). Default: 60. */
  futureToleranceS?: number;
}

/**
 * Canonical payload over the receipt's own content-blind identity fields.
 * Sorted `key=value` pairs, newline-delimited, trailing newline — same shape
 * as `buildCanonicalPayload` in task-signing.ts. Binding every identity/
 * instance/timestamp field (not just an opaque digest of the whole object)
 * keeps this auditable and independently reproducible by a human reading
 * docs/security/task-signing.md's sibling doc for receipts.
 */
export function buildExternalReceiptCanonicalPayload(receipt: ExternalReceiptEnvelope): string {
  const fields: Record<string, string> = {
    "capacity-principal": receipt.capacityPrincipal,
    "contract-version": receipt.contractVersion,
    harness: receipt.identity.harness,
    kind: receipt.kind,
    model: receipt.identity.model,
    "occurred-at": receipt.occurredAt,
    "produced-at": receipt.producedAt,
    provider: receipt.identity.provider,
    "receipt-id": receipt.receiptId,
    "reconciles-hugin-task-id": receipt.instance.reconcilesHuginTaskId ?? "",
    "schema-version": String(receipt.schemaVersion),
    "source-task-ref": `${receipt.instance.sourceTaskRef.system}:${receipt.instance.sourceTaskRef.id}`,
    surface: receipt.surface,
    "task-instance-id": receipt.instance.taskInstanceId,
    ...(receipt.kind === "outcome" ? { outcome: receipt.outcome } : {}),
  };

  return (
    Object.keys(fields)
      .sort()
      .map((key) => `${key}=${fields[key]}`)
      .join("\n") + "\n"
  );
}

export function signExternalReceipt(
  receipt: ExternalReceiptEnvelope,
  keyId: string,
  secretHex: string,
): string {
  const secret = decodeSecret(secretHex);
  const payload = buildExternalReceiptCanonicalPayload(receipt);
  const hex = createHmac("sha256", secret).update(payload).digest("hex");
  return `${EXTERNAL_RECEIPT_SIGNATURE_VERSION}:${keyId}:${hex}`;
}

/**
 * Verify an external receipt's signature. Never trusts the envelope's own
 * `capacityPrincipal` alone — the keyId must resolve to a configured key AND
 * alias back to that exact `capacityPrincipal` (or a `<principal>-<rotation>`
 * form), otherwise any signer holding any configured key could mint receipts
 * claiming to be a different producer's capacity principal.
 */
export function verifyExternalReceiptSignature(
  receipt: ExternalReceiptEnvelope,
  signatureRaw: string | null | undefined,
  keys: KeyStore,
  opts: ExternalReceiptVerifyOptions = {},
): ExternalReceiptVerification {
  if (!signatureRaw) return { status: "missing" };

  const parsed = parseSignature(signatureRaw);
  if (!parsed) return { status: "malformed", reason: "unparseable signature field" };

  if (parsed.version !== EXTERNAL_RECEIPT_SIGNATURE_VERSION) {
    return {
      status: "unsupported-version",
      keyId: parsed.keyId,
      reason: `unsupported signature version "${parsed.version}" (expected ${EXTERNAL_RECEIPT_SIGNATURE_VERSION})`,
    };
  }

  const secretHex = keys[parsed.keyId];
  if (!secretHex) {
    return {
      status: "unknown-producer",
      keyId: parsed.keyId,
      reason: `no receipt-producer key configured for "${parsed.keyId}"`,
    };
  }

  if (!keyIdMatchesSubmitter(parsed.keyId, receipt.capacityPrincipal)) {
    return {
      status: "producer-mismatch",
      keyId: parsed.keyId,
      reason: `keyId "${parsed.keyId}" is not authorized to sign for capacity principal "${receipt.capacityPrincipal}"`,
    };
  }

  const expectedHex = signExternalReceipt(receipt, parsed.keyId, secretHex).split(":")[2];
  const actual = Buffer.from(parsed.hex, "hex");
  const expected = Buffer.from(expectedHex, "hex");

  if (actual.length !== expected.length) {
    return { status: "invalid", keyId: parsed.keyId, reason: "signature length mismatch" };
  }
  if (!timingSafeEqual(actual, expected)) {
    return { status: "invalid", keyId: parsed.keyId, reason: "signature does not match" };
  }

  const maxAgeS = opts.maxAgeS ?? 0;
  const futureToleranceS = opts.futureToleranceS ?? 60;

  if (maxAgeS > 0) {
    const producedMs = Date.parse(receipt.producedAt);
    if (Number.isNaN(producedMs)) {
      return { status: "invalid", keyId: parsed.keyId, reason: "producedAt is not a valid ISO date" };
    }
    const ageS = (Date.now() - producedMs) / 1000;
    if (ageS > maxAgeS) {
      return {
        status: "expired",
        keyId: parsed.keyId,
        reason: `signature expired: producedAt is ${Math.round(ageS)}s ago (max ${maxAgeS}s)`,
      };
    }
    if (ageS < -futureToleranceS) {
      return {
        status: "future-skew",
        keyId: parsed.keyId,
        reason: `signature from the future: producedAt is ${Math.round(-ageS)}s ahead (tolerance ${futureToleranceS}s)`,
      };
    }
  }

  return { status: "valid", keyId: parsed.keyId };
}

/**
 * Load the receipt-producer keystore from `HUGIN_RECEIPT_PRODUCER_KEYS`
 * (inline JSON) or `HUGIN_RECEIPT_PRODUCER_KEYS_FILE` (path to JSON file,
 * takes precedence). Deliberately a *separate* keystore from
 * `HUGIN_SUBMITTER_KEYS` — a task submitter and a receipt producer are
 * different trust domains even when the same human operates both.
 */
export function loadReceiptProducerKeyStoreFromEnv(env: NodeJS.ProcessEnv = process.env): KeyStore {
  const filePath = env.HUGIN_RECEIPT_PRODUCER_KEYS_FILE?.trim();
  if (filePath) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return parseKeyStoreJson(raw, `file ${filePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[external-receipt-signing] failed to load HUGIN_RECEIPT_PRODUCER_KEYS_FILE (${filePath}): ${msg}`);
      return {};
    }
  }

  const inline = env.HUGIN_RECEIPT_PRODUCER_KEYS?.trim();
  if (inline) {
    return parseKeyStoreJson(inline, "HUGIN_RECEIPT_PRODUCER_KEYS");
  }

  return {};
}
