import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeExitCode,
  formatSummary,
  main,
  parseLivenessCliArgs,
  runLivenessCheck,
  type LivenessMuninReader,
} from "../src/liveness-cli.js";

const NOW = new Date("2026-09-27T12:00:00.000Z");

function isoOffset(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function heartbeatContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    worker_id: "huginmunin",
    process_instance_id: "abc123",
    polled_at: isoOffset(0),
    current_task: null,
    ...overrides,
  });
}

class FakeClient implements LivenessMuninReader {
  constructor(
    private readonly content: string | null,
    private readonly total = 0,
    private readonly readError?: Error,
  ) {}

  async read(_namespace: string, _key: string) {
    if (this.readError) throw this.readError;
    return this.content === null ? null : { content: this.content };
  }

  async query(_opts: unknown) {
    return { total: this.total };
  }
}

describe("parseLivenessCliArgs", () => {
  it("defaults poll-interval-ms from HUGIN_POLL_INTERVAL_MS or 30000", () => {
    delete process.env.HUGIN_POLL_INTERVAL_MS;
    expect(parseLivenessCliArgs([])).toEqual({ json: false, pollIntervalMs: 30_000, help: false });
  });

  it("respects HUGIN_POLL_INTERVAL_MS", () => {
    process.env.HUGIN_POLL_INTERVAL_MS = "45000";
    expect(parseLivenessCliArgs([])).toEqual({ json: false, pollIntervalMs: 45_000, help: false });
    delete process.env.HUGIN_POLL_INTERVAL_MS;
  });

  it("parses --json and --poll-interval-ms", () => {
    expect(parseLivenessCliArgs(["--json", "--poll-interval-ms", "5000"])).toEqual({
      json: true,
      pollIntervalMs: 5000,
      help: false,
    });
  });

  it("parses --help", () => {
    expect(parseLivenessCliArgs(["--help"])).toEqual({ json: false, pollIntervalMs: 30_000, help: true });
  });

  it("rejects a non-positive --poll-interval-ms", () => {
    expect(() => parseLivenessCliArgs(["--poll-interval-ms", "0"])).toThrow();
    expect(() => parseLivenessCliArgs(["--poll-interval-ms", "-5"])).toThrow();
  });

  it("rejects unknown options", () => {
    expect(() => parseLivenessCliArgs(["--bogus"])).toThrow();
  });
});

describe("runLivenessCheck", () => {
  it("reports healthy-idle for a fresh heartbeat", async () => {
    const client = new FakeClient(heartbeatContent(), 0);
    const result = await runLivenessCheck(client, { pollIntervalMs: 30_000, now: NOW });
    expect(result.state).toBe("healthy-idle");
  });

  it("reports healthy-busy when current_task is set", async () => {
    const client = new FakeClient(heartbeatContent({ current_task: "tasks/x" }), 0);
    const result = await runLivenessCheck(client, { pollIntervalMs: 30_000, now: NOW });
    expect(result.state).toBe("healthy-busy");
  });

  it("reports stale for an old heartbeat and folds in pendingCount", async () => {
    const client = new FakeClient(heartbeatContent({ polled_at: isoOffset(1_000_000) }), 4);
    const result = await runLivenessCheck(client, { pollIntervalMs: 30_000, now: NOW });
    expect(result.state).toBe("stale");
    expect(result.attention).toBe(true);
  });

  it("reports absent when no heartbeat entry exists", async () => {
    const client = new FakeClient(null, 0);
    const result = await runLivenessCheck(client, { pollIntervalMs: 30_000, now: NOW });
    expect(result.state).toBe("absent");
  });

  it("treats a query failure as unknown pendingCount rather than failing the whole check", async () => {
    const client: LivenessMuninReader = {
      read: async () => ({ content: heartbeatContent() }),
      query: async () => {
        throw new Error("query unavailable");
      },
    };
    const result = await runLivenessCheck(client, { pollIntervalMs: 30_000, now: NOW });
    expect(result.state).toBe("healthy-idle");
  });

  it("propagates a read failure (infrastructure error)", async () => {
    const client = new FakeClient(null, 0, new Error("ECONNREFUSED"));
    await expect(
      runLivenessCheck(client, { pollIntervalMs: 30_000, now: NOW }),
    ).rejects.toThrow("ECONNREFUSED");
  });
});

describe("computeExitCode", () => {
  it("returns 0 for healthy-idle and healthy-busy", () => {
    expect(computeExitCode({ state: "healthy-idle" } as never)).toBe(0);
    expect(computeExitCode({ state: "healthy-busy" } as never)).toBe(0);
  });

  it("returns 1 for stale, absent, and malformed", () => {
    expect(computeExitCode({ state: "stale" } as never)).toBe(1);
    expect(computeExitCode({ state: "absent" } as never)).toBe(1);
    expect(computeExitCode({ state: "malformed" } as never)).toBe(1);
  });
});

describe("formatSummary", () => {
  it("is a single line containing state and reason", () => {
    const client = new FakeClient(heartbeatContent());
    return runLivenessCheck(client, { pollIntervalMs: 30_000, now: NOW }).then((result) => {
      const summary = formatSummary(result);
      expect(summary.split("\n")).toHaveLength(1);
      expect(summary).toContain("healthy-idle");
    });
  });
});

describe("main (CLI exit codes with an injected client)", () => {
  beforeEach(() => {
    process.env.MUNIN_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.MUNIN_API_KEY;
  });

  it("exits 0 for a healthy worker", async () => {
    const client = new FakeClient(heartbeatContent(), 0);
    const code = await main([], { client, now: NOW });
    expect(code).toBe(0);
  });

  it("exits 1 for a stale worker", async () => {
    const client = new FakeClient(heartbeatContent({ polled_at: isoOffset(1_000_000) }), 1);
    const code = await main([], { client, now: NOW });
    expect(code).toBe(1);
  });

  it("exits 2 on a Munin infrastructure error", async () => {
    const client = new FakeClient(null, 0, new Error("network unreachable"));
    const code = await main([], { client, now: NOW });
    expect(code).toBe(2);
  });

  it("exits 2 when MUNIN_API_KEY is missing and no client is injected", async () => {
    delete process.env.MUNIN_API_KEY;
    const code = await main([]);
    expect(code).toBe(2);
  });

  it("prints JSON with --json", async () => {
    const client = new FakeClient(heartbeatContent(), 0);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await main(["--json"], { client, now: NOW });
    expect(writeSpy).toHaveBeenCalled();
    const printed = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(() => JSON.parse(printed)).not.toThrow();
    writeSpy.mockRestore();
  });
});
