/**
 * Lightweight prompt-injection scanner for context-refs.
 *
 * Flags instruction-like patterns that frequently appear in adversarial
 * prompt-injection payloads: instruction overrides, role hijacks, fenced
 * system blocks, exfiltration commands, and hidden Unicode markers. Pure
 * function — detective control only; callers decide how to react based on
 * severity (warn / block / fail via HUGIN_INJECTION_POLICY).
 *
 * See docs/security/lethal-trifecta-assessment.md §7.4.
 */

export type InjectionSeverity = "none" | "low" | "medium" | "high";

export type InjectionPatternId =
  | "instruction-override"
  | "role-hijack"
  | "system-block"
  | "exfil-command"
  | "credential-read"
  | "hidden-unicode";

export interface InjectionMatch {
  pattern: InjectionPatternId;
  severity: Exclude<InjectionSeverity, "none">;
  snippet: string;
  offset: number;
}

export interface InjectionScanResult {
  severity: InjectionSeverity;
  matches: InjectionMatch[];
}

interface PatternSpec {
  id: InjectionPatternId;
  severity: Exclude<InjectionSeverity, "none">;
  regex: RegExp;
}

const SEVERITY_RANK: Record<InjectionSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const PATTERNS: PatternSpec[] = [
  {
    id: "instruction-override",
    severity: "high",
    regex:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|the\s+|any\s+|previous\s+|prior\s+|above\s+|earlier\s+|your\s+)?(?:previous|prior|above|earlier|all|any|the|your)?\s*(?:instructions?|prompts?|rules?|directives?|system\s+prompt|guidelines?)\b/i,
  },
  {
    id: "role-hijack",
    severity: "medium",
    regex:
      /\b(?:you\s+are\s+now|you\s+must\s+now|from\s+now\s+on,?\s+you|act\s+as|pretend\s+to\s+be|roleplay\s+as|simulate\s+being)\b/i,
  },
  {
    id: "system-block",
    severity: "high",
    regex:
      /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\[?(?:SYSTEM|ASSISTANT|USER|INST)\]?\s*[:\]]|<\|(?:system|assistant|user|im_start|im_end)\|>|<\s*(?:system|assistant)\s*>|###\s*(?:system|assistant|instruction)\b)/i,
  },
  {
    id: "exfil-command",
    severity: "high",
    regex:
      /\b(?:c\u0075rl|wget|Invoke-WebRequest|iwr)\s+(?:-[A-Za-z]+\s+)*https?:\/\/|\bfetch\s*\(\s*["']https?:\/\//i,
  },
  {
    id: "credential-read",
    severity: "medium",
    regex:
      /\b(?:read|cat|print|open|include|exfiltrate|send)\b[^\n]{0,40}?(?:\.env\b|\.ssh\/|id_rsa\b|id_ed25519\b|credentials\.json\b|\.aws\/credentials\b|\.claude\/.credentials|HUGIN[_\-]?API[_\-]?KEY|MUNIN[_\-]?API[_\-]?KEY|ANTHROPIC[_\-]?API[_\-]?KEY|OPENAI[_\-]?API[_\-]?KEY)/i,
  },
  {
    id: "hidden-unicode",
    severity: "medium",
    regex: /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/,
  },
];

function maxSeverity(a: InjectionSeverity, b: InjectionSeverity): InjectionSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function extractSnippet(content: string, offset: number, matchLen: number): string {
  const contextBefore = 20;
  const contextAfter = 40;
  const start = Math.max(0, offset - contextBefore);
  const end = Math.min(content.length, offset + matchLen + contextAfter);
  const prefix = start > 0 ? "\u2026" : "";
  const suffix = end < content.length ? "\u2026" : "";
  const raw = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${prefix}${raw}${suffix}`;
}

export function scanForInjection(content: string): InjectionScanResult {
  if (!content || !content.trim()) {
    return { severity: "none", matches: [] };
  }

  const matches: InjectionMatch[] = [];
  let worst: InjectionSeverity = "none";

  for (const spec of PATTERNS) {
    const match = spec.regex.exec(content);
    if (!match) continue;
    matches.push({
      pattern: spec.id,
      severity: spec.severity,
      snippet: extractSnippet(content, match.index, match[0].length),
      offset: match.index,
    });
    worst = maxSeverity(worst, spec.severity);
  }

  return { severity: worst, matches };
}

export function compareInjectionSeverity(
  a: InjectionSeverity,
  b: InjectionSeverity,
): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}
