import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isSovereignGatewayHost } from "./orchestrator/provider-config.js";

export type OpencodePermissionProfile = "read-only" | "trusted-code";

export interface OpencodeGatewayConfig {
  gatewayBaseUrl: string;
  apiKey: string;
  providerId: string;
  defaultModel: string;
  opencodeCommand: string;
}

export interface OpencodeTaskConfig {
  prompt: string;
  workingDir: string;
  timeoutMs: number;
  maxOutputChars: number;
  gatewayBaseUrl: string;
  apiKey: string;
  providerId: string;
  model: string;
  permissionProfile: OpencodePermissionProfile;
  opencodeCommand?: string;
}

export interface OpencodeProviderConfig {
  $schema: string;
  provider: Record<
    string,
    {
      npm: "@ai-sdk/openai-compatible";
      name: string;
      options: {
        baseURL: string;
        apiKey: string;
      };
      models: Record<string, { name: string }>;
    }
  >;
  permission: {
    edit: "allow" | "deny";
    bash: "allow" | "deny";
  };
}

export interface OpencodeRunPlan {
  args: string[];
  agent: "plan" | "build";
  cliModel: string;
  modelId: string;
  config: OpencodeProviderConfig;
}

export interface OpencodeToolCall {
  type: "tool";
  tool: string;
  status?: string;
  command?: string;
  file?: string;
  exitCode?: number;
  additions?: number;
  deletions?: number;
  diff?: string;
}

export interface OpencodeTextEvent {
  type: "text";
  text: string;
}

export interface OpencodeStepFinishEvent {
  type: "step_finish";
  reason?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  };
}

export type OpencodeNormalizedEvent =
  | OpencodeToolCall
  | OpencodeTextEvent
  | OpencodeStepFinishEvent;

export interface OpencodeExecutorResult {
  exitCode: number | "TIMEOUT";
  output: string;
  logFile: string;
  resultText: string | null;
  model: string;
  agent: "plan" | "build";
  permissionProfile: OpencodePermissionProfile;
  toolCalls: OpencodeToolCall[];
  changedFiles: string[];
  testCommands: string[];
  events: OpencodeNormalizedEvent[];
  configDir: string;
  configDirRemoved: boolean;
}

export interface OpencodeExecutorOptions {
  abortController?: AbortController;
}

const DEFAULT_PROVIDER_ID = "m5";
const DEFAULT_MODEL = "qwen3-coder-next-80b";
const PROVIDER_API_KEY_ENV = "HUGIN_OPENCODE_PROVIDER_API_KEY";

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function normalizeOpenAiBaseUrl(raw: string): string {
  const stripped = raw.trim().replace(/\/+$/, "");
  if (!stripped) return stripped;
  const parsed = new URL(stripped);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenCode gateway URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("OpenCode gateway URL must not include credentials, query, or fragment");
  }
  if (!isSovereignGatewayHost(parsed.hostname)) {
    throw new Error("OpenCode gateway URL must be loopback/private-LAN/tailnet");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/v1") {
    return parsed.toString().replace(/\/+$/, "");
  }
  if (pathname !== "/") {
    throw new Error("OpenCode gateway URL must be a gateway root or /v1 base URL");
  }
  parsed.pathname = path.posix.join(parsed.pathname, "v1");
  return parsed.toString().replace(/\/+$/, "");
}

