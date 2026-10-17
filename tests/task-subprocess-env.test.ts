import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTaskSubprocessEnv,
  SENSITIVITY_CHECKPOINT_SECRET_ENV,
  TASK_SUBPROCESS_ENV_KEYS,
} from "../src/task-subprocess-env.js";

describe("task subprocess environment", () => {
  it.each([
    SENSITIVITY_CHECKPOINT_SECRET_ENV,
    "MUNIN_API_KEY",
    "HOMESERVER_GATEWAY_API_KEY",
    "OPENROUTER_API_KEY",
    "HUGIN_SIGNING_SECRET",
    "HUGIN_BROKER_KEYS",
    "HUGIN_ALLOWED_EGRESS_HOSTS",
    "HUGIN_DELIVERY_TARGETS",
    "HUGIN_INJECTION_POLICY",
    "HUGIN_FRICTION_INJECTION",
    "HUGIN_CODE_HEALTH_CAPTURE",
    "HUGIN_ARXIV_MCP",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "GIT_SSH_COMMAND",
    "SSH_AUTH_SOCK",
    "XDG_CONFIG_HOME",
    "UNKNOWN_TASK_ENV",
  ])("denies ambient or authority variable %s", (key) => {
    const result = buildTaskSubprocessEnv({
      PATH: "/usr/bin",
      [key]: "must-not-cross-boundary",
    } as NodeJS.ProcessEnv);

    expect(result).toEqual({ PATH: "/usr/bin" });
  });

  it("preserves only defined string values from the compatibility allowlist", () => {
    const source = Object.fromEntries(
      TASK_SUBPROCESS_ENV_KEYS.map((key) => [key, `${key}-value`]),
    ) as NodeJS.ProcessEnv;

    expect(buildTaskSubprocessEnv(source)).toEqual(source);
  });

  it("omits undefined and non-string compatibility values", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: undefined,
      USER: 42,
    } as unknown as NodeJS.ProcessEnv;

    expect(buildTaskSubprocessEnv(source)).toEqual({ PATH: "/usr/bin" });
  });

  it("does not mutate the source environment", () => {
    const source = {
      PATH: "/usr/bin",
      [SENSITIVITY_CHECKPOINT_SECRET_ENV]: "hugin-only-secret",
      UNKNOWN_TASK_ENV: "unknown",
    } as NodeJS.ProcessEnv;
    const before = { ...source };

    expect(buildTaskSubprocessEnv(source)).toEqual({ PATH: "/usr/bin" });
    expect(source).toEqual(before);
  });

  it("preserves explicit per-call overrides and purpose-bound env controls", () => {
    const source = {
      PATH: "/usr/bin",
      MUNIN_API_KEY: "dispatcher-key",
      HUGIN_OPENCODE_PROVIDER_API_KEY: "provider-key",
    } as NodeJS.ProcessEnv;
    const env = {
      ...buildTaskSubprocessEnv(source),
      HOME: "/task-home",
      HUGIN_TASK_ID: "task-1",
      HUGIN_OPENCODE_PROVIDER_API_KEY: "provider-key",
    };

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/task-home",
      HUGIN_TASK_ID: "task-1",
      HUGIN_OPENCODE_PROVIDER_API_KEY: "provider-key",
    });
    expect(env).not.toHaveProperty("MUNIN_API_KEY");
  });

  it("keeps purpose-bound provider and friction envs at their call sites", () => {
    const opencodeSource = readFileSync(
      path.join(__dirname, "..", "src", "opencode-executor.ts"),
      "utf8",
    );
    expect(opencodeSource).toContain("OPENCODE_CONFIG_DIR: configDir");
    expect(opencodeSource).toContain("[PROVIDER_API_KEY_ENV]: task.apiKey");
    expect(opencodeSource).toContain("HUGIN_TASK_ID: taskId");

    const sdkSource = readFileSync(
      path.join(__dirname, "..", "src", "sdk-executor.ts"),
      "utf8",
    );
    expect(sdkSource).toContain("MUNIN_API_KEY: task.muninApiKey");
    expect(sdkSource).toContain("...forwardedFrictionEnv()");
    expect(sdkSource).toContain("HUGIN_TASK_ID: taskId");
  });

  it("the Codex task spawn uses the scrubbed environment helper", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf8",
    );
    const start = source.indexOf("function spawnRuntime(");
    const end = source.indexOf("async function", start);
    const spawnRuntime = source.slice(start, end);
    expect(spawnRuntime).toContain("...buildTaskSubprocessEnv()");
    expect(spawnRuntime).not.toContain("...process.env");
  });

  it("scrubs the secret from the Pi harness and operational subprocesses", () => {
    const sources = [
      "src/artifact-delivery.ts",
      "src/orchestrator/worker-executor.ts",
      "src/task-helpers.ts",
    ].map((relativePath) =>
      readFileSync(path.join(__dirname, "..", relativePath), "utf8"),
    );

    for (const source of sources) {
      expect(source).toContain("buildTaskSubprocessEnv()");
    }

    const indexSource = readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf8",
    );
    const pgrepStart = indexSource.indexOf('spawn("pgrep"');
    const pgrepEnd = indexSource.indexOf("});", pgrepStart);
    expect(indexSource.slice(pgrepStart, pgrepEnd)).toContain(
      "env: buildTaskSubprocessEnv()",
    );
  });
});
