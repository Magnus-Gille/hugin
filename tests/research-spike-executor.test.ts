import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import {
  __test__,
  buildResearchLaunch,
  executeResearchSpike,
  loadResearchRuntimeConfig,
  sanitizeResearchPrompt,
  validateResearchUrl,
} from "../src/research-spike-executor.js";

const env = {
  HUGIN_RESEARCH_M5_URL: "http://100.99.119.52:8080",
  HUGIN_RESEARCH_M5_API_KEY: "test-key",
  HUGIN_RESEARCH_SEARCH_HELPER: "/opt/hugin/search-helper",
  HUGIN_RESEARCH_FETCH_HELPER: "/opt/hugin/fetch-helper",
};

function mockPi(stdout: string, stderr = "", code = 0): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  });
}

async function researchRequest(root: string, maxOutputChars: number) {
  const stagingRoot = await realpath(root);
  return {
    prompt: "research",
    workingDir: root,
    timeoutMs: 10_000,
    maxOutputChars,
    env: {
      ...env,
      HUGIN_RESEARCH_SEARCH_HELPER: process.execPath,
      HUGIN_RESEARCH_FETCH_HELPER: process.execPath,
      HUGIN_RESEARCH_PI_CMD: process.execPath,
      HUGIN_RESEARCH_BWRAP_CMD: process.execPath,
    },
    allowedStagingPrefixes: [stagingRoot],
    artifactManifest: { artifacts: [
      { id: "report", local: path.join(root, "report.md"), remote: "magnus@nas:/r/report.md", required: true },
      { id: "reading", local: path.join(root, "reading.md"), remote: "magnus@nas:/r/reading.md", required: true },
    ] },
  } as const;
}

