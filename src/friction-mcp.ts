#!/usr/bin/env node
/**
 * friction-mcp — stdio MCP server exposing the `report_friction` tool.
 *
 * Wiring:
 *   stdio  ↔  McpServer  ↔  buildFrictionTool()  ↔  MuninClient.write()
 *
 * Required env:
 *   MUNIN_URL                       — e.g. http://localhost:3030
 *   MUNIN_API_KEY                   — Munin bearer token
 *
 * Optional env:
 *   HUGIN_FRICTION_TASK_ID          — auto-tag events with task id (injected by SDK executor)
 *   HUGIN_FRICTION_MODEL_ID         — fallback model identifier for the `model:<id>` tag (default
 *                                     "unknown"). The SDK executor injects this; interactive sessions
 *                                     instead pass `model_id` as a tool input, which takes precedence.
 *   HUGIN_FRICTION_WRITE_TIMEOUT_MS — Munin write timeout, default 2000
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MuninClient } from "./munin-client.js";
import { buildFrictionTool } from "./friction/tool.js";

const SERVER_NAME = "friction-mcp";
const SERVER_VERSION = "0.1.0";

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    process.stderr.write(`friction-mcp: missing required env ${name}\n`);
    process.exit(1);
  }
  return value;
}

function readOptionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    process.stderr.write(`friction-mcp: invalid ${name}=${raw}, using ${fallback}\n`);
    return fallback;
  }
  return parsed;
}

export async function main(): Promise<void> {
  const muninUrl = readRequiredEnv("MUNIN_URL");
  const muninApiKey = readRequiredEnv("MUNIN_API_KEY");
  const modelId = process.env.HUGIN_FRICTION_MODEL_ID ?? "unknown";
  const taskId = process.env.HUGIN_FRICTION_TASK_ID;
  const writeTimeoutMs = readOptionalNumber("HUGIN_FRICTION_WRITE_TIMEOUT_MS", 2_000);

  const munin = new MuninClient({ baseUrl: muninUrl, apiKey: muninApiKey });
  const tool = buildFrictionTool({
    munin,
    modelId,
    taskId,
    writeTimeoutMs,
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputShape,
    },
    async (input: Record<string, unknown>) => tool.handler(input),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `friction-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
