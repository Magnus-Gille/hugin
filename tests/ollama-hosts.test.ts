import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  configureHosts,
  resolveOllamaHost,
  getHostStatus,
  probeAllHosts,
} from "../src/ollama-hosts.js";

// Helper: build a minimal /api/tags response
function tagsResponse(models: string[]) {
  return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Reset to a clean slate before each test by reconfiguring with empty URLs
  configureHosts({ piUrl: "http://127.0.0.1:11434", laptopUrl: "", orinUrl: "" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configureHosts — orin", () => {
  it("does not add orin entry when orinUrl is empty", () => {
    configureHosts({ piUrl: "http://127.0.0.1:11434", laptopUrl: "", orinUrl: "" });
    const status = getHostStatus();
    const names = status.map((h) => h.name);
    expect(names).not.toContain("orin");
  });

  it("adds orin entry when orinUrl is set", () => {
    configureHosts({
      piUrl: "http://127.0.0.1:11434",
      laptopUrl: "",
      orinUrl: "http://100.127.176.78:11434",
    });
    const status = getHostStatus();
    const names = status.map((h) => h.name);
    expect(names).toContain("orin");
  });

  it("orin entry has the correct baseUrl", () => {
    const orinUrl = "http://100.127.176.78:11434";
    configureHosts({ piUrl: "http://127.0.0.1:11434", laptopUrl: "", orinUrl });
    const status = getHostStatus();
    const orin = status.find((h) => h.name === "orin");
    expect(orin).toBeDefined();
    expect(orin!.baseUrl).toBe(orinUrl);
  });
});

describe("resolveOllamaHost — orin preferred", () => {
  const orinUrl = "http://100.127.176.78:11434";

  it("resolves to orin host when preferred and available", async () => {
    configureHosts({
      piUrl: "http://127.0.0.1:11434",
      laptopUrl: "",
      orinUrl,
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("100.127.176.78")) {
        return tagsResponse(["qwen2.5-coder:7b"]);
      }
      return new Response("{}", { status: 503 });
    });

    const host = await resolveOllamaHost(undefined, "orin");
    expect(host).not.toBeNull();
    expect(host!.name).toBe("orin");
  });

  it("returns null when orin is preferred but unreachable", async () => {
    configureHosts({
      piUrl: "http://127.0.0.1:11434",
      laptopUrl: "",
      orinUrl,
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"));

    const host = await resolveOllamaHost(undefined, "orin");
    expect(host).toBeNull();
  });

  it("falls back through pi when orin not configured", async () => {
    configureHosts({
      piUrl: "http://127.0.0.1:11434",
      laptopUrl: "",
      orinUrl: "",
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      tagsResponse(["qwen2.5:3b"]),
    );

    const host = await resolveOllamaHost(undefined, "orin");
    // orin not in registry, falls through fallback loop, pi is available
    expect(host).not.toBeNull();
    expect(host!.name).toBe("pi");
  });
});

describe("resolveOllamaHost — orin in auto-selection order", () => {
  const orinUrl = "http://100.127.176.78:11434";

  it("auto-selects orin when it has the requested model and pi does not", async () => {
    configureHosts({
      piUrl: "http://127.0.0.1:11434",
      laptopUrl: "",
      orinUrl,
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.startsWith("http://127.0.0.1")) {
        return tagsResponse(["qwen2.5:3b"]); // pi has a different model
      }
      if (u.includes("100.127.176.78")) {
        return tagsResponse(["qwen2.5-coder:7b"]);
      }
      return new Response("{}", { status: 503 });
    });

    const host = await resolveOllamaHost("qwen2.5-coder:7b");
    expect(host).not.toBeNull();
    expect(host!.name).toBe("orin");
  });
});

describe("orin negative caching", () => {
  const orinUrl = "http://100.127.176.78:11434";

  it("uses negative cache to avoid re-probing a recently-failed orin host", async () => {
    configureHosts({
      piUrl: "http://127.0.0.1:11434",
      laptopUrl: "",
      orinUrl,
    });

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Connection refused"));

    // First probe
    await resolveOllamaHost(undefined, "orin");
    const callsAfterFirst = fetchMock.mock.calls.filter((c) => {
      const u = typeof c[0] === "string" ? c[0] : (c[0] as URL).toString();
      return u.includes("100.127.176.78");
    }).length;

    // Second probe (should be cached)
    await resolveOllamaHost(undefined, "orin");
    const callsAfterSecond = fetchMock.mock.calls.filter((c) => {
      const u = typeof c[0] === "string" ? c[0] : (c[0] as URL).toString();
      return u.includes("100.127.176.78");
    }).length;

    // Should not have probed orin again due to negative cache
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });
});

describe("probeAllHosts — includes orin when configured", () => {
  const orinUrl = "http://100.127.176.78:11434";

  it("returns orin in probeAllHosts results when configured", async () => {
    configureHosts({
      piUrl: "http://127.0.0.1:11434",
      laptopUrl: "",
      orinUrl,
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      tagsResponse(["qwen2.5-coder:7b"]),
    );

    const allHosts = await probeAllHosts();
    const names = allHosts.map((h) => h.name);
    expect(names).toContain("orin");
  });

  it("does not return orin in probeAllHosts results when not configured", async () => {
    configureHosts({
      piUrl: "http://127.0.0.1:11434",
      laptopUrl: "",
      orinUrl: "",
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      tagsResponse(["qwen2.5:3b"]),
    );

    const allHosts = await probeAllHosts();
    const names = allHosts.map((h) => h.name);
    expect(names).not.toContain("orin");
  });
});
