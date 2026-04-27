#!/usr/bin/env node
/**
 * hugin-mcp — stdio MCP server that exposes the Pi-side broker's
 * `/v1/delegate/*` endpoints to a local Claude Code or Claude Desktop
 * session.
 *
 * Wiring:
 *   stdio  ↔  McpServer  ↔  buildTools()  ↔  BrokerClient  ↔  HTTP /v1/delegate
 *
 * The MCP layer fills in protocol envelope fields (envelope_version,
 * alias_map_version, idempotency_key, orchestrator_session_id,
 * orchestrator_submitter) so the model only has to think about the
 * task. See `src/mcp/tools.ts`.
 *
 * Required env:
 *   HUGIN_BROKER_URL    — e.g. http://huginmunin.tail-scale.ts.net:3033
 *   HUGIN_BROKER_TOKEN  — bearer token registered in HUGIN_BROKER_KEYS
 *
 * Optional env:
 *   HUGIN_MCP_SUBMITTER         — orchestrator_submitter principal (default: "claude-code")
 *   HUGIN_MCP_REQUEST_TIMEOUT_MS — per-request HTTP timeout (default: 60_000)
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrokerClient } from "./mcp/broker-client.js";
import { ALIAS_MAP_VERSION, buildTools, type HuginTool } from "./mcp/tools.js";

const SERVER_NAME = "hugin-mcp";
const SERVER_VERSION = "0.1.0";

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    process.stderr.write(`hugin-mcp: missing required env ${name}\n`);
    process.exit(1);
  }
  return value;
}

/**
 * Discover the broker's current `alias_map_version` so submit envelopes
 * carry the live value instead of a hard-coded constant. The broker
 * uses this to detect orchestrator skew when it bumps the alias map.
 *
 * If `/v1/delegate/models` is unreachable or returns an unexpected
 * shape, fall back to the compiled-in {@link ALIAS_MAP_VERSION}: this
 * keeps startup non-blocking on transient network errors, at the cost
 * of submitting a possibly-stale version (which the broker will
 * surface as a normal version-skew error on the first submit).
 */
async function discoverAliasMapVersion(broker: BrokerClient): Promise<number> {
  try {
    const response = await broker.models();
    if (
      response &&
      typeof response === "object" &&
      "alias_map_version" in response
    ) {
      const candidate = (response as { alias_map_version: unknown }).alias_map_version;
      if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) {
        return candidate;
      }
    }
    process.stderr.write(
      `hugin-mcp: /v1/delegate/models did not advertise alias_map_version; using ${ALIAS_MAP_VERSION}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `hugin-mcp: failed to fetch alias_map_version (${err instanceof Error ? err.message : String(err)}); using ${ALIAS_MAP_VERSION}\n`,
    );
  }
  return ALIAS_MAP_VERSION;
}

function readOptionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    process.stderr.write(`hugin-mcp: invalid ${name}=${raw}, using ${fallback}\n`);
    return fallback;
  }
  return parsed;
}

export async function main(): Promise<void> {
  const baseUrl = readRequiredEnv("HUGIN_BROKER_URL");
  const bearerToken = readRequiredEnv("HUGIN_BROKER_TOKEN");
  const submitter = process.env.HUGIN_MCP_SUBMITTER ?? "claude-code";
  const requestTimeoutMs = readOptionalNumber("HUGIN_MCP_REQUEST_TIMEOUT_MS", 60_000);

  const broker = new BrokerClient({ baseUrl, bearerToken, requestTimeoutMs });
  const aliasMapVersion = await discoverAliasMapVersion(broker);
  const tools = buildTools({
    broker,
    sessionId: randomUUID(),
    submitter,
    aliasMapVersion,
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const allTools: HuginTool<Record<string, unknown>>[] = [
    tools.submit as HuginTool<Record<string, unknown>>,
    tools.await_ as HuginTool<Record<string, unknown>>,
    tools.rate as HuginTool<Record<string, unknown>>,
    tools.list as HuginTool<Record<string, unknown>>,
    tools.models as HuginTool<Record<string, unknown>>,
  ];
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
      },
      async (input: Record<string, unknown>) => tool.handler(input),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `hugin-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
