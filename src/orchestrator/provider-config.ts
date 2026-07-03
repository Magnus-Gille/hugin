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

export type ResolvedBaseUrl =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: string };

/**
 * True when `hostname` is in operator-controlled network space: loopback,
 * RFC1918 private LAN, the CGNAT range Tailscale assigns (100.64.0.0/10),
 * IPv6 loopback/ULA/link-local, a `.ts.net` MagicDNS or `.local` mDNS name,
 * or a single-label hostname (resolvable only via local search domains).
 *
 * Public IPs and public DNS names return false. This is what keeps the
 * `homeserver` provider's sovereign/private-data standing from hinging on an
 * unvalidated env var: a gateway URL pointing at public address space is
 * rejected before any request (and never egress-allowlisted).
 */
export function isSovereignGatewayHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return false;
  if (host === "localhost" || host === "::1") return true;
  if (host.endsWith(".ts.net") || host.endsWith(".local")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / tailnet
    return false;
  }
  if (host.includes(":")) {
    // IPv6 (loopback handled above): allow ULA fc00::/7 and link-local fe80::/10.
    return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
  }
  // Single-label hostname (no dot): only resolvable on the local network.
  return !host.includes(".");
}

/**
 * Resolve the effective base URL for a provider.
 *
 * Static providers return their `baseUrl` as-is. Env-resolved providers
 * (`baseUrlEnvVar` set) read the gateway ROOT from the environment and
 * validate it before use: http(s) only, no credentials/path/query/fragment,
 * and the host must satisfy `isSovereignGatewayHost` — then trailing slashes
 * are stripped and `/v1` appended. Any failure returns `{ok: false}` with a
 * human-readable reason; callers must surface it as a configuration error
 * rather than attempting a request.
 */
export function resolveProviderBaseUrl(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBaseUrl {
  if (!config.baseUrlEnvVar) return { ok: true, baseUrl: config.baseUrl };
  const envVar = config.baseUrlEnvVar;
  const raw = env[envVar]?.trim();
  if (!raw) {
    return {
      ok: false,
      reason: `Missing base URL: environment variable ${envVar} is not set`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `Invalid ${envVar}: not a parseable URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Invalid ${envVar}: protocol must be http or https` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: `Invalid ${envVar}: credentials in the URL are not allowed` };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: `Invalid ${envVar}: query/fragment are not allowed` };
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    return {
      ok: false,
      reason: `Invalid ${envVar}: must be a gateway ROOT URL without a path (got "${parsed.pathname}"; /v1 is appended automatically)`,
    };
  }
  if (!isSovereignGatewayHost(parsed.hostname)) {
    return {
      ok: false,
      reason: `Invalid ${envVar}: host "${parsed.hostname}" is not loopback/private-LAN/tailnet — a sovereign gateway must live in operator-controlled network space`,
    };
  }
  return { ok: true, baseUrl: `${raw.replace(/\/+$/, "")}/v1` };
}
