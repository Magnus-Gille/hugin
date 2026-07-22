/** Environment values that belong to the dispatcher trust boundary only. */
export const SENSITIVITY_CHECKPOINT_SECRET_ENV =
  "HUGIN_SENSITIVITY_CHECKPOINT_SECRET" as const;

/**
 * Build an environment for any child process spawned by Hugin.
 *
 * Model runtimes can execute task-controlled code, and even operational
 * subprocesses can traverse repository hooks or helpers. Never let either
 * inherit dispatcher-only producer credentials.
 */
export function buildTaskSubprocessEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env[SENSITIVITY_CHECKPOINT_SECRET_ENV];
  return env;
}
