import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFrictionTool, type FrictionMuninWriter } from "../../src/friction/tool.js";
import { createFrictionOutbox } from "../../src/friction/outbox.js";

const FIXED_NOW = new Date("2026-05-05T10:30:00.123Z");

function fakeMunin(write: ReturnType<typeof vi.fn> = vi.fn(async () => ({}))): FrictionMuninWriter {
  return { write } as FrictionMuninWriter;
}

function parseResult(result: { content: { text: string }[]; isError?: boolean }): unknown {
  return JSON.parse(result.content[0]!.text);
}

async function runChildEnqueue(directory: string, key: string, maxEntries = 1): Promise<unknown> {
  const script = `
    import { createFrictionOutbox } from "./src/friction/outbox.ts";
    (async () => {
      const [directory, key] = process.argv.slice(1);
      const result = await createFrictionOutbox({ directory, maxEntries: Number(process.argv[3]) }).enqueue({
        namespace: "signals/friction",
        key,
        content: "{\\"event\\":true}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      });
      process.stdout.write(JSON.stringify(result));
    })().catch((error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    });
  `;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", script, directory, key, String(maxEntries)],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`child enqueue failed (${code ?? signal}): ${stderr.slice(0, 256)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`child enqueue returned invalid JSON: ${String(error)}`));
      }
    });
  });
}

