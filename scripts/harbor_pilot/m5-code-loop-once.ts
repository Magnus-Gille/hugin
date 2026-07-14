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
  type M5CodeLoopRequest,
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
  }).strict(),
  pollMs: z.number().int().min(250).max(30_000).default(5_000),
  resultDeadlineS: z.number().int().min(60).max(3_600).default(900),
  replayPath: z.string().min(1).optional(),
}).strict();

export type HarborCodeLoopOnceInput = z.infer<typeof inputSchema>;

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

function supportsRequestedContract(
  tools: Array<Record<string, unknown>>,
  request: M5CodeLoopRequest,
): boolean {
  const start = tools.find((tool) => tool.name === "code_loop_start");
  if (!start) return false;
  if (request.caps?.edit_deadline_turn === undefined) return true;
  return JSON.stringify(start).includes("edit_deadline_turn");
}

export async function runCodeLoopOnce(
  rawInput: HarborCodeLoopOnceInput,
): Promise<M5CodeLoopResult> {
  const input = inputSchema.parse(rawInput);
  let result: M5CodeLoopResult;

  if (input.replayPath) {
    result = m5CodeLoopResultSchema.parse(
      JSON.parse(readFileSync(resolve(input.replayPath), "utf8")),
    );
  } else {
    const client = new M5CodeLoopClient({
      endpoint: m5McpEndpoint(),
      bearerToken: requiredEnv("M5_API_KEY"),
    });
    const tools = await client.toolDefinitions();
    if (!supportsRequestedContract(tools, input.request)) {
      throw new Error("M5 does not advertise the requested code_loop contract");
    }

    const started = await client.start(input.request);
    const deadline = Date.now() + input.resultDeadlineS * 1_000;
    for (;;) {
      await sleep(input.pollMs);
      const status = await client.status(started.work_id);
      if (status.status !== "running") break;
      if (Date.now() >= deadline) {
        throw new Error(`M5 result deadline exceeded for ${started.work_id}`);
      }
    }
    result = await client.result(started.work_id);
  }

  assertM5CodeLoopExecutionBinding(result, input.expected);
  return result;
}

async function main(): Promise<void> {
  const [inputArg, outputArg] = process.argv.slice(2);
  if (!inputArg || !outputArg) {
    throw new Error("usage: m5-code-loop-once.ts <input.json> <output.json>");
  }
  const input = inputSchema.parse(JSON.parse(readFileSync(resolve(inputArg), "utf8")));
  const result = await runCodeLoopOnce(input);
  writeFileSync(resolve(outputArg), `${JSON.stringify(result)}\n`, { mode: 0o600 });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
