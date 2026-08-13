import { z } from "zod";
import { createHash } from "node:crypto";
import { isIP } from "node:net";

/** The deterministic minimum for every research contract. */
export const RESEARCH_REQUIRED_SEARCHES = 1;
export const RESEARCH_REQUIRED_FETCHES = 3;

export const researchGroundingFailureCodeSchema = z.enum([
  "process-failed",
  "evidence-missing",
  "evidence-invalid",
  "insufficient-searches",
  "insufficient-fetches",
  "artifact-missing",
  "artifact-no-links",
  "artifact-unsafe-url",
  "artifact-unfetched-url",
  "artifact-not-enough-links",
  "artifact-duplicate-url",
  "helper-circuit",
]);
export type ResearchGroundingFailureCode = z.infer<typeof researchGroundingFailureCodeSchema>;

function publicIpv4(octets: number[]): boolean {
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19)));
}

function parseIpv6(raw: string): number[] | null {
  const value = raw.toLowerCase();
  const pieces = value.split("::");
  if (pieces.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const parts = side.split(":");
    const output: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (part.includes(".")) {
        if (index !== parts.length - 1 || !publicIpv4(part.split(".").map(Number))) return null;
        const octets = part.split(".").map(Number);
        output.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else if (/^[0-9a-f]{1,4}$/.test(part)) output.push(Number.parseInt(part, 16));
      else return null;
    }
    return output;
  };
  const left = parseSide(pieces[0]!);
  const right = parseSide(pieces[1] ?? "");
  if (!left || !right) return null;
  if (pieces.length === 1 && left.length !== 8) return null;
  if (pieces.length === 2 && left.length + right.length >= 8) return null;
  return [...left, ...(pieces.length === 2 ? Array.from({ length: 8 - left.length - right.length }, () => 0) : []), ...right];
}

function publicIpLiteral(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(normalized) === 4) return publicIpv4(normalized.split(".").map(Number));
  if (isIP(normalized) !== 6) return true;
  const groups = parseIpv6(normalized);
  if (!groups) return false;
  const bytes = groups.flatMap((group) => [group >> 8, group & 0xff]);
  const mapped = bytes.slice(0, 10).every((value) => value === 0)
    && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return publicIpv4(bytes.slice(12));
  const unspecified = bytes.every((value) => value === 0);
  const loopback = unspecified ? false : bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1;
  const uniqueLocal = (bytes[0]! & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80;
  const multicast = bytes[0] === 0xff;
  return !unspecified && !loopback && !uniqueLocal && !linkLocal && !multicast;
}

function safePublicUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username && !parsed.password
      && publicIpLiteral(hostname)
      && hostname !== "localhost"
      && !hostname.endsWith(".local")
      && !hostname.endsWith(".ts.net");
  } catch {
    return false;
  }
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Safe persisted metadata. Raw URLs remain in the ephemeral validator only. */
export const researchGroundingFetchSchema = z.object({
  urlSha256: digestSchema,
  contentSha256: digestSchema,
});

export const researchGroundingSchema = z.object({
  version: z.literal(1),
  accepted: z.boolean(),
  requiredSearches: z.literal(RESEARCH_REQUIRED_SEARCHES),
  requiredFetches: z.literal(RESEARCH_REQUIRED_FETCHES),
  successfulSearches: z.number().int().nonnegative(),
  uniqueSuccessfulFetches: z.array(researchGroundingFetchSchema),
  artifactUrlSha256: z.record(z.string().min(1), z.array(digestSchema)),
  failureCode: researchGroundingFailureCodeSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.accepted && value.failureCode) {
    ctx.addIssue({ code: "custom", path: ["failureCode"], message: "accepted grounding cannot carry a failure code" });
  }
  if (!value.accepted && !value.failureCode) {
    ctx.addIssue({ code: "custom", path: ["failureCode"], message: "rejected grounding requires a failure code" });
  }
  if (value.accepted) {
    if (value.successfulSearches < RESEARCH_REQUIRED_SEARCHES) {
      ctx.addIssue({ code: "custom", path: ["successfulSearches"], message: "accepted grounding requires a successful search" });
    }
    if (value.uniqueSuccessfulFetches.length < RESEARCH_REQUIRED_FETCHES) {
      ctx.addIssue({ code: "custom", path: ["uniqueSuccessfulFetches"], message: "accepted grounding requires three unique fetches" });
    }
    if (new Set(value.uniqueSuccessfulFetches.map((fetch) => fetch.urlSha256)).size !== value.uniqueSuccessfulFetches.length) {
      ctx.addIssue({ code: "custom", path: ["uniqueSuccessfulFetches"], message: "accepted grounding requires unique fetched URL digests" });
    }
    if (Object.keys(value.artifactUrlSha256).length === 0) {
      ctx.addIssue({ code: "custom", path: ["artifactUrlSha256"], message: "accepted grounding requires artifact citations" });
    }
    for (const [artifactId, urls] of Object.entries(value.artifactUrlSha256)) {
      if (urls.length < RESEARCH_REQUIRED_FETCHES) {
        ctx.addIssue({ code: "custom", path: ["artifactUrlSha256", artifactId], message: "accepted artifact requires three linked sources" });
      }
      if (new Set(urls).size !== urls.length) {
        ctx.addIssue({ code: "custom", path: ["artifactUrlSha256", artifactId], message: "accepted artifact requires unique citation digests" });
      }
      const fetched = new Set(value.uniqueSuccessfulFetches.map((fetch) => fetch.urlSha256));
      if (urls.some((url) => !fetched.has(url))) {
        ctx.addIssue({ code: "custom", path: ["artifactUrlSha256", artifactId], message: "artifact citation digest was not fetched" });
      }
    }
  }
});
export type ResearchGroundingAttestation = z.infer<typeof researchGroundingSchema>;

