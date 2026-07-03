import { describe, it, expect } from "vitest";
import {
  PROVIDER_CONFIG,
  getProviderConfig,
  resolveProviderBaseUrl,
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
  it("returns the static baseUrl for providers without baseUrlEnvVar", () => {
    const cfg = PROVIDER_CONFIG["openrouter"];
    expect(resolveProviderBaseUrl(cfg, {})).toBe("https://openrouter.ai/api/v1");
  });

  it("resolves homeserver from the gateway-root env var, appending /v1", () => {
    const cfg = PROVIDER_CONFIG["homeserver"];
    expect(
      resolveProviderBaseUrl(cfg, { HOMESERVER_GATEWAY_URL: "http://100.76.72.59:8080" }),
    ).toBe("http://100.76.72.59:8080/v1");
  });

  it("strips trailing slashes from the gateway root before appending /v1", () => {
    const cfg = PROVIDER_CONFIG["homeserver"];
    expect(
      resolveProviderBaseUrl(cfg, { HOMESERVER_GATEWAY_URL: "http://gateway:8080/" }),
    ).toBe("http://gateway:8080/v1");
  });

  it("returns null when the env var is unset", () => {
    const cfg = PROVIDER_CONFIG["homeserver"];
    expect(resolveProviderBaseUrl(cfg, {})).toBeNull();
  });

  it("returns null when the env var is empty or whitespace", () => {
    const cfg = PROVIDER_CONFIG["homeserver"];
    expect(resolveProviderBaseUrl(cfg, { HOMESERVER_GATEWAY_URL: "" })).toBeNull();
    expect(resolveProviderBaseUrl(cfg, { HOMESERVER_GATEWAY_URL: "   " })).toBeNull();
  });
});
