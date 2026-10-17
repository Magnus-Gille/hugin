/** Environment values that belong to the dispatcher trust boundary only. */
export const SENSITIVITY_CHECKPOINT_SECRET_ENV =
  "HUGIN_SENSITIVITY_CHECKPOINT_SECRET" as const;

/**
 * Ambient compatibility values that task subprocesses may need. Keep this
 * list explicit: HUGIN_*, provider, loader, and platform authority variables
 * must not cross the dispatcher/task boundary by accident.
 */
export const TASK_SUBPROCESS_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;

/**
 * Build an environment for any child process spawned by Hugin.
 *
 * Model runtimes can execute task-controlled code, and even operational
 * subprocesses can traverse repository hooks or helpers. Preserve only the
 * small set of ordinary compatibility variables required by child tools;
 * callers must add any purpose-bound value explicitly at the call site.
 */
export function buildTaskSubprocessEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of TASK_SUBPROCESS_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return env;
}
