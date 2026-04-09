import { z } from "zod";
import {
  RUNTIME_REGISTRY,
  getRuntimeMaxSensitivity,
  getRegistryEntryById,
} from "./runtime-registry.js";
import type { DispatcherRuntime } from "./runtime-registry.js";

export const sensitivitySchema = z.enum(["public", "internal", "private"]);
export type Sensitivity = z.infer<typeof sensitivitySchema>;

const SENSITIVITY_ORDER: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  private: 2,
};

/**
 * Unambiguous private-data keywords — any match triggers private classification.
 * These are words that do not come up in legitimate technical discussion.
 */
const ALWAYS_PRIVATE_PATTERNS = [
  /\bmedical\b/i,
  /\bsalary\b/i,
  /\bpassport\b/i,
  /\bdiary\b/i,
  /\bpersonal notes?\b/i,
];

/**
 * Credential-adjacent vocabulary. Matches actual secrets if the line is a raw
 * dump, but must be suppressed in technical discussion (research on auth
 * systems, code work on secret-handling modules, debates about API auth).
 * Matched per-line with the same technical-context suppression as
 * CONTEXT_SENSITIVE_PATTERNS.
 */
const TECHNICAL_PRIVATE_PATTERNS = [
  /\bpassword\b/i,
  /\bapi[- ]?key\b/i,
  /\bbearer token\b/i,
  /\bprivate key\b/i,
];

/**
 * Actual secret-shaped strings. These match real credentials and have near-zero
 * false-positive rate — any match is always private regardless of context.
 */
const SECRET_SHAPED_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,             // OpenAI / Anthropic API keys
  /\bghp_[A-Za-z0-9]{20,}\b/,              // GitHub personal access tokens
  /\bgho_[A-Za-z0-9]{20,}\b/,              // GitHub OAuth tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,      // GitHub fine-grained PATs
  /\bAKIA[0-9A-Z]{16}\b/,                  // AWS access keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,      // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,    // PEM private keys
];

/**
 * Keywords that appear in both private-data and technical-discussion contexts.
 * Matched per-line: suppressed when the same line contains a technical modifier.
 */
const CONTEXT_SENSITIVE_PATTERNS = [
  /\bsecret\b/i,
  /\binvoice\b/i,
  /\btax\b/i,
  /\bbank\b/i,
  /\bjournal\b/i,
];

/** Words that signal a keyword is being discussed, not contained. */
const TECHNICAL_CONTEXT = /\b(?:handling|scanning|management|rotation|module|system|API|integration|processing|calculation|architecture|endpoint|schema|service|engine|middleware|template|pipeline|detection|verification|authentication|authorization|signing|encryption|hashing|registry|configuration|systemd|SDK|CLI|framework|protocol)\b/i;

const PRIVATE_PATH_PREFIXES = [
  "/home/magnus/mimir",
  "/home/magnus/.claude",
  "/home/magnus/.codex",
  "/home/magnus/.ssh",
  "/home/magnus/.config",
];

const INTERNAL_PATH_PREFIXES = [
  "/home/magnus/repos/",
  "/home/magnus/workspace",
  "/home/magnus/scratch",
];

export interface SensitivityAssessment {
  declared?: Sensitivity;
  effective: Sensitivity;
  mismatch: boolean;
  reasons: string[];
}

export function compareSensitivity(a: Sensitivity, b: Sensitivity): number {
  return SENSITIVITY_ORDER[a] - SENSITIVITY_ORDER[b];
}

export function maxSensitivity(...values: Array<Sensitivity | undefined>): Sensitivity {
  let current: Sensitivity = "public";
  for (const value of values) {
    if (!value) continue;
    if (compareSensitivity(value, current) > 0) {
      current = value;
    }
  }
  return current;
}

export function parseSensitivity(
  value: string | undefined,
  fallback?: Sensitivity,
): Sensitivity | undefined {
  if (!value) return fallback;
  const parsed = sensitivitySchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) {
    throw new Error(`Unsupported sensitivity "${value}"`);
  }
  return parsed.data;
}

/**
 * Strip fenced code blocks, inline code, and namespace-style paths
 * so that technical references (e.g. `clients/invoices`) don't trigger
 * keyword-based sensitivity classification.
 */
