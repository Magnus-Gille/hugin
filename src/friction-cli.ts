#!/usr/bin/env node

import { parseArgs as parseNodeArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { BrokerClient } from "./mcp/broker-client.js";
import {
  reportFrictionInputSchema,
  type ReportFrictionInput,
} from "./friction/schema.js";

const USAGE = `Usage: hugin-friction [options]

Submit one friction event to Hugin's authenticated Broker API.

Required:
  --friction-type <type>  Friction taxonomy value (for example tool_failure)
  --severity <level>      low | medium | high | blocking
  --summary <text>        One-sentence headline
  --detail <text>         What failed and what would have helped

Optional:
  --task-id <id>          Related Hugin task id
  --model-id <id>         Model/runtime identifier (defaults to Broker principal)
  --tool-name <name>      Tool that failed or was missing
  --resource-assessment <value>
                          under-resourced | appropriate | over-resourced
  --alias-suggested <id>  Suggested Hugin alias
  --tag <tag>             Extra tag; repeat up to 16 times
  --help                  Show this help

Environment:
  HUGIN_BROKER_URL        Broker base URL, e.g. http://huginmunin:3033
  HUGIN_BROKER_TOKEN      Bearer token registered in HUGIN_BROKER_KEYS
`;

export function parseFrictionCliArgs(argv: string[]): ReportFrictionInput | null {
  const { values } = parseNodeArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      "friction-type": { type: "string" },
      severity: { type: "string" },
      summary: { type: "string" },
      detail: { type: "string" },
      "task-id": { type: "string" },
      "model-id": { type: "string" },
      "tool-name": { type: "string" },
      "resource-assessment": { type: "string" },
      "alias-suggested": { type: "string" },
      tag: { type: "string", multiple: true },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return null;
  return reportFrictionInputSchema.parse({
    friction_type: values["friction-type"],
    severity: values.severity,
    summary: values.summary,
    detail: values.detail,
    task_id: values["task-id"],
    model_id: values["model-id"],
    tool_name: values["tool-name"],
    resource_assessment: values["resource-assessment"],
    alias_suggested: values["alias-suggested"],
    tags: values.tag,
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const input = parseFrictionCliArgs(argv);
  if (!input) {
    process.stdout.write(USAGE);
    return;
  }
  const client = new BrokerClient({
    baseUrl: requiredEnv("HUGIN_BROKER_URL"),
    bearerToken: requiredEnv("HUGIN_BROKER_TOKEN"),
  });
  const result = await client.reportFriction(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `hugin-friction: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
