import type { OrchestratorRole } from "./plan.js";
import type {
  HomeserverResponseFormat,
  HomeserverVerifierSpec,
} from "../homeserver-executor.js";
import type { WorkerExecutor, WorkerResult } from "./worker-executor.js";
import { createWorkerExecutor } from "./worker-executor.js";

export interface RoleBinding {
  provider: string;
  model: string;
  /**
   * Per-role completion-token cap (issue #112). Overrides the shared default
   * passed to createModelInvoker. Lets a role that needs longer output (e.g.
   * the synthesizer) exceed the conservative worker cap.
   */
  maxTokens?: number;
  /**
   * M5 `/delegate` provenance for homeserver worker leaves. When absent and
   * the worker role is homeserver-backed, createModelInvoker falls back to the
   * planner role's model as the best in-process delegator model Hugin knows.
   */
  delegatorModelId?: string;
}

export interface ModelInvokeOptions {
  systemPrompt?: string;
  signal?: AbortSignal;
  /** Worker-only metadata forwarded to M5 /delegate. */
  taskType?: string;
  verifier?: HomeserverVerifierSpec;
  responseFormat?: HomeserverResponseFormat;
  delegatorModelId?: string;
  premiumBaselineModelId?: string;
}

export interface ModelInvoker {
  invoke(
    role: OrchestratorRole,
    prompt: string,
    opts?: ModelInvokeOptions,
  ): Promise<WorkerResult>;
}

/**
 * Create a real ModelInvoker that resolves role bindings to WorkerExecutor calls.
 *
 * @param roles         - Map of OrchestratorRole → { provider, model }
 * @param defaults      - Shared defaults: timeoutMs, maxOutputChars, maxTokens
 * @param executorFactory - Optional injection point for tests; defaults to createWorkerExecutor
 */
export function createModelInvoker(
  roles: Record<OrchestratorRole, RoleBinding>,
  defaults: { timeoutMs: number; maxOutputChars?: number; maxTokens?: number },
  executorFactory?: (provider: string, opts?: { role?: OrchestratorRole }) => WorkerExecutor,
): ModelInvoker {
  const factory = executorFactory ?? createWorkerExecutor;

  return {
    async invoke(
      role: OrchestratorRole,
      prompt: string,
      opts?: ModelInvokeOptions,
    ): Promise<WorkerResult> {
      const binding = roles[role];
      const executor = factory(binding.provider, { role });
      const delegateMetadata =
        role === "worker" && binding.provider === "homeserver"
          ? {
              taskType: opts?.taskType,
              verifier: opts?.verifier,
              responseFormat: opts?.responseFormat,
              delegatorModelId:
                opts?.delegatorModelId ?? binding.delegatorModelId ?? roles.planner.model,
              premiumBaselineModelId: opts?.premiumBaselineModelId,
            }
          : {};
      return executor.run({
        provider: binding.provider,
        model: binding.model,
        prompt,
        systemPrompt: opts?.systemPrompt,
        timeoutMs: defaults.timeoutMs,
        maxOutputChars: defaults.maxOutputChars,
        maxTokens: binding.maxTokens ?? defaults.maxTokens,
        signal: opts?.signal,
        ...delegateMetadata,
      });
    },
  };
}
