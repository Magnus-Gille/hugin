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
 *
 * Two layers for `sk-`: a prefix allowlist (Anthropic / OpenAI / OpenRouter)
 * and a generic entropy fallback that requires ≥32 chars plus at least one
 * uppercase letter or digit. Slugs like `sk-telemetry-auth-pipeline-id` are
 * all-lowercase and short, so they never trigger; legacy `sk-...` secrets
 * that don't match the allowlist still get caught by the entropy fallback.
 */
const SECRET_SHAPED_PATTERNS = [
  /\bsk-(?:ant|proj|svcacct|live|test|or)-[A-Za-z0-9_-]{16,}\b/, // Prefixed provider keys
  /\bsk-(?=[A-Za-z0-9_-]*[A-Z\d])[A-Za-z0-9_-]{32,}\b/,          // Generic sk- with entropy
  /\bghp_[A-Za-z0-9]{20,}\b/,              // GitHub personal access tokens
  /\bgho_[A-Za-z0-9]{20,}\b/,              // GitHub OAuth tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,      // GitHub fine-grained PATs
  /\bAKIA[0-9A-Z]{16}\b/,                  // AWS access keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,      // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,    // PEM private keys
];

/**
 * A credential keyword followed by an apparent secret value — e.g.
 * `password: hunter2`, `api key = abc123`, `bearer token is eyJ...`,
 * `the API key for prod is sk-...`. These must always classify as private,
 * even on lines that also contain technical-context words, because the
 * presence of an assignment means the prompt contains the secret itself,
 * not just a discussion of one.
 *
 * Three guardrails against round-2 Codex review findings:
 *   1. Global keyword regex + `matchAll` so every credential occurrence on
 *      the line is scanned, not just the first. Catches patterns like
 *      `API key auth design notes ... password: hunter2`.
 *   2. Newlines normalized to spaces so `API key rotation\n: abc123` and
 *      `API key for prod\nis abc123` are still caught.
 *   3. The value after the indicator must contain a digit to count as a
 *      secret. Rejects descriptive prose like `is required`, `is hashed`,
 *      `is encrypted` that would otherwise false-positive. Accepts the
 *      limitation that pure-alphabetic passwords (e.g. `swordfish`) are
 *      missed — real secrets almost always contain digits.
 */
const CREDENTIAL_KEYWORD = /\b(?:password|api[- ]?key|bearer\s+token|private\s+key)\b/gi;
const CREDENTIAL_VALUE_INDICATOR = /(?:[:=]|\bis\b)\s*(\S+)/i;
const AUTHORIZATION_HEADER_PATTERN = /\bAuthorization\s*:\s*Bearer\s+(\S+)/i;

/**
 * Detects a credential keyword followed by a placeholder value like
 * `password: $SECRET_VAR`, `api key: ${API_KEY}`, or `password: <YOUR_PASSWORD>`.
 * Lines matching this pattern are documentation/templates, not credential
 * leaks, and should be exempted from the per-line credential-keyword check.
 */
const CREDENTIAL_PLACEHOLDER_ASSIGNMENT =
  /\b(?:password|api[- ]?key|bearer\s+token|private\s+key)\b[^:=\n]{0,20}[:=]\s*(?:\$\{?[A-Za-z_]|<[A-Za-z_])/i;

/**
 * Heuristic: does `value` look like an actual secret, or is it descriptive
 * prose? Real secrets almost always contain at least one digit. Placeholder
 * syntax (`$VAR`, `${VAR}`, `<TOKEN>`) is explicitly excluded.
 */
function isSecretShapedValue(value: string | undefined): boolean {
  if (!value) return false;
  // Trim leading/trailing quotes/backticks to look at the actual token
  const stripped = value.replace(/^["'`]+|["'`]+$/g, "");
  if (!stripped) return false;
  // Common placeholder patterns — not secrets
  if (/^<[^>]*>$/.test(stripped)) return false;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(stripped)) return false;
  // Must contain at least one digit to look like a secret value
  return /\d/.test(stripped);
}

function hasCredentialAssignment(text: string): boolean {
  // Handle `Authorization: Bearer <token>` specifically — the header form
  // doesn't go through the credential-keyword loop.
  const authMatch = text.match(AUTHORIZATION_HEADER_PATTERN);
  if (authMatch && isSecretShapedValue(authMatch[1])) return true;

  // Collapse newlines so a keyword on one line and its value on the next
  // are still caught by the 60-char window.
  const normalized = text.replace(/\r?\n/g, " ");

  // Scan every credential keyword occurrence, not just the first per line.
  for (const match of normalized.matchAll(CREDENTIAL_KEYWORD)) {
    const afterKeyword = normalized.slice(
      (match.index ?? 0) + match[0].length,
    );
    const window = afterKeyword.slice(0, 60);
    const indicatorMatch = window.match(CREDENTIAL_VALUE_INDICATOR);
    if (!indicatorMatch) continue;
    if (isSecretShapedValue(indicatorMatch[1])) return true;
  }
  return false;
}

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

/**
 * Words that signal a keyword is being discussed, not contained. Includes
 * both -ing and -ed forms of the common security verbs so that descriptive
 * sentences like `the password is hashed` or `the private key is encrypted`
 * don't fall through to the per-line credential check.
 *
 * `API` stays in the list — value-bearing credential lines like
 * `my API key is abc123` are caught earlier by `hasCredentialAssignment`
 * before this suppression runs, so pure technical discussion that says
 * `API key` (e.g. `Auth model (API key? OAuth?)`) remains non-private.
 */
const TECHNICAL_CONTEXT = /\b(?:handling|handled|scanning|scanned|management|managed|rotation|rotated|module|system|API|integration|integrated|processing|processed|calculation|calculated|architecture|endpoint|schema|service|engine|middleware|template|pipeline|detection|detected|verification|verified|authentication|authenticated|authorization|authorized|signing|signed|encryption|encrypted|hashing|hashed|registry|registered|configuration|configured|systemd|SDK|CLI|framework|protocol|required|optional|generated|stored|provided|available)\b/i;

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

  // Credential assignments (`password: hunter2`, `api key = xyz`,
  // `the API key for prod is sk-...`) are also scanned against the RAW text —
  // a secret assigned inside a code fence is still a secret. They run before
  // technical-context suppression so a line like
  // `rotate auth module password: hunter2` cannot sneak past.
  if (hasCredentialAssignment(prompt)) {
    return "private";
  }

  const stripped = stripCodeAndPaths(prompt);

  // Unambiguous vocabulary — any match across the full text is private
  if (ALWAYS_PRIVATE_PATTERNS.some((p) => p.test(stripped))) {
    return "private";
  }

  // Credential-adjacent and context-sensitive keywords — check per line,
  // suppress when the same line contains a technical modifier or is a
  // placeholder-style template assignment.
  const lines = stripped.split("\n");
  for (const line of lines) {
    const hasTechnicalContext = TECHNICAL_CONTEXT.test(line);
    if (hasTechnicalContext) continue;

    // Lines like `password: $SECRET_VAR` or `api key: <YOUR_KEY>` are
    // templates/docs, not credential leaks — skip them.
    if (CREDENTIAL_PLACEHOLDER_ASSIGNMENT.test(line)) continue;

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
