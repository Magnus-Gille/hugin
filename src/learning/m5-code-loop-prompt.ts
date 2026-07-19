import { createHash } from "node:crypto";

/**
 * Existing Gate D prompt contract. Keep this text stable: the first live
 * experiment's champion fingerprint binds its SHA-256.
 */
export const PASSTHROUGH_PROMPT_CONTRACT =
  "Gate D sample instruction, passed through byte-for-byte; per-sample content is bound by corpusSha256";

const PREFIX_PROMPT_CONTRACT =
  "Gate D instruction prefix v1, prepended byte-for-byte; per-sample content is bound by corpusSha256";

/** Content hash stored in the experiment's prompt ref. */
export function codeLoopPromptSha256(prefix: string | undefined): string {
  const payload = prefix === undefined
    ? PASSTHROUGH_PROMPT_CONTRACT
    : `${PREFIX_PROMPT_CONTRACT}\n${prefix}`;
  return createHash("sha256").update(payload).digest("hex");
}

/** Build the exact instruction sent to M5 for one arm. */
export function applyCodeLoopPromptPrefix(
  instruction: string,
  prefix: string | undefined,
): string {
  return prefix === undefined ? instruction : `${prefix}\n\n${instruction}`;
}
