import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  parseHostList,
  buildDefaultEgressHosts,
  installFetchEgressPolicy,
  extractGitRemoteHost,
  isGitRemoteAllowed,
} from "../src/egress-policy.js";

describe("parseHostList", () => {
  it("splits comma-separated hosts and normalizes", () => {
    expect(parseHostList("GitHub.com, Api.Example.COM ,localhost")).toEqual([
      "github.com",
      "api.example.com",
      "localhost",
    ]);
  });

  it("returns empty array for undefined/empty", () => {
    expect(parseHostList(undefined)).toEqual([]);
    expect(parseHostList("")).toEqual([]);
  });

  it("filters out empty segments", () => {
    expect(parseHostList("a,,b, ,c")).toEqual(["a", "b", "c"]);
  });
});

describe("buildDefaultEgressHosts", () => {
  it("always includes localhost, Anthropic, OpenAI, and GitHub hosts", () => {
    const hosts = buildDefaultEgressHosts({ muninUrl: "http://localhost:3030" });
    expect(hosts).toContain("127.0.0.1");
    expect(hosts).toContain("localhost");
    expect(hosts).toContain("::1");
    expect(hosts).toContain("api.anthropic.com");
    expect(hosts).toContain("api.openai.com");
    expect(hosts).toContain("github.com");
  });

  it("extracts hostnames from Munin and Ollama URLs", () => {
    const hosts = buildDefaultEgressHosts({
      muninUrl: "http://192.168.1.50:3030",
      ollamaPiUrl: "http://10.0.0.5:11434",
      ollamaLaptopUrl: "http://100.97.117.37:11434",
    });
    expect(hosts).toContain("192.168.1.50");
    expect(hosts).toContain("10.0.0.5");
    expect(hosts).toContain("100.97.117.37");
  });

  it("includes extra hosts and deduplicates", () => {
    const hosts = buildDefaultEgressHosts({
      muninUrl: "http://localhost:3030",
      extraHosts: ["custom.example.com", "LOCALHOST", "custom.example.com"],
    });
    expect(hosts).toContain("custom.example.com");
    // localhost already in defaults — no duplicates
    const localhostCount = hosts.filter((h) => h === "localhost").length;
    expect(localhostCount).toBe(1);
  });

  it("returns sorted list", () => {
    const hosts = buildDefaultEgressHosts({ muninUrl: "http://localhost:3030" });
    const sorted = [...hosts].sort();
    expect(hosts).toEqual(sorted);
  });

  it("handles missing optional URLs gracefully", () => {
    const hosts = buildDefaultEgressHosts({
      muninUrl: "http://localhost:3030",
      ollamaPiUrl: undefined,
      ollamaLaptopUrl: undefined,
    });
    expect(hosts.length).toBeGreaterThan(0);
  });
});

describe("extractGitRemoteHost", () => {
  it("extracts host from HTTPS URLs", () => {
    expect(extractGitRemoteHost("https://github.com/user/repo.git")).toBe(
      "github.com",
    );
  });

  it("extracts host from HTTP URLs", () => {
    expect(extractGitRemoteHost("http://gitlab.example.com/repo.git")).toBe(
      "gitlab.example.com",
    );
  });

  it("extracts host from SCP-style URLs", () => {
    expect(extractGitRemoteHost("git@github.com:user/repo.git")).toBe(
      "github.com",
    );
  });

  it("extracts host from SSH URLs with custom user", () => {
    expect(extractGitRemoteHost("deploy@gitlab.internal:team/project.git")).toBe(
      "gitlab.internal",
    );
  });

  it("returns null for empty/whitespace input", () => {
    expect(extractGitRemoteHost("")).toBeNull();
    expect(extractGitRemoteHost("   ")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(extractGitRemoteHost("not-a-url")).toBeNull();
  });

  it("normalizes to lowercase", () => {
    expect(extractGitRemoteHost("https://GitHub.COM/user/repo")).toBe(
      "github.com",
    );
    expect(extractGitRemoteHost("git@GitHub.COM:user/repo.git")).toBe(
      "github.com",
    );
  });
});

describe("isGitRemoteAllowed", () => {
  const allowedHosts = ["github.com", "*.internal.corp"];

  it("allows exact match", () => {
    expect(
      isGitRemoteAllowed("https://github.com/user/repo.git", allowedHosts),
    ).toBe(true);
  });

  it("allows wildcard match", () => {
    expect(
      isGitRemoteAllowed(
        "git@gitlab.internal.corp:team/repo.git",
        allowedHosts,
      ),
    ).toBe(true);
  });

  it("blocks unlisted hosts", () => {
    expect(
      isGitRemoteAllowed("https://evil.com/repo.git", allowedHosts),
    ).toBe(false);
  });

  it("blocks unparseable remotes", () => {
    expect(isGitRemoteAllowed("not-a-url", allowedHosts)).toBe(false);
  });
});

describe("installFetchEgressPolicy", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns policy with normalized sorted hosts", () => {
    const policy = installFetchEgressPolicy(["Localhost", "API.example.com", "localhost"]);
    expect(policy.enabled).toBe(true);
    expect(policy.allowedHosts).toEqual(["api.example.com", "localhost"]);
  });

  it("blocks HTTP requests to disallowed hosts", async () => {
    installFetchEgressPolicy(["localhost"]);
    await expect(
      globalThis.fetch("https://evil.example.com/data"),
    ).rejects.toThrow(/[Ee]gress policy denied.*evil\.example\.com/);
  });

  it("allows HTTP requests to permitted hosts", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = mockFetch;
    installFetchEgressPolicy(["api.example.com"]);

    await globalThis.fetch("https://api.example.com/v1/data");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("supports wildcard host patterns", async () => {
    installFetchEgressPolicy(["*.example.com"]);

    // Subdomain should be allowed — mock fetch so it doesn't actually connect
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    // installFetchEgressPolicy already wrapped globalThis.fetch, so we need
    // to replace the original that the wrapper delegates to
    // Instead, reinstall with a mock base
    globalThis.fetch = mockFetch;
    installFetchEgressPolicy(["*.example.com"]);

    await globalThis.fetch("https://sub.example.com/api");
    expect(mockFetch).toHaveBeenCalled();

    // Non-matching host should be blocked
    await expect(
      globalThis.fetch("https://other.com/api"),
    ).rejects.toThrow(/[Ee]gress policy denied/);
  });

  it("passes through non-HTTP protocols without blocking", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = mockFetch;
    installFetchEgressPolicy(["localhost"]);

    // data: URLs should pass through (not http/https)
    await globalThis.fetch("data:text/plain,hello");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("handles URL input as Request object", async () => {
    installFetchEgressPolicy(["localhost"]);

    const request = new Request("https://blocked.example.com/data");
    await expect(globalThis.fetch(request)).rejects.toThrow(
      /[Ee]gress policy denied/,
    );
  });

  it("handles URL input as URL object", async () => {
    installFetchEgressPolicy(["localhost"]);

    const url = new URL("https://blocked.example.com/data");
    await expect(globalThis.fetch(url)).rejects.toThrow(
      /[Ee]gress policy denied/,
    );
  });
});
