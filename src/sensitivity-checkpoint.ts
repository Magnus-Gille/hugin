import { createHash } from "node:crypto";
import { z } from "zod";
import {
  taskExecutionSensitivitySchema,
  type TaskExecutionSensitivity,
} from "./task-result-schema.js";

export const SENSITIVITY_CHECKPOINT_KEY = "sensitivity-checkpoint";
export const SENSITIVITY_CHECKPOINT_TAGS = [
  "type:task-sensitivity-checkpoint",
] as const;

const sensitivityCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  taskNamespace: z.string().min(1),
  taskContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sensitivity: taskExecutionSensitivitySchema,
}).strict();

function hashTaskContent(taskContent: string): string {
  return createHash("sha256").update(taskContent, "utf8").digest("hex");
}

export function buildSensitivityCheckpoint(
  taskNamespace: string,
  taskContent: string,
  sensitivity: TaskExecutionSensitivity,
): string {
  return JSON.stringify(
    sensitivityCheckpointSchema.parse({
      schemaVersion: 1,
      taskNamespace,
      taskContentSha256: hashTaskContent(taskContent),
      sensitivity,
    }),
  );
}

export function parseSensitivityCheckpoint(
  content: string,
  expectedTaskNamespace: string,
  expectedTaskContent: string,
): TaskExecutionSensitivity | undefined {
  try {
    const parsed = sensitivityCheckpointSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return undefined;
    if (parsed.data.taskNamespace !== expectedTaskNamespace) return undefined;
    if (parsed.data.taskContentSha256 !== hashTaskContent(expectedTaskContent)) {
      return undefined;
    }
    return parsed.data.sensitivity;
  } catch {
    return undefined;
  }
}
