/**
 * Ollama host resolution with lazy discovery and negative caching.
 *
 * Pi-local ollama is treated as static. Laptop (or other remote hosts)
 * are resolved lazily at task execution time with short connect timeouts
 * and negative-cache backoff to avoid noise when hosts are offline.
 */

export interface OllamaHost {
  name: string;
  baseUrl: string;
  available: boolean;
  models: string[];
  lastChecked: number; // Date.now()
  lastError?: string;
}

export interface OllamaHostsConfig {
  piUrl: string;
  laptopUrl: string; // empty string = disabled
}

const CONNECT_TIMEOUT_MS = 3_000;
const NEGATIVE_CACHE_MS = 5 * 60 * 1_000; // 5 minutes
const POSITIVE_CACHE_MS = 60 * 1_000; // 1 minute

const hosts = new Map<string, OllamaHost>();

let hostsConfig: OllamaHostsConfig = {
  piUrl: "http://127.0.0.1:11434",
  laptopUrl: "",
};

export function configureHosts(config: OllamaHostsConfig): void {
  hostsConfig = config;
  // Initialize host entries
  hosts.set("pi", {
    name: "pi",
    baseUrl: config.piUrl,
    available: false,
    models: [],
    lastChecked: 0,
  });
  if (config.laptopUrl) {
    hosts.set("laptop", {
      name: "laptop",
      baseUrl: config.laptopUrl,
      available: false,
      models: [],
      lastChecked: 0,
    });
  }
}

async function probeHost(host: OllamaHost): Promise<OllamaHost> {
  const now = Date.now();

  // Check cache: skip probe if recently checked
  if (host.lastChecked > 0) {
    const elapsed = now - host.lastChecked;
    if (host.available && elapsed < POSITIVE_CACHE_MS) return host;
    if (!host.available && elapsed < NEGATIVE_CACHE_MS) return host;
  }

  try {
    const res = await fetch(`${host.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });

    if (!res.ok) {
      host.available = false;
      host.models = [];
      host.lastChecked = now;
      host.lastError = `HTTP ${res.status}`;
      return host;
    }

    const data = (await res.json()) as { models?: Array<{ name: string }> };
    host.available = true;
    host.models = (data.models || []).map((m) => m.name);
    host.lastChecked = now;
    host.lastError = undefined;
  } catch (err) {
    host.available = false;
    host.models = [];
    host.lastChecked = now;
    host.lastError = err instanceof Error ? err.message : String(err);
  }

  return host;
}

/**
 * Resolve the best available ollama host for a given model and preference.
 *
 * Returns null if no suitable host is available.
 */
export async function resolveOllamaHost(
  model?: string,
  preferredHost?: string,
): Promise<OllamaHost | null> {
  // If a specific host is requested, try it first
  if (preferredHost) {
    const host = hosts.get(preferredHost);
    if (host) {
      const probed = await probeHost(host);
      if (probed.available) {
        if (!model || probed.models.some((m) => m === model || m.startsWith(model + ":"))) {
          return probed;
        }
      }
      // Preferred host unavailable or doesn't have the model — fall through
    }
  }

  // Try all hosts in priority order: pi first (always-on), then laptop
  const order = ["pi", "laptop"];
  for (const name of order) {
    const host = hosts.get(name);
    if (!host) continue;

    const probed = await probeHost(host);
    if (!probed.available) continue;

    // If no model specified, any available host works
    if (!model) return probed;

    // Check if the host has the requested model
    if (probed.models.some((m) => m === model || m.startsWith(model + ":"))) {
      return probed;
    }
  }

  return null;
}

/**
 * Probe all known hosts and return fresh status.
 * Use this before routing decisions that depend on availability.
 */
export async function probeAllHosts(): Promise<OllamaHost[]> {
  const entries = Array.from(hosts.values());
  await Promise.all(entries.map((h) => probeHost(h)));
  return entries;
}

/**
 * Get current status of all known hosts (for health/debug endpoint).
 */
export function getHostStatus(): OllamaHost[] {
  return Array.from(hosts.values());
}