export function loadOpencodeGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpencodeGatewayConfig | null {
  const rawBase = (env.HUGIN_OPENCODE_BASE_URL || env.HOMESERVER_GATEWAY_URL || "").trim();
  if (!rawBase) return null;

  let gatewayBaseUrl: string;
  try {
    gatewayBaseUrl = normalizeOpenAiBaseUrl(rawBase);
  } catch {
    return null;
  }

  const apiKey = (
    env.HUGIN_OPENCODE_API_KEY ||
    env.HOMESERVER_GATEWAY_API_KEY ||
    env.M5_API_KEY ||
    ""
  ).trim();
  if (!apiKey && !isLoopbackUrl(gatewayBaseUrl)) return null;

  return {
    gatewayBaseUrl,
    apiKey,
    providerId: (env.HUGIN_OPENCODE_PROVIDER || DEFAULT_PROVIDER_ID).trim() || DEFAULT_PROVIDER_ID,
    defaultModel: (env.HUGIN_OPENCODE_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    opencodeCommand: (env.HUGIN_OPENCODE_CMD || "opencode").trim() || "opencode",
  };
}

function resolveModel(providerId: string, requestedModel: string): {
  modelId: string;
  cliModel: string;
} {
  const trimmed = requestedModel.trim();
  const prefix = `${providerId}/`;
  const modelId = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
  return { modelId, cliModel: `${providerId}/${modelId}` };
}

export function buildOpencodeRunPlan(task: OpencodeTaskConfig): OpencodeRunPlan {
  const permission =
    task.permissionProfile === "trusted-code"
      ? { edit: "allow" as const, bash: "allow" as const }
      : { edit: "deny" as const, bash: "deny" as const };
  const agent = task.permissionProfile === "trusted-code" ? "build" : "plan";
  const { modelId, cliModel } = resolveModel(task.providerId, task.model);
  const config: OpencodeProviderConfig = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [task.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: `${task.providerId} Gateway`,
        options: {
          baseURL: task.gatewayBaseUrl,
          apiKey: `{env:${PROVIDER_API_KEY_ENV}}`,
        },
        models: {
          [modelId]: { name: modelId },
        },
      },
    },
    permission,
  };

  return {
    agent,
    cliModel,
    modelId,
    config,
    args: [
      "run",
      "--dir",
      task.workingDir,
      "--model",
      cliModel,
      "--agent",
      agent,
      "--format",
      "json",
      task.prompt,
    ],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeOpenCodeEvent(raw: unknown): OpencodeNormalizedEvent | null {
  const event = asRecord(raw);
  const type = asString(event.type);
  const part = asRecord(event.part);

  if (type === "text") {
    const text = asString(part.text);
    return text ? { type: "text", text } : null;
  }

  if (type === "step_finish") {
    const tokensRaw = asRecord(part.tokens);
    const normalized: OpencodeStepFinishEvent = {
      type: "step_finish",
      reason: asString(part.reason),
      cost: asNumber(part.cost),
    };
    const tokens = {
      input: asNumber(tokensRaw.input),
      output: asNumber(tokensRaw.output),
      total: asNumber(tokensRaw.total),
    };
    if (
      tokens.input !== undefined ||
      tokens.output !== undefined ||
      tokens.total !== undefined
    ) {
      normalized.tokens = tokens;
    }
    return normalized;
  }

  if (type !== "tool_use") return null;

  const tool = asString(part.tool);
  if (!tool) return null;

  const state = asRecord(part.state);
  const input = asRecord(state.input);
  const metadata = asRecord(state.metadata);
  const filediff = asRecord(metadata.filediff);
  const normalized: OpencodeToolCall = {
    type: "tool",
    tool,
    status: asString(state.status),
    command: asString(input.command),
    file: asString(input.filePath) || asString(filediff.file),
    exitCode: asNumber(metadata.exit),
    additions: asNumber(filediff.additions),
    deletions: asNumber(filediff.deletions),
    diff: asString(metadata.diff),
  };

  return normalized;
}

function renderSummary(
  result: Pick<
    OpencodeExecutorResult,
    "model" | "agent" | "permissionProfile" | "toolCalls" | "changedFiles" | "testCommands"
  >,
  textEvents: string[],
): string {
  const lines = [
    "### OpenCode Summary",
    "",
    `- **Model:** ${result.model}`,
    `- **Agent:** ${result.agent}`,
    `- **Permission profile:** ${result.permissionProfile}`,
    `- **Tool calls:** ${result.toolCalls.length}`,
  ];

  if (result.changedFiles.length > 0) {
    lines.push(`- **Changed files:** ${result.changedFiles.join(", ")}`);
  }
  if (result.testCommands.length > 0) {
    lines.push(`- **Test commands:** ${result.testCommands.join(", ")}`);
  }
  if (textEvents.length > 0) {
    lines.push("", "### Final Message", "", textEvents[textEvents.length - 1] as string);
  }

  return lines.join("\n");
}

export async function executeOpencodeTask(
  task: OpencodeTaskConfig,
  taskId: string,
  logDir: string,
  options?: OpencodeExecutorOptions,
): Promise<OpencodeExecutorResult> {
  const plan = buildOpencodeRunPlan(task);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-opencode-"));
  const logFile = path.join(logDir, `${taskId}.log`);
  const startedAt = new Date().toISOString();

  fs.mkdirSync(task.workingDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "opencode.json"),
    JSON.stringify(plan.config, null, 2),
  );

  const logStream = fs.createWriteStream(logFile, { encoding: "utf-8" });
  logStream.on("error", () => {});
  logStream.write(
    [
      "=== Hugin Task Log (opencode) ===",
      `Task: ${taskId}`,
      `Runtime: opencode`,
      `Working dir: ${task.workingDir}`,
      `Model: ${plan.cliModel}`,
      `Agent: ${plan.agent}`,
      `Permission profile: ${task.permissionProfile}`,
      `Gateway: ${task.gatewayBaseUrl}`,
      `Timeout: ${task.timeoutMs}ms`,
      `Started: ${startedAt}`,
      "===\n",
    ].join("\n"),
  );

  const events: OpencodeNormalizedEvent[] = [];
  const textEvents: string[] = [];
  const toolCalls: OpencodeToolCall[] = [];
  let output = "";
  let jsonLineBuffer = "";
  let child: ChildProcess | null = null;
  let timedOut = false;
  let configDirRemoved = false;

  const appendOutput = (text: string) => {
    output += text;
    if (output.length > task.maxOutputChars * 2) {
      output = output.slice(-task.maxOutputChars);
    }
    logStream.write(text);
  };

  const consumeJsonLines = (text: string) => {
    jsonLineBuffer += text;
    let newlineIndex = jsonLineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = jsonLineBuffer.slice(0, newlineIndex).trim();
      jsonLineBuffer = jsonLineBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const normalized = normalizeOpenCodeEvent(JSON.parse(line));
          if (normalized) {
            events.push(normalized);
            if (normalized.type === "text") textEvents.push(normalized.text);
            if (normalized.type === "tool") toolCalls.push(normalized);
          }
        } catch {
          // Keep raw line in the log/output; malformed JSON is not fatal.
        }
      }
      newlineIndex = jsonLineBuffer.indexOf("\n");
    }
  };

  const finish = async (exitCode: number | "TIMEOUT"): Promise<OpencodeExecutorResult> => {
    if (jsonLineBuffer.trim()) {
      consumeJsonLines("\n");
    }
    const changedFiles = [
      ...new Set(
        toolCalls
          .filter((call) => call.tool === "edit" && call.file)
          .map((call) => call.file as string),
      ),
    ];
    const testCommands = [
      ...new Set(
        toolCalls
          .filter((call) => call.tool === "bash" && call.command && /(^|[;&|]\s*)npm\s+test\b/.test(call.command))
          .map((call) => call.command as string),
      ),
    ];

    const resultBase = {
      model: plan.cliModel,
      agent: plan.agent,
      permissionProfile: task.permissionProfile,
      toolCalls,
      changedFiles,
      testCommands,
    };
    const resultText = renderSummary(resultBase, textEvents);

    logStream.write(
      [
        "\n===",
        `Exit code: ${exitCode}`,
        `Tool calls: ${toolCalls.length}`,
        `Changed files: ${changedFiles.join(", ") || "none"}`,
        `Completed: ${new Date().toISOString()}`,
        "===\n",
      ].join("\n"),
    );
    await new Promise<void>((resolve) => logStream.end(() => resolve()));
    fs.rmSync(configDir, { recursive: true, force: true });
    configDirRemoved = !fs.existsSync(configDir);

    return {
      exitCode,
      output: output.slice(-task.maxOutputChars),
      logFile,
      resultText,
      configDir,
      configDirRemoved,
      events,
      ...resultBase,
    };
  };

  return new Promise((resolve) => {
    const abortController = new AbortController();
    let settled = false;
    const settle = async (exitCode: number | "TIMEOUT") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(await finish(exitCode));
    };
    if (options?.abortController) {
      if (options.abortController.signal.aborted) abortController.abort();
      else options.abortController.signal.addEventListener("abort", () => abortController.abort());
    }

    const timer = setTimeout(() => abortController.abort(), task.timeoutMs);
    abortController.signal.addEventListener("abort", () => {
      timedOut = true;
      child?.kill("SIGTERM");
      setTimeout(() => {
        if (child && !child.killed) child.kill("SIGKILL");
      }, 5_000).unref();
    });

    child = spawn(task.opencodeCommand || "opencode", plan.args, {
      cwd: task.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: configDir,
        [PROVIDER_API_KEY_ENV]: task.apiKey,
        HUGIN_TASK_ID: taskId,
      },
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      appendOutput(text);
      consumeJsonLines(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => appendOutput(chunk.toString("utf-8")));

    child.on("error", async (err) => {
      appendOutput(`\n[OpenCode spawn error: ${err.message}]\n`);
      await settle(1);
    });

    child.on("close", async (code) => {
      await settle(timedOut ? "TIMEOUT" : code ?? 1);
    });
  });
}
