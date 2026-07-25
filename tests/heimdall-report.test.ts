import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildPushPanels,
  toPushPanel,
  startHeimdallPanelReporter,
} from "../src/heimdall-report.js";
import type { TypedPanel } from "../src/learning-loop-health.js";

// ---------------------------------------------------------------------------
// toPushPanel / buildPushPanels — pure conversion from descriptor-shaped
// TypedPanel to the Heimdall POST /api/panels envelope (#57 contract).
// ---------------------------------------------------------------------------

describe("toPushPanel", () => {
  it("maps a table panel to a push envelope keyed by service=hugin", () => {
    const panel: TypedPanel = {
      id: "hugin-capability-evidence",
      label: "M5 capability evidence",
      kind: "table",
      fullWidth: true,
      refresh: 300,
      cols: ["Task type", "Model"],
      rows: [{ "Task type": "summarize", Model: "gpt-oss-120b" }],
    };
    expect(toPushPanel(panel)).toEqual({
      service: "hugin",
      panel: "hugin-capability-evidence",
      label: "M5 capability evidence",
      kind: "table",
      cols: ["Task type", "Model"],
      rows: [{ "Task type": "summarize", Model: "gpt-oss-120b" }],
    });
  });

  it("strips descriptor-only fields (fullWidth, refresh) — not part of the push envelope", () => {
    const panel: TypedPanel = {
      id: "hugin-route-policy",
      label: "Route policy",
      kind: "status",
      refresh: 300,
      state: "warn",
      message: "shadow mode",
    };
    const pushed = toPushPanel(panel);
    expect(pushed).not.toHaveProperty("fullWidth");
    expect(pushed).not.toHaveProperty("refresh");
    expect(pushed).not.toHaveProperty("id");
  });

  it("drops a stat panel whose value is not numeric (push path hard-rejects non-numeric stat)", () => {
    const panel: TypedPanel = {
      id: "hugin-durable-handoffs",
      label: "Durable handoffs",
      kind: "stat",
      value: "—", // unmeasured placeholder — real value in the pull-path renderer
    };
    expect(toPushPanel(panel)).toBeNull();
  });

  it("keeps a stat panel with a real numeric value", () => {
    const panel: TypedPanel = {
      id: "hugin-durable-handoffs",
      label: "Durable handoffs",
      kind: "stat",
      value: 3,
    };
    expect(toPushPanel(panel)).toMatchObject({ kind: "stat", value: 3 });
  });

  it("drops a status panel with a missing/invalid state", () => {
    const panel: TypedPanel = {
      id: "broken",
      label: "Broken",
      kind: "status",
      state: 42 as unknown as string,
    };
    expect(toPushPanel(panel)).toBeNull();
  });

  it("drops a table panel whose rows are missing", () => {
    const panel: TypedPanel = {
      id: "broken-table",
      label: "Broken table",
      kind: "table",
      cols: ["a"],
    };
    expect(toPushPanel(panel)).toBeNull();
  });
});

describe("buildPushPanels", () => {
  it("filters out unpushable panels and keeps the rest, in order", () => {
    const panels: TypedPanel[] = [
      { id: "a", label: "A", kind: "table", rows: [{ x: "1" }] },
      { id: "b", label: "B", kind: "stat", value: "—" },
      { id: "c", label: "C", kind: "status", state: "pass" },
    ];
    const pushed = buildPushPanels(panels);
    expect(pushed.map((p) => p.panel)).toEqual(["a", "c"]);
  });
});

// ---------------------------------------------------------------------------
// startHeimdallPanelReporter — env-gating and fetch calls (mirrors mimir's
// src/heimdall-report.ts pattern, the established in-fleet push convention).
// ---------------------------------------------------------------------------

describe("startHeimdallPanelReporter", () => {
  const HUB_URL = "http://hub.local/api/panels";
  const FLEET_TOKEN = "test-fleet-token";

  const onePanel = (): TypedPanel[] => [
    { id: "hugin-route-policy", label: "Route policy", kind: "status", state: "pass" },
  ];

  beforeEach(() => {
    delete process.env.HEIMDALL_HUB_URL;
    delete process.env.HEIMDALL_FLEET_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null and never calls fetch when env vars are absent", () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const cleanup = startHeimdallPanelReporter(onePanel);

    expect(cleanup).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when only HEIMDALL_HUB_URL is set", () => {
    process.env.HEIMDALL_HUB_URL = HUB_URL;
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    expect(startHeimdallPanelReporter(onePanel)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("POSTs to the configured hub URL with a Bearer token on startup", async () => {
    process.env.HEIMDALL_HUB_URL = HUB_URL;
    process.env.HEIMDALL_FLEET_TOKEN = FLEET_TOKEN;
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const cleanup = startHeimdallPanelReporter(onePanel);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HUB_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${FLEET_TOKEN}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ service: "hugin", panel: "hugin-route-policy" });

    cleanup!();
  });

  it("never throws when fetch rejects (fail-soft)", async () => {
    process.env.HEIMDALL_HUB_URL = HUB_URL;
    process.env.HEIMDALL_FLEET_TOKEN = FLEET_TOKEN;
    const mockFetch = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", mockFetch);

    const cleanup = startHeimdallPanelReporter(onePanel);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(typeof cleanup).toBe("function");
    cleanup!();
  });
});
