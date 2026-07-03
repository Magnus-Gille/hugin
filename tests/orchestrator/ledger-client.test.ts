import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LedgerClient } from "../../src/orchestrator/ledger-client.js";

function makeLedgerResponse(overrides: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      report: [
        {
          taskType: "summarize",
          modelId: "qwen3-30b-instruct",
          verdict: "viable",
          attempts: 10,
          passes: 9,
          fails: 1,
          errors: 0,
          successRate: 0.9,
          frozen: false,
          recommendation: "delegate-local",
        },
      ],
    }),
    ...overrides,
  } as Response;
}

describe("LedgerClient.getLedger", () => {
  beforeEach(() => {
    vi.stubEnv("HOMESERVER_GATEWAY_URL", "http://100.76.72.59:8080");
    vi.stubEnv("HOMESERVER_GATEWAY_API_KEY", "hs-test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fetches {gatewayRoot}/ledger with a bearer auth header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeLedgerResponse());
    vi.stubGlobal("fetch", fetchMock);

    const client = new LedgerClient();
    const ledger = await client.getLedger();

    expect(ledger).not.toBeNull();
    expect(ledger!.report).toHaveLength(1);
    expect(ledger!.report[0].modelId).toBe("qwen3-30b-instruct");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://100.76.72.59:8080/ledger");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer hs-test-key");
  });

  it("returns null when the gateway URL fails validation (fail-open)", async () => {
    vi.stubEnv("HOMESERVER_GATEWAY_URL", "https://public-host.example.com");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new LedgerClient();
    const ledger = await client.getLedger();

    expect(ledger).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the API key is missing (fail-open)", async () => {
    vi.stubEnv("HOMESERVER_GATEWAY_API_KEY", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new LedgerClient();
    const ledger = await client.getLedger();

    expect(ledger).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on a non-ok HTTP response (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));

    const client = new LedgerClient();
    const ledger = await client.getLedger();

    expect(ledger).toBeNull();
  });

  it("returns null when fetch throws (network error, fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const client = new LedgerClient();
    const ledger = await client.getLedger();

    expect(ledger).toBeNull();
  });

  it("returns null when the response body is not the expected shape (fail-open)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ nope: true }) } as Response),
    );

    const client = new LedgerClient();
    const ledger = await client.getLedger();

    expect(ledger).toBeNull();
  });

  it("caches the ledger within the TTL — a second call within TTL does not refetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeLedgerResponse());
    vi.stubGlobal("fetch", fetchMock);

    let now = 1_000_000;
    const client = new LedgerClient({ ttlMs: 60_000, now: () => now });

    await client.getLedger();
    now += 10_000; // still within TTL
    await client.getLedger();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeLedgerResponse());
    vi.stubGlobal("fetch", fetchMock);

    let now = 1_000_000;
    const client = new LedgerClient({ ttlMs: 60_000, now: () => now });

    await client.getLedger();
    now += 70_000; // past TTL
    await client.getLedger();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("defaults the TTL from HUGIN_ORCH_LEDGER_TTL_MS", async () => {
    vi.stubEnv("HUGIN_ORCH_LEDGER_TTL_MS", "5000");
    const fetchMock = vi.fn().mockResolvedValue(makeLedgerResponse());
    vi.stubGlobal("fetch", fetchMock);

    let now = 0;
    const client = new LedgerClient({ now: () => now });

    await client.getLedger();
    now += 4000; // within the 5000ms TTL from env
    await client.getLedger();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 2000; // now past the 5000ms TTL (total elapsed 6000ms)
    await client.getLedger();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
