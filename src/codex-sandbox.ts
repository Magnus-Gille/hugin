/**
 * Zero-token Codex sandbox readiness probe (issue #218).
 *
 * `codex sandbox -- /bin/true` exercises the same Codex-owned sandbox launcher
 * used for shell/tool execution, but does not contact a model. When Hugin runs
 * this probe, it inherits the live systemd unit's address-family restrictions;
 * an omitted AF_NETLINK therefore fails here before a paid agent loop starts.
 */

import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FailureClassification } from "./failure-classification.js";
import {
  buildFrictionContent,
  buildFrictionKey,
  buildFrictionNamespace,
  buildFrictionTags,
} from "./friction/munin-key.js";
import type { ReportFrictionInput } from "./friction/schema.js";

export const CODEX_SANDBOX_FAILURE_KIND = "CODEX_SANDBOX_UNAVAILABLE";
export const CODEX_SANDBOX_FAILURE_TAG = "failure:infra";
export const CODEX_SANDBOX_PROBE_COMMAND = "codex sandbox -- /bin/true";

export interface CodexSandboxProbeResult {
  available: boolean;
  checkedAt: string;
  command: typeof CODEX_SANDBOX_PROBE_COMMAND;
  failureKind?: typeof CODEX_SANDBOX_FAILURE_KIND;
  reason?: string;
}

export interface CodexSandboxProbeOptions {
  timeoutMs?: number;
  now?: () => Date;
  execFileImpl?: typeof execFile;
}

function boundedDiagnostic(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  return combined ? combined.slice(-2_000) : "no diagnostic output";
}

/** Run the real Codex sandbox launcher without invoking a model. */
export function probeCodexSandbox(
  options: CodexSandboxProbeOptions = {},
): Promise<CodexSandboxProbeResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());
  const exec = options.execFileImpl ?? execFile;

  return new Promise((resolve) => {
    exec(
      "codex",
      ["sandbox", "--", "/bin/true"],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024,
        env: process.env,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        const checkedAt = now().toISOString();
        if (!error) {
          resolve({
            available: true,
            checkedAt,
            command: CODEX_SANDBOX_PROBE_COMMAND,
          });
          return;
        }

        const diagnostic = boundedDiagnostic(stdout, stderr);
        const timedOut = error.killed || error.signal === "SIGTERM";
        const prefix = timedOut
          ? `Codex sandbox self-test timed out after ${timeoutMs}ms`
          : `Codex sandbox self-test failed${error.code !== undefined ? ` (exit ${error.code})` : ""}`;
        resolve({
          available: false,
          checkedAt,
          command: CODEX_SANDBOX_PROBE_COMMAND,
          failureKind: CODEX_SANDBOX_FAILURE_KIND,
          reason: `${prefix}: ${diagnostic}`,
        });
      },
    );
  });
}

/** Trusted classification for a probe-generated, pre-model refusal. */
export function codexSandboxFailureClassification(reason: string): FailureClassification {
  return {
    kind: CODEX_SANDBOX_FAILURE_KIND,
    tag: CODEX_SANDBOX_FAILURE_TAG,
    reason,
  };
}

export interface CodexSandboxFrictionEvent {
  namespace: string;
  key: string;
  content: string;
  tags: string[];
}

/** Build the shared schema-v1 infrastructure-friction event for a failed probe. */
export function buildCodexSandboxFrictionEvent(args: {
  taskId: string;
  modelId?: string;
  reason: string;
  recordedAt: Date;
}): CodexSandboxFrictionEvent {
  const input: ReportFrictionInput = {
    event_id: randomUUID(),
    friction_type: "tool_failure",
    severity: "blocking",
    summary: "Codex sandbox self-test failed before task execution",
    detail: args.reason.slice(0, 8_000),
    task_id: args.taskId,
    model_id: args.modelId?.trim() || "codex",
    tool_name: "codex-sandbox",
    tags: ["runtime:codex", `failure-kind:${CODEX_SANDBOX_FAILURE_KIND}`],
  };
  const modelId = input.model_id || "codex";
  const tags = buildFrictionTags({
    input,
    modelId,
    resolvedTaskId: args.taskId,
  }).filter((tag) => tag !== "source:model-self-report");
  tags.push("source:hugin-preflight");
  const baseContent = JSON.parse(buildFrictionContent({
    input,
    modelId,
    resolvedTaskId: args.taskId,
    recordedAt: args.recordedAt,
  })) as Record<string, unknown>;

  return {
    namespace: buildFrictionNamespace(),
    key: buildFrictionKey(args.taskId, args.recordedAt),
    content: JSON.stringify({
      ...baseContent,
      reporter: "hugin-preflight",
      failure_kind: CODEX_SANDBOX_FAILURE_KIND,
    }, null, 2),
    tags,
  };
}
