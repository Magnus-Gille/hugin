/**
 * frontmatter-normalize.ts — the deterministic procedure for slice-one (#84).
 *
 * The slice-one skill is **markdown frontmatter normalization**: given a markdown
 * document that opens with a YAML frontmatter block (`---` … `---`), produce a
 * canonically-normalized version of that block while leaving the document body
 * untouched. It is chosen as slice-one because it is fully deterministic and
 * trivially gradeable by exact string match (no judge model, no flaky diff).
 *
 * Normalization contract (the "canonical form"):
 *   1. The frontmatter block is delimited by a line containing exactly `---`
 *      at the very start of the document and a following line of exactly `---`.
 *   2. Keys are emitted in ascending Unicode (code-point) order — `String`
 *      default sort. Stable + locale-independent.
 *   3. Each line is `key: value` with exactly one space after the colon and no
 *      trailing whitespace.
 *   4. Scalar string values are emitted unquoted UNLESS quoting is required to
 *      preserve the value (it contains a leading/trailing space, a `:` followed
 *      by a space, a `#`, or is empty / a YAML-ambiguous token like `true`,
 *      `false`, `null`, `yes`, `no`, or looks like a number). When quoting is
 *      needed, double quotes are used and embedded `"`/`\` are escaped.
 *   5. List values (`- item`) are emitted as one `- item` per line, indented two
 *      spaces, preserving list order (lists are ordered data, unlike keys).
 *   6. Exactly one blank line is NOT added inside the block; the block is the
 *      keys, nothing else. The body after the closing `---` is preserved byte
 *      for byte (including its leading newline).
 *
 * This is intentionally a SMALL, well-specified subset of YAML — enough for the
 * frontmatter Grimnir actually writes (string scalars + simple string lists),
 * and small enough to be exact-match gradeable. Inputs outside the subset
 * (nested maps, multi-line scalars, anchors, flow collections) are REJECTED via
 * `normalizeFrontmatter` returning `{ ok: false }`, which the grader treats as
 * an abstain/contraindication rather than a silent mangle.
 */

export interface NormalizeInput {
  /** The full markdown document text, frontmatter block first. */
  document: string;
}

export type NormalizeResult =
  | { ok: true; document: string }
  | { ok: false; reason: string };

// YAML-ambiguous bare scalars that MUST be quoted to stay strings.
const AMBIGUOUS_BARE = new Set([
  "true",
  "false",
  "null",
  "yes",
  "no",
  "on",
  "off",
  "~",
]);

const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

type FrontmatterValue = { kind: "scalar"; value: string } | { kind: "list"; items: string[] };

/**
 * Determine whether a scalar string must be double-quoted to round-trip as the
 * same string value. Conservative: quote whenever there is any ambiguity.
 */
function scalarNeedsQuoting(value: string): boolean {
  if (value === "") return true;
  if (value !== value.trim()) return true; // leading/trailing whitespace
  if (AMBIGUOUS_BARE.has(value.toLowerCase())) return true;
  if (NUMERIC_RE.test(value)) return true;
  if (value.includes(": ") || value.endsWith(":")) return true;
  if (value.includes(" #") || value.startsWith("#")) return true;
  if (/[:#"'\[\]{}&*!|>%@`]/.test(value[0] ?? "")) return true;
  if (value.includes('"') || value.includes("\\")) return true;
  return false;
}

function emitScalar(value: string): string {
  if (!scalarNeedsQuoting(value)) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Strip surrounding single/double quotes from an authored scalar, if present. */
function parseScalar(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    // YAML single-quote: '' is a literal '.
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/**
 * Parse the small frontmatter subset (string scalars + inline `[a, b]` or
 * block `- item` string lists). Returns null if a line is outside the subset.
 */
function parseFrontmatterBlock(lines: string[]): Map<string, FrontmatterValue> | null {
  const out = new Map<string, FrontmatterValue>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue; // tolerate blank lines between keys on input
    }
    // Reject indentation at top level (would indicate nesting — out of subset).
    if (/^\s/.test(line)) return null;
    const colon = line.indexOf(":");
    if (colon === -1) return null;
    const key = line.slice(0, colon).trim();
    if (key === "") return null;
    if (out.has(key)) return null; // duplicate key — ambiguous, reject
    const rest = line.slice(colon + 1).trim();

    if (rest === "") {
      // Possibly a block list on following indented `- ` lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s?/.test(lines[j])) {
        const itemRaw = lines[j].replace(/^\s+-\s?/, "");
        items.push(parseScalar(itemRaw));
        j++;
      }
      if (items.length === 0) {
        // Empty value, no list → empty string scalar.
        out.set(key, { kind: "scalar", value: "" });
        i++;
      } else {
        out.set(key, { kind: "list", items });
        i = j;
      }
      continue;
    }

    // Inline flow list: [a, b, c]
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      const items =
        inner === ""
          ? []
          : inner.split(",").map((s) => parseScalar(s));
      out.set(key, { kind: "list", items });
      i++;
      continue;
    }

    // Reject nested maps / unsupported flow maps.
    if (rest.startsWith("{")) return null;

    out.set(key, { kind: "scalar", value: parseScalar(rest) });
    i++;
  }
  return out;
}

