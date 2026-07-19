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

interface AlertEnvelopeFields {
  severity?: "info" | "warn" | "error" | "critical";
  source?: string;
  body?: string;
  ts?: string;
}

/** Matches Ratatoskr's firing/resolved AlertEnvelope contract. */
export interface FiringAlertEnvelope extends AlertEnvelopeFields {
  state?: "firing";
  title: string;
  dedup_key?: string;
}

export interface ResolvedAlertEnvelope extends AlertEnvelopeFields {
  state: "resolved";
  title?: string;
  dedup_key: string;
}

export type AlertEnvelope = FiringAlertEnvelope | ResolvedAlertEnvelope;

export type AlertDeliveryStatus = "delivered" | "skipped" | "failed";

/** Resolutions mutate external alert state and therefore require a real 2xx. */
export function alertDeliveryCommitsTransition(
  alert: AlertEnvelope,
  status: AlertDeliveryStatus,
): boolean {
  if (alert.state === "resolved") return status === "delivered";
  return status !== "failed";
}

export interface AuthProbeReading {
  auth: AuthProbeState;
  /** Token expiry (epoch ms) from the credential file, or null if unavailable. */
  expiresAtMs: number | null;
  /**
   * `not-applicable` is positive evidence that a refresh token can renew the
   * short-lived access token. `unknown` must never clear a firing warning.
   * Omitted readings retain the legacy safe default: numeric=known, null=unknown.
   */
  expiryEvidence?: "known" | "not-applicable" | "unknown";
}

/** Persisted between ticks so the alarm is edge-triggered, not repeated. */
export interface AuthAlarmState {
  /** Last CONFIRMED (non-`unknown`) auth state acted on. null = no reading yet. */
  lastAuth: "ok" | "unauthorized" | null;
  /** Whether the current token's impending-expiry warning has already fired. */
  expiryWarned: boolean;
  /**
   * Producer-owned expiry dedup lifecycle generation. Persisted legacy states
   * have no generation and hydrate as 0 so one positive safe reading can
   * reconcile an alert that predates resolved-envelope support.
   */
  expiryAlertLifecycleVersion: number;
}

export const AUTH_EXPIRY_LIFECYCLE_VERSION = 1;

export const INITIAL_AUTH_ALARM_STATE: AuthAlarmState = {
  lastAuth: null,
  expiryWarned: false,
  // No persisted state means no historical producer alert to reconcile.
  expiryAlertLifecycleVersion: AUTH_EXPIRY_LIFECYCLE_VERSION,
};

/**
 * Parse an existing persisted state. Callers intentionally invoke this only
 * when a Munin entry exists: no entry uses {@link INITIAL_AUTH_ALARM_STATE},
 * while a pre-generation entry must hydrate as legacy for one reconciliation.
 */
export function hydratePersistedAuthAlarmState(value: unknown): AuthAlarmState {
  const parsed = value && typeof value === "object"
    ? value as Partial<AuthAlarmState>
    : {};
  const rawLifecycleVersion = parsed.expiryAlertLifecycleVersion;
  return {
    lastAuth:
      parsed.lastAuth === "ok" || parsed.lastAuth === "unauthorized"
        ? parsed.lastAuth
        : null,
    expiryWarned: parsed.expiryWarned === true,
    expiryAlertLifecycleVersion:
      typeof rawLifecycleVersion === "number" &&
      Number.isSafeInteger(rawLifecycleVersion) &&
      rawLifecycleVersion >= AUTH_EXPIRY_LIFECYCLE_VERSION
        ? rawLifecycleVersion
        : 0,
  };
}

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
    state: "resolved",
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

function expiryRecoveredAlert(): AlertEnvelope {
  return {
    state: "resolved",
    dedup_key: AUTH_EXPIRY_DEDUP_KEY,
  };
}

/**
 * Decide, purely, what alert(s) a fresh probe reading warrants.
 *
 * Edge-triggered: an alert fires only on a *transition*, never every tick.
 * - `→ unauthorized` (from ok or first reading): one `error` alert.
 * - `unauthorized → ok`: resolve the auth dedup key.
 * - `ok` with `expiresAtMs` inside the warn window: one `warn` alert, once per
 *   token; resolve only on known-safe expiry or refresh-token N/A evidence.
 * - Unknown auth/expiry evidence leaves that dimension untouched.
 */
export function decideAuthAlarm(
  state: AuthAlarmState,
  reading: AuthProbeReading,
  opts: AuthAlarmDecideOptions,
): AuthAlarmDecision {
  const alerts: AlertEnvelope[] = [];
  const nextState: AuthAlarmState = { ...state };

  if (reading.auth === "unauthorized") {
    if (state.lastAuth !== "unauthorized") {
      alerts.push(invalidAlert());
    }
    nextState.lastAuth = "unauthorized";
  } else if (reading.auth === "ok") {
    if (state.lastAuth === "unauthorized") {
      alerts.push(recoveredAlert());
    }
    nextState.lastAuth = "ok";
  }

  const expiryEvidence = reading.expiryEvidence ?? (
    reading.expiresAtMs === null ? "unknown" : "known"
  );
  const expiryLifecycleCurrent =
    state.expiryAlertLifecycleVersion >= AUTH_EXPIRY_LIFECYCLE_VERSION;
  const currentExpiryLifecycleVersion = Math.max(
    state.expiryAlertLifecycleVersion || 0,
    AUTH_EXPIRY_LIFECYCLE_VERSION,
  );
  if (expiryEvidence === "not-applicable") {
    if (state.expiryWarned || !expiryLifecycleCurrent) {
      alerts.push(expiryRecoveredAlert());
    }
    nextState.expiryWarned = false;
    nextState.expiryAlertLifecycleVersion = currentExpiryLifecycleVersion;
  } else if (expiryEvidence === "known" && reading.expiresAtMs !== null) {
    const msLeft = reading.expiresAtMs - opts.nowMs;
    if (msLeft > 0 && msLeft <= opts.expiryWarnMs) {
      if (!state.expiryWarned) {
        const hoursLeft = Math.max(1, Math.ceil(msLeft / 3_600_000));
        alerts.push(expiryAlert(hoursLeft));
        nextState.expiryWarned = true;
        // A successfully committed firing transition establishes ownership of
        // the current external dedup lifecycle too.
        nextState.expiryAlertLifecycleVersion = currentExpiryLifecycleVersion;
      }
    } else if (msLeft > opts.expiryWarnMs) {
      if (state.expiryWarned || !expiryLifecycleCurrent) {
        alerts.push(expiryRecoveredAlert());
      }
      nextState.expiryWarned = false;
      nextState.expiryAlertLifecycleVersion = currentExpiryLifecycleVersion;
    }
  }

  return { alerts, nextState };
}
