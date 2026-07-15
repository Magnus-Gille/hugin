/**
 * `report_friction` MCP tool handler.
 *
 * Friction events are lossy by design — write failures must not block
 * task execution and must not surface to the model as MCP errors. The
 * only hard error is input validation (bad schema = caller's fault).
 *
 * Write contract:
 *   - hard timeout (default 2s) via AbortController + Promise.race
 *   - on timeout / Munin error → log to stderr, return { ok: true, dropped: true }
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
        source: "standalone-mcp",
      });
      const content = buildFrictionContent({
        input,
        modelId: resolvedModelId,
        resolvedTaskId,
        recordedAt,
      });

      const writePromise = deps.munin
        .write(namespace, key, content, tags, undefined, "internal")
        .then(() => ({ ok: true, dropped: false }) as const)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          stderr(`friction-mcp: write error for ${namespace}/${key}: ${message}\n`);
          return { ok: true, dropped: true, reason: "write_error" } as const;
        });

      const timeoutPromise = new Promise<{
        ok: true;
        dropped: true;
        reason: "timeout";
      }>((resolve) => {
        setTimeout(() => {
          stderr(
            `friction-mcp: write timed out after ${writeTimeoutMs}ms for ${namespace}/${key}\n`,
          );
          resolve({ ok: true, dropped: true, reason: "timeout" });
        }, writeTimeoutMs).unref?.();
      });

      const outcome = await Promise.race([writePromise, timeoutPromise]);

      if (outcome.dropped) {
        return asResult({
          ok: true,
          dropped: true,
          reason: "reason" in outcome ? outcome.reason : "unknown",
          namespace,
          key,
        });
      }
      return asResult({
        ok: true,
        dropped: false,
        namespace,
        key,
      });
    },
  };
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
