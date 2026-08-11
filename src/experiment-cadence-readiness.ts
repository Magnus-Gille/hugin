/**
 * Bounded Munin startup readiness for the experiment cadence oneshot.
 *
 * The cadence timer may run while Munin is still completing boot. Keep this
 * retry policy local to the cadence conductor; the daily exam factory has
 * its own independent lifecycle and must not inherit cadence behavior.
 */

export interface MuninReadinessProbe {
  health(options?: { requestTimeoutMs?: number }): Promise<boolean>;
}

export interface MuninReadinessOptions {
  /** Maximum number of health probes, including the first attempt. */
  maxAttempts?: number;
  /** Delay between failed probes. */
  retryDelayMs?: number;
  /** Timeout supplied to each health probe. */
  probeTimeoutMs?: number;
  /** Injectable delay for deterministic tests. */
  sleep?: (delayMs: number) => Promise<void>;
}

export const DEFAULT_MUNIN_READINESS: Required<Pick<
  MuninReadinessOptions,
  "maxAttempts" | "retryDelayMs" | "probeTimeoutMs"
>> = {
  // 5 x 5s probes plus 4 x 2s delays = 33s worst case, well inside the
  // cadence service's 120s startup timeout.
  maxAttempts: 5,
  retryDelayMs: 2_000,
  probeTimeoutMs: 5_000,
};

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function probeWithDeadline(
  munin: MuninReadinessProbe,
  probeTimeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), probeTimeoutMs);
  });
  try {
    return await Promise.race([
      munin.health({ requestTimeoutMs: probeTimeoutMs }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Wait until Munin reports ready, or fail after a fixed probe/delay budget. */
export async function waitForMuninReadiness(
  munin: MuninReadinessProbe,
  options: MuninReadinessOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MUNIN_READINESS.maxAttempts;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_MUNIN_READINESS.retryDelayMs;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_MUNIN_READINESS.probeTimeoutMs;
  const sleep = options.sleep ?? defaultSleep;

  validatePositiveInteger(maxAttempts, "maxAttempts");
  validateNonNegativeInteger(retryDelayMs, "retryDelayMs");
  validatePositiveInteger(probeTimeoutMs, "probeTimeoutMs");

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (await probeWithDeadline(munin, probeTimeoutMs)) return;
    } catch (error) {
      lastError = error;
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Munin readiness failed after ${maxAttempts} probe(s)${detail}`);
}