async function runChildStatus(directory: string, maxEntries: number, maxBytes: number): Promise<unknown> {
  const script = `
    import { createFrictionOutbox } from "./src/friction/outbox.ts";
    (async () => {
      const [directory, maxEntries, maxBytes] = process.argv.slice(1);
      const status = await createFrictionOutbox({
        directory,
        maxEntries: Number(maxEntries),
        maxBytes: Number(maxBytes),
      }).status();
      process.stdout.write(JSON.stringify(status));
    })().catch((error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    });
  `;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", script, directory, String(maxEntries), String(maxBytes)],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`child status failed (${code ?? signal}): ${stderr.slice(0, 256)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`child status returned invalid JSON: ${String(error)}`));
      }
    });
  });
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
    expect(tags).not.toContain("source:standalone-mcp");
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

  it("munin write rejection → fail-visible and durably spooled, stderr logged, no isError", async () => {
    const anthropicToken = "s" + "k-ant-api03-" + "A".repeat(32);
    const openAiProjectToken = "s" + "k-proj-" + "B".repeat(32);
    const openAiLegacyToken = "s" + "k-" + "C".repeat(48);
    const githubToken = "g" + "h" + "p_" + "D".repeat(36);
    const githubFineGrainedToken = "g" + "ithub_pat_" + "E".repeat(30);
    const write = vi.fn(async () => {
      throw new Error(
        "Munin 422: invalid tags; Authorization: Bearer super-secret; Basic basic-secret; "
        + `${anthropicToken} ${openAiProjectToken} ${openAiLegacyToken} `
        + `${githubToken} ${githubFineGrainedToken}`,
      );
    });
    const stderr = vi.fn();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const outbox = createFrictionOutbox({ directory });
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m",
      now: () => FIXED_NOW,
      stderr,
      outbox,
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
    expect(body.ok).toBe(false);
    expect(body.dropped).toBe(true);
    expect(body.reason).toBe("write_error");
    expect(body.recovery).toBe("spooled");
    expect(stderr).toHaveBeenCalled();
    expect(stderr.mock.calls[0]![0]).toContain("write error");
    expect(stderr.mock.calls[0]![0]).toContain("invalid tags");
    expect(stderr.mock.calls[0]![0]).not.toContain("super-secret");
    expect(stderr.mock.calls[0]![0]).not.toContain("basic-secret");
    expect(stderr.mock.calls[0]![0]).not.toContain(anthropicToken);
    expect(stderr.mock.calls[0]![0]).not.toContain(openAiProjectToken);
    expect(stderr.mock.calls[0]![0]).not.toContain(openAiLegacyToken);
    expect(stderr.mock.calls[0]![0]).not.toContain(githubToken);
    expect(stderr.mock.calls[0]![0]).not.toContain(githubFineGrainedToken);
    expect((body as { diagnostic: string }).diagnostic).not.toContain("super-secret");
    expect((body as { diagnostic: string }).diagnostic).not.toContain("basic-secret");
    expect((body as { diagnostic: string }).diagnostic).not.toContain(anthropicToken);
    expect((body as { diagnostic: string }).diagnostic).not.toContain(openAiProjectToken);
    expect((body as { diagnostic: string }).diagnostic).not.toContain(openAiLegacyToken);
    expect((body as { diagnostic: string }).diagnostic).not.toContain(githubToken);
    expect((body as { diagnostic: string }).diagnostic).not.toContain(githubFineGrainedToken);
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
    const stored = JSON.parse(
      fs.readFileSync(path.join(directory, fs.readdirSync(directory).find((entry) => entry.endsWith(".json"))!), "utf8"),
    ) as { namespace: string; key: string; content: string; tags: string[] };
    expect(stored.namespace).toBe("signals/friction");
    expect(stored.key).toBe("no-task-2026-05-05T10-30-00-123Z");
    expect(stored.content).toContain('"summary": "x"');
    expect(stored.content).not.toContain(anthropicToken);
    expect(stored.content).not.toContain(openAiProjectToken);
    expect(stored.content).not.toContain(openAiLegacyToken);
    expect(stored.content).not.toContain(githubToken);
    expect(stored.content).not.toContain(githubFineGrainedToken);
    expect(stored.tags.length).toBeLessThanOrEqual(20);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(directory, fs.readdirSync(directory).find((entry) => entry.endsWith(".json"))!)).mode & 0o777).toBe(0o600);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("synchronous Munin writer failure is also fail-visible and durably spooled", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const tool = buildFrictionTool({
      munin: fakeMunin((() => {
        throw new Error("synchronous writer failure");
      }) as unknown as ReturnType<typeof vi.fn>),
      modelId: "m",
      now: () => FIXED_NOW,
      outbox: createFrictionOutbox({ directory }),
    });

    const result = await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "y",
    });

    expect(parseResult(result)).toMatchObject({
      ok: false,
      dropped: true,
      reason: "write_error",
      recovery: "spooled",
    });
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("spools valid reports whose escaped content exceeds the old entry cap", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const write = vi.fn(async () => {
      throw new Error("offline");
    });
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m",
      now: () => FIXED_NOW,
      outbox: createFrictionOutbox({ directory }),
    });

    const result = await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "\\".repeat(8_000),
    });

    expect(parseResult(result)).toMatchObject({
      ok: false,
      dropped: true,
      reason: "write_error",
      recovery: "spooled",
    });
    const fileName = fs.readdirSync(directory).find((entry) => entry.endsWith(".json"));
    expect(fileName).toBeDefined();
    const stored = fs.readFileSync(path.join(directory, fileName!), "utf8");
    expect(stored.length).toBeGreaterThan(16_000);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("clamps long derived model and task tags before outbox validation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const write = vi.fn(async () => {
      throw new Error("offline");
    });
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m".repeat(200),
      taskId: "t".repeat(200),
      now: () => FIXED_NOW,
      outbox: createFrictionOutbox({ directory }),
    });

    const result = await tool.handler({
      friction_type: "ambiguity",
      severity: "low",
      summary: "x",
      detail: "y",
    });

    expect(parseResult(result)).toMatchObject({
      ok: false,
      dropped: true,
      reason: "write_error",
      recovery: "spooled",
    });
    const fileName = fs.readdirSync(directory).find((entry) => entry.endsWith(".json"));
    expect(fileName).toBeDefined();
    const stored = JSON.parse(fs.readFileSync(path.join(directory, fileName!), "utf8")) as {
      tags: string[];
    };
    expect(stored.tags.every((tag) => tag.length <= 200)).toBe(true);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("returns a visible outbox error instead of throwing on invalid durable input", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const stderr = vi.fn();
    const outbox = createFrictionOutbox({ directory, stderr });

    const result = await outbox.enqueue({
      namespace: "signals/friction",
      key: "invalid-entry",
      content: "{}",
      tags: ["x".repeat(201)],
      classification: "internal",
    });

    expect(result).toMatchObject({ stored: false, reason: "outbox_error" });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unable to spool event"));
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(0);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("hard timeout → fail-visible and durably spooled", async () => {
    // Munin write that never resolves
    const write = vi.fn(() => new Promise<unknown>(() => {}));
    const stderr = vi.fn();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m",
      writeTimeoutMs: 20,
      now: () => FIXED_NOW,
      stderr,
      outbox: createFrictionOutbox({ directory }),
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
    expect(body).toMatchObject({ ok: false, dropped: true, reason: "timeout", recovery: "spooled" });
    expect(stderr).toHaveBeenCalled();
    expect(stderr.mock.calls[0]![0]).toContain("timed out");
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("replays a spooled event once and keeps distinct recurrences", async () => {
    let recordedAt = FIXED_NOW;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const outbox = createFrictionOutbox({ directory });
    const write = vi.fn(async () => { throw new Error("temporarily unavailable"); });
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m",
      now: () => recordedAt,
      outbox,
    });

    await tool.handler({ friction_type: "ambiguity", severity: "low", summary: "x", detail: "y" });
    recordedAt = new Date(FIXED_NOW.getTime() + 1_000);
    await tool.handler({ friction_type: "ambiguity", severity: "low", summary: "x", detail: "y" });
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(2);

    write.mockImplementation(async () => ({ status: "created" }));
    const replay = await createFrictionOutbox({ directory }).replay(fakeMunin(write));
    expect(replay.replayed).toBe(2);
    expect(replay.failed).toBe(0);
    expect(write).toHaveBeenCalledTimes(4);
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(0);

    const secondReplay = await outbox.replay(fakeMunin(write));
    expect(secondReplay.replayed).toBe(0);
    expect(write).toHaveBeenCalledTimes(4);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("reports a bounded outbox without evicting older evidence", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const outbox = createFrictionOutbox({ directory, maxEntries: 1 });
    const write = vi.fn(async () => { throw new Error("down"); });
    const tool = buildFrictionTool({
      munin: fakeMunin(write),
      modelId: "m",
      outbox,
      now: () => FIXED_NOW,
    });

    await tool.handler({ friction_type: "ambiguity", severity: "low", summary: "first", detail: "y" });
    const result = await tool.handler({ friction_type: "ambiguity", severity: "low", summary: "second", detail: "y" });
    expect(parseResult(result)).toMatchObject({ ok: false, dropped: true, recovery: "outbox_full" });
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("keeps concurrent distinct enqueues within the configured bound", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const outbox = createFrictionOutbox({ directory, maxEntries: 1 });
    const common = {
      namespace: "signals/friction",
      content: "{\"event\":true}",
      tags: ["friction:ambiguity"],
      classification: "internal",
    } as const;

    const results = await Promise.all([
      outbox.enqueue({ ...common, key: "event-a" }),
      outbox.enqueue({ ...common, key: "event-b" }),
    ]);

    expect(results.filter((result) => result.stored)).toHaveLength(1);
    expect(results.filter((result) => !result.stored)).toHaveLength(1);
    expect((await outbox.status()).pendingCount).toBe(1);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("coordinates idempotent enqueues across processes without flock", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const results = await Promise.all([
        runChildEnqueue(directory, "cross-process-event", 2),
        runChildEnqueue(directory, "cross-process-event", 2),
      ]) as Array<{ stored: boolean; duplicate?: boolean }>;
      expect(results.filter((result) => result.stored)).toHaveLength(2);
      expect(results.some((result) => result.duplicate === true)).toBe(true);
      expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("converges concurrent cross-process writers into active and quarantine bounds", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const results = await Promise.all([
        runChildEnqueue(directory, "cross-process-a", 4),
        runChildEnqueue(directory, "cross-process-b", 4),
        runChildEnqueue(directory, "cross-process-c", 4),
        runChildEnqueue(directory, "cross-process-d", 4),
      ]) as Array<{ stored: boolean }>;
      expect(results.every((result) => result.stored)).toBe(true);
      const outbox = createFrictionOutbox({ directory, maxEntries: 2 });
      expect(await outbox.status()).toMatchObject({
        pendingCount: 2,
        quarantinedCount: 2,
      });
      expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(2);
      expect(fs.readdirSync(path.join(directory, "quarantine"))).toHaveLength(2);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("converges concurrent trimmers with atomic per-entry claims", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const writer = createFrictionOutbox({ directory, maxEntries: 2 });
      await writer.enqueue({
        namespace: "signals/friction",
        key: "trim-a",
        content: "{\"event\":\"a\"}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      });
      await writer.enqueue({
        namespace: "signals/friction",
        key: "trim-b",
        content: "{\"event\":\"b\"}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      });

      const left = createFrictionOutbox({ directory, maxEntries: 1 });
      const right = createFrictionOutbox({ directory, maxEntries: 1 });
      await Promise.all([left.status(), right.status()]);
      const status = await left.status();
      expect(status.pendingCount).toBe(1);
      expect(status.quarantinedCount).toBe(1);
      expect(fs.readdirSync(path.join(directory, "quarantine"))).toHaveLength(1);
      const duplicate = await left.enqueue({
        namespace: "signals/friction",
        key: "trim-a",
        content: "{\"event\":\"a\"}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      });
      expect(duplicate).toMatchObject({ stored: true, duplicate: true });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("converges overfull quarantine entry and byte bounds without deleting root artifacts", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const quarantine = path.join(directory, "quarantine");
      fs.mkdirSync(quarantine, { mode: 0o700 });
      const makeEntry = (key: string) => ({
        version: 1 as const,
        enqueuedAt: FIXED_NOW.toISOString(),
        namespace: "signals/friction",
        key,
        content: "{\"event\":true}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      });
      const first = `${JSON.stringify(makeEntry("quarantine-a"))}\n`;
      const second = `${JSON.stringify(makeEntry("quarantine-b"))}\n`;
      fs.writeFileSync(
        path.join(quarantine, `${"a".repeat(64)}.${"b".repeat(32)}.quarantine`),
        first,
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(quarantine, `${"c".repeat(64)}.${"d".repeat(32)}.quarantine`),
        second,
        { mode: 0o600 },
      );
      const unrelated = path.join(directory, "unrelated-artifact");
      fs.writeFileSync(unrelated, "keep me", { mode: 0o600 });

      await Promise.all(Array.from({ length: 4 }, () =>
        runChildStatus(directory, 1, first.length + 1)));
      const status = await createFrictionOutbox({
        directory,
        maxEntries: 1,
        maxBytes: first.length + 1,
      }).status();
      expect(status).toMatchObject({ pendingCount: 1, quarantinedCount: 1 });
      const quarantineFiles = fs.readdirSync(quarantine);
      expect(quarantineFiles).toHaveLength(1);
      expect(fs.statSync(path.join(quarantine, quarantineFiles[0]!)).size).toBeLessThanOrEqual(first.length + 1);
      expect(fs.readFileSync(unrelated, "utf8")).toBe("keep me");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores a valid overflow claim when quarantine capacity is full", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const makeEntry = (key: string) => ({
        version: 1 as const,
        enqueuedAt: FIXED_NOW.toISOString(),
        namespace: "signals/friction",
        key,
        content: "{\"event\":true}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      });
      const occupied = `${JSON.stringify(makeEntry("occupied-quarantine"))}\n`;
      const quarantine = path.join(directory, "quarantine");
      fs.mkdirSync(quarantine, { mode: 0o700 });
      fs.writeFileSync(
        path.join(quarantine, `${"e".repeat(64)}.${"f".repeat(32)}.quarantine`),
        occupied,
        { mode: 0o600 },
      );
      const writer = createFrictionOutbox({ directory, maxEntries: 2 });
      const overflow = makeEntry("overflow-when-full");
      await writer.enqueue(overflow);

      const outbox = createFrictionOutbox({ directory, maxEntries: 1 });
      const status = await outbox.status();
      expect(status).toMatchObject({ pendingCount: 1, quarantinedCount: 1 });
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(1);
      expect(fs.readdirSync(directory).some((name) => name.endsWith(".claim"))).toBe(false);

      const replayed = await outbox.replay({ write: vi.fn(async () => ({ status: "created" })) });
      expect(replayed.replayed).toBe(2);
      expect(replayed.failed).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps malformed quarantine overflow bounded and observable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const quarantine = path.join(directory, "quarantine");
      fs.mkdirSync(quarantine, { mode: 0o700 });
      for (const [prefix, suffix] of [["a", "b"], ["c", "d"]]) {
        fs.writeFileSync(
          path.join(quarantine, `${prefix.repeat(64)}.${suffix.repeat(32)}.quarantine`),
          "not-json",
          { mode: 0o600 },
        );
      }
      const stderr = vi.fn();
      const outbox = createFrictionOutbox({ directory, maxEntries: 1, stderr });
      const status = await outbox.status();
      expect(status).toMatchObject({ pendingCount: 1, quarantinedCount: 1 });
      expect(fs.readdirSync(quarantine)).toHaveLength(1);
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".claim"))).toHaveLength(1);
      expect(stderr.mock.calls.flat().join(" ")).toContain("retained non-replayable");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a replacement path safe after an atomic claim", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const outbox = createFrictionOutbox({ directory, maxEntries: 2 });
      await outbox.enqueue({
        namespace: "signals/friction",
        key: "replacement-race",
        content: "{\"event\":true}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      });
      const eventName = fs.readdirSync(directory).find((entry) => entry.endsWith(".json"))!;
      const internals = outbox as unknown as {
        claimRootFile: (filePath: string, fileName: string, reason: "overflow") => Promise<string | null>;
        finishClaim: (claimName: string, fileSize: number) => Promise<string | null>;
      };
      const eventPath = path.join(directory, eventName);
      const claimPath = await internals.claimRootFile(eventPath, eventName, "overflow");
      expect(claimPath).toBeTruthy();

      const replacement = "replacement must remain at its original path\n";
      fs.writeFileSync(eventPath, replacement, { mode: 0o600 });
      await internals.finishClaim(path.relative(directory, claimPath!), 1);
      expect(fs.readFileSync(eventPath, "utf8")).toBe(replacement);
      expect(fs.readdirSync(path.join(directory, "quarantine"))).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers an orphaned claim without deleting unrelated files", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const claim = `.${"c".repeat(64)}.json.123.${"d".repeat(8)}.malformed.claim`;
      fs.writeFileSync(path.join(directory, claim), "not-json", { mode: 0o600 });
      const outbox = createFrictionOutbox({ directory, maxEntries: 1 });
      const status = await outbox.status();
      expect(status).toMatchObject({ pendingCount: 0, quarantinedCount: 1 });
      expect(fs.existsSync(path.join(directory, claim))).toBe(false);
      expect(fs.readdirSync(path.join(directory, "quarantine"))).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers a complete orphan temp before applying the entry bound", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const entry = {
        namespace: "signals/friction",
        key: "complete-orphan-temp",
        content: "{\"event\":true}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      } as const;
      const outbox = createFrictionOutbox({ directory, maxEntries: 1 });
      await outbox.enqueue(entry);
      const eventName = fs.readdirSync(directory).find((name) => name.endsWith(".json"))!;
      const tempName = `.${eventName}.123.${"e".repeat(8)}.tmp`;
      fs.renameSync(path.join(directory, eventName), path.join(directory, tempName));

      const retried = await outbox.enqueue(entry);
      expect(retried).toMatchObject({ stored: true, duplicate: true, pendingCount: 1 });
      expect(fs.existsSync(path.join(directory, tempName))).toBe(false);
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers a schema-valid Unicode orphan temp larger than 128 KiB", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const entry = {
        namespace: "signals/friction",
        key: "large-unicode-orphan-temp",
        content: "€".repeat(64_000),
        tags: ["friction:ambiguity"],
        classification: "internal",
      } as const;
      const outbox = createFrictionOutbox({ directory, maxEntries: 1 });
      await outbox.enqueue(entry);
      const eventName = fs.readdirSync(directory).find((name) => name.endsWith(".json"))!;
      const eventPath = path.join(directory, eventName);
      expect(fs.statSync(eventPath).size).toBeGreaterThan(128 * 1024);
      const tempName = `.${eventName}.123.${"e".repeat(8)}.tmp`;
      fs.renameSync(eventPath, path.join(directory, tempName));

      const status = await outbox.status();
      expect(status).toMatchObject({ pendingCount: 1 });
      expect(fs.existsSync(path.join(directory, tempName))).toBe(false);
      expect(fs.existsSync(eventPath)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a digest pathname contains a different valid event", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const requested = {
        namespace: "signals/friction",
        key: "requested-content-address",
        content: "requested event",
        tags: ["friction:ambiguity"],
        classification: "internal",
      } as const;
      const replacement = {
        ...requested,
        key: "replacement-content-address",
        content: "different valid event",
      } as const;
      const outbox = createFrictionOutbox({ directory, maxEntries: 2 });
      await outbox.enqueue(requested);
      const requestedName = fs.readdirSync(directory).find((name) => name.endsWith(".json"))!;
      await outbox.enqueue(replacement);
      const replacementName = fs.readdirSync(directory)
        .find((name) => name.endsWith(".json") && name !== requestedName)!;
      const replacementBytes = fs.readFileSync(path.join(directory, replacementName));
      fs.unlinkSync(path.join(directory, requestedName));
      fs.renameSync(path.join(directory, replacementName), path.join(directory, requestedName));

      await expect(outbox.enqueue(requested)).resolves.toMatchObject({
        stored: false,
        reason: "outbox_error",
      });
      expect(fs.readFileSync(path.join(directory, requestedName))).toEqual(replacementBytes);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains a partial orphan temp and does not waive the entry bound", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const entry = {
        namespace: "signals/friction",
        key: "partial-orphan-temp",
        content: "{\"event\":true}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      } as const;
      const outbox = createFrictionOutbox({ directory, maxEntries: 1 });
      await outbox.enqueue(entry);
      const eventName = fs.readdirSync(directory).find((name) => name.endsWith(".json"))!;
      const tempName = `.${eventName}.123.${"f".repeat(8)}.tmp`;
      fs.renameSync(path.join(directory, eventName), path.join(directory, tempName));
      fs.writeFileSync(path.join(directory, tempName), "{\"partial\":", { mode: 0o600 });

      const retried = await outbox.enqueue({
        ...entry,
        key: "different-entry",
      });
      expect(retried).toMatchObject({ stored: false, reason: "outbox_full", pendingCount: 1 });
      expect(fs.existsSync(path.join(directory, tempName))).toBe(true);
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not recover a complete temp whose digest names another event", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const entry = {
        namespace: "signals/friction",
        key: "mismatched-orphan-temp",
        content: "{\"event\":true}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      } as const;
      const outbox = createFrictionOutbox({ directory, maxEntries: 1 });
      await outbox.enqueue(entry);
      const eventName = fs.readdirSync(directory).find((name) => name.endsWith(".json"))!;
      const wrongName = `.${"a".repeat(64)}.json.123.${"a".repeat(8)}.tmp`;
      fs.renameSync(path.join(directory, eventName), path.join(directory, wrongName));

      const status = await outbox.status();
      expect(status).toMatchObject({ pendingCount: 1, quarantinedCount: 0 });
      expect(fs.existsSync(path.join(directory, wrongName))).toBe(true);
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("counts an unrecognised hidden temp artifact toward the active bound", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const tempName = ".unrelated-work.tmp";
      fs.writeFileSync(path.join(directory, tempName), "preserve", { mode: 0o600 });
      const result = await createFrictionOutbox({ directory, maxEntries: 1 }).enqueue({
        namespace: "signals/friction",
        key: "hidden-temp-bound",
        content: "event",
        tags: ["friction:ambiguity"],
        classification: "internal",
      });
      expect(result).toMatchObject({ stored: false, reason: "outbox_full", pendingCount: 1 });
      expect(fs.existsSync(path.join(directory, tempName))).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers a complete orphan temp idempotently across concurrent processes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    try {
      const entry = {
        namespace: "signals/friction",
        key: "concurrent-orphan-recovery",
        content: "{\"event\":true}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      } as const;
      const writer = createFrictionOutbox({ directory, maxEntries: 2 });
      await writer.enqueue(entry);
      const eventName = fs.readdirSync(directory).find((name) => name.endsWith(".json"))!;
      const tempName = `.${eventName}.123.${"b".repeat(8)}.tmp`;
      fs.renameSync(path.join(directory, eventName), path.join(directory, tempName));

      const [left, right] = await Promise.all([
        createFrictionOutbox({ directory, maxEntries: 1 }).enqueue(entry),
        createFrictionOutbox({ directory, maxEntries: 1 }).enqueue(entry),
      ]);
      expect(left).toMatchObject({ stored: true, duplicate: true });
      expect(right).toMatchObject({ stored: true, duplicate: true });
      expect(fs.existsSync(path.join(directory, tempName))).toBe(false);
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains failed replays and accepts an exact already-existing Munin entry", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const outbox = createFrictionOutbox({ directory, replayTimeoutMs: 20 });
    const entry = {
      namespace: "signals/friction",
      key: "no-task-replay",
      content: '{"event_id":"replay-1"}',
      tags: ["friction:ambiguity"],
      classification: "internal",
      enqueuedAt: FIXED_NOW.toISOString(),
    } as const;
    await outbox.enqueue(entry);

    const failedWriter = {
      write: vi.fn(async () => { throw new Error("offline"); }),
    };
    const failed = await outbox.replay(failedWriter);
    expect(failed).toMatchObject({ replayed: 0, failed: 1, pendingCount: 1 });

    const exactConflictWriter = {
      write: vi.fn(async () => {
        const error = new Error("already exists") as Error & { conflictReason: string };
        error.conflictReason = "already_exists";
        throw error;
      }),
      read: vi.fn(async () => ({
        content: entry.content,
        tags: [...entry.tags].reverse(),
      })),
    };
    const replayed = await createFrictionOutbox({ directory }).replay(exactConflictWriter);
    expect(replayed).toMatchObject({ replayed: 1, failed: 0, pendingCount: 0 });
    expect(exactConflictWriter.read).toHaveBeenCalledWith(entry.namespace, entry.key);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("retains an event when replay returns anything other than status:created", async () => {
    for (const ambiguousResult of [
      undefined,
      {},
      { ok: true },
      { status: "updated" },
      { ok: false, status: "created" },
    ]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
      const outbox = createFrictionOutbox({ directory });
      await outbox.enqueue({
        namespace: "signals/friction",
        key: "ambiguous-replay",
        content: "{\"event\":true}",
        tags: ["friction:ambiguity"],
        classification: "internal",
      });
      const writer = {
        write: vi.fn(async () => ambiguousResult),
      };
      const replayed = await outbox.replay(writer);
      expect(replayed).toMatchObject({ replayed: 0, failed: 1, pendingCount: 1 });
      expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays concurrently without holding the enqueue admission lock", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const outbox = createFrictionOutbox({ directory });
    await outbox.enqueue({
      namespace: "signals/friction",
      key: "concurrent-replay",
      content: "{\"event\":true}",
      tags: ["friction:ambiguity"],
      classification: "internal",
    });

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writer = {
      write: vi.fn(async () => {
        await writeGate;
        return { status: "created" };
      }),
    };
    const firstReplay = outbox.replay(writer);
    while (writer.write.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const secondReplay = outbox.replay(writer);
    for (let attempt = 0; attempt < 200 && writer.write.mock.calls.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(writer.write).toHaveBeenCalledTimes(2);
    releaseWrite();

    const [first, second] = await Promise.all([firstReplay, secondReplay]);
    expect(first.replayed + second.replayed).toBe(2);
    expect(first.failed + second.failed).toBe(0);
    expect((await outbox.status()).pendingCount).toBe(0);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("admits new evidence while a replay writer remains pending", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const outbox = createFrictionOutbox({ directory });
    await outbox.enqueue({
      namespace: "signals/friction",
      key: "replay-blocking",
      content: "{\"event\":true}",
      tags: ["friction:ambiguity"],
      classification: "internal",
    });

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writer = {
      write: vi.fn(async () => {
        await writeGate;
        return { status: "created" };
      }),
    };
    const replay = outbox.replay(writer);
    while (writer.write.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const admitted = await outbox.enqueue({
      namespace: "signals/friction",
      key: "during-replay",
      content: "{\"event\":false}",
      tags: ["friction:ambiguity"],
      classification: "internal",
    });
    expect(admitted).toMatchObject({ stored: true, duplicate: false });
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))).toHaveLength(2);

    releaseWrite();
    const replayResult = await replay;
    expect(replayResult).toMatchObject({ replayed: 1, failed: 0, pendingCount: 1 });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("quarantines malformed events without poisoning active bounds", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const secretName = "s" + "k-ant-api03-" + "A".repeat(32);
    fs.writeFileSync(path.join(directory, `${secretName}.json`), "not-json", { mode: 0o600 });
    const stderr = vi.fn();
    const outbox = createFrictionOutbox({ directory, maxEntries: 1, stderr });

    const admitted = await outbox.enqueue({
      namespace: "signals/friction",
      key: "after-malformed",
      content: "{\"event\":true}",
      tags: ["friction:ambiguity"],
      classification: "internal",
    });

    expect(admitted).toMatchObject({ stored: true, duplicate: false, quarantinedCount: 1 });
    expect(fs.readdirSync(path.join(directory, "quarantine"))).toHaveLength(1);
    expect((await outbox.status())).toMatchObject({
      pendingCount: 1,
      quarantinedCount: 1,
    });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("quarantined"));
    expect(stderr.mock.calls.flat().join(" ")).not.toContain(secretName);
    expect(fs.readdirSync(path.join(directory, "quarantine")).join(" ")).not.toContain(secretName);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("counts exact orphan temp files toward bounds", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
    const orphan = `.${"a".repeat(64)}.json.123.${"b".repeat(8)}.tmp`;
    fs.writeFileSync(path.join(directory, orphan), "orphan", { mode: 0o600 });
    const outbox = createFrictionOutbox({ directory, maxEntries: 1 });

    const result = await outbox.enqueue({
      namespace: "signals/friction",
      key: "after-orphan",
      content: "{\"event\":true}",
      tags: ["friction:ambiguity"],
      classification: "internal",
    });

    expect(result).toMatchObject({ stored: false, reason: "outbox_full", pendingCount: 1 });
    expect((await outbox.status())).toMatchObject({ pendingCount: 1 });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("does not reconcile a conflicting content or classification", async () => {
    const entry = {
      namespace: "signals/friction",
      key: "conflicting-replay",
      content: "{\"event\":true}",
      tags: ["friction:ambiguity"],
      classification: "internal",
      enqueuedAt: FIXED_NOW.toISOString(),
    } as const;
    for (const existing of [
      { content: "{\"event\":false}", classification: "internal" },
      { content: entry.content, classification: "public" },
    ]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-friction-outbox-"));
      const outbox = createFrictionOutbox({ directory });
      await outbox.enqueue(entry);
      const writer = {
        write: vi.fn(async () => {
          const error = new Error("already exists") as Error & { conflictReason: string };
          error.conflictReason = "already_exists";
          throw error;
        }),
        read: vi.fn(async () => ({
          content: existing.content,
          tags: entry.tags,
          classification: existing.classification,
        })),
      };
      const replayed = await outbox.replay(writer);
      expect(replayed).toMatchObject({ replayed: 0, failed: 1, pendingCount: 1 });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
