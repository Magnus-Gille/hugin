import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { aliasSchema, type Alias } from "../broker/types.js";
import type { BrokerClient } from "./broker-client.js";
import {
  ALIAS_MAP_VERSION,
  buildTools,
  type HuginTool,
} from "./tools.js";
import { HUGIN_MCP_SERVER_INSTRUCTIONS } from "./server-instructions.js";

export const SERVER_NAME = "hugin-mcp";
export const SERVER_VERSION = "0.1.0";

export interface BrokerContractDiscovery {
  aliasMapVersion: number;
  executableAliases: Alias[];
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
export async function discoverBrokerContract(
  broker: Pick<BrokerClient, "models">,
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

function registerHuginTools(
  server: McpServer,
  tools: ReturnType<typeof buildTools>,
): void {
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
}

export function createHuginMcpServer(options: {
  broker: BrokerClient;
  sessionId: string;
  submitter: string;
  brokerContract: BrokerContractDiscovery;
}): McpServer {
  const tools = buildTools({
    broker: options.broker,
    sessionId: options.sessionId,
    submitter: options.submitter,
    aliasMapVersion: options.brokerContract.aliasMapVersion,
    executableAliases: options.brokerContract.executableAliases,
  });
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: HUGIN_MCP_SERVER_INSTRUCTIONS },
  );
  registerHuginTools(server, tools);
  return server;
}
