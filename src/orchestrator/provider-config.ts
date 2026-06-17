/**
 * Provider configuration for the orchestrator worker-executor layer.
 *
 * Each provider entry declares the base URL for its OpenAI-compatible
 * chat/completions endpoint and the environment variable name that holds
 * the API key.
 *
 * BaseUrl override via env (e.g. OPENROUTER_BASE_URL) is a future concern;
 * kept simple for now — the static table is the source of truth.
 */

export interface ProviderConfig {
  /** Base URL for the provider's OpenAI-compatible API (no trailing slash). */
  baseUrl: string;
  /** Name of the environment variable that holds the API key. */
  apiKeyEnvVar: string;
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
};

/**
 * Returns the ProviderConfig for the given provider id, or `undefined` if the
 * provider is not registered.
 */
export function getProviderConfig(provider: string): ProviderConfig | undefined {
  return PROVIDER_CONFIG[provider];
}
