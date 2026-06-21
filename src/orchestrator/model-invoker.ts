import type { OrchestratorRole } from "./plan.js";
import type { WorkerExecutor, WorkerResult } from "./worker-executor.js";
import { createWorkerExecutor } from "./worker-executor.js";

export interface RoleBinding {
  provider: string;
  model: string;
}

export interface ModelInvoker {
  invoke(
    role: OrchestratorRole,
    prompt: string,
    opts?: { systemPrompt?: string },
  ): Promise<WorkerResult>;
}

/**
 * Create a real ModelInvoker that resolves role bindings to WorkerExecutor calls.
 *
 * @param roles         - Map of OrchestratorRole → { provider, model }
 * @param defaults      - Shared defaults: timeoutMs, maxOutputChars
 * @param executorFactory - Optional injection point for tests; defaults to createWorkerExecutor
 */
export function createModelInvoker(
  roles: Record<OrchestratorRole, RoleBinding>,
  defaults: { timeoutMs: number; maxOutputChars?: number },
  executorFactory?: (provider: string) => WorkerExecutor,
): ModelInvoker {
  const factory = executorFactory ?? createWorkerExecutor;

  return {
    async invoke(
      role: OrchestratorRole,
      prompt: string,
      opts?: { systemPrompt?: string },
    ): Promise<WorkerResult> {
      const binding = roles[role];
      const executor = factory(binding.provider);
      return executor.run({
        provider: binding.provider,
        model: binding.model,
        prompt,
        systemPrompt: opts?.systemPrompt,
        timeoutMs: defaults.timeoutMs,
        maxOutputChars: defaults.maxOutputChars,
      });
    },
  };
}
