import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorConfig,
} from "./engine.js";

/**
 * Parse a role model specifier from an environment variable.
 *
 * Format: `provider|model`  — split on the FIRST `|`.
 * If no `|` present, the entire string is treated as the model and the
 * default provider for that role is preserved.
 */
function parseRoleEnv(
  raw: string,
  defaultProvider: string,
): { provider: string; model: string } {
  const sep = raw.indexOf("|");
  if (sep === -1) {
    return { provider: defaultProvider, model: raw.trim() };
  }
  return {
    provider: raw.slice(0, sep).trim(),
    model: raw.slice(sep + 1).trim(),
  };
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
      planner: parseRoleEnv(
        env.HUGIN_ORCH_PLANNER_MODEL,
        DEFAULT_ORCHESTRATOR_CONFIG.roles.planner.provider,
      ),
    };
  }

  if (env.HUGIN_ORCH_WORKER_MODEL) {
    cfg.roles = {
      ...cfg.roles,
      worker: parseRoleEnv(
        env.HUGIN_ORCH_WORKER_MODEL,
        DEFAULT_ORCHESTRATOR_CONFIG.roles.worker.provider,
      ),
    };
  }

  if (env.HUGIN_ORCH_VERIFIER_MODEL) {
    cfg.roles = {
      ...cfg.roles,
      verifier: parseRoleEnv(
        env.HUGIN_ORCH_VERIFIER_MODEL,
        DEFAULT_ORCHESTRATOR_CONFIG.roles.verifier.provider,
      ),
    };
  }

  if (env.HUGIN_ORCH_SYNTH_MODEL) {
    cfg.roles = {
      ...cfg.roles,
      synthesizer: parseRoleEnv(
        env.HUGIN_ORCH_SYNTH_MODEL,
        DEFAULT_ORCHESTRATOR_CONFIG.roles.synthesizer.provider,
      ),
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

  return cfg;
}

/**
 * If `taskModel` is a non-empty string, override the worker role's model in
 * a copy of `config`, keeping the worker's existing provider. Planner,
 * verifier, and synthesizer roles are left unchanged.
 *
 * Pure function — returns a new OrchestratorConfig; never mutates the input.
 */
export function applyTaskModel(
  config: OrchestratorConfig,
  taskModel?: string,
): OrchestratorConfig {
  if (!taskModel || !taskModel.trim()) return config;
  return {
    ...config,
    roles: {
      ...config.roles,
      worker: { ...config.roles.worker, model: taskModel.trim() },
    },
  };
}
