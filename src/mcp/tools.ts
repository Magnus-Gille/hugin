/**
 * Tool definitions for hugin-mcp.
 *
 * Five tools mirror the broker's `/v1/delegate/*` endpoints:
 *   hugin_submit, hugin_await, hugin_rate, hugin_list, hugin_models.
 *
 * The MCP layer is the only place that fills in protocol envelope
 * fields (`envelope_version`, `alias_map_version`, `idempotency_key`,
 * `orchestrator_session_id`, `orchestrator_submitter`). Callers supply
 * the *task* — what to do, with which alias — and trust the MCP to
 * tag it correctly. This keeps the skill-side prompt small.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  aliasSchema,
  ratingSchema,
  sensitivitySchema,
  taskTypeSchema,
  verificationOutcomeSchema,
  worktreeSpecSchema,
} from "../broker/types.js";
import {
  BrokerHttpError,
  BrokerNetworkError,
  type BrokerClient,
} from "./broker-client.js";

export const ALIAS_MAP_VERSION = 1;
export const ENVELOPE_VERSION = 1 as const;

export interface ToolDeps {
  broker: BrokerClient;
  /**
   * Stable per-MCP-process session id. Persisted in journal events so
   * later analysis can group tasks submitted by the same Claude
   * session. Generated on server startup.
   *
   * Note: this value participates in the broker's idempotency hash
   * (see `src/broker/idempotency.ts`). Retries that span MCP restarts
   * will see a different session id and therefore a different hash —
   * the broker will treat them as a collision rather than a replay.
   * Within a single MCP process, retries with the same
   * `idempotency_key` (returned in the submit response) replay
   * cleanly.
   */
  sessionId: string;
  /**
   * `orchestrator_submitter` — must match the principal the Pi-side
   * broker recognises (e.g. `claude-code`, `claude-desktop`).
   */
  submitter: string;
  /**
   * Alias-map version stamped on every submit envelope. Discovered
   * from `/v1/delegate/models` at server startup; if unavailable,
   * falls back to {@link ALIAS_MAP_VERSION}. The broker uses this to
   * detect orchestrator skew when it bumps the alias map.
   */
  aliasMapVersion?: number;
  /** UUID generator (overridable for tests). */
  newId?: () => string;
}

export const submitInputShape = {
  task_type: taskTypeSchema.describe(
    "What kind of task this is. Steers the broker's accounting + rating UI.",
  ),
  prompt: z
    .string()
    .min(1)
    .describe("The full task prompt to hand to the runtime."),
  alias_requested: aliasSchema.describe(
    "Logical alias (`tiny` / `medium` / `large-reasoning` / `pi-large-coder`). The broker resolves this to a runtime row.",
  ),
  worktree: worktreeSpecSchema
    .optional()
    .describe("Required for `pi-large-coder` (harness aliases). Omit for one-shots."),
  sensitivity: sensitivitySchema
    .optional()
    .describe("Caps which runtimes can run this task. Defaults to `internal`."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Per-task timeout. Defaults to 300_000 (5 min) for one-shot."),
  max_output_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap on generated tokens. Optional."),
  parent_task_id: z.string().min(1).optional().describe("Reserved; not used in v1."),
  idempotency_key: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Override the auto-generated idempotency key. Useful when the caller knows the request is a retry of an earlier one.",
    ),
};
const submitInputSchema = z.object(submitInputShape);

export const awaitInputShape = {
  task_id: z.string().min(1).describe("Task id returned by `hugin_submit`."),
};
const awaitInputSchema = z.object(awaitInputShape);

export const rateInputShape = {
  task_id: z.string().min(1),
  rating: ratingSchema.describe("`pass` / `partial` / `redo` / `wrong`."),
  rating_reason: z.string().min(1),
  verification_outcome: verificationOutcomeSchema,
  retries_count: z.number().int().nonnegative().optional(),
};
const rateInputSchema = z.object(rateInputShape);

export const listInputShape = {
  limit: z.number().int().min(1).max(500).optional(),
  since_ts: z.string().min(1).optional(),
  outcome: z.enum(["completed", "failed", "running", "any"]).optional(),
  alias: aliasSchema.optional(),
};
const listInputSchema = z.object(listInputShape);

export const modelsInputShape = {};
const modelsInputSchema = z.object(modelsInputShape);

export interface HuginTool<I extends Record<string, unknown>> {
  name: string;
  title: string;
  description: string;
  inputShape: Record<string, z.ZodTypeAny>;
  handler: (input: I) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
}

function asResult(value: unknown, isError = false): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/**
 * Surface the idempotency_key used on a submit so the caller can
 * replay the same logical request after a transient error. We add the
 * key alongside whatever shape the broker returned, without
 * overwriting any existing `idempotency_key` field.
 */
function withIdempotencyKey(response: unknown, idempotencyKey: string): unknown {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const obj = response as Record<string, unknown>;
    if (obj.idempotency_key === undefined) {
      return { ...obj, idempotency_key: idempotencyKey };
    }
    return obj;
  }
  return { response, idempotency_key: idempotencyKey };
}

