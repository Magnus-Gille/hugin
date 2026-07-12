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
  type Alias,
  ratingSchema,
  sensitivitySchema,
  taskTypeSchema,
  verificationOutcomeSchema,
  worktreeSpecSchema,
  verifierSpecSchema,
} from "../broker/types.js";
import {
  BrokerHttpError,
  BrokerNetworkError,
  type BrokerClient,
} from "./broker-client.js";

export const ALIAS_MAP_VERSION = 2;
export const ENVELOPE_VERSION = 2 as const;

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
  /**
   * Alias set advertised by the live Broker `/models` response. An empty set
   * disables `hugin_submit` in the MCP schema. Tests and embedded callers that
   * omit this retain the one currently implemented alias.
   */
  executableAliases?: readonly Alias[];
  /** UUID generator (overridable for tests). */
  newId?: () => string;
}

export const submitInputShape = {
  task_type: taskTypeSchema.describe(
    "Canonical M5 task type. The gateway uses it for capability routing and ledger evidence.",
  ),
  prompt: z
    .string()
    .min(1)
    .describe("The full task prompt to hand to the runtime."),
  alias_requested: aliasSchema.describe(
    "Logical alias. The live executable set is discovered from `hugin_models` when the MCP starts.",
  ),
  worktree: worktreeSpecSchema
    .optional()
    .describe("Reserved for future harness aliases. Omit for the current one-shot alias."),
  sensitivity: sensitivitySchema
    .optional()
    .describe("Caps which runtimes can run this task. Defaults to `internal`."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(900_000)
    .optional()
    .describe("Per-task timeout in ms. Defaults to 300_000; maximum 900_000."),
  max_output_tokens: z
    .number()
    .int()
    .positive()
    .max(32_768)
    .optional()
    .describe("Cap on generated tokens. Defaults to 4_096; maximum 32_768."),
  acceptance: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("l1_review") }).strict(),
    z.object({ mode: z.literal("verifier"), verifier: verifierSpecSchema }).strict(),
  ]).optional().describe("Acceptance contract. Defaults to explicit L1 review."),
  parent_task_id: z.string().min(1).optional().describe("Optional L1 parent-task correlation id."),
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
  const executableAliases = deps.executableAliases ?? ["m5"];
  const executableAliasInput = executableAliases.length > 0
    ? z.enum(executableAliases as [Alias, ...Alias[]])
    : z.never();
  const activeSubmitInputShape = {
    ...submitInputShape,
    alias_requested: executableAliasInput.describe(
      executableAliases.length > 0
        ? `Executable logical alias. Live set: ${executableAliases.join(", ")}.`
        : "No Broker alias currently has an enabled executor; submission is disabled.",
    ),
  };
  const activeSubmitInputSchema = z.object(activeSubmitInputShape);

  const submit: HuginTool<z.infer<typeof submitInputSchema>> = {
    name: "hugin_submit",
    title: "Submit a delegation task to Hugin",
    description:
      "Persist one bounded task in Hugin's durable lifecycle and execute it as one M5 `/delegate` leaf. M5 chooses the model and owns capability evidence; Hugin owns lifecycle and delivery. Returns the task_id and idempotency_key — reuse that key only to retry the same logical request. For judgment-flavored task_type values (classify, qa-factual, triage, memory-decision, claim-verify) submitted with the default `l1_review` acceptance and a prompt with no rubric, the response carries a non-blocking `warnings` array — the task still runs, but attach a mechanical `acceptance.verifier` or add a rubric/grading-criteria section to the prompt for stronger capability evidence.",
    inputShape: activeSubmitInputShape,
    handler: async (rawInput) => {
      let idempotencyKey: string | undefined;
      try {
        const input = activeSubmitInputSchema.parse(rawInput);
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
          sensitivity: input.sensitivity ?? "internal",
          timeout_ms: input.timeout_ms ?? 300_000,
          max_output_tokens: input.max_output_tokens ?? 4_096,
          acceptance: input.acceptance ?? { mode: "l1_review" as const },
          allowed_destinations: ["m5" as const],
          tool_policy: { mode: "none" as const },
          budget: { max_attempts: 1 as const, max_cost_usd: 0 as const },
          durability: "required" as const,
          delivery: { mode: "munin" as const },
          escalation: { mode: "return_to_l1" as const },
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
        // Envelope autofill (#164): the awaiting session id is what lets the
        // broker tell a durable handoff (a LATER session collecting a result)
        // from an ordinary same-session poll. Callers never supply it.
        const response = await deps.broker.await_({
          ...input,
          orchestrator_session_id: deps.sessionId,
        });
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
      "Store a product-usefulness rating for a terminal task. This is Hugin product evidence; it does not directly modify M5's capability ledger.",
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
      "List this authenticated principal's recent canonical Munin tasks, plus its read-only historical orch-v1 rows.",
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
      "Returns only aliases with a live Broker executor and the runtime rows they can actually dispatch to.",
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
