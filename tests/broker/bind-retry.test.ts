import { describe, expect, it } from "vitest";
import {
  computeBrokerHealthField,
  isPermanentBindError,
  startBrokerWithRetry,
  type BrokerBindStatus,
} from "../../src/broker/bind-retry.js";
import type { BrokerServerConfig, RunningBroker } from "../../src/broker/server.js";
import { brokerExecutorCapabilities } from "../../src/broker/executor-capabilities.js";
import type { BrokerTaskStore } from "../../src/broker/task-store.js";
import type { DelegationJournal } from "../../src/broker/journal.js";
import type { IdempotencyIndex } from "../../src/broker/idempotency.js";

function eaddrnotavail(): NodeJS.ErrnoException {
  const err = new Error("bind EADDRNOTAVAIL 100.97.117.37:3035") as NodeJS.ErrnoException;
  err.code = "EADDRNOTAVAIL";
  return err;
}

function eaddrinuse(): NodeJS.ErrnoException {
  const err = new Error("bind EADDRINUSE 127.0.0.1:3035") as NodeJS.ErrnoException;
  err.code = "EADDRINUSE";
  return err;
}

function eacces(): NodeJS.ErrnoException {
  const err = new Error("bind EACCES 127.0.0.1:80") as NodeJS.ErrnoException;
  err.code = "EACCES";
  return err;
}

function fakeConfig(overrides: Partial<BrokerServerConfig> = {}): BrokerServerConfig {
  return {
    host: "100.97.117.37",
    port: 3035,
    keys: { codex: "a".repeat(64) },
    deps: {
      taskStore: {} as BrokerTaskStore,
      journal: {} as DelegationJournal,
      idempotency: {} as IdempotencyIndex,
      executorCapabilities: brokerExecutorCapabilities({ homeserverEnabled: false }),
    },
    ...overrides,
  };
}

function fakeRunningBroker(): RunningBroker {
  return {
    app: {} as RunningBroker["app"],
    server: {} as RunningBroker["server"],
    close: async () => {},
  };
}

/** Immediate no-op sleep so retry tests run without real timers/wall-clock delay. */
async function instantSleep(_ms: number): Promise<void> {}

describe("isPermanentBindError", () => {
  it("treats EADDRINUSE as permanent", () => {
    expect(isPermanentBindError(eaddrinuse())).toBe(true);
  });

  it("treats EACCES as permanent", () => {
    expect(isPermanentBindError(eacces())).toBe(true);
  });

  it("treats EADDRNOTAVAIL as not permanent (transient)", () => {
    expect(isPermanentBindError(eaddrnotavail())).toBe(false);
  });

  it("treats an error with no code as not permanent", () => {
    expect(isPermanentBindError(new Error("boom"))).toBe(false);
  });

  it("treats a non-Error thrown value as not permanent", () => {
    expect(isPermanentBindError("boom")).toBe(false);
  });
});

describe("startBrokerWithRetry — success path", () => {
  it("binds on the first attempt and reports listening", async () => {
    const statuses: BrokerBindStatus[] = [];
    const broker = fakeRunningBroker();
    const result = await startBrokerWithRetry(fakeConfig(), {
      sleep: instantSleep,
      bind: async () => broker,
      onStatus: (s) => statuses.push({ ...s }),
    });

    expect(result).toBe(broker);
    expect(statuses.map((s) => s.state)).toEqual(["starting", "listening"]);
    const last = statuses[statuses.length - 1];
    expect(last.attempts).toBe(1);
    expect(last.boundAt).toBeDefined();
  });
});

describe("startBrokerWithRetry — transient EADDRNOTAVAIL", () => {
  it("retries and succeeds once the address becomes available", async () => {
    const statuses: BrokerBindStatus[] = [];
    const logs: Array<{ level: string; message: string }> = [];
    const broker = fakeRunningBroker();
    let calls = 0;
    const result = await startBrokerWithRetry(fakeConfig(), {
      sleep: instantSleep,
      bind: async () => {
        calls++;
        if (calls < 3) throw eaddrnotavail();
        return broker;
      },
      onStatus: (s) => statuses.push({ ...s }),
      onLog: (level, message) => logs.push({ level, message }),
    });

    expect(result).toBe(broker);
    expect(calls).toBe(3);
    expect(statuses.map((s) => s.state)).toEqual([
      "starting",
      "retrying",
      "retrying",
      "listening",
    ]);
    expect(statuses[3].attempts).toBe(3);
    // Each failed attempt logged at warn (not swallowed), success at info.
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(2);
    expect(logs.filter((l) => l.level === "info" && /bound/.test(l.message))).toHaveLength(1);
    expect(logs.some((l) => l.level === "error")).toBe(false);
  });

  it("reports degradedSince from the first failure and clears on success", async () => {
    const statuses: BrokerBindStatus[] = [];
    let calls = 0;
    await startBrokerWithRetry(fakeConfig(), {
      sleep: instantSleep,
      bind: async () => {
        calls++;
        if (calls < 2) throw eaddrnotavail();
        return fakeRunningBroker();
      },
      onStatus: (s) => statuses.push({ ...s }),
    });

    const retrying = statuses.find((s) => s.state === "retrying");
    expect(retrying?.degradedSince).toBeDefined();
    const listening = statuses.find((s) => s.state === "listening");
    // Success path does not carry a stale degradedSince forward as "still degraded".
    expect(listening?.degradedSince).toBeUndefined();
  });
});

