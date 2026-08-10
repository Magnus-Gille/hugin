import { describe, expect, it, vi } from "vitest";
import { waitForMuninReadiness } from "../src/experiment-cadence-readiness.js";

describe("experiment cadence Munin readiness", () => {
  it("retries boot-time unavailability before allowing the cadence tick to run", async () => {
    const health = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await waitForMuninReadiness({ health }, {
      maxAttempts: 4,
      probeTimeoutMs: 10,
      retryDelayMs: 25,
      sleep,
    });

    expect(health).toHaveBeenCalledTimes(3);
    expect(health).toHaveBeenNthCalledWith(1, { requestTimeoutMs: 10 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
  });

  it("fails after the bounded probe budget is exhausted", async () => {
    const health = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(waitForMuninReadiness({ health }, {
      maxAttempts: 3,
      probeTimeoutMs: 10,
      retryDelayMs: 25,
      sleep,
    })).rejects.toThrow("Munin readiness failed after 3 probe(s)");

    expect(health).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("bounds a health probe that never resolves", async () => {
    const health = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(() => {}))
      .mockResolvedValueOnce(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await waitForMuninReadiness({ health }, {
      maxAttempts: 2,
      probeTimeoutMs: 1,
      retryDelayMs: 0,
      sleep,
    });

    expect(health).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });
});
