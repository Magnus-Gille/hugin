import { createHash } from "node:crypto";
import { z } from "zod";

/** Normative LearningTaskContract v1 raw-task fingerprint. */
export const TASK_EXPOSURE_FINGERPRINT_VERSION = "trim-utf8-sha256-v1" as const;
/** Exact bytes of Hugin's rendered user message, without trim or normalization. */
export const RENDERED_PROMPT_FINGERPRINT_VERSION =
  "hugin-delegate-prompt-utf8-sha256-v1" as const;
export const HUGIN_TASK_IDENTITY_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const rawTaskFingerprintSchema = z.object({
  algorithm: z.literal("sha256"),
  version: z.literal(TASK_EXPOSURE_FINGERPRINT_VERSION),
  digest: sha256Schema,
}).strict();

export const renderedPromptFingerprintSchema = z.object({
  algorithm: z.literal("sha256"),
  version: z.literal(RENDERED_PROMPT_FINGERPRINT_VERSION),
  digest: sha256Schema,
  utf8Bytes: z.number().int().nonnegative(),
}).strict();

/**
 * Hugin-owned identity projected onto the legacy `/delegate` request.
 *
 * It is deliberately constructed inside the executor from the accepted logical
 * task and lifecycle task id. Task authors cannot supply or override it. The
 * gateway must still authenticate and bind this producer claim before treating
 * it as exposure evidence; that stamp/echo handshake belongs to Hugin #240 and
 * gille-inference #2.
 */
export const huginTaskIdentitySchema = z.object({
  schemaVersion: z.literal(HUGIN_TASK_IDENTITY_SCHEMA_VERSION),
  producer: z.literal("hugin"),
  taskId: z.string().min(1).max(512),
  rawTaskFingerprint: rawTaskFingerprintSchema,
  renderedPromptFingerprint: renderedPromptFingerprintSchema,
}).strict();

export type HuginTaskIdentity = z.infer<typeof huginTaskIdentitySchema>;

/** JavaScript String.trim(), no Unicode normalization, then exact UTF-8 bytes. */
export function canonicalRawTaskBytes(rawTaskText: string): Buffer {
  return Buffer.from(rawTaskText.trim(), "utf8");
}

export function fingerprintRawTask(rawTaskText: string): HuginTaskIdentity["rawTaskFingerprint"] {
  const bytes = canonicalRawTaskBytes(rawTaskText);
  return {
    algorithm: "sha256",
    version: TASK_EXPOSURE_FINGERPRINT_VERSION,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function fingerprintRenderedPrompt(
  renderedPrompt: string,
): HuginTaskIdentity["renderedPromptFingerprint"] {
  const bytes = Buffer.from(renderedPrompt, "utf8");
  return {
    algorithm: "sha256",
    version: RENDERED_PROMPT_FINGERPRINT_VERSION,
    digest: createHash("sha256").update(bytes).digest("hex"),
    utf8Bytes: bytes.byteLength,
  };
}

export function buildHuginTaskIdentity(input: {
  taskId: string;
  rawTaskText: string;
  renderedPrompt: string;
}): HuginTaskIdentity {
  if (input.taskId !== input.taskId.trim()) {
    throw new Error("Hugin task identity requires an exact non-whitespace-padded task id");
  }
  if (input.rawTaskText.trim() === "") {
    throw new Error("Hugin task identity requires a non-empty logical task");
  }
  return huginTaskIdentitySchema.parse({
    schemaVersion: HUGIN_TASK_IDENTITY_SCHEMA_VERSION,
    producer: "hugin",
    taskId: input.taskId,
    rawTaskFingerprint: fingerprintRawTask(input.rawTaskText),
    renderedPromptFingerprint: fingerprintRenderedPrompt(input.renderedPrompt),
  });
}