function stripCodeAndPaths(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")    // fenced code blocks
    .replace(/`[^`]+`/g, "")           // inline code
    .replace(/\b[\w-]+\/[\w/*-]+/g, ""); // namespace/path patterns like clients/invoices
}

export function classifyPromptSensitivity(
  prompt: string | undefined,
): Sensitivity | undefined {
  if (!prompt) return undefined;

  // Secret-shaped strings are scanned against the RAW text, before stripping
  // code blocks — a real key pasted into a code fence is still a real key.
  if (SECRET_SHAPED_PATTERNS.some((p) => p.test(prompt))) {
    return "private";
  }

  const stripped = stripCodeAndPaths(prompt);

  // Unambiguous vocabulary — any match across the full text is private
  if (ALWAYS_PRIVATE_PATTERNS.some((p) => p.test(stripped))) {
    return "private";
  }

  // Credential-adjacent and context-sensitive keywords — check per line,
  // suppress when the same line contains a technical modifier.
  const lines = stripped.split("\n");
  for (const line of lines) {
    const hasTechnicalContext = TECHNICAL_CONTEXT.test(line);
    if (hasTechnicalContext) continue;

    if (TECHNICAL_PRIVATE_PATTERNS.some((p) => p.test(line))) {
      return "private";
    }
    if (CONTEXT_SENSITIVE_PATTERNS.some((p) => p.test(line))) {
      return "private";
    }
  }

  return undefined;
}

export function classifyContextSensitivity(
  context: string | undefined,
  workingDir: string | undefined,
): Sensitivity | undefined {
  const contextValue = context?.trim();
  if (contextValue === "files") return "private";
  if (contextValue === "scratch") return "internal";
  if (contextValue?.startsWith("repo:")) return "internal";

  const candidate = contextValue || workingDir;
  if (!candidate) return undefined;

  if (PRIVATE_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix))) {
    return "private";
  }
  if (INTERNAL_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix))) {
    return "internal";
  }

  return undefined;
}

export function muninClassificationToSensitivity(
  classification: string | undefined,
): Sensitivity | undefined {
  if (!classification) return undefined;
  const normalized = classification.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "public") return "public";
  if (normalized === "internal") return "internal";
  if (
    normalized === "private" ||
    normalized === "client-confidential" ||
    normalized === "confidential" ||
    normalized === "restricted" ||
    normalized === "secret" ||
    normalized === "sensitive" ||
    normalized === "owner-only"
  ) {
    return "private";
  }
  return "private";
}

export function namespaceFallbackSensitivity(namespace: string): Sensitivity {
  if (namespace.startsWith("people/")) return "private";
  if (
    namespace.startsWith("projects/") ||
    namespace.startsWith("decisions/") ||
    namespace.startsWith("meta/") ||
    namespace.startsWith("tasks/")
  ) {
    return "internal";
  }
  return "internal";
}

export function sensitivityToTag(sensitivity: Sensitivity): string {
  return `sensitivity:${sensitivity}`;
}

export function sensitivityToMuninClassification(
  sensitivity: Sensitivity,
): string {
  switch (sensitivity) {
    case "public":
      return "public";
    case "private":
      return "client-confidential";
    case "internal":
    default:
      return "internal";
  }
}

export function getDispatcherRuntimeMaxSensitivity(
  runtime: DispatcherRuntime,
): Sensitivity {
  const def = RUNTIME_REGISTRY.find((r) => r.dispatcherRuntime === runtime);
  if (!def) return "internal";
  return getRuntimeMaxSensitivity(def.trustTier);
}

export function getPipelineRuntimeMaxSensitivity(runtimeId: string): Sensitivity {
  const def = getRegistryEntryById(runtimeId);
  if (!def) return "internal";
  return getRuntimeMaxSensitivity(def.trustTier);
}

export function buildSensitivityAssessment(input: {
  declared?: Sensitivity;
  baseline?: Sensitivity;
  context?: Sensitivity;
  prompt?: Sensitivity;
  refs?: Sensitivity;
  inherited?: Sensitivity;
}): SensitivityAssessment {
  const baseline = input.baseline || "internal";
  const effective = maxSensitivity(
    baseline,
    input.declared,
    input.context,
    input.prompt,
    input.refs,
    input.inherited,
  );

  const reasons = [
    input.declared ? `declared:${input.declared}` : undefined,
    input.context ? `context:${input.context}` : undefined,
    input.prompt ? `prompt:${input.prompt}` : undefined,
    input.refs ? `context-refs:${input.refs}` : undefined,
    input.inherited ? `inherited:${input.inherited}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    declared: input.declared,
    effective,
    mismatch:
      Boolean(input.declared) && compareSensitivity(effective, input.declared!) > 0,
    reasons,
  };
}

export function buildSensitivityPolicyError(input: {
  runtimeLabel: string;
  runtimeMax: Sensitivity;
  effective: Sensitivity;
  deniedRef?: string;
  deniedClassification?: string;
}): string {
  if (input.deniedRef) {
    return `Context ref "${input.deniedRef}" is classified ${input.deniedClassification || input.effective}, but runtime "${input.runtimeLabel}" only allows up to ${input.runtimeMax}`;
  }
  return `Runtime "${input.runtimeLabel}" cannot execute ${input.effective}-sensitivity work (max allowed: ${input.runtimeMax})`;
}
