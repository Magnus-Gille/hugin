import { describe, expect, it } from "vitest";
import {
  AUTH_ALARM_DEDUP_KEY,
  AUTH_EXPIRY_DEDUP_KEY,
  AUTH_EXPIRY_LIFECYCLE_VERSION,
  INITIAL_AUTH_ALARM_STATE,
  alertDeliveryCommitsTransition,
  decideAuthAlarm,
  hydratePersistedAuthAlarmState,
  type AuthAlarmState,
} from "../src/auth-alarm.js";

const NOW = 1_800_000_000_000; // fixed clock
const WARN_MS = 12 * 3_600_000; // 12h
const opts = { nowMs: NOW, expiryWarnMs: WARN_MS };

// A token that expires comfortably beyond the warn window.
const farExpiry = NOW + 30 * 3_600_000;

function currentState(
  lastAuth: AuthAlarmState["lastAuth"],
  expiryWarned: boolean,
): AuthAlarmState {
  return {
    lastAuth,
    expiryWarned,
    expiryAlertLifecycleVersion: AUTH_EXPIRY_LIFECYCLE_VERSION,
  };
}

describe("decideAuthAlarm — edge-triggered auth transitions", () => {
  it("does not alarm on a first healthy reading", () => {
    const { alerts, nextState } = decideAuthAlarm(
      INITIAL_AUTH_ALARM_STATE,
      { auth: "ok", expiresAtMs: farExpiry },
      opts,
    );
    expect(alerts).toHaveLength(0);
    expect(nextState.lastAuth).toBe("ok");
  });

  it("fires one error alert on ok → unauthorized", () => {
    const prev = currentState("ok", false);
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "unauthorized", expiresAtMs: null },
      opts,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("error");
    expect(alerts[0].dedup_key).toBe(AUTH_ALARM_DEDUP_KEY);
    expect(alerts[0].source).toBe("hugin");
    expect(nextState.lastAuth).toBe("unauthorized");
  });

  it("fires on a first-reading that is already unauthorized (startup catch)", () => {
    const { alerts } = decideAuthAlarm(
      INITIAL_AUTH_ALARM_STATE,
      { auth: "unauthorized", expiresAtMs: null },
      opts,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("error");
  });

  it("does NOT re-fire while it stays unauthorized (not repeatedly)", () => {
    const prev = currentState("unauthorized", false);
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "unauthorized", expiresAtMs: null },
      opts,
    );
    expect(alerts).toHaveLength(0);
    expect(nextState.lastAuth).toBe("unauthorized");
  });

  it("resolves the firing auth alert on confirmed unauthorized → ok", () => {
    const prev = currentState("unauthorized", false);
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "ok", expiresAtMs: farExpiry },
      opts,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual({
      state: "resolved",
      dedup_key: AUTH_ALARM_DEDUP_KEY,
    });
    expect(nextState.lastAuth).toBe("ok");
  });

  it("treats unknown as fail-open: no alert, state untouched", () => {
    const prevOk = currentState("ok", true);
    const r1 = decideAuthAlarm(prevOk, { auth: "unknown", expiresAtMs: null }, opts);
    expect(r1.alerts).toHaveLength(0);
    expect(r1.nextState).toEqual(prevOk);

    const prevDown = currentState("unauthorized", false);
    const r2 = decideAuthAlarm(prevDown, { auth: "unknown", expiresAtMs: null }, opts);
    expect(r2.alerts).toHaveLength(0);
    expect(r2.nextState).toEqual(prevDown);
  });
});

