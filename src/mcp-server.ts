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
 *   HUGIN_BROKER_URL    — e.g. http://huginmunin.tail-scale.ts.net:3033
 *   HUGIN_BROKER_TOKEN  — bearer token registered in HUGIN_BROKER_KEYS
 *
 * Optional env:
 *   HUGIN_MCP_SUBMITTER         — orchestrator_submitter principal (default: "claude-code")
 *   HUGIN_MCP_REQUEST_TIMEOUT_MS — per-request HTTP timeout (default: 60_000)
 */

import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrokerClient } from "./mcp/broker-client.js";
import {
  createHuginMcpServer,
  discoverBrokerContract,
} from "./mcp/server-factory.js";

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    process.stderr.write(`hugin-mcp: missing required env ${name}\n`);
    process.exit(1);
  }
  return value;
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
  const server = createHuginMcpServer({
    broker,
    sessionId: randomUUID(),
    submitter,
    brokerContract,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `hugin-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
