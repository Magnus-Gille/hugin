import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  __test__,
  buildResearchLaunch,
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
    expect(launch.env).toEqual(expect.objectContaining({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/hugin-research-home" }));
    expect(launch.env).not.toHaveProperty("MUNIN_API_KEY");
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
