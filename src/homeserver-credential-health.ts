const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_WINDOW_MS = 7 * DAY_MS;

export type HomeserverCredentialState = "ok" | "expiring" | "expired" | "unknown";

export interface HomeserverCredentialHealth {
  expires_at: string | null;
  days_remaining: number | null;
  state: HomeserverCredentialState;
}

function unknownHealth(): HomeserverCredentialHealth {
  return {
    expires_at: null,
    days_remaining: null,
    state: "unknown",
  };
}

/**
 * Build the content-blind health projection for the homeserver gateway key.
 * Invalid values deliberately degrade to `unknown`; health must never prevent
 * the dispatcher from starting.
 */
export function buildHomeserverCredentialHealth(
  raw: string | undefined,
  now: Date | number = Date.now(),
): HomeserverCredentialHealth {
  const value = raw?.trim();
  if (!value) return unknownHealth();
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return unknownHealth();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    return unknownHealth();
  }

  const expiresAtMs = Date.parse(value);
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return unknownHealth();

  const remainingMs = expiresAtMs - nowMs;
  return {
    expires_at: value,
    days_remaining: Math.ceil(remainingMs / DAY_MS),
    state:
      remainingMs <= 0
        ? "expired"
        : remainingMs < EXPIRING_WINDOW_MS
          ? "expiring"
          : "ok",
  };
}

export const HOMESERVER_CREDENTIAL_WARNING_INTERVAL_MS = 60 * 60 * 1000;
