/**
 * Adapter for OpenAI Privacy Filter (OPF) output → harness spans (#56).
 *
 * OPF produces two relevant shapes (see openai/privacy-filter OUTPUT_SCHEMAS.md):
 *
 *   1. Redaction output (`opf "..."` / `opf -f file`), one JSON object:
 *      {
 *        "schema_version": 1,
 *        "summary": { "span_count": N, "by_label": {...}, ... },
 *        "text": "...",
 *        "detected_spans": [
 *          { "label": "private_person", "start": 0, "end": 5,
 *            "text": "Alice", "placeholder": "<PRIVATE_PERSON>" }
 *        ],
 *        "redacted_text": "..."
 *      }
 *
 *   2. Predictions output (`opf eval --predictions-out`), one JSON per line:
 *      {
 *        "example_id": "stable-id",
 *        "text": "...",
 *        "predicted_spans": { "private_person: Alice": [[0, 5]] }
 *      }
 *
 * The eval harness drives OPF in `eval` mode over our JSONL fixtures, so the
 * predictions shape is the primary path; the redaction shape is parsed too so
 * a quick `opf "<text>"` smoke test can be scored the same way.
 *
 * Parsing is defensive — OPF is an external tool and a future version may add
 * fields or reorder; we read only what we need and reject malformed records
 * loudly rather than silently scoring garbage.
 */

import { z } from "zod";
import type { PiiSpan } from "./pii-types.js";
import { isPiiLabel, parseSpanKey } from "./pii-types.js";

const detectedSpanSchema = z.object({
  label: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string().optional(),
  placeholder: z.string().optional(),
});

const redactionSchema = z.object({
  schema_version: z.number().optional(),
  text: z.string(),
  detected_spans: z.array(detectedSpanSchema).default([]),
  redacted_text: z.string().optional(),
});

const predictionSchema = z.object({
  example_id: z.string(),
  text: z.string(),
  predicted_spans: z.record(z.string(), z.array(z.tuple([z.number(), z.number()]))),
});

export type OpfPrediction = {
  exampleId: string;
  text: string;
  spans: PiiSpan[];
};

/** Parse a single OPF redaction-output JSON object into spans. */
export function parseOpfRedaction(raw: unknown): { text: string; spans: PiiSpan[] } {
  const parsed = redactionSchema.parse(raw);
  const spans: PiiSpan[] = [];
  for (const s of parsed.detected_spans) {
    if (!isPiiLabel(s.label)) {
      throw new Error(`OPF emitted unknown label "${s.label}"`);
    }
    spans.push({
      label: s.label,
      start: s.start,
      end: s.end,
      text: s.text ?? parsed.text.slice(s.start, s.end),
    });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  return { text: parsed.text, spans };
}

/** Parse a single OPF predictions-JSONL record into spans. */
export function parseOpfPrediction(raw: unknown): OpfPrediction {
  const parsed = predictionSchema.parse(raw);
  const spans: PiiSpan[] = [];
  for (const [key, pairs] of Object.entries(parsed.predicted_spans)) {
    const { label } = parseSpanKey(key);
    for (const [start, end] of pairs) {
      spans.push({ label, start, end, text: parsed.text.slice(start, end) });
    }
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  return { exampleId: parsed.example_id, text: parsed.text, spans };
}

/**
 * Parse a full OPF predictions JSONL file body into a map keyed by example id.
 * Blank lines are skipped; a malformed line throws with its line number so a
 * partial/corrupt predictions file is caught rather than silently scored.
 */
export function parseOpfPredictionsJsonl(body: string): Map<string, OpfPrediction> {
  const out = new Map<string, OpfPrediction>();
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `OPF predictions JSONL line ${i + 1} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const pred = parseOpfPrediction(json);
    out.set(pred.exampleId, pred);
  }
  return out;
}
