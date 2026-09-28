import { describe, expect, it } from "vitest";
import {
  buildHomeserverCredentialHealth,
  type HomeserverCredentialHealth,
} from "../src/homeserver-credential-health.js";
import { app } from "../src/index.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("HOMESERVER_GATEWAY_KEY_EXPIRES_AT health state", () => {
  it("reports unknown for an absent value", () => {
    expect(buildHomeserverCredentialHealth(undefined, NOW)).toEqual({
      expires_at: null,
      days_remaining: null,
      state: "unknown",
    });
  });

  it("reports unknown for an invalid ISO value without throwing", () => {
    expect(buildHomeserverCredentialHealth("not-a-date", NOW)).toEqual({
      expires_at: null,
      days_remaining: null,
      state: "unknown",
    });
  });

  it("reports unknown for an impossible calendar date", () => {
    expect(buildHomeserverCredentialHealth("2026-02-30T12:00:00.000Z", NOW)).toEqual({
      expires_at: null,
      days_remaining: null,
      state: "unknown",
    });
  });

  it("reports ok at exactly seven days", () => {
    const expiresAt = new Date(NOW.getTime() + 7 * DAY_MS).toISOString();
    expect(buildHomeserverCredentialHealth(expiresAt, NOW)).toEqual({
      expires_at: expiresAt,
      days_remaining: 7,
      state: "ok",
    });
  });

  it("reports expiring below seven days", () => {
    const expiresAt = new Date(NOW.getTime() + 6.5 * DAY_MS).toISOString();
    expect(buildHomeserverCredentialHealth(expiresAt, NOW)).toEqual({
      expires_at: expiresAt,
      days_remaining: 7,
      state: "expiring",
    });
  });

  it("reports expired at and after the expiry instant", () => {
    const expiresAt = new Date(NOW.getTime() - 2 * DAY_MS).toISOString();
    expect(buildHomeserverCredentialHealth(expiresAt, NOW)).toEqual({
      expires_at: expiresAt,
      days_remaining: -2,
      state: "expired",
    });
  });

  it("returns a content-blind object suitable for the /health field", () => {
    const result: HomeserverCredentialHealth = buildHomeserverCredentialHealth(
      "2026-09-30T12:00:00.000Z",
      NOW,
    );
    expect(result).toEqual({
      expires_at: "2026-09-30T12:00:00.000Z",
      days_remaining: 2,
      state: "expiring",
    });
    expect(JSON.stringify(result)).not.toContain("key");
  });

  it("exposes the content-blind object on /health", async () => {
    const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = {
        method: "GET",
        url: "/health",
        originalUrl: "/health",
        headers: {},
      };
      const headers = new Map<string, unknown>();
      const response = {
        statusCode: 200,
        setHeader(name: string, value: unknown) {
          headers.set(name.toLowerCase(), value);
        },
        getHeader(name: string) {
          return headers.get(name.toLowerCase());
        },
        end(payload: string) {
          resolve(JSON.parse(payload));
        },
      };
      app.handle(request as never, response as never, reject);
    });
    expect(body.homeserver_credential).toEqual({
      expires_at: null,
      days_remaining: null,
      state: "unknown",
    });
  });
});