/** Render the canonical frontmatter block lines (no fences). */
function renderFrontmatter(map: Map<string, FrontmatterValue>): string[] {
  const keys = [...map.keys()].sort(); // ascending code-point order
  const lines: string[] = [];
  for (const key of keys) {
    const v = map.get(key)!;
    if (v.kind === "scalar") {
      lines.push(`${key}: ${emitScalar(v.value)}`);
    } else {
      lines.push(`${key}:`);
      for (const item of v.items) {
        lines.push(`  - ${emitScalar(item)}`);
      }
    }
  }
  return lines;
}

/**
 * Normalize the frontmatter block of a markdown document. The body after the
 * closing `---` is preserved exactly. Returns `{ ok: false }` for documents
 * with no frontmatter or with frontmatter outside the supported subset — the
 * grader / lane treats that as an abstain, never a silent mangle.
 */
export function normalizeFrontmatter(input: NormalizeInput): NormalizeResult {
  const doc = input.document;
  // Frontmatter must be the very first thing in the document.
  if (!doc.startsWith("---\n") && doc !== "---" && !doc.startsWith("---\r\n")) {
    return { ok: false, reason: "no-frontmatter" };
  }

  // Normalize CRLF → LF for parsing; we re-emit LF (canonical).
  const normalizedDoc = doc.replace(/\r\n/g, "\n");
  const afterOpen = normalizedDoc.slice("---\n".length);
  const closeIdx = afterOpen.indexOf("\n---");
  if (closeIdx === -1) return { ok: false, reason: "unterminated-frontmatter" };

  const blockText = afterOpen.slice(0, closeIdx);
  // Everything from the closing fence onward (preserved verbatim).
  const rest = afterOpen.slice(closeIdx + "\n---".length);

  const blockLines = blockText === "" ? [] : blockText.split("\n");
  const parsed = parseFrontmatterBlock(blockLines);
  if (parsed === null) return { ok: false, reason: "unsupported-frontmatter" };

  const rendered = renderFrontmatter(parsed);
  const canonical = ["---", ...rendered, "---"].join("\n") + rest;
  return { ok: true, document: canonical };
}

/**
 * Deterministic grader for the slice-one eval suite. The oracle is an
 * independent exact-string comparison: the normalized output must equal the
 * fixture's expected canonical document. Mirrors A6's "deterministic test
 * oracle" requirement — no judge model.
 *
 * For abort/contraindication fixtures the expected value is the sentinel
 * `{ abstain: true, reason }`; the grader passes when the normalizer abstains
 * for the same reason.
 */
export function gradeFrontmatter(
  output: NormalizeResult,
  expected: unknown,
): { pass: boolean } {
  if (
    expected !== null &&
    typeof expected === "object" &&
    (expected as { abstain?: unknown }).abstain === true
  ) {
    const reason = (expected as { reason?: unknown }).reason;
    return {
      pass: output.ok === false && (reason === undefined || output.reason === reason),
    };
  }
  if (typeof expected === "string") {
    return { pass: output.ok === true && output.document === expected };
  }
  if (
    expected !== null &&
    typeof expected === "object" &&
    typeof (expected as { document?: unknown }).document === "string"
  ) {
    return {
      pass:
        output.ok === true &&
        output.document === (expected as { document: string }).document,
    };
  }
  return { pass: false };
}
