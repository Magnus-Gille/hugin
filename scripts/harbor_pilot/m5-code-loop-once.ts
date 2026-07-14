#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  assertM5CodeLoopExecutionBinding,
  m5CodeLoopResultSchema,
  type M5CodeLoopResult,
} from "../../src/learning/m5-code-loop-adapter.js";
import {
  M5CodeLoopClient,
  startM5CodeLoopDurably,
  supportsM5CodeLoopContract,
  type M5CodeLoopRequest,
  type M5CodeLoopStart,
} from "../../src/learning/m5-code-loop-client.js";

const capsSchema = z.object({
  wall_s: z.number().int().positive().max(900),
  turns: z.number().int().positive().max(40),
  completion_tokens: z.number().int().positive().max(120_000),
  edit_deadline_turn: z.number().int().positive().max(40).optional(),
}).strict().superRefine((caps, ctx) => {
  if (caps.edit_deadline_turn !== undefined && caps.edit_deadline_turn > caps.turns) {
    ctx.addIssue({
      code: "custom",
      path: ["edit_deadline_turn"],
      message: "edit deadline must not exceed the turn cap",
    });
  }
});

const requestSchema = z.object({
  client_run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  instruction: z.string().min(1),
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.string(),
  }).strict()).min(1).max(64),
  check_cmd: z.string().min(1).optional(),
  protected: z.array(z.string().min(1)).optional(),
  task_type: z.string().min(1).optional(),
  caps: capsSchema,
}).strict();

const inputSchema = z.object({
  request: requestSchema,
  expected: z.object({
    model: z.string().min(1),
    harnessVersion: z.string().min(1),
    caps: capsSchema,
    capabilities: z.object({
      startIdempotency: z.literal("client-run-id-v1"),
      agentChecks: z.literal("pi-bash-events-v3"),
    }).strict().optional(),
  }).strict(),
  pollMs: z.number().int().min(250).max(30_000).default(5_000),
  resultDeadlineS: z.number().int().min(60).max(3_600).default(900),
  replayPath: z.string().min(1).optional(),
}).strict();

export type HarborCodeLoopOnceInput = z.infer<typeof inputSchema>;
export interface HarborCodeLoopOnceOutput {
  result: M5CodeLoopResult;
  start: null | Pick<
    M5CodeLoopStart,
    "work_id" | "status" | "client_run_id" | "request_fingerprint" | "recovered" | "capabilities"
  >;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function m5McpEndpoint(): string {
  const explicit = process.env.M5_MCP_URL;
  if (explicit) return explicit;
  const url = new URL(requiredEnv("M5_BASE_URL"));
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function runCodeLoopOnce(
  rawInput: HarborCodeLoopOnceInput,
): Promise<HarborCodeLoopOnceOutput> {
  const input = inputSchema.parse(rawInput);
  let result: M5CodeLoopResult;

  if (input.replayPath) {
    result = m5CodeLoopResultSchema.parse(
      JSON.parse(readFileSync(resolve(input.replayPath), "utf8")),
    );
    assertM5CodeLoopExecutionBinding(result, input.expected);
    return { result, start: null };
  } else {
    if (!input.request.client_run_id) {
      throw new Error("live Harbor code_loop requests require client_run_id");
    }
    const client = new M5CodeLoopClient({
      endpoint: m5McpEndpoint(),
      bearerToken: requiredEnv("M5_API_KEY"),
    });
    const tools = await client.toolDefinitions();
    if (!supportsM5CodeLoopContract(tools)) {
      throw new Error("M5 does not advertise the exact durable v6/v3 code_loop contract");
    }

    const request = {
      ...input.request,
      client_run_id: input.request.client_run_id,
    } satisfies M5CodeLoopRequest & { client_run_id: string };
    const started = await startM5CodeLoopDurably(client, request);
    if (started.client_run_id !== input.request.client_run_id) {
      throw new Error("M5 did not echo the declared client_run_id");
    }
    if (!started.request_fingerprint) {
      throw new Error("M5 omitted the durable request fingerprint");
    }
    const deadline = Date.now() + input.resultDeadlineS * 1_000;
    let status = started.status;
    while (status === "running") {
      await sleep(input.pollMs);
      status = (await client.status(started.work_id)).status;
      if (status === "running" && Date.now() >= deadline) {
        throw new Error(`M5 result deadline exceeded for ${started.work_id}`);
      }
    }
    result = started.result ?? await client.result(started.work_id);
    if (result.work_id !== started.work_id || result.status !== status) {
      throw new Error("M5 result does not match the durable start binding");
    }
    assertM5CodeLoopExecutionBinding(result, input.expected);
    return {
      result,
      start: {
        work_id: started.work_id,
        status: started.status,
        client_run_id: started.client_run_id,
        request_fingerprint: started.request_fingerprint,
        recovered: started.recovered,
        capabilities: started.capabilities,
      },
    };
  }
}

async function main(): Promise<void> {
  const [inputArg, outputArg] = process.argv.slice(2);
  if (!inputArg || !outputArg) {
    throw new Error("usage: m5-code-loop-once.ts <input.json> <output.json>");
  }
  const input = inputSchema.parse(JSON.parse(readFileSync(resolve(inputArg), "utf8")));
  const output = await runCodeLoopOnce(input);
  writeFileSync(resolve(outputArg), `${JSON.stringify(output)}\n`, { mode: 0o600 });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