describe("startBrokerWithRetry — permanent EADDRINUSE", () => {
  it("stops after the first attempt and reports failed", async () => {
    const statuses: BrokerBindStatus[] = [];
    const logs: Array<{ level: string; message: string }> = [];
    let calls = 0;
    const result = await startBrokerWithRetry(fakeConfig(), {
      sleep: instantSleep,
      bind: async () => {
        calls++;
        throw eaddrinuse();
      },
      onStatus: (s) => statuses.push({ ...s }),
      onLog: (level, message) => logs.push({ level, message }),
    });

    expect(result).toBeNull();
    expect(calls).toBe(1); // no retry on a permanent error
    const last = statuses[statuses.length - 1];
    expect(last.state).toBe("failed");
    expect(last.lastErrorCode).toBe("EADDRINUSE");
    expect(logs.some((l) => l.level === "error" && /not retrying/.test(l.message))).toBe(true);
  });

  it("also fails fast on EACCES", async () => {
    let calls = 0;
    const result = await startBrokerWithRetry(fakeConfig(), {
      sleep: instantSleep,
      bind: async () => {
        calls++;
        throw eacces();
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("startBrokerWithRetry — bounded retry (does not retry forever)", () => {
  it("gives up after maxAttempts and reports failed", async () => {
    const statuses: BrokerBindStatus[] = [];
    let calls = 0;
    const result = await startBrokerWithRetry(fakeConfig(), {
      sleep: instantSleep,
      maxAttempts: 3,
      bind: async () => {
        calls++;
        throw eaddrnotavail();
      },
      onStatus: (s) => statuses.push({ ...s }),
    });

    expect(result).toBeNull();
    expect(calls).toBe(3);
    const last = statuses[statuses.length - 1];
    expect(last.state).toBe("failed");
    expect(last.attempts).toBe(3);
  });

  it("gives up after maxDurationMs elapses even under the attempt cap", async () => {
    let elapsedMs = 0;
    let calls = 0;
    const result = await startBrokerWithRetry(fakeConfig(), {
      sleep: instantSleep,
      maxAttempts: 1000,
      maxDurationMs: 5_000,
      now: () => {
        // Each call to now() advances the fake clock; the loop checks
        // elapsed time right after a failure, so a large jump simulates
        // "a long time passed" without a real wall-clock wait.
        elapsedMs += 3_000;
        return elapsedMs;
      },
      bind: async () => {
        calls++;
        throw eaddrnotavail();
      },
    });

    expect(result).toBeNull();
    // startedAt=3000 (first now() call), then fails once elapsed >= 5000,
    // i.e. by the 2nd attempt's elapsed check (6000-3000=3000... loop is
    // deterministic regardless of exact count; assert it terminates well
    // under the attempt cap).
    expect(calls).toBeLessThan(10);
  });
});

describe("startBrokerWithRetry — defensive sleep handling", () => {
  it("does not crash (unhandled rejection) if the injected sleep rejects, and still retries", async () => {
    let calls = 0;
    const broker = fakeRunningBroker();
    const result = await startBrokerWithRetry(fakeConfig(), {
      sleep: async () => {
        throw new Error("injected sleep failure");
      },
      bind: async () => {
        calls++;
        if (calls < 2) throw eaddrnotavail();
        return broker;
      },
    });

    expect(result).toBe(broker);
    expect(calls).toBe(2);
  });

  it("treats a rejecting sleep as elapsed even with an abort signal attached", async () => {
    const controller = new AbortController();
    let calls = 0;
    const broker = fakeRunningBroker();
    const result = await startBrokerWithRetry(fakeConfig(), {
      signal: controller.signal,
      sleep: async () => {
        throw new Error("injected sleep failure");
      },
      bind: async () => {
        calls++;
        if (calls < 2) throw eaddrnotavail();
        return broker;
      },
    });

    expect(result).toBe(broker);
    expect(calls).toBe(2);
  });
});

describe("startBrokerWithRetry — shutdown cancellation", () => {
  it("stops retrying once the signal aborts and does not bind again", async () => {
    const controller = new AbortController();
    const statuses: BrokerBindStatus[] = [];
    let calls = 0;
    const resultPromise = startBrokerWithRetry(fakeConfig(), {
      signal: controller.signal,
      sleep: async () => {
        // Abort mid-backoff, simulating shutdown arriving while a retry is pending.
        controller.abort();
      },
      bind: async () => {
        calls++;
        throw eaddrnotavail();
      },
      onStatus: (s) => statuses.push({ ...s }),
    });

    const result = await resultPromise;
    expect(result).toBeNull();
    expect(calls).toBe(1); // failed once, then the pending retry was cancelled
    expect(statuses[statuses.length - 1].state).toBe("retrying"); // no terminal "failed" from cancellation
  });

  it("does not attempt to bind at all if already aborted before the first attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await startBrokerWithRetry(fakeConfig(), {
      signal: controller.signal,
      sleep: instantSleep,
      bind: async () => {
        calls++;
        return fakeRunningBroker();
      },
    });
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("computeBrokerHealthField", () => {
  it("reports disabled when the broker is not configured", () => {
    expect(computeBrokerHealthField(false, null)).toEqual({
      configured: false,
      state: "disabled",
      listening: false,
      degraded: false,
    });
  });

  it("reports disabled even if a stale status object is passed", () => {
    // Defensive: enabled=false must win regardless of leftover status state.
    const field = computeBrokerHealthField(false, {
      state: "listening",
      host: "1.2.3.4",
      port: 1,
      attempts: 1,
    });
    expect(field.state).toBe("disabled");
    expect(field.degraded).toBe(false);
  });

  it("reports a starting default when enabled but no status has landed yet", () => {
    const field = computeBrokerHealthField(true, null);
    expect(field.configured).toBe(true);
    expect(field.state).toBe("starting");
    expect(field.listening).toBe(false);
    expect(field.degraded).toBe(false);
  });

  it("reports listening as not degraded", () => {
    const field = computeBrokerHealthField(true, {
      state: "listening",
      host: "100.97.117.37",
      port: 3035,
      attempts: 2,
      boundAt: "2026-07-20T02:41:00.000Z",
    });
    expect(field.listening).toBe(true);
    expect(field.degraded).toBe(false);
    expect(field.boundAt).toBe("2026-07-20T02:41:00.000Z");
  });

  it("reports retrying as degraded but not permanently failed", () => {
    const field = computeBrokerHealthField(true, {
      state: "retrying",
      host: "100.97.117.37",
      port: 3035,
      attempts: 1,
      lastError: "bind EADDRNOTAVAIL 100.97.117.37:3035",
      lastErrorCode: "EADDRNOTAVAIL",
      nextRetryAt: "2026-07-20T02:04:03.000Z",
      degradedSince: "2026-07-20T02:04:01.000Z",
    });
    expect(field.listening).toBe(false);
    expect(field.degraded).toBe(true);
    expect(field.lastErrorCode).toBe("EADDRNOTAVAIL");
    expect(field.nextRetryAt).toBeDefined();
  });

  it("reports failed as degraded with the permanent error surfaced", () => {
    const field = computeBrokerHealthField(true, {
      state: "failed",
      host: "127.0.0.1",
      port: 3035,
      attempts: 1,
      lastError: "bind EADDRINUSE 127.0.0.1:3035",
      lastErrorCode: "EADDRINUSE",
      degradedSince: "2026-07-20T02:04:01.000Z",
    });
    expect(field.listening).toBe(false);
    expect(field.degraded).toBe(true);
    expect(field.lastErrorCode).toBe("EADDRINUSE");
  });

  it("distinguishes disabled from failed — both are non-listening but only one is degraded", () => {
    const disabled = computeBrokerHealthField(false, null);
    const failed = computeBrokerHealthField(true, {
      state: "failed",
      host: "127.0.0.1",
      port: 3035,
      attempts: 5,
      lastErrorCode: "EADDRINUSE",
    });
    expect(disabled.listening).toBe(false);
    expect(failed.listening).toBe(false);
    expect(disabled.degraded).toBe(false);
    expect(failed.degraded).toBe(true);
    expect(disabled.state).not.toBe(failed.state);
  });
});
