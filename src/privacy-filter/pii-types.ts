/**
 * Shared types for the OpenAI Privacy Filter (OPF) evaluation harness (#56).
 *
 * The label set matches OPF's taxonomy exactly (see OUTPUT_SCHEMAS.md in
 * openai/privacy-filter): 8 span categories. Keeping the enum aligned means
 * our labelled fixtures are valid OPF `eval` input and OPF predictions map
 * back onto our gold spans without translation.
 *
 * This module is pure (no I/O, no deps) so it is safe to import from both the
 * shipped runtime (a future HUGIN_EXFIL_POLICY=opf integration) and the
 * offline eval scripts.
 */

/** The 8 PII span categories OPF emits. */
export const PII_LABELS = [
  "private_person",
  "private_email",
  "private_phone",
  "private_address",
  "private_date",
  "private_url",
  "account_number",
  "secret",
] as const;

export type PiiLabel = (typeof PII_LABELS)[number];

const PII_LABEL_SET: ReadonlySet<string> = new Set(PII_LABELS);

export function isPiiLabel(value: string): value is PiiLabel {
  return PII_LABEL_SET.has(value);
}

/**
 * A single PII span: a half-open character range `[start, end)` over the
 * example text, tagged with a label and carrying the surface text it covers.
 */
export interface PiiSpan {
  label: PiiLabel;
  start: number;
  end: number;
  /** The substring `text.slice(start, end)`. Kept for debugging/auditing. */
  text: string;
}

/**
 * A labelled evaluation example. Serialized as one JSONL line in OPF's native
 * eval format:
 *
 *   {"text": "...", "spans": {"<label>: <surface>": [[start, end], ...]}, "info": {...}}
 *
 * `info.lang` and `info.category` are Grimnir extensions (harmless to OPF) used
 * to slice metrics — e.g. Swedish-vs-English recall, or per-document-type F1.
 */
export interface LabelledExample {
  id: string;
  text: string;
  spans: PiiSpan[];
  info: {
    id: string;
    source: string;
    lang?: "en" | "sv" | "mixed";
    category?: string;
  };
}

/**
 * The OPF eval `spans` wire shape: a map from `"<label>: <surface>"` to a list
 * of `[start, end]` offset pairs. The same key can map to multiple pairs when
 * the identical surface string appears more than once.
 */
export type OpfSpanMap = Record<string, Array<[number, number]>>;

/** A detector's output for one example — just the flat span list. */
export interface DetectionResult {
  spans: PiiSpan[];
}

/** A detector that maps text → spans (regex baseline, OPF adapter, etc.). */
export interface PiiDetector {
  readonly name: string;
  detect(text: string): PiiSpan[];
}

/**
 * Parse an OPF span-map key (`"private_person: Anna Lindqvist"`) into its label
 * and surface text. The label is always one of the known labels followed by
 * `": "`; we split on the first known-label prefix so a surface string that
 * itself contains `": "` is preserved intact.
 */
export function parseSpanKey(key: string): { label: PiiLabel; surface: string } {
  const sep = key.indexOf(": ");
  if (sep === -1) {
    if (isPiiLabel(key)) return { label: key, surface: "" };
    throw new Error(`Malformed span key (no "label: surface" form): ${key}`);
  }
  const labelPart = key.slice(0, sep);
  if (!isPiiLabel(labelPart)) {
    throw new Error(`Unknown PII label "${labelPart}" in span key: ${key}`);
  }
  return { label: labelPart, surface: key.slice(sep + 2) };
}

/** Build the canonical `"<label>: <surface>"` key for a span. */
export function spanKey(label: PiiLabel, surface: string): string {
  return `${label}: ${surface}`;
}

/** Flatten an OPF span-map onto `text` into a list of {@link PiiSpan}. */
export function spanMapToSpans(map: OpfSpanMap, text: string): PiiSpan[] {
  const out: PiiSpan[] = [];
  for (const [key, pairs] of Object.entries(map)) {
    const { label } = parseSpanKey(key);
    for (const [start, end] of pairs) {
      out.push({ label, start, end, text: text.slice(start, end) });
    }
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/** Collapse a flat span list back into the OPF span-map wire shape. */
export function spansToSpanMap(spans: PiiSpan[]): OpfSpanMap {
  const map: OpfSpanMap = {};
  for (const s of spans) {
    const key = spanKey(s.label, s.text);
    (map[key] ??= []).push([s.start, s.end]);
  }
  return map;
}
