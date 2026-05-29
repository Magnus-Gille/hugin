import { describe, it, expect } from "vitest";
import { decideDeliveryRetry } from "../src/task-helpers.js";

// Retry-budget logic for the `defer` delivery policy (issue #72).
const NOW = 1_700_000_000_000;
const MAX_ATTEMPTS = 10;
const MAX_AGE_MS = 86_400_000; // 24h

describe("decideDeliveryRetry (#72 defer budget)", () => {
  it("retries when both attempts and age are within budget", () => {
    const d = decideDeliveryRetry({
      attempts: 3,
      firstAttemptAtMs: NOW - 60_000,
      now: NOW,
      maxAttempts: MAX_ATTEMPTS,
      maxAgeMs: MAX_AGE_MS,
    });
    expect(d.action).toBe("retry");
    expect(d.reason).toBe("");
  });

  it("retries on the very first deferral (attempts=1)", () => {
    const d = decideDeliveryRetry({
      attempts: 1,
      firstAttemptAtMs: NOW,
      now: NOW,
      maxAttempts: MAX_ATTEMPTS,
      maxAgeMs: MAX_AGE_MS,
    });
    expect(d.action).toBe("retry");
  });

  it("exhausts when attempts reach the cap", () => {
    const d = decideDeliveryRetry({
      attempts: MAX_ATTEMPTS,
      firstAttemptAtMs: NOW - 60_000,
      now: NOW,
      maxAttempts: MAX_ATTEMPTS,
      maxAgeMs: MAX_AGE_MS,
    });
    expect(d.action).toBe("exhausted");
    expect(d.reason).toMatch(/budget exhausted/);
    expect(d.reason).toMatch(/max 10/);
  });

  it("exhausts when age exceeds max even if attempts remain", () => {
    const d = decideDeliveryRetry({
      attempts: 2,
      firstAttemptAtMs: NOW - (MAX_AGE_MS + 1_000),
      now: NOW,
      maxAttempts: MAX_ATTEMPTS,
      maxAgeMs: MAX_AGE_MS,
    });
    expect(d.action).toBe("exhausted");
    expect(d.reason).toMatch(/max age/);
  });

  it("attempts cap trips before age when both would exhaust (attempts checked first)", () => {
    const d = decideDeliveryRetry({
      attempts: MAX_ATTEMPTS,
      firstAttemptAtMs: NOW - (MAX_AGE_MS + 1_000),
      now: NOW,
      maxAttempts: MAX_ATTEMPTS,
      maxAgeMs: MAX_AGE_MS,
    });
    expect(d.action).toBe("exhausted");
    expect(d.reason).toMatch(/attempt/);
  });

  it("age boundary is inclusive (age === maxAge exhausts)", () => {
    const d = decideDeliveryRetry({
      attempts: 1,
      firstAttemptAtMs: NOW - MAX_AGE_MS,
      now: NOW,
      maxAttempts: MAX_ATTEMPTS,
      maxAgeMs: MAX_AGE_MS,
    });
    expect(d.action).toBe("exhausted");
  });
});
