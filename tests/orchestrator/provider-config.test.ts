import { describe, it, expect } from "vitest";
import {
  PROVIDER_CONFIG,
  getProviderConfig,
  resolveProviderBaseUrl,
  resolveGatewayRootUrl,
  isSovereignGatewayHost,
} from "../../src/orchestrator/provider-config.js";

describe("PROVIDER_CONFIG", () => {
  it("contains openrouter with correct values", () => {
    const cfg = PROVIDER_CONFIG["openrouter"];
    expect(cfg).toBeDefined();
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
  });

  it("contains berget with correct values", () => {
    const cfg = PROVIDER_CONFIG["berget"];
    expect(cfg).toBeDefined();
    expect(cfg.baseUrl).toBe("https://api.berget.ai/v1");
    expect(cfg.apiKeyEnvVar).toBe("BERGET_API_KEY");
  });

  it("contains homeserver with env-resolved base URL and gateway API key", () => {
    const cfg = PROVIDER_CONFIG["homeserver"];
    expect(cfg).toBeDefined();
    expect(cfg.baseUrl).toBe("");
    expect(cfg.baseUrlEnvVar).toBe("HOMESERVER_GATEWAY_URL");
    expect(cfg.apiKeyEnvVar).toBe("HOMESERVER_GATEWAY_API_KEY");
  });

  it("baseUrls do not have trailing slashes", () => {
    for (const [id, cfg] of Object.entries(PROVIDER_CONFIG)) {
      expect(cfg.baseUrl, `${id} baseUrl`).not.toMatch(/\/$/);
    }
  });
});

