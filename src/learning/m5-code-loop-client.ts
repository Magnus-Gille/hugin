/** Minimal owner-authenticated JSON-RPC client for M5's async code_loop tools. */

import { z } from "zod";
import {
  m5CodeLoopResultSchema,
  type M5CodeLoopResult,
} from "./m5-code-loop-adapter.js";

export interface M5CodeLoopClientConfig {
  endpoint: string;
  bearerToken: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface M5CodeLoopRequest {
  /** Durable caller idempotency key (M5 client-run-id-v1). */
  client_run_id?: string;
  instruction: string;
  files: Array<{ path: string; content: string }>;
  check_cmd?: string;
  protected?: string[];
  task_type?: string;
  caps?: {
    wall_s?: number;
    turns?: number;
    completion_tokens?: number;
    /** Proposed in gille-inference #247. */
    edit_deadline_turn?: number;
  };
}

const codeLoopCapabilitiesSchema = z.object({
  start_idempotency: z.literal("client-run-id-v1"),
  agent_checks: z.literal("pi-bash-events-v1"),
}).strict();

const jobStatusSchema = z.enum([
  "running",
  "completed",
  "cap-exceeded",
  "degenerate",
  "arm-error",
  "orphaned",
]);

const startSchema = z.object({
  work_id: z.string().min(1),
  status: jobStatusSchema,
  client_run_id: z.string().min(1).nullable(),
  request_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  recovered: z.boolean(),
  capabilities: codeLoopCapabilitiesSchema,
  result: m5CodeLoopResultSchema.optional(),
}).strict();
export type M5CodeLoopStart = z.infer<typeof startSchema>;

const statusSchema = z.object({
  status: jobStatusSchema,
  usage: z.object({
    turns: z.number().int().nonnegative(),
    wall_ms: z.number().int().nonnegative(),
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export class M5CodeLoopError extends Error {
  constructor(
    message: string,
    public readonly detail?: unknown,
    /** The remote side may have accepted the mutation even though no response arrived. */
    public readonly ambiguousOutcome = false,
  ) {
    super(message);
    this.name = "M5CodeLoopError";
  }
}

export class M5CodeLoopClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(config: M5CodeLoopClientConfig) {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("M5 code-loop endpoint must use http(s)");
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("M5 code-loop endpoint must not contain credentials, query, or fragment");
    }
    if (endpoint.pathname !== "/mcp") {
      throw new Error(`M5 code-loop endpoint path must be /mcp; got ${endpoint.pathname}`);
    }
    if (config.bearerToken.trim() === "") throw new Error("M5 bearer token is required");
    this.endpoint = endpoint.toString();
    this.token = config.bearerToken;
    this.timeoutMs = config.requestTimeoutMs ?? 30_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async start(request: M5CodeLoopRequest): Promise<M5CodeLoopStart> {
    return startSchema.parse(
      await this.call("code_loop_start", { ...request }),
    );
  }

  async status(workId: string): Promise<z.infer<typeof statusSchema>> {
    return statusSchema.parse(await this.call("code_loop_status", { work_id: workId }));
  }

  async result(workId: string): Promise<M5CodeLoopResult> {
    return m5CodeLoopResultSchema.parse(
      await this.call("code_loop_result", { work_id: workId }),
    );
  }

  async toolDefinitions(): Promise<Array<Record<string, unknown>>> {
    const response = await this.rpc("tools/list", {});
    if (!response || typeof response !== "object" || !Array.isArray((response as { tools?: unknown }).tools)) {
      throw new M5CodeLoopError("M5 tools/list returned an invalid payload");
    }
    return (response as { tools: Array<Record<string, unknown>> }).tools;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.rpc("tools/call", { name, arguments: args });
    if (!response || typeof response !== "object") {
      throw new M5CodeLoopError(`M5 ${name} returned an invalid result`);
    }
    const result = response as { isError?: unknown; content?: unknown };
    if (!Array.isArray(result.content)) {
      throw new M5CodeLoopError(`M5 ${name} returned no content`);
    }
    const text = result.content.find(
      (item): item is { type: "text"; text: string } =>
        !!item && typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )?.text;
    if (text === undefined) throw new M5CodeLoopError(`M5 ${name} returned no text content`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new M5CodeLoopError(`M5 ${name} returned non-JSON text`);
    }
    if (result.isError === true) {
      throw new M5CodeLoopError(`M5 ${name} refused or failed`, parsed);
    }
    return parsed;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new M5CodeLoopError(`M5 JSON-RPC returned HTTP ${response.status}`);
      }
      const body = await response.json() as {
        error?: { code?: unknown; message?: unknown };
        result?: unknown;
      };
      if (body.error) {
        throw new M5CodeLoopError(
          `M5 JSON-RPC error ${String(body.error.code ?? "unknown")}: ${String(body.error.message ?? "unknown")}`,
        );
      }
      return body.result;
    } catch (err) {
      if (err instanceof M5CodeLoopError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new M5CodeLoopError(
          `M5 JSON-RPC timed out after ${this.timeoutMs}ms`,
          undefined,
          true,
        );
      }
      throw new M5CodeLoopError(
        `M5 JSON-RPC request failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
