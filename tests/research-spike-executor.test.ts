import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import {
  __test__,
  buildResearchLaunch,
  executeResearchSpike,
  loadResearchRuntimeConfig,
  RESEARCH_TOOL_BUDGET,
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
      stdin: { end: ReturnType<typeof vi.fn> };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = { end: vi.fn() };
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

  it("discloses the enforced web-tool budgets in the research prompt", () => {
    const prompt = __test__.buildPiPrompt({
      prompt: "Investigate the topic.",
      workingDir: "/home/magnus/scratch",
      timeoutMs: 1_000,
      maxOutputChars: 1_000,
      artifactManifest: { artifacts: [
        { id: "report", local: "/home/magnus/scratch/report.md", remote: "magnus@nas:/r/report", required: true },
      ] },
    });
    expect(prompt).toMatch(/at most 6 web_search calls and 12 fetch_content calls/);
    expect(prompt).toMatch(/Consecutive duplicate calls are blocked/);
    expect(prompt).toMatch(/3 consecutive helper failures/);
  });

  it("keeps the prompt budget constants in parity with the Pi extension", async () => {
    const extension = await import("../scripts/research-pi-extension.mjs");
    expect(extension.RESEARCH_TOOL_BUDGET).toEqual({
      webSearch: RESEARCH_TOOL_BUDGET.webSearch,
      fetchContent: RESEARCH_TOOL_BUDGET.fetchContent,
      maxConsecutiveHelperFailures: RESEARCH_TOOL_BUDGET.maxConsecutiveHelperFailures,
    });
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

  it("puts grounding rejection code and reason first in visible result text", () => {
    const result = __test__.composeResearchResult("Research grounding rejected: insufficient-fetches", "partial model answer", 1000);
    expect(result).toMatch(/^Research grounding rejected: insufficient-fetches/);
    expect(result).toContain("partial model answer");
  });

  it("accepts only Hugin-recorded searches, three unique public fetches, and linked fetched sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-grounding-"));
    const evidence = path.join(root, "grounding.jsonl");
    const detailed = path.join(root, "detailed.md");
    const popular = path.join(root, "popular.md");
    const urls = ["https://example.com/one", "https://example.com/two", "https://example.com/three"];
    try {
      await writeFile(evidence, [
        JSON.stringify({ kind: "search" }),
        ...urls.map((url, index) => JSON.stringify({ kind: "fetch", url, sha256: String(index + 1).repeat(64) })),
      ].join("\n"));
      const links = urls.map((url) => `[source](${url})`).join(" ");
      await writeFile(detailed, links);
      await writeFile(popular, links);
      const result = await __test__.readGroundingEvidence(evidence, { artifacts: [
        { id: "detailed", local: detailed, remote: "magnus@nas:/detailed", required: true },
        { id: "popular", local: popular, remote: "magnus@nas:/popular", required: true },
      ] });
      expect(result.accepted).toBe(true);
      expect(result.successfulSearches).toBe(1);
      expect(result.uniqueSuccessfulFetches).toHaveLength(3);
      expect(JSON.stringify(result)).not.toContain("body");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ["missing search", [{ kind: "fetch", url: "https://example.com/one", sha256: "1".repeat(64) }], "insufficient-searches"],
    ["duplicate fetches", [
      { kind: "search" },
      ...["one", "one", "two"].map((part) => ({ kind: "fetch", url: `https://example.com/${part}`, sha256: "1".repeat(64) })),
    ], "insufficient-fetches"],
  ])("rejects %s before delivery/indexing", async (_label, records, failureCode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-grounding-reject-"));
    const evidence = path.join(root, "grounding.jsonl");
    const artifacts = ["detailed", "popular"].map((id) => ({ id, local: path.join(root, `${id}.md`), remote: `magnus@nas:/${id}`, required: true }));
    try {
      await writeFile(evidence, (records as Array<Record<string, string>>).map((record) => JSON.stringify(record)).join("\n"));
      for (const artifact of artifacts) await writeFile(artifact.local, "[source](https://example.com/one) [source](https://example.com/two) [source](https://example.com/three)");
      const result = await __test__.readGroundingEvidence(evidence, { artifacts });
      expect(result.accepted).toBe(false);
      if (failureCode === "insufficient-fetches") {
        expect(["insufficient-fetches", "artifact-unfetched-url", "artifact-not-enough-links"]).toContain(result.failureCode);
      } else {
        expect(result.failureCode).toBe(failureCode);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects invented, private, and duplicate artifact links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-grounding-links-"));
    const evidence = path.join(root, "grounding.jsonl");
    const artifact = path.join(root, "report.md");
    const fetched = ["https://example.com/one", "https://example.com/two", "https://example.com/three"];
    try {
      await writeFile(evidence, [JSON.stringify({ kind: "search" }), ...fetched.map((url) => JSON.stringify({ kind: "fetch", url, sha256: "a".repeat(64) }))].join("\n"));
      await writeFile(artifact, `[one](${fetched[0]}) [duplicate](${fetched[0]}) [private](http://127.0.0.1/x)`);
      const result = await __test__.readGroundingEvidence(evidence, { artifacts: [{ id: "report", local: artifact, remote: "magnus@nas:/report", required: true }] });
      expect(result.accepted).toBe(false);
      expect(["artifact-duplicate-url", "artifact-unsafe-url"]).toContain(result.failureCode);
    } finally { await rm(root, { recursive: true, force: true }); }
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
      await expect(registered.fetch_content!.execute("id", { url: "http://[::ffff:127.0.0.1]/" })).rejects.toThrow(/forbidden/);
      expect(await readFile(artifact, "utf8")).toBe("hello");
      expect(Object.keys(registered).sort()).toEqual(["fetch_content", "web_search", "write_artifact"]);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records successful extension calls in the Hugin sidecar, outside model text", async () => {
    const registered: Record<string, { execute: (id: string, params: Record<string, string>) => Promise<unknown> }> = {};
    const module = await import("../scripts/research-pi-extension.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-evidence-test-"));
    const helper = path.join(root, "helper.mjs");
    const evidence = path.join(root, "grounding.jsonl");
    await writeFile(helper, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify(process.argv[1] === 'fetch' ? {url:'https://example.com/a', content:'body'} : {results:[{url:'https://example.com/a'}]})));\n");
    await chmod(helper, 0o700);
    const previous = { ...process.env };
    process.env.HUGIN_RESEARCH_EVIDENCE_FILE = evidence;
    try {
      // The production setting is an absolute command; use a tiny shell-free
      // node wrapper per helper so this test exercises the real child boundary.
      const searchHelper = path.join(root, "search.mjs");
      const fetchHelper = path.join(root, "fetch.mjs");
      await writeFile(searchHelper, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({results:[{url:'https://93.184.216.34/a'}]})));\n");
      await writeFile(fetchHelper, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({url:'https://93.184.216.34/a', content:'body'})));\n");
      await chmod(searchHelper, 0o700); await chmod(fetchHelper, 0o700);
      process.env.HUGIN_RESEARCH_SEARCH_HELPER = searchHelper;
      process.env.HUGIN_RESEARCH_FETCH_HELPER = fetchHelper;
      module.default({ registerTool(tool: { name: string; execute: (id: string, params: Record<string, string>) => Promise<unknown> }) { registered[tool.name] = tool; } });
      mockPi(JSON.stringify({ results: [{ url: "https://93.184.216.34/a" }] }));
      await registered.web_search!.execute("id", { query: "test" });
      mockPi(JSON.stringify({ url: "https://93.184.216.34/a", content: "body" }));
      await registered.fetch_content!.execute("id", { url: "https://93.184.216.34/a" });
      const records = (await readFile(evidence, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toEqual([
        { kind: "search" },
        { kind: "fetch", url: "https://93.184.216.34/a", sha256: expect.any(String) },
      ]);
      expect(JSON.stringify(records)).not.toContain("body");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not record empty search or fetch helper results as successful evidence", async () => {
    const registered: Record<string, { execute: (id: string, params: Record<string, string>) => Promise<unknown> }> = {};
    const module = await import("../scripts/research-pi-extension.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-empty-evidence-test-"));
    const searchHelper = path.join(root, "search.mjs");
    const fetchHelper = path.join(root, "fetch.mjs");
    const evidence = path.join(root, "grounding.jsonl");
    await writeFile(searchHelper, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({results:[]})));\n");
    await writeFile(fetchHelper, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({url:'https://93.184.216.34/a', content:''})));\n");
    await chmod(searchHelper, 0o700); await chmod(fetchHelper, 0o700);
    const previous = { ...process.env };
    Object.assign(process.env, {
      HUGIN_RESEARCH_EVIDENCE_FILE: evidence,
      HUGIN_RESEARCH_SEARCH_HELPER: searchHelper,
      HUGIN_RESEARCH_FETCH_HELPER: fetchHelper,
    });
    try {
      module.default({ registerTool(tool: { name: string; execute: (id: string, params: Record<string, string>) => Promise<unknown> }) { registered[tool.name] = tool; } });
      mockPi(JSON.stringify({ results: [] }));
      await expect(registered.web_search!.execute("id", { query: "empty" })).rejects.toThrow(/no results/);
      mockPi(JSON.stringify({ url: "https://93.184.216.34/a", content: "" }));
      await expect(registered.fetch_content!.execute("id", { url: "https://93.184.216.34/a" })).rejects.toThrow(/empty content/);
      await expect(readFile(evidence, "utf8")).rejects.toThrow();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces per-run search quotas and consecutive duplicate blocking", async () => {
    const registered: Record<string, { execute: (id: string, params: Record<string, string>) => Promise<unknown> }> = {};
    const module = await import("../scripts/research-pi-extension.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-budget-test-"));
    const searchHelper = path.join(root, "search.mjs");
    const previous = { ...process.env };
    await writeFile(searchHelper, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({results:[{url:'https://example.com/a'}]})));\n");
    await chmod(searchHelper, 0o700);
    Object.assign(process.env, { HUGIN_RESEARCH_SEARCH_HELPER: searchHelper });
    try {
      module.default({ registerTool(tool: { name: string; execute: (id: string, params: Record<string, string>) => Promise<unknown> }) { registered[tool.name] = tool; } });
      for (let i = 0; i < 6; i += 1) {
        mockPi(JSON.stringify({ results: [{ url: "https://example.com/a" }] }));
        await registered.web_search!.execute("id", { query: `quota-${i}` });
      }
      await expect(registered.web_search!.execute("id", { query: "quota-7" })).resolves.toMatchObject({ terminate: true, content: [{ text: expect.stringMatching(/quota exhausted/) }] });
      const duplicateRegistered = registered;
      module.default({ registerTool(tool: { name: string; execute: (id: string, params: Record<string, string>) => Promise<unknown> }) { duplicateRegistered[tool.name] = tool; } });
      mockPi(JSON.stringify({ results: [{ url: "https://example.com/a" }] }));
      await duplicateRegistered.web_search!.execute("id", { query: "duplicate" });
      await expect(duplicateRegistered.web_search!.execute("id", { query: "duplicate" })).resolves.toMatchObject({ terminate: true, content: [{ text: expect.stringMatching(/consecutive duplicate/) }] });
      // The terminating result prevents any cooperative model follow-up.
      await expect(duplicateRegistered.web_search!.execute("id", { query: "another" })).resolves.toMatchObject({ terminate: true });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens one bounded diagnostic after repeated helper failures and caps quota", async () => {
    const registered: Record<string, { execute: (id: string, params: Record<string, string>) => Promise<unknown> }> = {};
    const module = await import("../scripts/research-pi-extension.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-failure-budget-test-"));
    const searchHelper = path.join(root, "search.mjs");
    const previous = { ...process.env };
    await writeFile(searchHelper, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('HTTP 403 forbidden\\n'); process.exit(1); });\n");
    await chmod(searchHelper, 0o700);
    Object.assign(process.env, { HUGIN_RESEARCH_SEARCH_HELPER: searchHelper });
    try {
      module.default({ registerTool(tool: { name: string; execute: (id: string, params: Record<string, string>) => Promise<unknown> }) { registered[tool.name] = tool; } });
      mockPi("", "HTTP 403 forbidden", 1);
      await expect(registered.web_search!.execute("id", { query: "failure-1" })).rejects.toThrow(/helper failed.*403/);
      mockPi("", "HTTP 403 forbidden", 1);
      await expect(registered.web_search!.execute("id", { query: "failure-2" })).rejects.toThrow(/helper failed.*403/);
      mockPi("", "HTTP 403 forbidden", 1);
      await expect(registered.web_search!.execute("id", { query: "failure-3" })).resolves.toMatchObject({ terminate: true, content: [{ text: expect.stringMatching(/stopped after 3 consecutive helper failures.*403/) }] });
      await expect(registered.web_search!.execute("id", { query: "failure-4" })).resolves.toMatchObject({ terminate: true });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates repeated invalid fetch attempts without spawning a helper", async () => {
    const registered: Record<string, { execute: (id: string, params: Record<string, string>) => Promise<any> }> = {};
    const module = await import("../scripts/research-pi-extension.mjs");
    const previous = { ...process.env };
    try {
      module.default({ registerTool(tool: { name: string; execute: (id: string, params: Record<string, string>) => Promise<any> }) { registered[tool.name] = tool; } });
      await expect(registered.fetch_content!.execute("id", { url: "http://127.0.0.1/" })).rejects.toThrow(/helper failed.*forbidden/);
      await expect(registered.fetch_content!.execute("id", { url: "http://10.0.0.1/" })).rejects.toThrow(/helper failed.*forbidden/);
      const terminal = await registered.fetch_content!.execute("id", { url: "http://192.168.1.1/" });
      expect(terminal).toMatchObject({ terminate: true, content: [{ text: expect.stringMatching(/stopped after 3 consecutive helper failures/) }] });
      // A fourth invocation returns the same terminal result and cannot enter
      // DNS resolution or spawn a helper process.
      await expect(registered.fetch_content!.execute("id", { url: "http://example.com/" })).resolves.toMatchObject({ terminate: true });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  it("preserves the helper-circuit diagnostic in the Hugin grounding evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-circuit-evidence-"));
    const evidence = path.join(root, "grounding.jsonl");
    try {
      await writeFile(evidence, JSON.stringify({ kind: "failure", code: "helper-circuit", diagnostic: "Research web access stopped after 3 consecutive helper failures: HTTP 403 forbidden" }));
      const result = await __test__.readGroundingEvidence(evidence, { artifacts: [] });
      expect(result.failureCode).toBe("helper-circuit");
      expect(result.failureDiagnostic).toMatch(/HTTP 403 forbidden/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps search and fetch quotas independent", async () => {
    const registered: Record<string, { execute: (id: string, params: Record<string, string>) => Promise<unknown> }> = {};
    const module = await import("../scripts/research-pi-extension.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "hugin-research-fetch-budget-test-"));
    const searchHelper = path.join(root, "search.mjs");
    const fetchHelper = path.join(root, "fetch.mjs");
    const previous = { ...process.env };
    await writeFile(searchHelper, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({results:[{url:'https://example.com/a'}]})));\n");
    await writeFile(fetchHelper, "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({url:'https://93.184.216.34/a', content:'body'})));\n");
    await chmod(searchHelper, 0o700); await chmod(fetchHelper, 0o700);
    Object.assign(process.env, { HUGIN_RESEARCH_SEARCH_HELPER: searchHelper, HUGIN_RESEARCH_FETCH_HELPER: fetchHelper });
    try {
      module.default({ registerTool(tool: { name: string; execute: (id: string, params: Record<string, string>) => Promise<unknown> }) { registered[tool.name] = tool; } });
      // Exhaust only the search budget; fetch remains independently available.
      for (let i = 0; i < 6; i += 1) {
        mockPi(JSON.stringify({ results: [{ url: "https://example.com/a" }] }));
        await registered.web_search!.execute("id", { query: `search-${i}` });
      }
      await expect(registered.web_search!.execute("id", { query: "search-over" })).resolves.toMatchObject({ terminate: true, content: [{ text: expect.stringMatching(/web_search quota exhausted/) }] });
      mockPi(JSON.stringify({ url: "https://93.184.216.34/a", content: "body" }));
      await registered.fetch_content!.execute("id", { url: "https://93.184.216.34/a" });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await rm(root, { recursive: true, force: true });
    }
  });
});