function errorPayload(err: unknown): { error: { kind: string; message: string; http_status?: number; body?: unknown } } {
  if (err instanceof BrokerHttpError) {
    return {
      error: {
        kind: "broker_http_error",
        message: err.message,
        http_status: err.httpStatus,
        body: err.body,
      },
    };
  }
  if (err instanceof BrokerNetworkError) {
    return { error: { kind: "broker_network_error", message: err.message } };
  }
  if (err instanceof z.ZodError) {
    return {
      error: {
        kind: "input_validation",
        message: "tool input failed validation",
        body: err.issues,
      },
    };
  }
  return {
    error: {
      kind: "internal",
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

export function buildTools(deps: ToolDeps): {
  submit: HuginTool<z.infer<typeof submitInputSchema>>;
  await_: HuginTool<z.infer<typeof awaitInputSchema>>;
  rate: HuginTool<z.infer<typeof rateInputSchema>>;
  list: HuginTool<z.infer<typeof listInputSchema>>;
  models: HuginTool<z.infer<typeof modelsInputSchema>>;
} {
  const newId = deps.newId ?? randomUUID;

  const submit: HuginTool<z.infer<typeof submitInputSchema>> = {
    name: "hugin_submit",
    title: "Submit a delegation task to Hugin",
    description:
      "Hand a task off to the Pi-side broker for execution on a cheaper or differently-capable runtime. Returns the assigned task_id and the `idempotency_key` used (auto-generated if not supplied) — pass that key back as `idempotency_key` to safely retry the same logical request.",
    inputShape: submitInputShape,
    handler: async (rawInput) => {
      let idempotencyKey: string | undefined;
      try {
        const input = submitInputSchema.parse(rawInput);
        idempotencyKey = input.idempotency_key ?? newId();
        const payload = {
          envelope_version: ENVELOPE_VERSION,
          idempotency_key: idempotencyKey,
          orchestrator_session_id: deps.sessionId,
          orchestrator_submitter: deps.submitter,
          parent_task_id: input.parent_task_id,
          task_type: input.task_type,
          prompt: input.prompt,
          alias_requested: input.alias_requested,
          alias_map_version: deps.aliasMapVersion ?? ALIAS_MAP_VERSION,
          worktree: input.worktree,
          sensitivity: input.sensitivity,
          timeout_ms: input.timeout_ms,
          max_output_tokens: input.max_output_tokens,
        };
        const response = await deps.broker.submit(payload);
        return asResult(withIdempotencyKey(response, idempotencyKey));
      } catch (err) {
        const payload = errorPayload(err) as Record<string, unknown>;
        if (idempotencyKey) payload.idempotency_key = idempotencyKey;
        return asResult(payload, true);
      }
    },
  };

  const await_: HuginTool<z.infer<typeof awaitInputSchema>> = {
    name: "hugin_await",
    title: "Read the current state of a delegated task",
    description:
      "Idempotent read of a task's status: `running` / `completed` / `failed`. Returns immediately. While `running`, the response also carries lease info and an `orphan_suspected` flag (true once the lease has expired without completion). Safe to poll.",
    inputShape: awaitInputShape,
    handler: async (rawInput) => {
      try {
        const input = awaitInputSchema.parse(rawInput);
        const response = await deps.broker.await_(input);
        return asResult(response);
      } catch (err) {
        return asResult(errorPayload(err), true);
      }
    },
  };

  const rate: HuginTool<z.infer<typeof rateInputSchema>> = {
    name: "hugin_rate",
    title: "Rate the outcome of a delegated task",
    description:
      "Append a rating event for a previously completed task. Used by the audit pipeline + future routing improvements.",
    inputShape: rateInputShape,
    handler: async (rawInput) => {
      try {
        const input = rateInputSchema.parse(rawInput);
        const response = await deps.broker.rate(input);
        return asResult(response);
      } catch (err) {
        return asResult(errorPayload(err), true);
      }
    },
  };

  const list: HuginTool<z.infer<typeof listInputSchema>> = {
    name: "hugin_list",
    title: "List recent delegated tasks",
    description:
      "Projection over the broker's journal. Useful to find a forgotten task_id or review what ran today.",
    inputShape: listInputShape,
    handler: async (rawInput) => {
      try {
        const input = listInputSchema.parse(rawInput);
        const response = await deps.broker.list(input);
        return asResult(response);
      } catch (err) {
        return asResult(errorPayload(err), true);
      }
    },
  };

  const models: HuginTool<z.infer<typeof modelsInputSchema>> = {
    name: "hugin_models",
    title: "Read the active alias map and runtime registry",
    description:
      "Returns the current alias map (`tiny`/`medium`/`large-reasoning`/`pi-large-coder`) and the runtime rows the broker can dispatch to.",
    inputShape: modelsInputShape,
    handler: async () => {
      try {
        const response = await deps.broker.models();
        return asResult(response);
      } catch (err) {
        return asResult(errorPayload(err), true);
      }
    },
  };

  return { submit, await_, rate, list, models };
}
