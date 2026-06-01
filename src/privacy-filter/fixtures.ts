/**
 * Fixture loading, validation, and authoring helpers for the OPF eval (#56).
 *
 * Fixtures are stored as JSONL in OPF's native eval format so the exact same
 * file is valid input to `opf eval` and to our scorer. Each line:
 *
 *   {"text": "...", "spans": {"<label>: <surface>": [[s, e], ...]}, "info": {...}}
 *
 * The {@link buildExample} authoring helper computes character offsets from an
 * ordered segment list so hand-counting is never required — the offsets are
 * correct by construction, and {@link validateExample} re-checks that every
 * stored span slices to its labelled surface text as a defense-in-depth gate
 * (also enforced by the fixtures test).
 */

import type {
  LabelledExample,
  OpfSpanMap,
  PiiLabel,
  PiiSpan,
} from "./pii-types.js";
import { parseSpanKey, spanKey } from "./pii-types.js";

// --- Authoring (used by scripts/build-pii-fixtures.ts) ---

/** A labelled segment of example text. */
export interface LabelledSegment {
  label: PiiLabel;
  text: string;
}

/** One piece of an example: a literal string or a labelled span. */
export type Segment = string | LabelledSegment;

/** Tag a string as a labelled PII span when authoring an example. */
export function pii(label: PiiLabel, text: string): LabelledSegment {
  return { label, text };
}

/**
 * Build a {@link LabelledExample} from ordered segments, computing offsets by
 * construction. Literal strings contribute text but no spans; {@link pii}
 * segments contribute both. Identical (label, surface) pairs that recur are
 * merged into one span-map key with multiple offset pairs, matching OPF.
 */
export function buildExample(
  id: string,
  segments: Segment[],
  info: { source?: string; lang?: "en" | "sv" | "mixed"; category?: string } = {},
): LabelledExample {
  let text = "";
  const spans: PiiSpan[] = [];
  for (const seg of segments) {
    if (typeof seg === "string") {
      text += seg;
      continue;
    }
    const start = text.length;
    text += seg.text;
    spans.push({ label: seg.label, start, end: text.length, text: seg.text });
  }
  return {
    id,
    text,
    spans,
    info: {
      id,
      source: info.source ?? "grimnir.synthetic",
      ...(info.lang ? { lang: info.lang } : {}),
      ...(info.category ? { category: info.category } : {}),
    },
  };
}

// --- Serialization ---

function toSpanMap(spans: PiiSpan[]): OpfSpanMap {
  const map: OpfSpanMap = {};
  for (const s of spans) {
    const key = spanKey(s.label, s.text);
    (map[key] ??= []).push([s.start, s.end]);
  }
  return map;
}

/** Serialize one example to a single OPF-native JSONL line. */
export function exampleToJsonl(ex: LabelledExample): string {
  return JSON.stringify({ text: ex.text, spans: toSpanMap(ex.spans), info: ex.info });
}

/** Serialize a set of examples to a JSONL document (newline-terminated). */
export function examplesToJsonl(examples: LabelledExample[]): string {
  return examples.map(exampleToJsonl).join("\n") + "\n";
}

// --- Loading + validation ---

export interface ValidationIssue {
  exampleId: string;
  message: string;
}

/**
 * Validate one example: every span must be in-bounds and its [start, end)
 * slice must equal the labelled surface text. Returns a list of issues
 * (empty = valid).
 */
export function validateExample(ex: LabelledExample): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const s of ex.spans) {
    if (s.start < 0 || s.end > ex.text.length || s.start >= s.end) {
      issues.push({
        exampleId: ex.id,
        message: `span [${s.start}, ${s.end}) for ${s.label} is out of bounds (text len ${ex.text.length})`,
      });
      continue;
    }
    const actual = ex.text.slice(s.start, s.end);
    if (actual !== s.text) {
      issues.push({
        exampleId: ex.id,
        message: `span [${s.start}, ${s.end}) for ${s.label} slices to ${JSON.stringify(
          actual,
        )} but is labelled ${JSON.stringify(s.text)}`,
      });
    }
  }
  return issues;
}

/** Parse one OPF-native JSONL line into a {@link LabelledExample}. */
export function parseExampleLine(line: string): LabelledExample {
  const raw = JSON.parse(line) as {
    text: string;
    spans?: OpfSpanMap;
    info?: { id?: string; source?: string; lang?: string; category?: string };
  };
  if (typeof raw.text !== "string") {
    throw new Error("fixture line missing string `text`");
  }
  const id = raw.info?.id ?? "(unknown)";
  const spans: PiiSpan[] = [];
  for (const [key, pairs] of Object.entries(raw.spans ?? {})) {
    const { label } = parseSpanKey(key);
    for (const [start, end] of pairs) {
      spans.push({ label, start, end, text: raw.text.slice(start, end) });
    }
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    id,
    text: raw.text,
    spans,
    info: {
      id,
      source: raw.info?.source ?? "unknown",
      lang: raw.info?.lang as LabelledExample["info"]["lang"],
      category: raw.info?.category,
    },
  };
}

/** Parse a JSONL document body into examples (blank lines skipped). */
export function parseJsonl(body: string): LabelledExample[] {
  const out: LabelledExample[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(parseExampleLine(line));
    } catch (err) {
      throw new Error(
        `fixture line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}
