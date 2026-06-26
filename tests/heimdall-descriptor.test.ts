import { describe, it, expect } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HEIMDALL_DESCRIPTOR, registerHeimdallDescriptorRoute } from "../src/heimdall-descriptor.js";

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
        self: "/heimdall.json",
        health: "/health",
        repo: "https://github.com/Magnus-Gille/hugin",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP route test — mount only the /heimdall.json route on a minimal app
// ---------------------------------------------------------------------------

async function startMinimalApp(): Promise<{ url: string; close: () => void }> {
  const app = express();
  registerHeimdallDescriptorRoute(app);
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
});
