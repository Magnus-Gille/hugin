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
import { buildTaskSubprocessEnv } from "./task-subprocess-env.js";

export const CODEX_SANDBOX_FAILURE_KIND = "CODEX_SANDBOX_UNAVAILABLE";
export const CODEX_SANDBOX_FAILURE_TAG = "failure:infra";
export const CODEX_SANDBOX_PROBE_COMMAND = "codex sandbox -- /bin/true";

/**
 * Permission-bearing options of the task executor's `codex exec` call. The
 * executor spawns these followed by `--` and the prompt; the argument
 * self-test runs the executor's option list (derived from `codexExecArgs`) followed by `--help`, so the two cannot
 * drift apart. Never substitute a bypass/unrestricted mode here.
 */
export const CODEX_EXEC_BASE_ARGS: readonly string[] = [
  "exec", "--sandbox", "workspace-write",
  "-c", 'approval_policy="on-request"',
];

/**
 * Codex refuses to start outside a git repository or trusted directory.
 * Non-repository task contexts (scratch, files, legacy paths) therefore add
 * this flag. It only disables that trust check; sandbox and approval options
 * are unchanged. Managed `repo:<name>` checkouts never receive it.
 */
export const CODEX_SKIP_GIT_REPO_CHECK_ARG = "--skip-git-repo-check";

export function codexExecArgs(context: string | undefined, prompt: string): string[] {
  const managed = typeof context === "string" && context.startsWith("repo:");
  return [
    ...CODEX_EXEC_BASE_ARGS,
    ...(managed ? [] : [CODEX_SKIP_GIT_REPO_CHECK_ARG]),
    "--", prompt,
  ];
}

/**
 * Argv of the model-free `--help` self-test: the non-managed executor argv
 * (a superset of the managed one) with the `-- <prompt>` tail replaced by
 * `--help`. Derived from `codexExecArgs` so the two cannot drift.
 */
export function codexExecProbeArgs(): string[] {
  return [...codexExecArgs(undefined, "").slice(0, -2), "--help"];
}

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

function runProbe(
  exec: typeof execFile,
  args: string[],
  timeoutMs: number,
): Promise<{ error: ExecFileException | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(
      "codex",
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024,
        env: buildTaskSubprocessEnv(),
      },
      (error: ExecFileException | null, stdout: string, stderr: string) =>
        resolve({ error, stdout, stderr }),
    );
  });
}

/**
 * Run the real Codex sandbox launcher without invoking a model, then check
 * that the installed CLI still accepts the executor's permission options
 * (`codex exec <options> --help` exits before any model call). A removed or
 * renamed option therefore fails here, pre-model, instead of mid-task.
 */
export async function probeCodexSandbox(
  options: CodexSandboxProbeOptions = {},
): Promise<CodexSandboxProbeResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());
  const exec = options.execFileImpl ?? execFile;

  const checks: Array<{ label: string; args: string[] }> = [
    { label: "Codex sandbox self-test", args: ["sandbox", "--", "/bin/true"] },
    { label: "Codex exec argument self-test", args: codexExecProbeArgs() },
  ];

  for (const check of checks) {
    const { error, stdout, stderr } = await runProbe(exec, check.args, timeoutMs);
    if (!error) continue;
    const diagnostic = boundedDiagnostic(stdout, stderr);
    const timedOut = error.killed || error.signal === "SIGTERM";
    const prefix = timedOut
      ? `${check.label} timed out after ${timeoutMs}ms`
      : `${check.label} failed${error.code !== undefined ? ` (exit ${error.code})` : ""}`;
    return {
      available: false,
      checkedAt: now().toISOString(),
      command: CODEX_SANDBOX_PROBE_COMMAND,
      failureKind: CODEX_SANDBOX_FAILURE_KIND,
      reason: `${prefix}: ${diagnostic}`,
    };
  }
  return {
    available: true,
    checkedAt: now().toISOString(),
    command: CODEX_SANDBOX_PROBE_COMMAND,
  };
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
