import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HEIMDALL_DESCRIPTOR,
  registerHeimdallDescriptorRoute,
  deriveDescriptorStatus,
  readDeployedCommit,
} from "../src/heimdall-descriptor.js";

// ---------------------------------------------------------------------------
// Descriptor shape tests (no HTTP needed)
// ---------------------------------------------------------------------------

describe("HEIMDALL_DESCRIPTOR", () => {
  it("satisfies the Heimdall contract (required fields + valid shape)", () => {
    const d = HEIMDALL_DESCRIPTOR;

    // Required: service.name must be a non-empty string
    expect(typeof d.service?.name).toBe("string");
    expect(d.service.name.length).toBeGreaterThan(0);

    // kind must be one of the valid archetypes
    const ARCHETYPES = ["inference", "http-service", "timer", "static", "mcp"] as const;
    expect(ARCHETYPES).toContain(d.kind);

    // status must be a valid contract status
    const STATUSES = ["pass", "warn", "fail"] as const;
    expect(STATUSES).toContain(d.status);

    // _schema must reference the v1 service schema
    expect(typeof d._schema).toBe("string");
    expect(d._schema).toContain("/service/v1");

    // links values must be safe hrefs (root-relative or absolute https)
    const isSafeHref = (url: string) =>
      url.startsWith("/") ? !url.startsWith("//") : /^https?:\/\//i.test(url);
    for (const [key, url] of Object.entries(d.links)) {
      expect(isSafeHref(url), `links.${key} must be a safe href`).toBe(true);
    }

    // version must be a string when present
    if (d.version !== null && d.version !== undefined) {
      expect(typeof d.version).toBe("string");
    }
  });

  it("declares the Tasks and Task history panels so Heimdall renders them (Tier-1 services own their panels, #135)", () => {
    const panels = HEIMDALL_DESCRIPTOR.panels as ReadonlyArray<Record<string, unknown>>;

    // Shape must match Heimdall's descriptor panel contract
    // (heimdall src/contract/schema.js normalizePanels: id required; plugin/view/
    // label/refresh/fullWidth pass through) and the pre-#116 known-panels set.
    expect(panels).toEqual([
      { id: "hugin-tasks", plugin: "hugin", view: "tasks", label: "Tasks", refresh: 60, fullWidth: true },
      { id: "hugin-history", plugin: "hugin", view: "history", label: "Task history", refresh: 120, fullWidth: true },
    ]);
  });

  it("returns the expected static descriptor values", () => {
    expect(HEIMDALL_DESCRIPTOR).toMatchObject({
      service: {
        name: "hugin",
        label: "Hugin",
        namespace: "grimnir",
        instance_id: "huginmunin",
      },
      kind: "http-service",
      status: "pass",
      links: {
        repo: "https://github.com/Magnus-Gille/hugin",
      },
    });
    expect(HEIMDALL_DESCRIPTOR.links).toEqual({
      repo: "https://github.com/Magnus-Gille/hugin",
    });
  });
});

// ---------------------------------------------------------------------------
// deriveDescriptorStatus — pure function, no hardcoded "pass"
// ---------------------------------------------------------------------------

describe("deriveDescriptorStatus", () => {
  it("reports fail when the dispatcher poll loop is not running", () => {
    const result = deriveDescriptorStatus({
      polling: false,
      brokerConfigured: false,
      brokerDegraded: false,
      blockedTasks: 0,
    });
    expect(result.status).toBe("fail");
    expect(result.output).toMatch(/poll/i);
  });

  it("reports warn when the broker is configured but degraded", () => {
    const result = deriveDescriptorStatus({
      polling: true,
      brokerConfigured: true,
      brokerDegraded: true,
      blockedTasks: 0,
    });
    expect(result.status).toBe("warn");
    expect(result.output).toMatch(/broker/i);
  });

  it("ignores broker degradation when the broker is not configured at all", () => {
    const result = deriveDescriptorStatus({
      polling: true,
      brokerConfigured: false,
      brokerDegraded: true,
      blockedTasks: 0,
    });
    expect(result.status).toBe("pass");
  });

  it("reports warn with a finding count when tasks are blocked (ran fine, N findings — not a binary)", () => {
    const result = deriveDescriptorStatus({
      polling: true,
      brokerConfigured: true,
      brokerDegraded: false,
      blockedTasks: 3,
    });
    expect(result.status).toBe("warn");
    expect(result.output).toContain("3");
  });

  it("reports pass with no output when everything is nominal", () => {
    const result = deriveDescriptorStatus({
      polling: true,
      brokerConfigured: true,
      brokerDegraded: false,
      blockedTasks: 0,
    });
    expect(result).toEqual({ status: "pass", output: null });
  });
});

// ---------------------------------------------------------------------------
// readDeployedCommit — reads the same `.deployed-commit` stamp file Heimdall's
// drift.js reads (authoritative deploy fact, #deploy-honesty)
// ---------------------------------------------------------------------------

