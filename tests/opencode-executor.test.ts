import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildOpencodeRunPlan,
  executeOpencodeTask,
  loadOpencodeGatewayConfig,
  normalizeOpenCodeEvent,
  type OpencodeTaskConfig,
} from "../src/opencode-executor.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-opencode-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(overrides?: Partial<OpencodeTaskConfig>): OpencodeTaskConfig {
  return {
    prompt: "Fix the failing test.",
    workingDir: path.join(tmpDir, "repo"),
    timeoutMs: 30_000,
    maxOutputChars: 5_000,
    gatewayBaseUrl: "http://127.0.0.1:8080/v1",
    apiKey: "",
    providerId: "m5",
    model: "qwen3-coder-next-80b",
    permissionProfile: "trusted-code",
    ...overrides,
  };
}

describe("loadOpencodeGatewayConfig", () => {
  it("returns null when no OpenCode or homeserver gateway URL is configured", () => {
    expect(loadOpencodeGatewayConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("uses HOMESERVER_GATEWAY_URL and appends /v1 for OpenAI-compatible config", () => {
    const cfg = loadOpencodeGatewayConfig({
      HOMESERVER_GATEWAY_URL: "http://100.64.0.42:8080/",
      HOMESERVER_GATEWAY_API_KEY: "owner-key",
    } as NodeJS.ProcessEnv);

    expect(cfg).toEqual({
      gatewayBaseUrl: "http://100.64.0.42:8080/v1",
      apiKey: "owner-key",
      providerId: "m5",
      defaultModel: "qwen3-coder-next-80b",
      opencodeCommand: "opencode",
    });
  });

  it("honors HUGIN_OPENCODE_* overrides", () => {
    const cfg = loadOpencodeGatewayConfig({
      HUGIN_OPENCODE_BASE_URL: "http://127.0.0.1:9999/v1/",
      HUGIN_OPENCODE_API_KEY: "k",
      HUGIN_OPENCODE_PROVIDER: "local",
      HUGIN_OPENCODE_MODEL: "mellum",
      HUGIN_OPENCODE_CMD: "/opt/bin/opencode",
    } as NodeJS.ProcessEnv);

    expect(cfg).toEqual({
      gatewayBaseUrl: "http://127.0.0.1:9999/v1",
      apiKey: "k",
      providerId: "local",
      defaultModel: "mellum",
      opencodeCommand: "/opt/bin/opencode",
    });
  });

  it("refuses a keyless non-loopback gateway", () => {
    expect(
      loadOpencodeGatewayConfig({
        HUGIN_OPENCODE_BASE_URL: "http://100.64.0.42:8080/v1",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("accepts a keyless loopback gateway for local-only development", () => {
    expect(
      loadOpencodeGatewayConfig({
        HUGIN_OPENCODE_BASE_URL: "http://127.0.0.1:8080",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      gatewayBaseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "",
    });
  });

  it("refuses public or path-scoped gateway URLs even with an API key", () => {
    expect(
      loadOpencodeGatewayConfig({
        HUGIN_OPENCODE_BASE_URL: "https://example.com",
        HUGIN_OPENCODE_API_KEY: "owner-key",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      loadOpencodeGatewayConfig({
        HUGIN_OPENCODE_BASE_URL: "http://100.64.0.42:8080/api",
        HUGIN_OPENCODE_API_KEY: "owner-key",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("buildOpencodeRunPlan", () => {
  it("denies edit and bash in read-only mode", () => {
    const plan = buildOpencodeRunPlan(makeTask({ permissionProfile: "read-only" }));

    expect(plan.agent).toBe("plan");
    expect(plan.config.permission).toEqual({ edit: "deny", bash: "deny" });
    expect(plan.args).toContain("--format");
    expect(plan.args).toContain("json");
  });

  it("allows edit and bash in trusted-code mode", () => {
    const plan = buildOpencodeRunPlan(makeTask({ permissionProfile: "trusted-code" }));

    expect(plan.agent).toBe("build");
    expect(plan.config.permission).toEqual({ edit: "allow", bash: "allow" });
    expect(plan.cliModel).toBe("m5/qwen3-coder-next-80b");
    expect(plan.config.provider.m5.models["qwen3-coder-next-80b"]).toEqual({
      name: "qwen3-coder-next-80b",
    });
  });
});

describe("normalizeOpenCodeEvent", () => {
  it("extracts bash, edit, and text events from OpenCode JSONL", () => {
    const bash = normalizeOpenCodeEvent({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "npm test 2>&1" },
          metadata: { exit: 0 },
        },
      },
    });
    const edit = normalizeOpenCodeEvent({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          metadata: {
            filediff: {
              file: "/tmp/repo/math.js",
              additions: 1,
              deletions: 1,
            },
            diff: "@@ diff",
          },
        },
      },
    });
    const text = normalizeOpenCodeEvent({
      type: "text",
      part: { text: "Fixed math.js and tests pass." },
    });

    expect(bash).toMatchObject({
      type: "tool",
      tool: "bash",
      status: "completed",
      command: "npm test 2>&1",
      exitCode: 0,
    });
    expect(edit).toMatchObject({
      type: "tool",
      tool: "edit",
      file: "/tmp/repo/math.js",
      additions: 1,
      deletions: 1,
    });
    expect(text).toEqual({ type: "text", text: "Fixed math.js and tests pass." });
  });
});

describe("executeOpencodeTask", () => {
  it("runs opencode with a temp config, captures normalized events, and removes the config dir", async () => {
    const repoDir = path.join(tmpDir, "repo");
    const logDir = path.join(tmpDir, "logs");
    fs.mkdirSync(repoDir, { recursive: true });

    const fakeOpencode = path.join(tmpDir, "opencode-fake.mjs");
    fs.writeFileSync(
      fakeOpencode,
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const configDir = process.env.OPENCODE_CONFIG_DIR;
fs.writeFileSync(path.join(process.cwd(), "observed.json"), JSON.stringify({
  argv: process.argv.slice(2),
  configDir,
  config: JSON.parse(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")),
  apiKey: process.env.HUGIN_OPENCODE_PROVIDER_API_KEY
}));
console.log(JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test 2>&1" }, metadata: { exit: 0 } } } }));
console.log(JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "edit", state: { status: "completed", metadata: { filediff: { file: path.join(process.cwd(), "math.js"), additions: 1, deletions: 1 }, diff: "@@ diff" } } } }));
console.log(JSON.stringify({ type: "text", part: { text: "Fixed math.js and tests pass." } }));
`,
      { mode: 0o755 },
    );

    const result = await executeOpencodeTask(
      makeTask({
        workingDir: repoDir,
        apiKey: "owner-key",
        opencodeCommand: fakeOpencode,
      }),
      "opencode-ok",
      logDir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.resultText).toContain("Fixed math.js");
    expect(result.toolCalls.map((t) => t.tool)).toEqual(["bash", "edit"]);
    expect(result.changedFiles).toEqual([path.join(fs.realpathSync(repoDir), "math.js")]);
    expect(result.testCommands).toEqual(["npm test 2>&1"]);
    expect(result.configDirRemoved).toBe(true);
    expect(fs.existsSync(result.configDir)).toBe(false);

    const observed = JSON.parse(
      fs.readFileSync(path.join(repoDir, "observed.json"), "utf8"),
    );
    expect(observed.argv).toEqual([
      "run",
      "--dir",
      repoDir,
      "--model",
      "m5/qwen3-coder-next-80b",
      "--agent",
      "build",
      "--format",
      "json",
      "Fix the failing test.",
    ]);
    expect(observed.config.permission).toEqual({ edit: "allow", bash: "allow" });
    expect(observed.apiKey).toBe("owner-key");
  });
});
