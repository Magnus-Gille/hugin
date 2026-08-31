/**
 * `report_friction` MCP tool handler.
 *
 * Friction writes are non-blocking for the parent task, but never silently
 * successful: a write failure is durably spooled and returned as `ok:false`.
 * The only MCP protocol error is input validation (bad schema = caller's
 * fault); the task can continue while the caller receives recovery state.
 *
 * Write contract:
 *   - hard timeout (default 2s) via a bounded Promise.race
 *   - on timeout / Munin error → spool the exact event, log bounded diagnostics,
 *     return { ok: false, dropped: true, recovery: "spooled" }
 *   - on success → return { ok: true, dropped: false, namespace, key }
 */

import { z } from "zod";
import {
  buildFrictionContent,
  buildFrictionKey,
  buildFrictionNamespace,
  buildFrictionTags,
  keepCallerFrictionTags,
  sanitiseTaskId,
} from "./munin-key.js";
import {
  reportFrictionInputSchema,
  type ReportFrictionInput,
  reportFrictionInputShape,
} from "./schema.js";
import {
  createFrictionOutbox,
  defaultFrictionOutboxDirectory,
  redactFrictionDiagnostic,
  type FrictionOutbox,
} from "./outbox.js";

export interface FrictionMuninWriter {
  write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
  ): Promise<unknown>;
}

export interface FrictionToolDeps {
  munin: FrictionMuninWriter;
  /** Process-wide default model id; overridden per call by env. */
  modelId: string;
  /** SDK-injected default task id; overridden by tool-input task_id. */
  taskId?: string;
  /** Hard write timeout in ms. Defaults to 2_000. */
  writeTimeoutMs?: number;
  /** Clock override for tests. */
  now?: () => Date;
  /** Stderr override for tests. */
  stderr?: (line: string) => void;
  /** Durable local queue for Munin failures. Defaults to the operator state directory. */
  outbox?: FrictionOutbox;
  /** Override the default queue directory, primarily for isolated tests. */
  outboxDirectory?: string;
}

export interface FrictionTool {
  name: string;
  title: string;
  description: string;
  inputShape: typeof reportFrictionInputShape;
  handler: (input: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}

const REPORT_FRICTION_DESCRIPTION = `Use this tool only when something concrete made the task harder than it should
have been. Examples worth reporting: a tool returned an error you couldn't
recover from; a constraint in the task contradicted another; you needed
information you didn't have; you noticed your reasoning was hitting a ceiling
and you simplified to fit. Do NOT call this for routine difficulty,
mild ambiguity that you resolved, or when you simply prefer more context.
At most one call per distinct friction event. Severity guidance:
- low: noticed but coped; output unaffected
- medium: slowed down or had to simplify; output mostly unaffected
- high: had to drop or guess part of the task
- blocking: could not proceed without external help`;

function asResult(value: unknown, isError = false): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

function errorPayload(err: unknown): { error: { kind: string; message: string; body?: unknown } } {
  if (err instanceof z.ZodError) {
    return {
      error: {
        kind: "input_validation",
        message: "report_friction input failed validation",
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

export function buildFrictionTool(deps: FrictionToolDeps): FrictionTool {
  const writeTimeoutMs = deps.writeTimeoutMs ?? 2_000;
  const now = deps.now ?? (() => new Date());
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line));
  const outbox = deps.outbox ?? createFrictionOutbox({
    directory: deps.outboxDirectory ?? defaultFrictionOutboxDirectory(),
    stderr,
  });

  return {
    name: "report_friction",
    title: "Report friction encountered during task execution",
    description: REPORT_FRICTION_DESCRIPTION,
    inputShape: reportFrictionInputShape,
    handler: async (rawInput: unknown) => {
      let input: ReportFrictionInput;
      try {
        input = reportFrictionInputSchema.parse(rawInput);
        input = {
          ...input,
          ...(input.tags ? { tags: keepCallerFrictionTags(input.tags) } : {}),
        };
      } catch (err) {
        return asResult(errorPayload(err), true);
      }

      const recordedAt = now();
      const resolvedTaskId = pickTaskId(input.task_id, deps.taskId);
      const resolvedModelId = pickModelId(input.model_id, deps.modelId);
      const namespace = buildFrictionNamespace();
      const key = buildFrictionKey(resolvedTaskId, recordedAt);
      const tags = buildFrictionTags({
        input,
        modelId: resolvedModelId,
        resolvedTaskId,
        source: "model-self-report",
      });
      const content = buildFrictionContent({
        input,
        modelId: resolvedModelId,
        resolvedTaskId,
        recordedAt,
      });

      const writeOutcome = await writeWithTimeout(
        Promise.resolve().then(() =>
          deps.munin.write(namespace, key, content, tags, undefined, "internal")),
        writeTimeoutMs,
      );
      if (writeOutcome.kind === "success") {
        return asResult({ ok: true, dropped: false, namespace, key });
      }

      const reason = writeOutcome.kind === "timeout" ? "timeout" : "write_error";
      const diagnostic = writeOutcome.kind === "timeout"
        ? `write timed out after ${writeTimeoutMs}ms`
        : redactFrictionDiagnostic(writeOutcome.error);
      const recovery = await outbox.enqueue({
        namespace,
        key,
        content,
        tags,
        classification: "internal",
      });
      const recoveryState = recovery.stored ? "spooled" : recovery.reason;
      stderr(
        `friction-mcp: ${reason === "timeout" ? "write timed out" : "write error"} for `
        + `${namespace}/${key}: ${diagnostic}; ${recoveryState} `
        + `(pending=${recovery.pendingCount})\n`,
      );
      return asResult({
        ok: false,
        dropped: true,
        reason,
        recovery: recoveryState,
        namespace,
        key,
        diagnostic,
        pending: recovery.pendingCount,
        oldestAt: recovery.oldestAt,
      });
    },
  };
}

type WriteOutcome =
  | { kind: "success" }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

async function writeWithTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<WriteOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race<WriteOutcome>([
    promise.then(() => ({ kind: "success" as const }), (error: unknown) => ({ kind: "error" as const, error })),
    new Promise<WriteOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
}

function pickTaskId(fromInput: string | undefined, fromDeps: string | undefined): string | undefined {
  const candidate = fromInput?.trim() || fromDeps?.trim();
  if (!candidate) return undefined;
  return sanitiseTaskId(candidate);
}

/**
 * Caller-supplied model id (interactive sessions self-report) wins over the
 * process-wide env default. A blank/whitespace value at either layer falls
 * through to the next, so a stray empty string (input OR a blank
 * HUGIN_FRICTION_MODEL_ID env) never produces a `model:` tag with no value —
 * the floor is always the documented `"unknown"`.
 */
function pickModelId(fromInput: string | undefined, fromDeps: string): string {
  return fromInput?.trim() || fromDeps.trim() || "unknown";
}
