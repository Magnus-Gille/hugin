import { describe, expect, it, vi } from "vitest";
import { buildFrictionTool, type FrictionMuninWriter } from "../../src/friction/tool.js";

const FIXED_NOW = new Date("2026-05-05T10:30:00.123Z");

function fakeMunin(write: ReturnType<typeof vi.fn> = vi.fn(async () => ({}))): FrictionMuninWriter {
  return { write } as FrictionMuninWriter;
}

function parseResult(result: { content: { text: string }[]; isError?: boolean }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("report_friction tool — happy path", () => {
  it("writes to signals/friction with the expected payload", async () => {
    const write = vi.fn(async () => ({}));
    const munin = fakeMunin(write);
    const stderr = vi.fn();

    const tool = buildFrictionTool({
      munin,
      modelId: "claude-sonnet-4-6",
      taskId: "t-abc",
      now: () => FIXED_NOW,
      stderr,
    });

    const result = await tool.handler({
      friction_type: "reasoning_limit",
      severity: "high",
      summary: "Hit ceiling on algebra step.",
      detail: "Tried two simplifications, both wrong.",
      resource_assessment: "under-resourced",
      alias_suggested: "large-reasoning",
      tags: ["source:broker-api", "reporter:spoofed", "repo:hugin"],
    });

    expect(result.isError).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    const [namespace, key, content, tags, expectedUpdatedAt, classification] =
      write.mock.calls[0]!;
    expect(namespace).toBe("signals/friction");
    expect(key).toBe("t-abc-2026-05-05T10-30-00-123Z");
    expect(expectedUpdatedAt).toBeUndefined();
    expect(classification).toBe("internal");
    expect(tags).toContain("friction:reasoning_limit");
    expect(tags).toContain("severity:high");
    expect(tags).toContain("model:claude-sonnet-4-6");
    expect(tags).toContain("source:model-self-report");
    expect(tags).toContain("source:standalone-mcp");
    expect(tags).toContain("repo:hugin");
    expect(tags).not.toContain("source:broker-api");
    expect(tags).not.toContain("reporter:spoofed");
    expect(tags).toContain("alias-suggested:large-reasoning");
    expect(tags).toContain("task:t-abc");

    const parsed = JSON.parse(content);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.task_id_resolved).toBe("t-abc");
    expect(parsed.summary).toBe("Hit ceiling on algebra step.");
    expect(parsed.user_tags).toEqual(["repo:hugin"]);

    const body = parseResult(result) as {
      ok: boolean;
      dropped: boolean;
      namespace: string;
      key: string;
    };
    expect(body).toEqual({
      ok: true,
      dropped: false,
      namespace: "signals/friction",
      key: "t-abc-2026-05-05T10-30-00-123Z",
    });
  });
});

describe("report_friction tool — task id resolution", () => {
  it("input.task_id overrides deps.taskId", async () => {
    const write = vi.fn(async () => ({}));
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m",
      taskId: "from-deps",
      now: () => FIXED_NOW,
    });
    await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "y",
      task_id: "from-input",
    });
    const [, key, , tags] = write.mock.calls[0]!;
    expect(key).toBe("from-input-2026-05-05T10-30-00-123Z");
    expect(tags).toContain("task:from-input");
  });

  it("absent both → no-task namespace, no task tag", async () => {
    const write = vi.fn(async () => ({}));
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m",
      now: () => FIXED_NOW,
    });
    await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "y",
    });
    const [, key, , tags] = write.mock.calls[0]!;
    expect(key).toBe("no-task-2026-05-05T10-30-00-123Z");
    expect((tags as string[]).some((t) => t.startsWith("task:"))).toBe(false);
  });
});

describe("report_friction tool — model id resolution", () => {
  it("input.model_id overrides deps.modelId in tags and content", async () => {
    const write = vi.fn(async () => ({}));
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "unknown",
      now: () => FIXED_NOW,
    });
    await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "y",
      model_id: "claude-opus-4-8",
    });
    const [, , content, tags] = write.mock.calls[0]!;
    expect(tags).toContain("model:claude-opus-4-8");
    expect((tags as string[]).some((t) => t === "model:unknown")).toBe(false);
    expect(JSON.parse(content as string).model_id).toBe("claude-opus-4-8");
  });

  it("falls back to deps.modelId when input.model_id absent", async () => {
    const write = vi.fn(async () => ({}));
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "claude-sonnet-4-6",
      now: () => FIXED_NOW,
    });
    await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "y",
    });
    const [, , content, tags] = write.mock.calls[0]!;
    expect(tags).toContain("model:claude-sonnet-4-6");
    expect(JSON.parse(content as string).model_id).toBe("claude-sonnet-4-6");
  });

  it("blank input.model_id falls back to deps.modelId (not empty tag)", async () => {
    const write = vi.fn(async () => ({}));
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "claude-sonnet-4-6",
      now: () => FIXED_NOW,
    });
    await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "y",
      model_id: "   ",
    });
    const [, , , tags] = write.mock.calls[0]!;
    expect(tags).toContain("model:claude-sonnet-4-6");
  });

  it("blank deps.modelId AND blank input → model:unknown, never an empty tag", async () => {
    const write = vi.fn(async () => ({}));
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "   ",
      now: () => FIXED_NOW,
    });
    await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "y",
    });
    const [, , content, tags] = write.mock.calls[0]!;
    expect(tags).toContain("model:unknown");
    expect((tags as string[]).some((t) => t === "model:" || t === "model:   ")).toBe(false);
    expect(JSON.parse(content as string).model_id).toBe("unknown");
  });
});

describe("report_friction tool — failure modes", () => {
  it("zod validation error → isError, kind input_validation", async () => {
    const write = vi.fn(async () => ({}));
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m",
      now: () => FIXED_NOW,
    });
    const result = await tool.handler({
      friction_type: "made_up",
      severity: "low",
      summary: "x",
      detail: "y",
    });
    expect(result.isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
    const body = parseResult(result) as { error: { kind: string } };
    expect(body.error.kind).toBe("input_validation");
  });

  it("munin write rejection → ok:true dropped:true (lossy), stderr logged, no isError", async () => {
    const write = vi.fn(async () => {
      throw new Error("boom");
    });
    const stderr = vi.fn();
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m",
      now: () => FIXED_NOW,
      stderr,
    });
    const result = await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "y",
    });
    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as {
      ok: boolean;
      dropped: boolean;
      reason: string;
    };
    expect(body.ok).toBe(true);
    expect(body.dropped).toBe(true);
    expect(body.reason).toBe("write_error");
    expect(stderr).toHaveBeenCalled();
    expect(stderr.mock.calls[0]![0]).toContain("write error");
  });

  it("hard timeout → ok:true dropped:true reason=timeout", async () => {
    // Munin write that never resolves
    const write = vi.fn(() => new Promise<unknown>(() => {}));
    const stderr = vi.fn();
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m",
      writeTimeoutMs: 20,
      now: () => FIXED_NOW,
      stderr,
    });
    const result = await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "y",
    });
    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as {
      ok: boolean;
      dropped: boolean;
      reason: string;
    };
    expect(body).toMatchObject({ ok: true, dropped: true, reason: "timeout" });
    expect(stderr).toHaveBeenCalled();
    expect(stderr.mock.calls[0]![0]).toContain("timed out");
  });
});
