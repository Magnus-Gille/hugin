import { describe, it, expect } from "vitest";
import {
  PROVIDER_CONFIG,
  getProviderConfig,
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
