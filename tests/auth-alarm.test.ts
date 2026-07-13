import { describe, expect, it } from "vitest";
import {
  AUTH_ALARM_DEDUP_KEY,
  AUTH_EXPIRY_DEDUP_KEY,
  INITIAL_AUTH_ALARM_STATE,
  alertDeliveryCommitsTransition,
  decideAuthAlarm,
  type AuthAlarmState,
} from "../src/auth-alarm.js";

const NOW = 1_800_000_000_000; // fixed clock
const WARN_MS = 12 * 3_600_000; // 12h
const opts = { nowMs: NOW, expiryWarnMs: WARN_MS };

// A token that expires comfortably beyond the warn window.
const farExpiry = NOW + 30 * 3_600_000;

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
    const prev: AuthAlarmState = { lastAuth: "ok", expiryWarned: false };
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
    const prev: AuthAlarmState = { lastAuth: "unauthorized", expiryWarned: false };
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "unauthorized", expiresAtMs: null },
      opts,
    );
    expect(alerts).toHaveLength(0);
    expect(nextState.lastAuth).toBe("unauthorized");
  });

  it("resolves the firing auth alert on confirmed unauthorized → ok", () => {
    const prev: AuthAlarmState = { lastAuth: "unauthorized", expiryWarned: false };
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
    const prevOk: AuthAlarmState = { lastAuth: "ok", expiryWarned: true };
    const r1 = decideAuthAlarm(prevOk, { auth: "unknown", expiresAtMs: null }, opts);
    expect(r1.alerts).toHaveLength(0);
    expect(r1.nextState).toEqual(prevOk);

    const prevDown: AuthAlarmState = { lastAuth: "unauthorized", expiryWarned: false };
    const r2 = decideAuthAlarm(prevDown, { auth: "unknown", expiresAtMs: null }, opts);
    expect(r2.alerts).toHaveLength(0);
    expect(r2.nextState).toEqual(prevDown);
  });
});

describe("decideAuthAlarm — impending-expiry warning", () => {
  it("warns once when a valid token is inside the warn window", () => {
    const prev: AuthAlarmState = { lastAuth: "ok", expiryWarned: false };
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
    const prev: AuthAlarmState = { lastAuth: "ok", expiryWarned: true };
    const soon = NOW + 3 * 3_600_000;
    const { alerts } = decideAuthAlarm(prev, { auth: "ok", expiresAtMs: soon }, opts);
    expect(alerts).toHaveLength(0);
  });

  it("resolves and re-arms the warning when expiry moves beyond the window", () => {
    const prev: AuthAlarmState = { lastAuth: "ok", expiryWarned: true };
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
    const prev: AuthAlarmState = { lastAuth: "ok", expiryWarned: true };
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
    const prev: AuthAlarmState = { lastAuth: "ok", expiryWarned: true };
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "ok", expiresAtMs: null, expiryEvidence: "unknown" },
      opts,
    );
    expect(alerts).toEqual([]);
    expect(nextState.expiryWarned).toBe(true);
  });

  it("does not warn when expiry is unknown (null)", () => {
    const prev: AuthAlarmState = { lastAuth: "ok", expiryWarned: false };
    const { alerts, nextState } = decideAuthAlarm(
      prev,
      { auth: "ok", expiresAtMs: null },
      opts,
    );
    expect(alerts).toHaveLength(0);
    expect(nextState.expiryWarned).toBe(false);
  });

  it("does not warn on an already-past expiry (msLeft <= 0)", () => {
    const prev: AuthAlarmState = { lastAuth: "ok", expiryWarned: false };
    const { alerts } = decideAuthAlarm(
      prev,
      { auth: "ok", expiresAtMs: NOW - 1000 },
      opts,
    );
    expect(alerts).toHaveLength(0);
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