describe("dedicated research Pi/M5 runtime", () => {
  it("requires explicit local M5 and both helper commands", () => {
    expect(loadResearchRuntimeConfig(env)).toMatchObject({ ok: true });
    expect(loadResearchRuntimeConfig({ ...env, HUGIN_RESEARCH_M5_URL: "https://openrouter.ai" })).toMatchObject({ ok: false });
    expect(loadResearchRuntimeConfig({ ...env, HUGIN_RESEARCH_SEARCH_HELPER: "search" })).toMatchObject({ ok: false });
  });

  it("reuses the managed homeserver M5 gateway without duplicating credentials", () => {
    expect(loadResearchRuntimeConfig({
      HOMESERVER_GATEWAY_URL: "http://100.99.119.52:8080",
      HOMESERVER_GATEWAY_API_KEY: "managed-key",
      HUGIN_RESEARCH_SEARCH_HELPER: "/opt/hugin/search-helper",
      HUGIN_RESEARCH_FETCH_HELPER: "/opt/hugin/fetch-helper",
    })).toMatchObject({ ok: true, config: { gatewayApiKey: "managed-key" } });
  });

  it("rejects SSRF targets and permits configured public hosts", () => {
    expect(() => validateResearchUrl("http://127.0.0.1/x")).toThrow(/forbidden/);
    expect(() => validateResearchUrl("http://10.0.0.1/x")).toThrow(/forbidden/);
    expect(validateResearchUrl("https://example.com/a", ["example.com"])).toBe("https://example.com/a");
    expect(() => validateResearchUrl("https://other.example/a", ["example.com"])).toThrow(/allowlist/);
  });

  it("builds the provider config with an env reference, never the key", () => {
    const config = loadResearchRuntimeConfig(env);
    if (!config.ok) throw new Error(config.reason);
    const rendered = __test__.providerModelsJson(config.config);
    expect(rendered).toContain("$HUGIN_RESEARCH_M5_API_KEY");
    expect(rendered).not.toContain("test-key");
  });

  it("constructs a deny-by-default bwrap/Pi launch", () => {
    const config = loadResearchRuntimeConfig(env);
    if (!config.ok) throw new Error(config.reason);
    const request = {
      prompt: "research",
      workingDir: "/home/magnus/scratch",
      timeoutMs: 1000,
      maxOutputChars: 1000,
      artifactManifest: { artifacts: [
        { id: "report", local: "/home/magnus/scratch/report.md", remote: "magnus@nas:/r/report.md", required: true },
        { id: "reading", local: "/home/magnus/scratch/reading.md", remote: "magnus@nas:/r/reading.md", required: true },
      ] },
    };
    const launch = buildResearchLaunch(request, config.config, "/tmp/config", "/tmp/extension.mjs", ["/home/magnus/scratch/report.md", "/home/magnus/scratch/reading.md"]);
    expect(launch.args).toContain("--no-builtin-tools");
    expect(launch.args).toContain("web_search,fetch_content,write_artifact");
    expect(launch.args).toContain("--bind");
    expect(launch.args).toContain("/tmp/hugin-research-pi");
    expect(launch.args).toContain("/tmp/hugin-research-pi-extension.mjs");
    expect(launch.args).not.toContain("/opt/hugin-research-pi");
    expect(launch.env.PI_CODING_AGENT_DIR).toBe("/tmp/hugin-research-pi");
    const configDestination = launch.args.indexOf("/tmp/hugin-research-pi");
    const extensionDestination = launch.args.indexOf("/tmp/hugin-research-pi-extension.mjs");
    expect(launch.args[configDestination - 2]).toBe("--bind");
    expect(launch.args[extensionDestination - 2]).toBe("--ro-bind");
    expect(launch.env).toEqual(expect.objectContaining({ PATH: "/home/magnus/.npm-global/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/hugin-research-home" }));
    expect(launch.env).not.toHaveProperty("MUNIN_API_KEY");
  });

  it("refuses to overwrite an existing staging artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-existing-"));
    const existing = path.join(root, "report.md");
    await writeFile(existing, "keep me");
    try {
      await expect(__test__.precreateArtifacts({ artifacts: [
        { id: "report", local: existing, remote: "magnus@nas:/r/report.md", required: true },
      ] }, [root])).rejects.toThrow();
      expect(await readFile(existing, "utf8")).toBe("keep me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes legacy agent-owned delivery and remote destinations from the model prompt", () => {
    const sanitized = sanitizeResearchPrompt([
      "Research the hardware options.",
      "### Phase 6 — Deliver and index",
      "rsync report.md magnus@nas:/home/magnus/mimir-inbox/research/report.md",
      "memory_write documents/report/index",
      "## Constraints",
      "Cite primary sources.",
      "Remote destination: magnus@10.0.0.2:/secret/report.md",
    ].join("\n"));
    expect(sanitized).toContain("Research the hardware options.");
    expect(sanitized).toContain("Cite primary sources.");
    expect(sanitized).not.toMatch(/rsync|memory_write|magnus@|mimir-inbox|\/secret\/report/i);
  });

  it("turns a semantic Pi turn error into a failed result even with process exit 0", () => {
    expect(__test__.parsePiOutput(JSON.stringify({ type: "turn_end", message: { stopReason: "error", errorMessage: "tool failed" } }))).toMatchObject({ error: "tool failed" });
    expect(__test__.parsePiOutput(JSON.stringify({ type: "message", message: { role: "assistant", content: "done", stopReason: "stop" } }))).toEqual({ text: "done" });
  });

  it("bounds output and resultText while still detecting a late semantic error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-output-bound-"));
    try {
      const transcript = [
        JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(120_000) } }),
        JSON.stringify({ type: "turn_end", message: { stopReason: "error", errorMessage: "late tool failure" } }),
      ].join("\n");
      mockPi(transcript);
      const result = await executeResearchSpike(await researchRequest(root, 1_000));
      expect(result.exitCode).toBe(1);
      expect(result.error).toBe("late tool failure");
      expect(result.output.length).toBeLessThanOrEqual(1_000);
      expect(result.resultText?.length).toBeLessThanOrEqual(1_000);
      expect(result.output).toContain("[...truncated]");
      expect(result.resultText).toContain("[...truncated]");
      expect(result.output).toContain("late tool failure");
      expect(result.resultText).toContain("late tool failure");
      expect(result.output.startsWith("late tool failure")).toBe(true);
      expect(result.resultText?.startsWith("late tool failure")).toBe(true);
      expect((await readFile(result.logFile, "utf8")).length).toBeLessThanOrEqual(100_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a large configured max below the Munin-safe research result cap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-munin-bound-"));
    try {
      const transcript = [
        JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(120_000) } }),
        JSON.stringify({ type: "turn_end", message: { stopReason: "error", errorMessage: "late tool failure" } }),
      ].join("\n");
      mockPi(transcript);
      const result = await executeResearchSpike(await researchRequest(root, 1_000_000));
      expect(result.exitCode).toBe(1);
      expect(result.output.length).toBeLessThanOrEqual(50_000);
      expect(result.resultText?.length).toBeLessThanOrEqual(50_000);
      expect(result.error?.length).toBeLessThanOrEqual(50_000);
      expect(result.output).toContain("late tool failure");
      expect(result.resultText).toContain("late tool failure");
      expect(result.output).toContain("[...truncated]");
      expect(result.resultText).toContain("[...truncated]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a bounded stderr fallback with an explicit marker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-stderr-bound-"));
    try {
      mockPi("not-json\n", "e".repeat(120_000), 1);
      const result = await executeResearchSpike(await researchRequest(root, 1_000));
      expect(result.exitCode).toBe(1);
      expect(result.resultText).toBeNull();
      expect(result.output.length).toBeLessThanOrEqual(1_000);
      expect(result.output).toContain("[...truncated]");
      expect((await readFile(result.logFile, "utf8")).length).toBeLessThanOrEqual(100_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes only the three Hugin tool result shapes and refuses unknown artifact IDs", async () => {
    const registered: Record<string, { execute: (id: string, params: Record<string, string>) => Promise<unknown> }> = {};
    const module = await import("../scripts/research-pi-extension.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-extension-test-"));
    const artifact = path.join(root, "report.md");
    const previous = { ...process.env };
    process.env.HUGIN_RESEARCH_ARTIFACTS = JSON.stringify({ report: artifact });
    try {
      module.default({ registerTool(tool: { name: string; execute: (id: string, params: Record<string, string>) => Promise<unknown> }) { registered[tool.name] = tool; } });
      const written = await registered.write_artifact!.execute("id", { id: "report", content: "hello" });
      expect(written).toEqual({ content: [{ type: "text", text: "artifact report written" }], details: {} });
      await expect(registered.write_artifact!.execute("id", { id: "../escape", content: "no" })).rejects.toThrow(/Unknown artifact ID/);
      expect(await readFile(artifact, "utf8")).toBe("hello");
      expect(Object.keys(registered).sort()).toEqual(["fetch_content", "web_search", "write_artifact"]);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  });
});