describe("decideAuthAlarm — impending-expiry warning", () => {
  it("warns once when a valid token is inside the warn window", () => {
    const prev = currentState("ok", false);
    const soon = NOW + 6 * 3_600_000; // 6h left, inside 12h window
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "ok", expiresAtMs: soon },
      opts,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("warn");
    expect(alerts[0].dedup_key).toBe(AUTH_EXPIRY_DEDUP_KEY);
    expect(alerts[0].title).toMatch(/~6h/);
    expect(nextState.expiryWarned).toBe(true);
  });

  it("does not re-warn once expiryWarned is set", () => {
    const prev = currentState("ok", true);
    const soon = NOW + 3 * 3_600_000;
    const { alerts } = decideAuthAlarm(prev, { auth: "ok", expiresAtMs: soon }, opts);
    expect(alerts).toHaveLength(0);
  });

  it("resolves and re-arms the warning when expiry moves beyond the window", () => {
    const prev = currentState("ok", true);
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "ok", expiresAtMs: farExpiry },
      opts,
    );
    expect(alerts).toEqual([{
      state: "resolved",
      dedup_key: AUTH_EXPIRY_DEDUP_KEY,
    }]);
    expect(nextState.expiryWarned).toBe(false);
  });

  it("resolves expiry only when refresh-token evidence proves hard expiry is not applicable", () => {
    const prev = currentState("ok", true);
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "unknown", expiresAtMs: null, expiryEvidence: "not-applicable" },
      opts,
    );
    expect(alerts).toEqual([{
      state: "resolved",
      dedup_key: AUTH_EXPIRY_DEDUP_KEY,
    }]);
    expect(nextState.expiryWarned).toBe(false);
    // Auth remained inconclusive; expiry evidence must not fake auth recovery.
    expect(nextState.lastAuth).toBe("ok");
  });

  it("does not clear an active expiry warning when expiresAtMs:null is unknown", () => {
    const prev = currentState("ok", true);
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "ok", expiresAtMs: null, expiryEvidence: "unknown" },
      opts,
    );
    expect(alerts).toEqual([]);
    expect(nextState.expiryWarned).toBe(true);
  });

  it("does not warn when expiry is unknown (null)", () => {
    const prev = currentState("ok", false);
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "ok", expiresAtMs: null },
      opts,
    );
    expect(alerts).toHaveLength(0);
    expect(nextState.expiryWarned).toBe(false);
  });

  it("does not warn on an already-past expiry (msLeft <= 0)", () => {
    const prev = currentState("ok", false);
    const { alerts } = decideAuthAlarm(
      prev,
      { auth: "ok", expiresAtMs: NOW - 1000 },
      opts,
    );
    expect(alerts).toHaveLength(0);
  });
});

