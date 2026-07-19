import { taskTypeSchema, type TaskType } from "./types.js";

/**
 * Version of the M5 task-type taxonomy mirrored by Hugin's Broker schema.
 *
 * The taxonomy calls itself v1 in gille-inference. Additive enum values (such
 * as draft/conversation in Hugin #191) remain v1 and flow through this module
 * automatically when taskTypeSchema is updated. A semantic taxonomy change
 * must introduce a new version and an explicit reader branch.
 */
export const BROKER_TASK_TYPE_TAXONOMY_ID = "gille-inference/task-types" as const;
export const BROKER_TASK_TYPE_TAXONOMY_VERSION =
  "gille-inference-task-types-2026-07-19-v1" as const;
export const LEGACY_TASK_TYPE_TAXONOMY_VERSION = "legacy-unversioned" as const;

export const BROKER_TASK_TYPE_TAG_PREFIX = "task-type:";
export const BROKER_TASK_TAXONOMY_TAG_PREFIX = "task-taxonomy:";

export type PersistedTaskTypeSource =
  | "broker-canonical"
  | "broker-unversioned"
  | "legacy-type-tag";

export type PersistedTaskTypeMetadata =
  | { state: "missing" }
  | {
      state: "known";
      taskType: TaskType;
      taxonomyVersion:
        | typeof BROKER_TASK_TYPE_TAXONOMY_VERSION
        | typeof LEGACY_TASK_TYPE_TAXONOMY_VERSION;
      source: PersistedTaskTypeSource;
    }
  | {
      state: "invalid";
      reason:
        | "task-type-metadata-conflicting-values"
        | "task-type-metadata-unknown-value"
        | "task-type-taxonomy-missing-type"
        | "task-type-taxonomy-conflicting-versions"
        | "task-type-taxonomy-unsupported-version"
        | "legacy-task-type-metadata-conflicting-values"
        | "legacy-task-type-metadata-unknown-value";
    };

export function buildBrokerTaskTypeTags(taskType: TaskType): string[] {
  return [
    `${BROKER_TASK_TYPE_TAG_PREFIX}${taskType}`,
    `${BROKER_TASK_TAXONOMY_TAG_PREFIX}${BROKER_TASK_TYPE_TAXONOMY_VERSION}`,
  ];
}

function valuesWithPrefix(tags: readonly string[], prefix: string): string[] {
  return [...new Set(
    tags
      .filter((tag) => tag.startsWith(prefix))
      .map((tag) => tag.slice(prefix.length)),
  )];
}

/**
 * Read task-type metadata from persisted status tags.
 *
 * Canonical Broker metadata is authoritative. Existing Broker rows predate
 * the taxonomy-version tag, while older/general Hugin rows used `type:*`.
 * Both compatibility paths are labeled `legacy-unversioned`; malformed,
 * conflicting, future-version, and unknown values stay invalid so harvest can
 * quarantine them instead of silently teaching the `other` bucket.
 */
export function readPersistedTaskTypeMetadata(
  tags: readonly string[],
): PersistedTaskTypeMetadata {
  const brokerValues = valuesWithPrefix(tags, BROKER_TASK_TYPE_TAG_PREFIX);
  const taxonomyVersions = valuesWithPrefix(tags, BROKER_TASK_TAXONOMY_TAG_PREFIX);

  if (brokerValues.length > 0) {
    if (brokerValues.length !== 1) {
      return { state: "invalid", reason: "task-type-metadata-conflicting-values" };
    }
    const parsed = taskTypeSchema.safeParse(brokerValues[0]);
    if (!parsed.success) {
      return { state: "invalid", reason: "task-type-metadata-unknown-value" };
    }
    if (taxonomyVersions.length === 0) {
      return {
        state: "known",
        taskType: parsed.data,
        taxonomyVersion: LEGACY_TASK_TYPE_TAXONOMY_VERSION,
        source: "broker-unversioned",
      };
    }
    if (taxonomyVersions.length !== 1) {
      return { state: "invalid", reason: "task-type-taxonomy-conflicting-versions" };
    }
    if (taxonomyVersions[0] !== BROKER_TASK_TYPE_TAXONOMY_VERSION) {
      return { state: "invalid", reason: "task-type-taxonomy-unsupported-version" };
    }
    return {
      state: "known",
      taskType: parsed.data,
      taxonomyVersion: BROKER_TASK_TYPE_TAXONOMY_VERSION,
      source: "broker-canonical",
    };
  }

  if (taxonomyVersions.length > 0) {
    return { state: "invalid", reason: "task-type-taxonomy-missing-type" };
  }

  const legacyValues = valuesWithPrefix(tags, "type:")
    .filter((value) => !isHuginMarkerType(value));
  if (legacyValues.length === 0) return { state: "missing" };
  if (legacyValues.length !== 1) {
    return { state: "invalid", reason: "legacy-task-type-metadata-conflicting-values" };
  }
  const parsed = taskTypeSchema.safeParse(legacyValues[0]);
  if (!parsed.success) {
    return { state: "invalid", reason: "legacy-task-type-metadata-unknown-value" };
  }
  return {
    state: "known",
    taskType: parsed.data,
    taxonomyVersion: LEGACY_TASK_TYPE_TAXONOMY_VERSION,
    source: "legacy-type-tag",
  };
}

const HUGIN_MARKER_TYPES = new Set([
  "pipeline",
  "pipeline-phase",
  "pipeline-spec",
  "pipeline-summary",
  "approval-request",
  "pipeline-approval-request",
]);

function isHuginMarkerType(value: string): boolean {
  return HUGIN_MARKER_TYPES.has(value)
    || value === "task-result"
    || value.startsWith("task-result-");
}
