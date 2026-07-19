import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { taskTypeSchema } from "../../src/broker/types.js";
import {
  BROKER_TASK_TYPE_TAXONOMY_ID,
  BROKER_TASK_TYPE_TAXONOMY_VERSION,
  buildBrokerTaskTypeTags,
  readPersistedTaskTypeMetadata,
} from "../../src/broker/task-type-metadata.js";

const acceptedTaxonomy = JSON.parse(readFileSync(
  new URL("../fixtures/learning-task-taxonomy-v1.json", import.meta.url),
  "utf8",
)) as {
  taxonomy_id: string;
  taxonomy_version: string;
  task_types: string[];
};

describe("persisted Broker task-type metadata", () => {
  it("pins identifiers and local values to the accepted LearningTaskContract fixture", () => {
    expect(BROKER_TASK_TYPE_TAXONOMY_ID).toBe(acceptedTaxonomy.taxonomy_id);
    expect(BROKER_TASK_TYPE_TAXONOMY_VERSION).toBe(acceptedTaxonomy.taxonomy_version);
    expect(new Set(acceptedTaxonomy.task_types).size).toBe(acceptedTaxonomy.task_types.length);
    expect(taskTypeSchema.options).toHaveLength(26);
    expect(taskTypeSchema.options).toEqual(acceptedTaxonomy.task_types);
  });

  it.each(taskTypeSchema.options)(
    "round-trips the canonical taxonomy value %s",
    (taskType) => {
      expect(readPersistedTaskTypeMetadata(buildBrokerTaskTypeTags(taskType))).toEqual({
        state: "known",
        taskType,
        taxonomyVersion: BROKER_TASK_TYPE_TAXONOMY_VERSION,
        source: "broker-canonical",
      });
    },
  );

  it("labels an existing unversioned Broker tag as legacy", () => {
    expect(readPersistedTaskTypeMetadata(["task-type:summarize"])).toEqual({
      state: "known",
      taskType: "summarize",
      taxonomyVersion: "legacy-unversioned",
      source: "broker-unversioned",
    });
  });

  it("rejects unknown values and future taxonomy versions visibly", () => {
    expect(readPersistedTaskTypeMetadata([
      "task-type:not-real",
      `task-taxonomy:${BROKER_TASK_TYPE_TAXONOMY_VERSION}`,
    ])).toEqual({ state: "invalid", reason: "task-type-metadata-unknown-value" });
    expect(readPersistedTaskTypeMetadata([
      "task-type:summarize",
      "task-taxonomy:gille-inference-task-types-2099-01-01-v2",
    ])).toEqual({ state: "invalid", reason: "task-type-taxonomy-unsupported-version" });
  });

  it("rejects conflicting values instead of choosing tag order", () => {
    expect(readPersistedTaskTypeMetadata([
      "task-type:summarize",
      "task-type:extract",
      `task-taxonomy:${BROKER_TASK_TYPE_TAXONOMY_VERSION}`,
    ])).toEqual({ state: "invalid", reason: "task-type-metadata-conflicting-values" });
    expect(readPersistedTaskTypeMetadata([
      "type:summarize",
      "type:extract",
    ])).toEqual({ state: "invalid", reason: "legacy-task-type-metadata-conflicting-values" });
  });

  it("rejects conflicting versions, a version without a type, and unknown legacy values", () => {
    expect(readPersistedTaskTypeMetadata([
      "task-type:summarize",
      `task-taxonomy:${BROKER_TASK_TYPE_TAXONOMY_VERSION}`,
      "task-taxonomy:gille-inference-task-types-2099-01-01-v2",
    ])).toEqual({ state: "invalid", reason: "task-type-taxonomy-conflicting-versions" });
    expect(readPersistedTaskTypeMetadata([
      `task-taxonomy:${BROKER_TASK_TYPE_TAXONOMY_VERSION}`,
    ])).toEqual({ state: "invalid", reason: "task-type-taxonomy-missing-type" });
    expect(readPersistedTaskTypeMetadata([
      "type:not-a-real-task-type",
    ])).toEqual({ state: "invalid", reason: "legacy-task-type-metadata-unknown-value" });
  });

  it.each([
    ["pipeline phase", ["type:pipeline", "type:pipeline-phase"]],
    ["pipeline documents", ["type:pipeline-spec", "type:pipeline-summary"]],
    ["approval phase", [
      "type:pipeline",
      "type:pipeline-phase",
      "type:approval-request",
      "type:pipeline-approval-request",
    ]],
    ["task result", ["type:task-result", "type:task-result-structured"]],
  ])("treats Hugin's %s marker tags as missing task metadata", (_name, tags) => {
    expect(readPersistedTaskTypeMetadata(tags)).toEqual({ state: "missing" });
  });

  it("reads a valid legacy task type alongside structural pipeline markers", () => {
    expect(readPersistedTaskTypeMetadata([
      "type:pipeline",
      "type:pipeline-phase",
      "type:summarize",
    ])).toEqual({
      state: "known",
      taskType: "summarize",
      taxonomyVersion: "legacy-unversioned",
      source: "legacy-type-tag",
    });
  });
});
