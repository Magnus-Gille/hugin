/**
 * Provider configuration for the orchestrator worker-executor layer.
 *
 * Each provider entry declares the base URL for its OpenAI-compatible
 * chat/completions endpoint and the environment variable name that holds
 * the API key.
 *
 * Cloud providers use a static baseUrl. Providers whose address is
 * deployment-specific (the homeserver gateway lives on a Tailscale address)
 * set `baseUrlEnvVar` instead and are resolved at request time via
 * `resolveProviderBaseUrl`.
 */

export interface ProviderConfig {
  /**
   * Base URL for the provider's OpenAI-compatible API (no trailing slash).
   * Empty when the provider is env-resolved via `baseUrlEnvVar`.
   */
  baseUrl: string;
  /** Name of the environment variable that holds the API key. */
  apiKeyEnvVar: string;
  /**
   * When set, the base URL is resolved at request time from this env var.
   * The env var holds the gateway ROOT URL (no `/v1` — same convention as
   * src/homeserver-executor.ts); trailing slashes are stripped and `/v1` is
   * appended to reach the OpenAI-compatible surface.
   */
  baseUrlEnvVar?: string;
}

export const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
  },
  berget: {
    baseUrl: "https://api.berget.ai/v1",
    apiKeyEnvVar: "BERGET_API_KEY",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnvVar: "GOOGLE_API_KEY",
  },
  // M5 local-inference gateway (ADR-004). Sovereign/local: data stays on
  // owned hardware, reached over the tailnet. Shares its env vars with the
  // standalone homeserver-executor so the Pi is configured exactly once.
  homeserver: {
    baseUrl: "",
    apiKeyEnvVar: "HOMESERVER_GATEWAY_API_KEY",
    baseUrlEnvVar: "HOMESERVER_GATEWAY_URL",
  },
};

/**
 * Returns the ProviderConfig for the given provider id, or `undefined` if the
 * provider is not registered.
 */
export function getProviderConfig(provider: string): ProviderConfig | undefined {
  return PROVIDER_CONFIG[provider];
}

/**
 * Resolve the effective base URL for a provider.
 *
 * Static providers return `baseUrl` as-is. Env-resolved providers
 * (`baseUrlEnvVar` set) read the gateway root from the environment, strip
 * trailing slashes, and append `/v1`; they return `null` when the env var is
 * unset or blank — callers must surface that as a configuration error rather
 * than attempting a request.
 */
export function resolveProviderBaseUrl(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!config.baseUrlEnvVar) return config.baseUrl;
  const raw = env[config.baseUrlEnvVar]?.trim();
  if (!raw) return null;
  return `${raw.replace(/\/+$/, "")}/v1`;
}