describe("decideAuthAlarm — legacy expiry lifecycle migration", () => {
  const legacyState: AuthAlarmState = {
    lastAuth: "ok",
    expiryWarned: false,
    expiryAlertLifecycleVersion: 0,
  };

  it("reconciles a legacy false state on refresh-token not-applicable evidence", () => {
    const decision = decideAuthAlarm(
      legacyState,
      { auth: "unknown", expiresAtMs: null, expiryEvidence: "not-applicable" },
      opts,
    );

    expect(decision.alerts).toEqual([{
      state: "resolved",
      dedup_key: AUTH_EXPIRY_DEDUP_KEY,
    }]);
    expect(decision.nextState).toEqual(currentState("ok", false));
  });

  it("hydrates only an existing pre-marker state as legacy", () => {
    expect(hydratePersistedAuthAlarmState({
      lastAuth: "ok",
      expiryWarned: false,
    })).toEqual(legacyState);
    expect(hydratePersistedAuthAlarmState(currentState("ok", false))).toEqual(
      currentState("ok", false),
    );
    expect(INITIAL_AUTH_ALARM_STATE.expiryAlertLifecycleVersion).toBe(
      AUTH_EXPIRY_LIFECYCLE_VERSION,
    );
  });

  it("also reconciles a legacy false state on a known-safe distant expiry", () => {
    const decision = decideAuthAlarm(
      legacyState,
      { auth: "ok", expiresAtMs: farExpiry, expiryEvidence: "known" },
      opts,
    );

    expect(decision.alerts).toEqual([{
      state: "resolved",
      dedup_key: AUTH_EXPIRY_DEDUP_KEY,
    }]);
    expect(decision.nextState).toEqual(currentState("ok", false));
  });

  it("leaves a legacy state untouched on unknown or already-past expiry evidence", () => {
    const unknown = decideAuthAlarm(
      legacyState,
      { auth: "unknown", expiresAtMs: null, expiryEvidence: "unknown" },
      opts,
    );
    const past = decideAuthAlarm(
      legacyState,
      { auth: "ok", expiresAtMs: NOW - 1, expiryEvidence: "known" },
      opts,
    );

    expect(unknown).toEqual({ alerts: [], nextState: legacyState });
    expect(past).toEqual({ alerts: [], nextState: legacyState });
  });

  it("establishes current lifecycle ownership with a newly firing warning", () => {
    const soon = NOW + 3_600_000;
    const decision = decideAuthAlarm(
      legacyState,
      { auth: "ok", expiresAtMs: soon, expiryEvidence: "known" },
      opts,
    );

    expect(decision.alerts).toHaveLength(1);
    expect(decision.alerts[0]).toMatchObject({
      dedup_key: AUTH_EXPIRY_DEDUP_KEY,
      severity: "warn",
    });
    expect(decision.nextState).toEqual(currentState("ok", true));
  });

  it("does not claim current ownership without an external transition", () => {
    const activeLegacy = { ...legacyState, expiryWarned: true };
    const decision = decideAuthAlarm(
      activeLegacy,
      { auth: "ok", expiresAtMs: NOW + 3_600_000, expiryEvidence: "known" },
      opts,
    );

    expect(decision).toEqual({ alerts: [], nextState: activeLegacy });
  });

  it("does not send a gratuitous resolution for a brand-new current state", () => {
    const decision = decideAuthAlarm(
      INITIAL_AUTH_ALARM_STATE,
      { auth: "unknown", expiresAtMs: null, expiryEvidence: "not-applicable" },
      opts,
    );

    expect(decision.alerts).toEqual([]);
    expect(decision.nextState).toEqual(INITIAL_AUTH_ALARM_STATE);
  });

  it("becomes steady and idempotent after the delivered migration is committed", () => {
    const first = decideAuthAlarm(
      legacyState,
      { auth: "unknown", expiresAtMs: null, expiryEvidence: "not-applicable" },
      opts,
    );
    const resolution = first.alerts[0];
    expect(alertDeliveryCommitsTransition(resolution, "skipped")).toBe(false);
    expect(alertDeliveryCommitsTransition(resolution, "failed")).toBe(false);
    expect(alertDeliveryCommitsTransition(resolution, "delivered")).toBe(true);

    const steady = decideAuthAlarm(
      first.nextState,
      { auth: "unknown", expiresAtMs: null, expiryEvidence: "not-applicable" },
      opts,
    );
    expect(steady).toEqual({ alerts: [], nextState: first.nextState });
  });
});

describe("alert delivery gating", () => {
  it("retries a resolution unless Ratatoskr confirms delivery", () => {
    const resolution = { state: "resolved" as const, dedup_key: AUTH_ALARM_DEDUP_KEY };
    expect(alertDeliveryCommitsTransition(resolution, "delivered")).toBe(true);
    expect(alertDeliveryCommitsTransition(resolution, "skipped")).toBe(false);
    expect(alertDeliveryCommitsTransition(resolution, "failed")).toBe(false);
  });

  it("preserves the existing log-only terminal behavior for firing alerts", () => {
    const firing = { title: "Auth invalid", dedup_key: AUTH_ALARM_DEDUP_KEY };
    expect(alertDeliveryCommitsTransition(firing, "delivered")).toBe(true);
    expect(alertDeliveryCommitsTransition(firing, "skipped")).toBe(true);
    expect(alertDeliveryCommitsTransition(firing, "failed")).toBe(false);
  });
});
