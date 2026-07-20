#!/usr/bin/env node
/**
 * hugin-mcp — stdio MCP server that exposes the Pi-side broker's
 * delegation and versioned-learning endpoints to a local Claude Code or
 * Claude Desktop session.
 *
 * Wiring:
 *   stdio  ↔  McpServer  ↔  buildTools()  ↔  BrokerClient  ↔  HTTP /v1/delegate
 *
 * The MCP layer fills in the protocol identity plus safe sensitivity, timeout,
 * token, destination, tool, attempt/cost, durability, delivery and escalation
 * defaults so the model only has to think about the task and its acceptance
 * contract. See `src/mcp/tools.ts`.
 *
 * Required env:
 *   HUGIN_BROKER_URL    — e.g. http://hugin.internal.example:3033
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
import { aliasSchema, type Alias } from "./broker/types.js";

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
 * If `/v1/delegate/models` is unreachable or malformed, retain the compiled
 * alias-map version for diagnostics but return an empty executable alias set.
 * That keeps MCP startup non-blocking while disabling submission until the
 * client reconnects and successfully discovers the Broker contract.
 */
interface BrokerContractDiscovery {
  aliasMapVersion: number;
  executableAliases: Alias[];
}

async function discoverBrokerContract(
  broker: BrokerClient,
): Promise<BrokerContractDiscovery> {
  try {
    const response = await broker.models();
    if (
      response &&
      typeof response === "object" &&
      "alias_map_version" in response
    ) {
      const candidate = (response as { alias_map_version: unknown })
        .alias_map_version;
      if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) {
        const rawAliases = "aliases" in response
          ? (response as { aliases: unknown }).aliases
          : undefined;
        const executableAliases = Array.isArray(rawAliases)
          ? rawAliases.flatMap((entry) => {
              if (!entry || typeof entry !== "object" || !("alias" in entry)) {
                return [];
              }
              const parsed = aliasSchema.safeParse(
                (entry as { alias: unknown }).alias,
              );
              return parsed.success ? [parsed.data] : [];
            })
          : [];
        return { aliasMapVersion: candidate, executableAliases };
      }
    }
    process.stderr.write(
      `hugin-mcp: /v1/delegate/models did not advertise a valid contract; submission disabled (compiled alias map ${ALIAS_MAP_VERSION})\n`,
    );
  } catch (err) {
    process.stderr.write(
      `hugin-mcp: failed to discover Broker contract (${err instanceof Error ? err.message : String(err)}); submission disabled (compiled alias map ${ALIAS_MAP_VERSION})\n`,
    );
  }
  return { aliasMapVersion: ALIAS_MAP_VERSION, executableAliases: [] };
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
  const brokerContract = await discoverBrokerContract(broker);
  const tools = buildTools({
    broker,
    sessionId: randomUUID(),
    submitter,
    aliasMapVersion: brokerContract.aliasMapVersion,
    executableAliases: brokerContract.executableAliases,
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const allTools: HuginTool<Record<string, unknown>>[] = [
    tools.submit as HuginTool<Record<string, unknown>>,
    tools.await_ as HuginTool<Record<string, unknown>>,
    tools.rate as HuginTool<Record<string, unknown>>,
    tools.list as HuginTool<Record<string, unknown>>,
    tools.models as HuginTool<Record<string, unknown>>,
    tools.friction as HuginTool<Record<string, unknown>>,
    tools.experimentCreate as HuginTool<Record<string, unknown>>,
    tools.experimentObserve as HuginTool<Record<string, unknown>>,
    tools.experimentRate as HuginTool<Record<string, unknown>>,
    tools.experimentStatus as HuginTool<Record<string, unknown>>,
    tools.experimentPromote as HuginTool<Record<string, unknown>>,
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
