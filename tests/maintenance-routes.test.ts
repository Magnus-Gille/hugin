import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { MaintenanceDrain } from "../src/maintenance-drain.js";
import {
  MAINTENANCE_TOKEN_MIN_LENGTH,
  isLoopbackAddress,
  registerMaintenanceRoutes,
} from "../src/maintenance-routes.js";
import { buildTaskSubprocessEnv } from "../src/task-subprocess-env.js";

const TOKEN = "t".repeat(MAINTENANCE_TOKEN_MIN_LENGTH);

interface Harness {
  base: string;
  drain: MaintenanceDrain;
  setCurrent: (v: string | null) => void;
  setShuttingDown: (v: boolean) => void;
  audit: string[];
}

let server: Server | undefined;

async function start(token: string | undefined | null = TOKEN): Promise<Harness> {
  let current: string | null = null;
  let shuttingDown = false;
  const audit: string[] = [];
  const drain = new MaintenanceDrain(() => current);
  const app = express();
  registerMaintenanceRoutes(app, {
    drain,
    token: token ?? undefined,
    getProcessInstanceId: () => "inst-1",
    isShuttingDown: () => shuttingDown,
    audit: (l) => audit.push(l),
  });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  const { port } = server!.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/admin/maintenance`,
    drain,
    audit,
    setCurrent: (v) => { current = v; },
    setShuttingDown: (v) => { shuttingDown = v; },
  };
}

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("maintenance routes", () => {
  it("is disabled (404) when no token or a too-short token is configured", async () => {
    for (const token of [null, "", "short"]) {
      const h = await start(token);
      const res = await fetch(h.base, { headers: auth });
      expect(res.status).toBe(404);
      expect(h.drain.snapshot().state).toBe("open");
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("rejects missing, malformed and wrong tokens without changing state", async () => {
    const h = await start();
    for (const headers of [
      {},
      { authorization: "Bearer" },
      { authorization: `Bearer ${"x".repeat(MAINTENANCE_TOKEN_MIN_LENGTH)}` },
      { authorization: `Basic ${TOKEN}` },
    ] as Array<Record<string, string>>) {
      const res = await fetch(`${h.base}/drain`, { method: "POST", headers });
      expect(res.status).toBe(401);
    }
    expect(h.drain.snapshot().state).toBe("open");
  });

  it("drains an idle dispatcher: 200, ready, with instance id and lease", async () => {
    const h = await start();
    const res = await fetch(`${h.base}/drain`, { method: "POST", headers: auth, body: "{}" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ state: "draining", ready: true, process_instance_id: "inst-1" });
    expect(body.hold_expires_at).toBeTruthy();
    expect(h.audit[0]).toContain("reversal");
    expect(h.drain.tryEnterWork()).toBe(false);
  });

  it("returns an explicit 409 busy outcome when a task is running, and does not cancel it", async () => {
    const h = await start();
    h.setCurrent("tasks/running-1");
    const res = await fetch(`${h.base}/drain`, { method: "POST", headers: auth, body: JSON.stringify({ timeout_ms: 300 }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ busy: true, ready: false, state: "draining", current_task: "tasks/running-1" });
    // Admission stays closed and the task is untouched; GET shows verifiable state.
    expect((await (await fetch(h.base, { headers: auth })).json()).state).toBe("draining");
    h.setCurrent(null);
    expect((await (await fetch(h.base, { headers: auth })).json()).ready).toBe(true);
  });

  it("resume reopens admission", async () => {
    const h = await start();
    await fetch(`${h.base}/drain`, { method: "POST", headers: auth, body: "{}" });
    const res = await fetch(`${h.base}/resume`, { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("open");
    expect(h.drain.tryEnterWork()).toBe(true);
  });

  it("validates the body strictly", async () => {
    const h = await start();
    for (const body of [
      { timeout_ms: -1 },
      { timeout_ms: 1.5 },
      { timeout_ms: "5" },
      { timeout_ms: 10 * 60_000 + 1 },
      { hold_ms: 5 },
      { hold_ms: 60 * 60_000 + 1 },
      { cancel: true },
      { timeout_ms: 5000, hold_ms: 5000 },
    ]) {
      const res = await fetch(`${h.base}/drain`, { method: "POST", headers: auth, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
    expect(h.drain.snapshot().state).toBe("open");
  });

  it("answers malformed JSON with a JSON 400 and leaves admission open", async () => {
    const h = await start();
    const res = await fetch(`${h.base}/drain`, { method: "POST", headers: auth, body: "{not json" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(h.drain.snapshot().state).toBe("open");
  });

  it("disables the surface for a token containing whitespace", async () => {
    const h = await start(`${TOKEN}\n`);
    expect((await fetch(h.base, { headers: auth })).status).toBe(404);
  });

  it("returns 503 while the process is shutting down", async () => {
    const h = await start();
    h.setShuttingDown(true);
    const res = await fetch(h.base, { headers: auth });
    expect(res.status).toBe(503);
  });
});

describe("maintenance hardening helpers", () => {
  it("accepts only loopback peers", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ["10.0.0.5", "::ffff:10.0.0.5", "", undefined]) expect(isLoopbackAddress(a)).toBe(false);
  });

  it("never forwards the maintenance token to task subprocesses", () => {
    const env = buildTaskSubprocessEnv({ PATH: "/bin", HUGIN_MAINTENANCE_TOKEN: TOKEN });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