describe("readDeployedCommit", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no .deployed-commit file exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-descriptor-test-"));
    expect(readDeployedCommit(tmpDir)).toBeNull();
  });

  it("returns the trimmed commit sha when the stamp file is present", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-descriptor-test-"));
    const sha = "a".repeat(40);
    fs.writeFileSync(path.join(tmpDir, ".deployed-commit"), `${sha}\n`);
    expect(readDeployedCommit(tmpDir)).toBe(sha);
  });

  it("returns null for malformed stamp content rather than publishing garbage", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-descriptor-test-"));
    fs.writeFileSync(path.join(tmpDir, ".deployed-commit"), "not-a-sha\n");
    expect(readDeployedCommit(tmpDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP route test — mount only the /heimdall.json route on a minimal app
// ---------------------------------------------------------------------------

async function startMinimalApp(
  opts?: Parameters<typeof registerHeimdallDescriptorRoute>[1]
): Promise<{ url: string; close: () => void }> {
  const app = express();
  registerHeimdallDescriptorRoute(app, opts);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}

describe("GET /heimdall.json", () => {
  it("returns 200 with application/json and a valid descriptor", async () => {
    const { url, close } = await startMinimalApp();
    try {
      const res = await fetch(`${url}/heimdall.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = await res.json();
      expect(body.service?.name).toBe("hugin");
      expect(body._schema).toContain("/service/v1");
      expect(body.kind).toBe("http-service");
    } finally {
      close();
    }
  });

  it("stays within an order of magnitude of munin-memory's reference descriptor (648 bytes live)", async () => {
    const { url, close } = await startMinimalApp();
    try {
      const res = await fetch(`${url}/heimdall.json`);
      const raw = await res.text();
      // Live measurement 2026-07-25: hugin 7754B vs munin-memory 648B before
      // this change. 2000B keeps real headroom for identity/deploy/panel
      // declarations while remaining the same order of magnitude, not 12x.
      expect(raw.length).toBeLessThan(2000);
    } finally {
      close();
    }
  });

  it("does not embed the learning-loop capability-evidence table (bulk data belongs behind the panel push endpoint, not the descriptor)", async () => {
    const { url, close } = await startMinimalApp();
    try {
      const raw = await (await fetch(`${url}/heimdall.json`)).text();
      expect(raw).not.toContain("hugin-capability-evidence");
      expect(raw).not.toContain("M5 recommends");
      const body = JSON.parse(raw);
      expect(body.panels).toEqual([
        { id: "hugin-tasks", plugin: "hugin", view: "tasks", label: "Tasks", refresh: 60, fullWidth: true },
        { id: "hugin-history", plugin: "hugin", view: "history", label: "Task history", refresh: 120, fullWidth: true },
      ]);
    } finally {
      close();
    }
  });

  it("omits deployed_commit/latest_commit/drift/deployed_at rather than publishing nulls when no stamp is available", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-descriptor-test-"));
    try {
      const { url, close } = await startMinimalApp({ repoRoot: tmpDir });
      try {
        const res = await fetch(`${url}/heimdall.json`);
        const body = await res.json();
        expect(body.deploy).not.toHaveProperty("deployed_commit");
        expect(body.deploy).not.toHaveProperty("latest_commit");
        expect(body.deploy).not.toHaveProperty("drift");
        expect(body.deploy).not.toHaveProperty("deployed_at");
        // What Hugin genuinely knows about itself stays present.
        expect(body.deploy.host).toBeTruthy();
        expect(body.deploy.platform).toBeTruthy();
      } finally {
        close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("publishes a real deployed_commit when the .deployed-commit stamp is present (Hugin knows its own deployed revision)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-descriptor-test-"));
    const sha = "b".repeat(40);
    fs.writeFileSync(path.join(tmpDir, ".deployed-commit"), `${sha}\n`);
    try {
      const { url, close } = await startMinimalApp({ repoRoot: tmpDir });
      try {
        const res = await fetch(`${url}/heimdall.json`);
        const body = await res.json();
        expect(body.deploy.deployed_commit).toBe(sha);
      } finally {
        close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("derives status/output from live health input instead of a hardcoded pass", async () => {
    const { url, close } = await startMinimalApp({
      health: () => ({
        polling: true,
        brokerConfigured: true,
        brokerDegraded: true,
        blockedTasks: 0,
      }),
    });
    try {
      const res = await fetch(`${url}/heimdall.json`);
      const body = await res.json();
      expect(body.status).toBe("warn");
      expect(body.output).toMatch(/broker/i);
    } finally {
      close();
    }
  });

  it("falls back to the base pass status when no health input is wired (never breaks the route)", async () => {
    const { url, close } = await startMinimalApp();
    try {
      const res = await fetch(`${url}/heimdall.json`);
      const body = await res.json();
      expect(body.status).toBe("pass");
    } finally {
      close();
    }
  });

  it("never fails the route when the health callback throws (fail-open, #135)", async () => {
    const { url, close } = await startMinimalApp({
      health: () => {
        throw new Error("boom");
      },
    });
    try {
      const res = await fetch(`${url}/heimdall.json`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.service?.name).toBe("hugin");
    } finally {
      close();
    }
  });
});
