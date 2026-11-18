/**
 * hugin-gateway-preflight producer journey (HUGIN-388). No real network: fetch is injected.
 * Pins the closed Heimdall synthetic-journey-outcome v1 shape, the runner-vs-dependency split,
 * the content-free guarantee, idempotent same-attempt delivery retry, and (when a Heimdall
 * checkout is available) agreement with Heimdall's real validateJourneyOutcome.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  JOURNEY_ID, STEP_IDS, deliverOutcome, runPreflightAttempt, safeDeliveryUrl, validateOutcome,
  type JourneyOutcome,
} from "../src/gateway-preflight-journey.js";
import { runCli } from "../src/gateway-preflight-journey-cli.js";
import { LEARNING_TASK_CAPABILITIES } from "../src/learning-task-handshake.js";

const KEY = "gateway-key-SECRET-123";
const TOKEN = "heimdall-token-SECRET-456";
const T0 = 1_700_000_000_000;
const BASE = { gatewayUrl: "http://gateway.test:8080", gatewayKey: KEY, version: "hugin@1.2.3" };

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function clock(step = 10) {
  let t = T0;
  return () => { t += step; return t; };
}
const advert = (over: Record<string, unknown> = {}) => ({
  advertisement_id: "opaque:11111111-1111-4111-8111-111111111111",
  endpoint: "/v1/capabilities/learning-task",
  protocol_version: "learning-task-preflight/v1",
  advertised_at: new Date(T0 + 5).toISOString(),
  expires_at: new Date(T0 + 10 * 60_000).toISOString(),
  authenticated_principal_id: "service:gille-inference",
  authentication: "service-auth",
  capabilities: structuredClone(LEARNING_TASK_CAPABILITIES),
  ...over,
});
function router(map: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const handler = map[path];
    if (!handler) throw new Error(`unexpected ${path}`);
    return handler();
  }) as unknown as typeof fetch;
}
const healthy = {
  "/v1/capabilities/learning-task": () => res(200, advert()),
  "/portal/me": () => res(200, { alias: "owner-alias-private", tier: "owner", extra: "x" }),
};

describe("runPreflightAttempt", () => {
  it("passes only when both declared steps ran in one attempt", async () => {
    const o = await runPreflightAttempt({ ...BASE, now: clock(), fetchFn: router(healthy) });
    expect(o.outcome).toBe("pass");
    expect(o.runner_outcome).toBe("ok");
    expect(o.journey_id).toBe(JOURNEY_ID);
    expect(o.producer).toBe("hugin");
    expect(o.version).toBe("hugin@1.2.3");
    expect(o.steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(o.steps.every((s) => s.outcome === "pass" && s.latency_ms !== null)).toBe(true);
    expect(validateOutcome(o)).toEqual([]);
  });

  it("step failure: a 5xx preflight is a dependency failure and skips admission (partial path is never pass)", async () => {
    const fetchFn = router({ ...healthy, "/v1/capabilities/learning-task": () => res(502, {}) });
    const o = await runPreflightAttempt({ ...BASE, now: clock(), fetchFn });
    expect(o.outcome).toBe("fail");
    expect(o.runner_outcome).toBe("ok");
    expect(o.error_class).toBe("dependency-http");
    expect(o.steps[1]).toMatchObject({ id: "gateway-admission", outcome: "skipped", error_class: "blocked-by-preflight" });
    expect(validateOutcome(o)).toEqual([]);
  });

  it("partial path: preflight ok but admission failing is fail with a green first step", async () => {
    const o = await runPreflightAttempt({
      ...BASE, now: clock(),
      fetchFn: router({ ...healthy, "/portal/me": () => res(200, { alias: "a", tier: "guest" }) }),
    });
    expect(o.outcome).toBe("fail");
    expect(o.error_class).toBe("admission-denied");
    expect(o.steps[0]!.outcome).toBe("pass");
    expect(o.steps[1]).toMatchObject({ outcome: "fail", error_class: "admission-denied" });
    expect(validateOutcome(o)).toEqual([]);
  });

  it("maps downgraded, stale and partial advertisements to closed error classes", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ capabilities: { ...LEARNING_TASK_CAPABILITIES, features: [] } }, "unsupported-contract"],
      [{ extra: 1 }, "unsupported-contract"],
      [{ expires_at: new Date(T0 + 1000).toISOString() }, "stale-preflight"],
      [{ expires_at: new Date(T0 + 3_600_000).toISOString() }, "stale-preflight"],
    ];
    for (const [over, cls] of cases) {
      const o = await runPreflightAttempt({
        ...BASE, now: clock(),
        fetchFn: router({ ...healthy, "/v1/capabilities/learning-task": () => res(200, advert(over)) }),
      });
      expect(o.outcome).toBe("fail");
      expect(o.error_class).toBe(cls);
      expect(validateOutcome(o)).toEqual([]);
    }
  });

  it("auth denial on either route is a runner failure, not a gateway failure", async () => {
    for (const route of ["/v1/capabilities/learning-task", "/portal/me"]) {
      const o = await runPreflightAttempt({ ...BASE, now: clock(), fetchFn: router({ ...healthy, [route]: () => res(401, {}) }) });
      expect(o.outcome).toBe("unknown");
      expect(o.runner_outcome).toBe("failed");
      expect(o.error_class).toBe("runner-auth");
      expect(o.steps.every((s) => s.outcome === "skipped")).toBe(true);
      expect(validateOutcome(o)).toEqual([]);
    }
  });

  it("classifies a timeout and a connection failure", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const a = await runPreflightAttempt({ ...BASE, now: clock(), fetchFn: (async () => { throw timeout; }) as unknown as typeof fetch });
    expect(a.outcome).toBe("fail");
    expect(a.error_class).toBe("timeout");
    const b = await runPreflightAttempt({ ...BASE, now: clock(), fetchFn: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    expect(b.error_class).toBe("dependency-network");
  });

  it("runner failure: missing key or bad URL is runner-failed/unknown and never calls the network", async () => {
    for (const bad of [{ gatewayKey: undefined }, { gatewayKey: "  " }, { gatewayUrl: undefined }, { gatewayUrl: "ftp://x" }]) {
      const fetchFn = vi.fn() as unknown as typeof fetch;
      const o = await runPreflightAttempt({ ...BASE, ...bad, now: clock(), fetchFn });
      expect(o.runner_outcome).toBe("failed");
      expect(o.outcome).toBe("unknown");
      expect(o.error_class).toBe("runner-config");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(validateOutcome(o)).toEqual([]);
    }
  });

  it("rejects an oversize body instead of passing", async () => {
    const o = await runPreflightAttempt({
      ...BASE, now: clock(),
      fetchFn: router({ ...healthy, "/v1/capabilities/learning-task": () => res(200, { pad: "x".repeat(70_000) }) }),
    });
    expect(o.outcome).toBe("fail");
    expect(o.error_class).toBe("invalid-response");
  });

  it("is content-free: no key, alias, advertisement id or response text reaches the outcome", async () => {
    const o = await runPreflightAttempt({ ...BASE, now: clock(), fetchFn: router(healthy) });
    const text = JSON.stringify(o);
    for (const secret of [KEY, "owner-alias-private", "11111111-1111", "gateway.test", "service:gille-inference"]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(o).sort()).toEqual([
      "attempt_id", "error_class", "extensions", "journey_id", "kind", "latency_ms", "max_age_seconds",
      "observed_at", "outcome", "producer", "runner_outcome", "schema_version", "started_at", "steps",
      "trace_id", "version",
    ]);
    for (const s of o.steps) expect(Object.keys(s).sort()).toEqual(["error_class", "id", "latency_ms", "outcome"]);
  });

  it("sends only the bearer key and no body to the gateway", async () => {
    const fetchFn = router(healthy) as unknown as ReturnType<typeof vi.fn>;
    await runPreflightAttempt({ ...BASE, now: clock(), fetchFn: fetchFn as unknown as typeof fetch });
    for (const call of fetchFn.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe("error");
    }
  });
});

describe("validateOutcome (local contract mirror)", () => {
  const good = async () => runPreflightAttempt({ ...BASE, now: clock(), fetchFn: router(healthy) });
  it("rejects a pass with a skipped step, unknown fields and a fail without error class", async () => {
    const o = await good();
    expect(validateOutcome({ ...o, steps: [o.steps[0]!, { ...o.steps[1]!, outcome: "skipped" }] })).toContain("pass-consistency");
    expect(validateOutcome({ ...o, prompt: "x" } as unknown as JourneyOutcome)).toContain("unknown-field");
    expect(validateOutcome({ ...o, outcome: "fail", error_class: null })).toContain("fail-consistency");
  });
});

describe("deliverOutcome", () => {
  const URL_OK = "https://heimdall.test/api/synthetic-journeys";
  const outcomeP = () => runPreflightAttempt({ ...BASE, now: clock(), fetchFn: router(healthy), attemptId: "attempt-fixed" });

  it("posts the closed document with the bearer token and nothing else", async () => {
    const fetchFn = vi.fn(async () => res(200, { ok: true })) as unknown as typeof fetch;
    const o = await outcomeP();
    const r = await deliverOutcome(o, { url: URL_OK, token: TOKEN, fetchFn });
    expect(r).toEqual({ delivered: true, attempts: 1, status: 200 });
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual(o);
    expect(init.body as string).not.toContain(TOKEN);
    expect(init.body as string).not.toContain(KEY);
  });

  it("retry idempotence: transport errors and 5xx re-send the byte-identical document", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetchFn = vi.fn(async (_u: unknown, init: RequestInit) => {
      bodies.push(init.body as string);
      n += 1;
      if (n === 1) throw new TypeError("net");
      if (n === 2) return res(503, {});
      return res(200, {});
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);
    const r = await deliverOutcome(await outcomeP(), { url: URL_OK, token: TOKEN, fetchFn, sleep });
    expect(r.delivered).toBe(true);
    expect(r.attempts).toBe(3);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!).attempt_id).toBe("attempt-fixed");
  });

  it("4xx is final (no retry) and surfaces as a delivery failure class only", async () => {
    const fetchFn = vi.fn(async () => res(401, { error: TOKEN })) as unknown as typeof fetch;
    const r = await deliverOutcome(await outcomeP(), { url: URL_OK, token: TOKEN, fetchFn, sleep: async () => undefined });
    expect(r).toEqual({ delivered: false, attempts: 1, status: 401, error: "delivery-rejected" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("persistent 5xx is reported as not delivered after bounded retries", async () => {
    const fetchFn = vi.fn(async () => res(500, {})) as unknown as typeof fetch;
    const r = await deliverOutcome(await outcomeP(), { url: URL_OK, token: TOKEN, fetchFn, sleep: async () => undefined });
    expect(r).toMatchObject({ delivered: false, attempts: 3, error: "delivery-server-error" });
  });

  it("refuses unsafe targets and missing config without sending", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const o = await outcomeP();
    for (const url of [
      "http://heimdall.test/api/synthetic-journeys", "https://heimdall.test/other",
      "https://u:p@heimdall.test/api/synthetic-journeys", "https://heimdall.test/api/synthetic-journeys?x=1", "nonsense", undefined,
    ]) {
      expect(await deliverOutcome(o, { url, token: TOKEN, fetchFn })).toMatchObject({ delivered: false, error: "delivery-config" });
    }
    expect(await deliverOutcome(o, { url: URL_OK, token: undefined, fetchFn })).toMatchObject({ error: "delivery-config" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(safeDeliveryUrl("http://127.0.0.1:3033/api/synthetic-journeys")).toBe(true);
  });

  it("never sends a locally invalid outcome", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const o = await outcomeP();
    const r = await deliverOutcome({ ...o, outcome: "fail", error_class: null }, { url: URL_OK, token: TOKEN, fetchFn });
    expect(r).toMatchObject({ delivered: false, error: "invalid-outcome" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("runCli exit status", () => {
  const env = {
    HOMESERVER_GATEWAY_URL: "http://gateway.test:8080", HOMESERVER_GATEWAY_API_KEY: KEY,
    HEIMDALL_SYNTHETIC_JOURNEYS_URL: "https://heimdall.test/api/synthetic-journeys", HEIMDALL_HUGIN_JOURNEY_TOKEN: TOKEN,
  };
  const ok = vi.fn(async () => res(200, {})) as unknown as typeof fetch;
  const run = (e: NodeJS.ProcessEnv, gw: typeof fetch, deliver: typeof fetch) => {
    const lines: string[] = [];
    return runCli(e, { run: { fetchFn: gw, now: clock() }, deliver: { fetchFn: deliver, sleep: async () => undefined }, write: (l) => lines.push(l) })
      .then((code) => ({ code, out: lines.join("") }));
  };

  it("exits 0 for a delivered pass and for a delivered dependency failure", async () => {
    expect((await run(env, router(healthy), ok)).code).toBe(0);
    const failing = await run(env, router({ ...healthy, "/portal/me": () => res(500, {}) }), ok);
    expect(failing.code).toBe(0);
    expect(JSON.parse(failing.out)).toMatchObject({ outcome: "fail", runner_outcome: "ok", delivered: true });
  });

  it("exits non-zero on delivery failure and on runner failure, printing classes only", async () => {
    const bad = await run(env, router(healthy), vi.fn(async () => res(500, {})) as unknown as typeof fetch);
    expect(bad.code).toBe(1);
    const runner = await run({ ...env, HOMESERVER_GATEWAY_API_KEY: "" }, router(healthy), ok);
    expect(runner.code).toBe(1);
    expect(JSON.parse(runner.out)).toMatchObject({ outcome: "unknown", runner_outcome: "failed", error_class: "runner-config", delivered: true });
    for (const out of [bad.out, runner.out]) {
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(KEY);
    }
  });
});

// Cross-check against Heimdall's real validator when a checkout is available.
const heimdallPath = resolve(process.env.HEIMDALL_REPO ?? "../heimdall", "src/synthetic-journeys.js");
describe.skipIf(!existsSync(heimdallPath))("agreement with Heimdall validateJourneyOutcome", () => {
  const { validateJourneyOutcome } = createRequire(import.meta.url)(heimdallPath) as {
    validateJourneyOutcome: (v: unknown) => { ok: boolean; errors: string[] };
  };
  const failing = (over: Record<string, () => Response>) => router({ ...healthy, ...over });

  it("accepts every outcome this producer can emit", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const outcomes = await Promise.all([
      runPreflightAttempt({ ...BASE, now: clock(), fetchFn: router(healthy) }),
      runPreflightAttempt({ ...BASE, now: clock(), fetchFn: failing({ "/v1/capabilities/learning-task": () => res(503, {}) }) }),
      runPreflightAttempt({ ...BASE, now: clock(), fetchFn: failing({ "/portal/me": () => res(200, { alias: "a", tier: "guest" }) }) }),
      runPreflightAttempt({ ...BASE, now: clock(), fetchFn: failing({ "/portal/me": () => res(403, {}) }) }),
      runPreflightAttempt({ ...BASE, now: clock(), fetchFn: (async () => { throw timeout; }) as unknown as typeof fetch }),
      runPreflightAttempt({ ...BASE, gatewayKey: undefined, now: clock() }),
    ]);
    for (const o of outcomes) {
      expect(validateJourneyOutcome(o)).toEqual({ ok: true, errors: [] });
      expect(validateOutcome(o)).toEqual([]);
    }
  });

  it("agrees on rejection of tampered documents", async () => {
    const o = await runPreflightAttempt({ ...BASE, now: clock(), fetchFn: router(healthy) });
    const tampered: unknown[] = [
      { ...o, prompt: "secret" },
      { ...o, producer: "gille-inference" },
      { ...o, steps: [o.steps[0]] , outcome: "pass" },
      { ...o, steps: [{ ...o.steps[0], url: "http://x" }, o.steps[1]] },
    ];
    for (const t of tampered) {
      expect(validateJourneyOutcome(t).ok).toBe(false);
      expect(validateOutcome(t as JourneyOutcome).length).toBeGreaterThan(0);
    }
  });
});
