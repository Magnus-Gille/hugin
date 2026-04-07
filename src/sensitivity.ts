import { z } from "zod";

export const sensitivitySchema = z.enum(["public", "internal", "private"]);
export type Sensitivity = z.infer<typeof sensitivitySchema>;

const SENSITIVITY_ORDER: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  private: 2,
};

const PRIVATE_PROMPT_PATTERNS = [
  /\bpassword\b/i,
  /\bapi[- ]?key\b/i,
  /\bsecret\b/i,
  /\bbearer token\b/i,
  /\bprivate key\b/i,
  /\bmedical\b/i,
  /\bsalary\b/i,
  /\bbank\b/i,
  /\binvoice\b/i,
  /\btax\b/i,
  /\bpassport\b/i,
  /\bjournal\b/i,
  /\bdiary\b/i,
  /\bpersonal notes?\b/i,
];

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
  const stripped = stripCodeAndPaths(prompt);
  return PRIVATE_PROMPT_PATTERNS.some((pattern) => pattern.test(stripped))
    ? "private"
    : undefined;
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
  runtime: "claude" | "codex" | "ollama",
): Sensitivity {
  // Delegates to trust-tier semantics: ollama = trusted (private), cloud = semi-trusted (internal)
  switch (runtime) {
    case "ollama":
      return "private";
    case "claude":
    case "codex":
    default:
      return "internal";
  }
}

export function getPipelineRuntimeMaxSensitivity(runtimeId: string): Sensitivity {
  // Delegates to trust-tier semantics: ollama-* = trusted (private), cloud = semi-trusted (internal)
  if (runtimeId === "ollama-pi" || runtimeId === "ollama-laptop") {
    return "private";
  }
  return "internal";
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
