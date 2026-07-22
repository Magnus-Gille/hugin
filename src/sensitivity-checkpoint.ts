import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  taskExecutionSensitivitySchema,
  type TaskExecutionSensitivity,
} from "./task-result-schema.js";

export const SENSITIVITY_CHECKPOINT_KEY = "sensitivity-checkpoint";
export const SENSITIVITY_CHECKPOINT_TAGS = [
  "type:task-sensitivity-checkpoint",
] as const;
export const SENSITIVITY_CHECKPOINT_VERSION =
  "hugin-sensitivity-checkpoint/v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const sensitivityCheckpointSchema = z.object({
  version: z.literal(SENSITIVITY_CHECKPOINT_VERSION),
  taskNamespace: z.string().min(1),
  taskContentSha256: sha256Schema,
  sensitivity: taskExecutionSensitivitySchema,
  hmacSha256: sha256Schema,
}).strict();

function hashTaskContent(taskContent: string): string {
  return createHash("sha256").update(taskContent, "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => {
      const child = record[key];
      return `${JSON.stringify(key)}:${canonicalize(child)}`;
    }).join(",")}}`;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  throw new Error("sensitivity checkpoint accepts only JSON objects, arrays, strings, booleans, and null");
}

function checkpointKey(secret: string): Buffer {
  if (secret.length < 32) {
    throw new Error("sensitivity checkpoint secret must contain at least 32 characters");
  }
  return createHmac("sha256", secret)
    .update("hugin-sensitivity-checkpoint/server-key/v1", "utf8")
    .digest();
}

function unsignedCheckpoint(
  taskNamespace: string,
  taskContent: string,
  sensitivity: TaskExecutionSensitivity,
) {
  return {
    version: SENSITIVITY_CHECKPOINT_VERSION,
    taskNamespace,
    taskContentSha256: hashTaskContent(taskContent),
    sensitivity: taskExecutionSensitivitySchema.parse(sensitivity),
  };
}

export function buildSensitivityCheckpoint(
  taskNamespace: string,
  taskContent: string,
  sensitivity: TaskExecutionSensitivity,
  secret: string,
): string {
  const unsigned = unsignedCheckpoint(taskNamespace, taskContent, sensitivity);
  return JSON.stringify(
    sensitivityCheckpointSchema.parse({
      ...unsigned,
      hmacSha256: createHmac("sha256", checkpointKey(secret))
        .update(canonicalize(unsigned), "utf8")
        .digest("hex"),
    }),
  );
}

export function parseSensitivityCheckpoint(
  content: string,
  expectedTaskNamespace: string,
  expectedTaskContent: string,
  secret: string,
): TaskExecutionSensitivity | undefined {
  try {
    if (!secret) return undefined;
    const parsed = sensitivityCheckpointSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return undefined;
    if (parsed.data.taskNamespace !== expectedTaskNamespace) return undefined;
    if (parsed.data.taskContentSha256 !== hashTaskContent(expectedTaskContent)) {
      return undefined;
    }
    const unsigned = unsignedCheckpoint(
      parsed.data.taskNamespace,
      expectedTaskContent,
      parsed.data.sensitivity,
    );
    const expectedMac = Buffer.from(
      createHmac("sha256", checkpointKey(secret))
        .update(canonicalize(unsigned), "utf8")
        .digest("hex"),
      "hex",
    );
    const actualMac = Buffer.from(parsed.data.hmacSha256, "hex");
    if (
      expectedMac.length !== actualMac.length ||
      !timingSafeEqual(expectedMac, actualMac)
    ) {
      return undefined;
    }
    return parsed.data.sensitivity;
  } catch {
    return undefined;
  }
}
