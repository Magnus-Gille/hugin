/**
 * Proactive Pi Claude credential-expiry alarm (issue #131, follow-up to #129).
 *
 * #130 made an auth failure legible *when a task runs and fails*. This closes
 * the remaining gap: a token that expires while the queue is idle still drains
 * the whole overnight run before any task surfaces the 401. A periodic probe
 * (reusing the #130 usage check) feeds this pure, edge-triggered state machine,
 * which decides — without any I/O — whether to emit an alert and what it says.
 *
 * The alert is delivered through Ratatoskr's Alert Bus (`POST /api/send` with an
 * `alert` envelope → Telegram + Heimdall echo). This module only *builds* the
 * envelope; the dispatcher owns the network send. Kept pure so the transition
 * logic and the expiry-threshold arithmetic are unit-tested without a clock,
 * network, or credential file.
 */

/** Result of a credential probe. `unknown` = transient/inconclusive (fail-open). */
export type AuthProbeState = "ok" | "unauthorized" | "unknown";

/** Matches Ratatoskr's AlertEnvelope contract (ratatoskr/src/alert.ts, #16). */
export interface AlertEnvelope {
  severity?: "info" | "warn" | "error" | "critical";
  source?: string;
  title: string;
  body?: string;
  dedup_key?: string;
  ts?: string;
}

export interface AuthProbeReading {
  auth: AuthProbeState;
  /** Token expiry (epoch ms) from the credential file, or null if unavailable. */
  expiresAtMs: number | null;
}

/** Persisted between ticks so the alarm is edge-triggered, not repeated. */
export interface AuthAlarmState {
  /** Last CONFIRMED (non-`unknown`) auth state acted on. null = no reading yet. */
  lastAuth: "ok" | "unauthorized" | null;
  /** Whether the current token's impending-expiry warning has already fired. */
  expiryWarned: boolean;
}

export const INITIAL_AUTH_ALARM_STATE: AuthAlarmState = {
  lastAuth: null,
  expiryWarned: false,
};

/** Stable dedup keys so Heimdall collapses repeats of the same condition. */
export const AUTH_ALARM_DEDUP_KEY = "hugin-claude-auth";
export const AUTH_EXPIRY_DEDUP_KEY = "hugin-claude-auth-expiry";

export interface AuthAlarmDecideOptions {
  /** Current time (epoch ms). Injected so the decision is deterministic. */
  nowMs: number;
  /** Warn this far ahead of `expiresAtMs` when the credential is still valid. */
  expiryWarnMs: number;
}

export interface AuthAlarmDecision {
  /** Zero or more envelopes to deliver. Empty in the steady state. */
  alerts: AlertEnvelope[];
  /** State to persist for the next tick. */
  nextState: AuthAlarmState;
}

function invalidAlert(): AlertEnvelope {
  return {
    severity: "error",
    source: "hugin",
    title: "Pi Claude auth invalid — overnight tasks will fail",
    body:
      "The Pi's Claude Code credential is no longer valid (HTTP 401). All " +
      "`runtime:claude` autonomous tasks will fail until it is refreshed — " +
      "re-run `/login` in a `claude` session on huginmunin.",
    dedup_key: AUTH_ALARM_DEDUP_KEY,
  };
}

function recoveredAlert(): AlertEnvelope {
  return {
    severity: "info",
    source: "hugin",
    title: "Pi Claude auth restored",
    body: "The Pi's Claude Code credential authenticates again — autonomous tasks can run.",
    dedup_key: AUTH_ALARM_DEDUP_KEY,
  };
}

function expiryAlert(hoursLeft: number): AlertEnvelope {
  return {
    severity: "warn",
    source: "hugin",
    title: `Pi Claude auth expires in ~${hoursLeft}h`,
    body:
      "The Pi's Claude Code credential is nearing expiry. Refresh it (re-run " +
      "`/login` on huginmunin) before it lapses to avoid draining the overnight queue.",
    dedup_key: AUTH_EXPIRY_DEDUP_KEY,
  };
}

/**
 * Decide, purely, what alert(s) a fresh probe reading warrants.
 *
 * Edge-triggered: an alert fires only on a *transition*, never every tick.
 * - `→ unauthorized` (from ok or first reading): one `error` alert.
 * - `unauthorized → ok`: one `info` recovery alert.
 * - `ok` with `expiresAtMs` inside the warn window: one `warn` alert, once per
 *   token (re-armed when a fresh token pushes expiry back beyond the window).
 * - `unknown`: no alert, state untouched — a transient probe glitch must never
 *   flip the alarm or spam a recovery/failure notice.
 */
export function decideAuthAlarm(
  state: AuthAlarmState,
  reading: AuthProbeReading,
  opts: AuthAlarmDecideOptions,
): AuthAlarmDecision {
  // Fail-open: an inconclusive probe leaves the alarm exactly as it was.
  if (reading.auth === "unknown") {
    return { alerts: [], nextState: state };
  }

  const alerts: AlertEnvelope[] = [];
  const nextState: AuthAlarmState = { ...state };

  if (reading.auth === "unauthorized") {
    if (state.lastAuth !== "unauthorized") {
      alerts.push(invalidAlert());
    }
    nextState.lastAuth = "unauthorized";
    // Leave expiryWarned as-is: a dead token has nothing to pre-warn about, and
    // preserving the flag avoids a spurious re-warn if it briefly recovers.
    return { alerts, nextState };
  }

  // reading.auth === "ok"
  if (state.lastAuth === "unauthorized") {
    alerts.push(recoveredAlert());
  }
  nextState.lastAuth = "ok";

  if (reading.expiresAtMs !== null) {
    const msLeft = reading.expiresAtMs - opts.nowMs;
    if (msLeft > 0 && msLeft <= opts.expiryWarnMs) {
      if (!state.expiryWarned) {
        const hoursLeft = Math.max(1, Math.ceil(msLeft / 3_600_000));
        alerts.push(expiryAlert(hoursLeft));
        nextState.expiryWarned = true;
      }
    } else if (msLeft > opts.expiryWarnMs) {
      // A freshly-refreshed token pushed expiry back beyond the window — re-arm
      // so the next approach to expiry warns again.
      nextState.expiryWarned = false;
    }
  }

  return { alerts, nextState };
}