export interface ResearchGroundingEvidence {
  version: 1;
  accepted: boolean;
  requiredSearches: typeof RESEARCH_REQUIRED_SEARCHES;
  requiredFetches: typeof RESEARCH_REQUIRED_FETCHES;
  successfulSearches: number;
  uniqueSuccessfulFetches: Array<{ url: string; contentSha256: string }>;
  artifactUrls: Record<string, string[]>;
  failureCode?: ResearchGroundingFailureCode;
  failureDiagnostic?: string;
}

export interface ResearchGroundingRecord {
  kind: "search" | "fetch" | "failure";
  url?: string;
  sha256?: string;
  code?: string;
  diagnostic?: string;
}

export function canonicalResearchUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

export function isSafePublicResearchUrl(raw: string): boolean {
  return safePublicUrl(raw);
}

export function buildResearchGroundingAttestation(evidence: ResearchGroundingEvidence): ResearchGroundingAttestation {
  const digestUrl = (url: string) => createHash("sha256").update(canonicalResearchUrl(url), "utf8").digest("hex");
  return researchGroundingSchema.parse({
    version: 1,
    accepted: evidence.accepted,
    requiredSearches: RESEARCH_REQUIRED_SEARCHES,
    requiredFetches: RESEARCH_REQUIRED_FETCHES,
    successfulSearches: evidence.successfulSearches,
    uniqueSuccessfulFetches: evidence.uniqueSuccessfulFetches.map((fetch) => ({
      urlSha256: digestUrl(fetch.url),
      contentSha256: fetch.contentSha256,
    })),
    artifactUrlSha256: Object.fromEntries(Object.entries(evidence.artifactUrls).map(([id, urls]) => [id, urls.map(digestUrl)])),
    ...(evidence.failureCode ? { failureCode: evidence.failureCode } : {}),
  });
}

export function parseResearchGroundingAttestation(raw: string): ResearchGroundingAttestation | null {
  try {
    const parsed = researchGroundingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Validate the durable attestation against the exact required task artifacts. */
export function validateResearchGroundingAttestation(
  value: unknown,
  requiredArtifactIds: readonly string[],
): ResearchGroundingAttestation | null {
  const parsed = researchGroundingSchema.safeParse(value);
  if (!parsed.success || !parsed.data.accepted) return null;
  const actual = Object.keys(parsed.data.artifactUrlSha256).sort();
  const required = [...new Set(requiredArtifactIds)].sort();
  if (actual.length !== required.length || actual.some((id, index) => id !== required[index])) return null;
  return parsed.data;
}

export const isPublicResearchIpLiteral = publicIpLiteral;

export function extractMarkdownLinks(content: string): string[] {
  const links: string[] = [];
  const pattern = /\[[^\]]+\]\(\s*(https?:\/\/[^\s)]+)(?:\s+["'][^)]*)?\)/gi;
  for (const match of content.matchAll(pattern)) {
    if (match[1]) links.push(match[1]);
  }
  return links;
}

export function extractUrls(content: string): string[] {
  return [...content.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)]
    .map((match) => match[0]!.replace(/[.,;:!?]+$/, ""));
}
