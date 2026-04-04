export interface FetchEgressPolicy {
  enabled: boolean;
  allowedHosts: string[];
}

const GITHUB_DEFAULT_HOSTS = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "uploads.github.com",
];

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

export function parseHostList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => normalizeHost(value))
    .filter(Boolean);
}

function hostFromUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return normalizeHost(new URL(raw).hostname);
  } catch {
    return null;
  }
}

function isAllowedHost(host: string, allowedHosts: string[]): boolean {
  const normalizedHost = normalizeHost(host);
  return allowedHosts.some((candidate) => {
    if (candidate.startsWith("*.")) {
      const suffix = candidate.slice(1);
      return normalizedHost.endsWith(suffix);
    }
    return normalizedHost === candidate;
  });
}

export function buildDefaultEgressHosts(input: {
  muninUrl: string;
  ollamaPiUrl?: string;
  ollamaLaptopUrl?: string;
  extraHosts?: string[];
}): string[] {
  const hosts = new Set<string>([
    "127.0.0.1",
    "localhost",
    "::1",
    "api.anthropic.com",
    "api.openai.com",
    ...GITHUB_DEFAULT_HOSTS,
    ...(input.extraHosts || []).map(normalizeHost),
  ]);

  for (const candidate of [
    input.muninUrl,
    input.ollamaPiUrl,
    input.ollamaLaptopUrl,
  ]) {
    const host = hostFromUrl(candidate);
    if (host) hosts.add(host);
  }

  return Array.from(hosts).sort();
}

export function installFetchEgressPolicy(
  allowedHosts: string[],
): FetchEgressPolicy {
  const normalizedHosts = Array.from(
    new Set(allowedHosts.map(normalizeHost).filter(Boolean)),
  ).sort();

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl);
    const protocol = url.protocol.toLowerCase();

    if (
      (protocol === "http:" || protocol === "https:") &&
      !isAllowedHost(url.hostname, normalizedHosts)
    ) {
      throw new Error(
        `Egress policy denied outbound request to host "${url.hostname}"`,
      );
    }

    return originalFetch(input, init);
  };

  return {
    enabled: true,
    allowedHosts: normalizedHosts,
  };
}

export function extractGitRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  try {
    return normalizeHost(new URL(trimmed).hostname);
  } catch {
    // fall through
  }

  const scpLikeMatch = trimmed.match(/^[^@]+@([^:]+):/);
  if (scpLikeMatch?.[1]) {
    return normalizeHost(scpLikeMatch[1]);
  }

  return null;
}

export function isGitRemoteAllowed(
  remoteUrl: string,
  allowedHosts: string[],
): boolean {
  const host = extractGitRemoteHost(remoteUrl);
  if (!host) return false;
  return isAllowedHost(host, allowedHosts);
}
