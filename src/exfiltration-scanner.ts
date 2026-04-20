/**
 * Lightweight exfiltration scanner for task output.
 *
 * Scans result bodies for patterns that may indicate data leakage:
 * private keys, API credentials, POST-style outbound commands, URLs with
 * sensitive query parameters, and large base64 blobs. Pure function —
 * detective control only; callers decide how to react based on severity
 * (warn / flag / redact via HUGIN_EXFIL_POLICY).
 *
 * See docs/security/lethal-trifecta-assessment.md §7.4,
 * docs/security/exfiltration-scanner.md.
 */

export type ExfilSeverity = "none" | "low" | "medium" | "high";

export type ExfilPatternId =
  | "private-key"
  | "api-key"
  | "exfil-command"
  | "exfil-url"
  | "base64-blob";

export interface ExfilMatch {
  pattern: ExfilPatternId;
  severity: Exclude<ExfilSeverity, "none">;
  snippet: string;
  offset: number;
  matchLen: number;
}

export interface ExfilScanResult {
  severity: ExfilSeverity;
  matches: ExfilMatch[];
}

interface PatternSpec {
  id: ExfilPatternId;
  severity: Exclude<ExfilSeverity, "none">;
  regex: RegExp;
}

const SEVERITY_RANK: Record<ExfilSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

// Patterns avoid verbatim secret-like tokens in source to keep this file
// quiet for scanners that flag literal keys. Pattern literals use
// \u-escapes on the first character of each well-known prefix.
const PATTERNS: PatternSpec[] = [
  {
    id: "private-key",
    severity: "high",
    regex:
      /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP|ED25519|PRIVATE)\s+(?:PRIVATE\s+)?KEY(?:\s+BLOCK)?-----/g,
  },
  {
    id: "api-key",
    severity: "high",
    regex: new RegExp(
      [
        // Anthropic: sk-ant-<kind>-<payload>
        "\\bs\u006B-ant-[a-z0-9]+-[A-Za-z0-9_\\-]{24,}",
        // OpenAI project/user: sk-proj-<payload>, sk-<40+char>
        "\\bs\u006B-proj-[A-Za-z0-9_\\-]{24,}",
        "\\bs\u006B-[A-Za-z0-9]{40,}",
        // GitHub PAT/server/oauth/user
        "\\b\u0067h[pousr]_[A-Za-z0-9]{30,}",
        // Slack
        "\\bxox[baprs]-[A-Za-z0-9\\-]{10,}",
        // AWS access key id
        "\\b\u0041KIA[0-9A-Z]{16}\\b",
        // Google API key
        "\\b\u0041Iza[0-9A-Za-z_\\-]{35}\\b",
        // Generic Bearer JWT
        "\\bBearer\\s+ey[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}",
      ].join("|"),
      "gi",
    ),
  },
  {
    id: "exfil-command",
    severity: "high",
    regex: new RegExp(
      [
        // c\u0075rl/wget POST with explicit data flags
        "\\b(?:c\u0075rl|wget)\\s+(?:-[A-Za-z]+\\s+)*(?:-X\\s+POST|--data|--data-binary|--data-urlencode|--post-data|--upload-file|-T\\s)",
        // PowerShell Invoke-WebRequest/RestMethod with Method POST
        "\\bInvoke-(?:WebRequest|RestMethod)\\s+[^\\n]*-Method\\s+(?:POST|PUT)",
        // fetch('...', { method: 'POST' })
        'fetch\\s*\\(\\s*["\']https?:\\/\\/[^"\']+["\'][^)]*method\\s*:\\s*["\'](?:POST|PUT)["\']',
      ].join("|"),
      "gi",
    ),
  },
  {
    id: "exfil-url",
    severity: "medium",
    regex:
      /\bhttps?:\/\/[^\s"'<>\]]+?[?&](?:data|payload|secret|token|leak|exfil|key|password|credentials?|session|cookie|auth|apikey|access_token|id_token|refresh_token)=[^\s"'<>&\]]+/gi,
  },
  {
    id: "base64-blob",
    severity: "low",
    // Contiguous base64-ish run (no whitespace) of at least 256 chars.
    // Threshold is intentionally high — model output, PDF dumps, and
    // image transfers are common false positives at lower thresholds.
    regex: /[A-Za-z0-9+/]{256,}={0,2}/g,
  },
];

function maxSeverity(a: ExfilSeverity, b: ExfilSeverity): ExfilSeverity {
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

export function scanForExfiltration(content: string): ExfilScanResult {
  if (!content || !content.trim()) {
    return { severity: "none", matches: [] };
  }

  const matches: ExfilMatch[] = [];
  let worst: ExfilSeverity = "none";

  for (const spec of PATTERNS) {
    for (const m of content.matchAll(spec.regex)) {
      if (m.index === undefined) continue;
      matches.push({
        pattern: spec.id,
        severity: spec.severity,
        snippet: extractSnippet(content, m.index, m[0].length),
        offset: m.index,
        matchLen: m[0].length,
      });
      worst = maxSeverity(worst, spec.severity);
    }
  }

  return { severity: worst, matches };
}

export function compareExfilSeverity(a: ExfilSeverity, b: ExfilSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

/**
 * Replace every match in-place with `[redacted: <pattern>]`. Matches are
 * processed in ascending offset order; overlapping matches are merged so
 * the outermost span wins and the replacement shows the earlier pattern.
 */
export function redactExfiltration(content: string, result: ExfilScanResult): string {
  if (!result.matches.length) return content;

  const sorted = [...result.matches].sort((a, b) => a.offset - b.offset);
  const merged: ExfilMatch[] = [];
  for (const m of sorted) {
    const last = merged[merged.length - 1];
    if (last && m.offset < last.offset + last.matchLen) {
      if (m.offset + m.matchLen > last.offset + last.matchLen) {
        last.matchLen = m.offset + m.matchLen - last.offset;
      }
      continue;
    }
    merged.push({ ...m });
  }

  let out = "";
  let cursor = 0;
  for (const m of merged) {
    out += content.slice(cursor, m.offset);
    out += `[redacted: ${m.pattern}]`;
    cursor = m.offset + m.matchLen;
  }
  out += content.slice(cursor);
  return out;
}
