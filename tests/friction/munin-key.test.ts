import { describe, expect, it } from "vitest";
import {
  FRICTION_NAMESPACE,
  FRICTION_NO_TASK,
  buildFrictionContent,
  buildFrictionKey,
  buildFrictionNamespace,
  buildFrictionTags,
  sanitiseTaskId,
} from "../../src/friction/munin-key.js";

const RECORDED_AT = new Date("2026-05-05T10:30:00.123Z");

describe("buildFrictionNamespace", () => {
  it("returns the flat signals/friction namespace", () => {
    expect(buildFrictionNamespace()).toBe(FRICTION_NAMESPACE);
    expect(buildFrictionNamespace()).toBe("signals/friction");
  });
});

describe("sanitiseTaskId", () => {
  it("returns no-task for undefined or blank", () => {
    expect(sanitiseTaskId(undefined)).toBe(FRICTION_NO_TASK);
    expect(sanitiseTaskId("")).toBe(FRICTION_NO_TASK);
    expect(sanitiseTaskId("   ")).toBe(FRICTION_NO_TASK);
  });

  it("passes through safe ids", () => {
    expect(sanitiseTaskId("t-abc123")).toBe("t-abc123");
    expect(sanitiseTaskId("task_42_v2")).toBe("task_42_v2");
  });

  it("replaces unsafe characters with underscore", () => {
    expect(sanitiseTaskId("foo/bar:baz")).toBe("foo_bar_baz");
    expect(sanitiseTaskId("hello world")).toBe("hello_world");
    expect(sanitiseTaskId("task_42.v2")).toBe("task_42_v2");
  });

  it("prefixes ids that don't start with alphanumeric", () => {
    expect(sanitiseTaskId("-foo")).toBe("t_-foo");
    expect(sanitiseTaskId("_bar")).toBe("t__bar");
  });
});

describe("buildFrictionKey", () => {
  it("combines task id with iso timestamp, : and . both replaced with -", () => {
    expect(buildFrictionKey("t-abc123", RECORDED_AT)).toBe(
      "t-abc123-2026-05-05T10-30-00-123Z",
    );
  });

  it("uses no-task when task id missing", () => {
    expect(buildFrictionKey(undefined, RECORDED_AT)).toBe(
      "no-task-2026-05-05T10-30-00-123Z",
    );
  });

  it("sanitises unsafe task ids", () => {
    expect(buildFrictionKey("foo:bar", RECORDED_AT)).toBe(
      "foo_bar-2026-05-05T10-30-00-123Z",
    );
  });
});

describe("buildFrictionTags", () => {
  it("emits required tags in canonical order", () => {
    const tags = buildFrictionTags({
      input: {
        friction_type: "reasoning_limit",
        severity: "high",
        summary: "x",
        detail: "y",
      },
      modelId: "claude-sonnet-4-6",
      resolvedTaskId: undefined,
    });
    expect(tags).toEqual([
      "friction:reasoning_limit",
      "friction-category:cap",
      "severity:high",
      "model:claude-sonnet-4-6",
      "source:model-self-report",
      "schema:v1",
    ]);
  });

  it("appends optional tags when fields populated", () => {
    const tags = buildFrictionTags({
      input: {
        friction_type: "tool_failure",
        severity: "medium",
        summary: "x",
        detail: "y",
        resource_assessment: "under-resourced",
        alias_suggested: "large-reasoning",
        tool_name: "ssh",
        tags: ["custom-a", "custom-b"],
      },
      modelId: "qwen3:7b",
      resolvedTaskId: "t-123",
    });
    expect(tags).toContain("friction:tool_failure");
    expect(tags).toContain("friction-category:env");
    expect(tags).toContain("severity:medium");
    expect(tags).toContain("model:qwen3:7b");
    expect(tags).toContain("source:model-self-report");
    expect(tags).toContain("schema:v1");
    expect(tags).toContain("task:t-123");
    expect(tags).toContain("resource:under-resourced");
    expect(tags).toContain("alias-suggested:large-reasoning");
    expect(tags).toContain("tool:ssh");
    expect(tags).toContain("custom-a");
    expect(tags).toContain("custom-b");
  });

  it("uses spec short tag for specification category", () => {
    const tags = buildFrictionTags({
      input: {
        friction_type: "ambiguity",
        severity: "low",
        summary: "x",
        detail: "y",
      },
      modelId: "m",
      resolvedTaskId: undefined,
    });
    expect(tags).toContain("friction-category:spec");
  });
});

describe("buildFrictionContent", () => {
  it("serialises all fields with schema_version 1", () => {
    const content = buildFrictionContent({
      input: {
        friction_type: "knowledge_gap",
        severity: "medium",
        summary: "Couldn't recall the API.",
        detail: "Tried 2 versions, both wrong.",
        resource_assessment: "appropriate",
        alias_suggested: "medium",
        tool_name: undefined,
        tags: ["a"],
      },
      modelId: "claude-haiku-4-5",
      resolvedTaskId: "t-abc",
      recordedAt: RECORDED_AT,
    });
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({
      schema_version: 1,
      recorded_at: "2026-05-05T10:30:00.123Z",
      model_id: "claude-haiku-4-5",
      event_id: null,
      task_id_resolved: "t-abc",
      friction_type: "knowledge_gap",
      friction_category: "capability",
      severity: "medium",
      summary: "Couldn't recall the API.",
      detail: "Tried 2 versions, both wrong.",
      resource_assessment: "appropriate",
      alias_suggested: "medium",
      tool_name: null,
      user_tags: ["a"],
    });
  });

  it("nulls out optional fields when omitted", () => {
    const content = buildFrictionContent({
      input: {
        friction_type: "ambiguity",
        severity: "low",
        summary: "x",
        detail: "y",
      },
      modelId: "m",
      resolvedTaskId: undefined,
      recordedAt: RECORDED_AT,
    });
    const parsed = JSON.parse(content);
    expect(parsed.task_id_resolved).toBeNull();
    expect(parsed.event_id).toBeNull();
    expect(parsed.resource_assessment).toBeNull();
    expect(parsed.alias_suggested).toBeNull();
    expect(parsed.tool_name).toBeNull();
    expect(parsed.user_tags).toEqual([]);
  });
});
