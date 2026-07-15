/**
 * Pure helpers for the friction-mcp Munin write payload.
 *
 * Splitting these out of `tool.ts` keeps the format easy to test
 * without mocking a Munin client and makes the on-disk shape
 * inspectable in one file.
 *
 * Layout:
 *   namespace: "signals/friction"   (flat, regardless of task)
 *   key:       "<task-id>-<iso-stamp>"  (colons in stamp replaced with `-`)
 */

import {
  FRICTION_CATEGORY,
  FRICTION_SCHEMA_VERSION,
  type FrictionCategory,
  type FrictionType,
  type ReportFrictionInput,
} from "./schema.js";

export const FRICTION_NAMESPACE = "signals/friction";
export const FRICTION_NO_TASK = "no-task";

/**
 * Munin keys must be `[A-Za-z0-9_-]+` and start with an alphanumeric.
 * Dots (`.`) are not allowed — that's why the millisecond `.` and the
 * iso timestamp's `:` both get replaced with `-` in the key.
 */
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function sanitiseTaskId(raw: string | undefined): string {
  if (!raw) return FRICTION_NO_TASK;
  const trimmed = raw.trim();
  if (!trimmed) return FRICTION_NO_TASK;
  if (SAFE_TASK_ID.test(trimmed)) return trimmed;
  let cleaned = trimmed.replace(/[^A-Za-z0-9_-]/g, "_");
  // Munin requires the first character to be alphanumeric.
  if (!/^[A-Za-z0-9]/.test(cleaned)) cleaned = `t_${cleaned}`;
  return cleaned || FRICTION_NO_TASK;
}

export function buildFrictionNamespace(): string {
  return FRICTION_NAMESPACE;
}

export function buildFrictionKey(taskId: string | undefined, recordedAt: Date): string {
  const safeTask = sanitiseTaskId(taskId);
  const iso = recordedAt.toISOString().replace(/[:.]/g, "-");
  return `${safeTask}-${iso}`;
}

export interface FrictionTagInputs {
  input: ReportFrictionInput;
  modelId: string;
  resolvedTaskId: string | undefined;
}

export function buildFrictionTags(args: FrictionTagInputs): string[] {
  const { input, modelId, resolvedTaskId } = args;
  const category: FrictionCategory = FRICTION_CATEGORY[input.friction_type as FrictionType];

  const tags: string[] = [
    `friction:${input.friction_type}`,
    `friction-category:${shortCategory(category)}`,
    `severity:${input.severity}`,
    `model:${modelId}`,
    "source:model-self-report",
    `schema:v${FRICTION_SCHEMA_VERSION}`,
  ];

  if (resolvedTaskId) {
    tags.push(`task:${resolvedTaskId}`);
  }
  if (input.resource_assessment) {
    tags.push(`resource:${input.resource_assessment}`);
  }
  if (input.alias_suggested) {
    tags.push(`alias-suggested:${input.alias_suggested}`);
  }
  if (input.tool_name) {
    tags.push(`tool:${input.tool_name}`);
  }
  if (input.tags && input.tags.length > 0) {
    tags.push(...input.tags);
  }
  return tags;
}

function shortCategory(category: FrictionCategory): string {
  if (category === "capability") return "cap";
  if (category === "environment") return "env";
  return "spec";
}

export interface FrictionContentInputs {
  input: ReportFrictionInput;
  modelId: string;
  resolvedTaskId: string | undefined;
  recordedAt: Date;
}

export function buildFrictionContent(args: FrictionContentInputs): string {
  const { input, modelId, resolvedTaskId, recordedAt } = args;
  const category = FRICTION_CATEGORY[input.friction_type as FrictionType];
  const payload = {
    schema_version: FRICTION_SCHEMA_VERSION,
    recorded_at: recordedAt.toISOString(),
    model_id: modelId,
    event_id: input.event_id ?? null,
    task_id_resolved: resolvedTaskId ?? null,
    friction_type: input.friction_type,
    friction_category: category,
    severity: input.severity,
    summary: input.summary,
    detail: input.detail,
    resource_assessment: input.resource_assessment ?? null,
    alias_suggested: input.alias_suggested ?? null,
    tool_name: input.tool_name ?? null,
    user_tags: input.tags ?? [],
  };
  return JSON.stringify(payload, null, 2);
}