describe("getProviderConfig", () => {
  it("returns config for known provider", () => {
    const cfg = getProviderConfig("openrouter");
    expect(cfg).toBeDefined();
    expect(cfg!.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
  });

  it("returns config for berget", () => {
    const cfg = getProviderConfig("berget");
    expect(cfg).toBeDefined();
    expect(cfg!.baseUrl).toBe("https://api.berget.ai/v1");
  });

  it("returns undefined for unknown provider", () => {
    expect(getProviderConfig("unknown-provider")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(getProviderConfig("")).toBeUndefined();
  });
});

describe("resolveProviderBaseUrl", () => {
  const homeserver = () => PROVIDER_CONFIG["homeserver"];

  it("returns the static baseUrl for providers without baseUrlEnvVar", () => {
    const cfg = PROVIDER_CONFIG["openrouter"];
    expect(resolveProviderBaseUrl(cfg, {})).toEqual({
      ok: true,
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("resolves homeserver from the gateway-root env var, appending /v1", () => {
    expect(
      resolveProviderBaseUrl(homeserver(), { HOMESERVER_GATEWAY_URL: "http://100.76.72.59:8080" }),
    ).toEqual({ ok: true, baseUrl: "http://100.76.72.59:8080/v1" });
  });

  it("strips trailing slashes from the gateway root before appending /v1", () => {
    expect(
      resolveProviderBaseUrl(homeserver(), { HOMESERVER_GATEWAY_URL: "http://192.168.1.20:8080/" }),
    ).toEqual({ ok: true, baseUrl: "http://192.168.1.20:8080/v1" });
  });

  it("fails with a 'not set' reason when the env var is unset, empty, or whitespace", () => {
    for (const env of [{}, { HOMESERVER_GATEWAY_URL: "" }, { HOMESERVER_GATEWAY_URL: "   " }]) {
      const result = resolveProviderBaseUrl(homeserver(), env);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("HOMESERVER_GATEWAY_URL is not set");
    }
  });

  it("rejects a public host — sovereignty must not hinge on a typo'd env var", () => {
    const result = resolveProviderBaseUrl(homeserver(), {
      HOMESERVER_GATEWAY_URL: "https://example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("example.com");
  });

  it("rejects the public Cloudflare route to the gateway (not sovereign transit)", () => {
    const result = resolveProviderBaseUrl(homeserver(), {
      HOMESERVER_GATEWAY_URL: "https://inference.gille.ai",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects URLs with credentials, query, fragment, or a path", () => {
    for (const url of [
      "http://user:pw@100.76.72.59:8080",
      "http://100.76.72.59:8080?x=1",
      "http://100.76.72.59:8080#frag",
      "http://100.76.72.59:8080/api",
      "http://100.76.72.59:8080/v1",
    ]) {
      const result = resolveProviderBaseUrl(homeserver(), { HOMESERVER_GATEWAY_URL: url });
      expect(result.ok, url).toBe(false);
    }
  });

  it("rejects non-http(s) schemes and unparseable URLs", () => {
    for (const url of ["ftp://100.76.72.59:8080", "not a url"]) {
      const result = resolveProviderBaseUrl(homeserver(), { HOMESERVER_GATEWAY_URL: url });
      expect(result.ok, url).toBe(false);
    }
  });

  it("accepts loopback, RFC1918, tailnet CGNAT, .ts.net, .local, and single-label hosts", () => {
    for (const url of [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://10.0.0.5:8080",
      "http://172.16.0.1:8080",
      "http://192.168.1.5:8080",
      "http://100.64.0.1:8080",
      "http://100.127.255.254:8080",
      "http://m5:8080",
      "http://m5.tail1234.ts.net:8080",
      "http://gateway.local:8080",
    ]) {
      const result = resolveProviderBaseUrl(homeserver(), { HOMESERVER_GATEWAY_URL: url });
      expect(result.ok, url).toBe(true);
    }
  });
});

describe("resolveGatewayRootUrl (V7 — ledger client, no /v1 append)", () => {
  it("returns the gateway ROOT with no /v1 suffix", () => {
    const result = resolveGatewayRootUrl({ HOMESERVER_GATEWAY_URL: "http://100.76.72.59:8080" });
    expect(result).toEqual({ ok: true, baseUrl: "http://100.76.72.59:8080" });
  });

  it("strips a trailing slash from the gateway root", () => {
    const result = resolveGatewayRootUrl({ HOMESERVER_GATEWAY_URL: "http://192.168.1.20:8080/" });
    expect(result).toEqual({ ok: true, baseUrl: "http://192.168.1.20:8080" });
  });

  it("fails with a 'not set' reason when the env var is unset", () => {
    const result = resolveGatewayRootUrl({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("HOMESERVER_GATEWAY_URL is not set");
  });

  it("rejects a public host — sovereignty must not hinge on a typo'd env var", () => {
    const result = resolveGatewayRootUrl({ HOMESERVER_GATEWAY_URL: "https://example.com" });
    expect(result.ok).toBe(false);
  });

  it("rejects URLs with credentials, query, fragment, or a path", () => {
    for (const url of [
      "http://user:pw@100.76.72.59:8080",
      "http://100.76.72.59:8080?x=1",
      "http://100.76.72.59:8080#frag",
      "http://100.76.72.59:8080/api",
    ]) {
      const result = resolveGatewayRootUrl({ HOMESERVER_GATEWAY_URL: url });
      expect(result.ok, url).toBe(false);
    }
  });

  it("rejects non-http(s) schemes and unparseable URLs", () => {
    for (const url of ["ftp://100.76.72.59:8080", "not a url"]) {
      const result = resolveGatewayRootUrl({ HOMESERVER_GATEWAY_URL: url });
      expect(result.ok, url).toBe(false);
    }
  });

  it("accepts a tailnet host", () => {
    const result = resolveGatewayRootUrl({ HOMESERVER_GATEWAY_URL: "http://m5.tail1234.ts.net:8080" });
    expect(result.ok).toBe(true);
  });
});

describe("isSovereignGatewayHost", () => {
  it("accepts operator-controlled network space", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.31.255.255",
      "192.168.0.1",
      "100.64.0.0",
      "100.76.72.59",
      "100.127.255.255",
      "m5",
      "huginmunin",
      "box.ts.net",
      "nas.local",
      "[::1]",
      "::1",
    ]) {
      expect(isSovereignGatewayHost(host), host).toBe(true);
    }
  });

  it("rejects public IPs and public DNS names", () => {
    for (const host of [
      "8.8.8.8",
      "100.63.255.255",
      "100.128.0.0",
      "172.15.0.1",
      "172.32.0.1",
      "11.0.0.1",
      "example.com",
      "inference.gille.ai",
      "api.openai.com",
      "evil.ts.net.attacker.com",
    ]) {
      expect(isSovereignGatewayHost(host), host).toBe(false);
    }
  });
});
