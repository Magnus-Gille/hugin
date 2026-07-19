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
    vi.stubEnv("HOMESERVER_GATEWAY_URL", "http://100.64.0.42:8080");
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
    expect(url).toBe("http://100.64.0.42:8080/ledger");
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

  // -------------------------------------------------------------------------
  // Row validation (Fix #5): drop invalid rows instead of trusting the shape
  // -------------------------------------------------------------------------

  it("drops a null row but keeps otherwise-valid rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeLedgerResponse({
        json: async () => ({
          report: [
            null,
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
      } as Partial<Response>),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new LedgerClient();
    const ledger = await client.getLedger();

    expect(ledger).not.toBeNull();
    expect(ledger!.report).toHaveLength(1);
    expect(ledger!.report[0].modelId).toBe("qwen3-30b-instruct");
  });

  it("drops a row with a non-string modelId/taskType", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeLedgerResponse({
        json: async () => ({
          report: [
            { taskType: 123, modelId: "m", recommendation: "delegate-local" },
            { taskType: "summarize", modelId: 456, recommendation: "delegate-local" },
          ],
        }),
      } as Partial<Response>),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new LedgerClient();
    const ledger = await client.getLedger();

    expect(ledger).not.toBeNull();
    expect(ledger!.report).toHaveLength(0);
  });

  it("drops a row with a recommendation outside the known enum", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeLedgerResponse({
        json: async () => ({
          report: [{ taskType: "summarize", modelId: "m", recommendation: "yolo" }],
        }),
      } as Partial<Response>),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new LedgerClient();
    const ledger = await client.getLedger();

    expect(ledger).not.toBeNull();
    expect(ledger!.report).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Negative cache (Fix #5): a down gateway doesn't add a request-timeout
  // stall to every task while the negative-cache window is active.
  // -------------------------------------------------------------------------

  it("negative-caches a non-2xx response — a second call within the window does not refetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue("server error"),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    let now = 1_000_000;
    const client = new LedgerClient({ negativeTtlMs: 60_000, now: () => now });

    expect(await client.getLedger()).toBeNull();
    now += 10_000; // still within the negative-cache window
    expect(await client.getLedger()).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("consumes the response body on a non-2xx response (releases the keep-alive socket)", async () => {
    const textSpy = vi.fn().mockResolvedValue("server error");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: textSpy } as unknown as Response),
    );

    const client = new LedgerClient();
    await client.getLedger();

    expect(textSpy).toHaveBeenCalledTimes(1);
  });

  it("refetches once the negative-cache window has elapsed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue("server error"),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    let now = 1_000_000;
    const client = new LedgerClient({ negativeTtlMs: 60_000, now: () => now });

    expect(await client.getLedger()).toBeNull();
    now += 70_000; // past the negative-cache window
    expect(await client.getLedger()).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("negative-caches a network error (fetch throws) the same as a non-2xx response", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    let now = 1_000_000;
    const client = new LedgerClient({ negativeTtlMs: 60_000, now: () => now });

    expect(await client.getLedger()).toBeNull();
    now += 1_000; // within the negative-cache window
    expect(await client.getLedger()).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a successful fetch after a negative-cache window clears the negative cache (no lingering nulls)", async () => {
    let now = 1_000_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue("err") } as unknown as Response)
      .mockResolvedValueOnce(makeLedgerResponse());
    vi.stubGlobal("fetch", fetchMock);

    const client = new LedgerClient({ negativeTtlMs: 1_000, now: () => now });

    expect(await client.getLedger()).toBeNull();
    now += 2_000; // past negative TTL
    const ledger = await client.getLedger();
    expect(ledger).not.toBeNull();
    expect(ledger!.report).toHaveLength(1);
  });
});
