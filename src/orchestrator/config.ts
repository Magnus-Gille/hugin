import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
} from "./engine.js";

/**
 * Parse a role model specifier from an environment variable or task field.
 *
 * Format: `provider|model`  — split on the FIRST `|`.
 * If no `|` present, the entire string is treated as the model and the
 * default provider for that role is preserved.
 *
 * Returns `null` for malformed input (empty model, or an empty half around
 * the separator) — callers keep their default binding instead of sending a
 * blank provider/model downstream.
 */
function parseRoleEnv(
  raw: string,
  defaultProvider: string,
): { provider: string; model: string } | null {
  const sep = raw.indexOf("|");
  if (sep === -1) {
    const model = raw.trim();
    return model ? { provider: defaultProvider, model } : null;
  }
  const provider = raw.slice(0, sep).trim();
  const model = raw.slice(sep + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

/**
 * Parse a strictly-positive integer environment variable, returning the
 * fallback value when the raw string is absent, empty, not a valid integer,
 * has trailing junk ("2abc"), is zero, or is negative.
 */
function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  // Reject anything that is not a pure integer string (no trailing junk).
  if (!/^-?\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * Load an OrchestratorConfig from environment variables, starting from
 * DEFAULT_ORCHESTRATOR_CONFIG and applying any overrides that are present.
 *
 * Recognised variables:
 *   HUGIN_ORCH_PLANNER_MODEL   — `provider|model` for the planner role
 *   HUGIN_ORCH_WORKER_MODEL    — `provider|model` for the worker role
 *   HUGIN_ORCH_VERIFIER_MODEL  — `provider|model` for the verifier role
 *   HUGIN_ORCH_SYNTH_MODEL     — `provider|model` for the synthesizer role
 *   HUGIN_ORCH_MAX_CONCURRENCY — positive integer
 *   HUGIN_ORCH_VERIFY          — "on" | "true" → verifyWorkers = true
 *   HUGIN_ORCH_PER_CALL_TIMEOUT_MS — positive integer (ms)
 *   HUGIN_ORCH_MAX_SUBTASKS    — positive integer
 *   HUGIN_ORCH_MAX_TOKENS      — positive integer (completion-token cap)
 *
 * Pure function — no side-effects, no I/O.
 */
export function loadOrchestratorConfig(
  env: NodeJS.ProcessEnv,
): OrchestratorConfig {
  const cfg: OrchestratorConfig = {
    ...DEFAULT_ORCHESTRATOR_CONFIG,
    roles: { ...DEFAULT_ORCHESTRATOR_CONFIG.roles },
  };

  if (env.HUGIN_ORCH_PLANNER_MODEL) {
    cfg.roles = {
      ...cfg.roles,
      planner:
        parseRoleEnv(
          env.HUGIN_ORCH_PLANNER_MODEL,
          DEFAULT_ORCHESTRATOR_CONFIG.roles.planner.provider,
        ) ?? cfg.roles.planner,
    };
  }

  if (env.HUGIN_ORCH_WORKER_MODEL) {
    cfg.roles = {
      ...cfg.roles,
      worker:
        parseRoleEnv(
          env.HUGIN_ORCH_WORKER_MODEL,
          DEFAULT_ORCHESTRATOR_CONFIG.roles.worker.provider,
        ) ?? cfg.roles.worker,
    };
  }

  if (env.HUGIN_ORCH_VERIFIER_MODEL) {
    cfg.roles = {
      ...cfg.roles,
      verifier:
        parseRoleEnv(
          env.HUGIN_ORCH_VERIFIER_MODEL,
          DEFAULT_ORCHESTRATOR_CONFIG.roles.verifier.provider,
        ) ?? cfg.roles.verifier,
    };
  }

  if (env.HUGIN_ORCH_SYNTH_MODEL) {
    cfg.roles = {
      ...cfg.roles,
      synthesizer:
        parseRoleEnv(
          env.HUGIN_ORCH_SYNTH_MODEL,
          DEFAULT_ORCHESTRATOR_CONFIG.roles.synthesizer.provider,
        ) ?? cfg.roles.synthesizer,
    };
  }

  if (env.HUGIN_ORCH_MAX_CONCURRENCY) {
    cfg.maxConcurrency = parseIntEnv(
      env.HUGIN_ORCH_MAX_CONCURRENCY,
      DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrency,
    );
  }

  if (env.HUGIN_ORCH_VERIFY) {
    const v = env.HUGIN_ORCH_VERIFY.trim().toLowerCase();
    if (v === "on" || v === "true") {
      cfg.verifyWorkers = true;
    }
  }

  if (env.HUGIN_ORCH_PER_CALL_TIMEOUT_MS) {
    cfg.perCallTimeoutMs = parseIntEnv(
      env.HUGIN_ORCH_PER_CALL_TIMEOUT_MS,
      DEFAULT_ORCHESTRATOR_CONFIG.perCallTimeoutMs,
    );
  }

  if (env.HUGIN_ORCH_MAX_SUBTASKS) {
    cfg.maxSubtasks = parseIntEnv(
      env.HUGIN_ORCH_MAX_SUBTASKS,
      DEFAULT_ORCHESTRATOR_CONFIG.maxSubtasks,
    );
  }

  if (env.HUGIN_ORCH_MAX_TOKENS) {
    cfg.maxTokens = parseIntEnv(
      env.HUGIN_ORCH_MAX_TOKENS,
      DEFAULT_ORCHESTRATOR_CONFIG.maxTokens,
    );
  }

  return cfg;
}

/**
 * If `taskModel` is a non-empty string, override the worker role in a copy
 * of `config`. Accepts the same `provider|model` format as the
 * HUGIN_ORCH_*_MODEL env vars (e.g. `homeserver|qwen3-30b-instruct`); a bare
 * model string keeps the worker's existing provider. Malformed values (an
 * empty half around `|`) are ignored — the defaults are kept. Planner,
 * verifier, and synthesizer roles are left unchanged.
 *
 * Pure function — returns a new OrchestratorConfig; never mutates the input.
 */
export function applyTaskModel(
  config: OrchestratorConfig,
  taskModel?: string,
): OrchestratorConfig {
  if (!taskModel || !taskModel.trim()) return config;
  const parsed = parseRoleEnv(taskModel.trim(), config.roles.worker.provider);
  if (!parsed) return config;
  return {
    ...config,
    roles: {
      ...config.roles,
      worker: { ...config.roles.worker, provider: parsed.provider, model: parsed.model },
    },
  };
}

/**
 * The effective orchestrator config for a task: env-derived role bindings
 * with the task-level `Model:` override folded in.
 *
 * The sensitivity guard MUST run on this post-override config — `Model:` can
 * switch the worker's provider, so guarding the env-only config would let a
 * task steer a private run to a cloud provider after the check. The
 * dispatcher goes through this helper so that ordering lives in tested code
 * (see the composition tests in sensitivity-guard.test.ts).
 */
export function effectiveOrchestratorConfig(
  env: NodeJS.ProcessEnv,
  taskModel?: string,
): OrchestratorConfig {
  return applyTaskModel(loadOrchestratorConfig(env), taskModel);
}
