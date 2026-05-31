import { describe, expect, it } from "vitest";
import {
  parseOpfPrediction,
  parseOpfPredictionsJsonl,
  parseOpfRedaction,
} from "../../src/privacy-filter/opf-output.js";

describe("opf-output — redaction shape", () => {
  it("parses detected_spans from the redaction output schema", () => {
    const raw = {
      schema_version: 1,
      summary: { output_mode: "typed", span_count: 2, by_label: {}, decoded_mismatch: false },
      text: "Alice was born on 1990-01-02.",
      detected_spans: [
        { label: "private_person", start: 0, end: 5, text: "Alice", placeholder: "<PRIVATE_PERSON>" },
        { label: "private_date", start: 18, end: 28, text: "1990-01-02", placeholder: "<PRIVATE_DATE>" },
      ],
      redacted_text: "<PRIVATE_PERSON> was born on <PRIVATE_DATE>.",
    };
    const { spans } = parseOpfRedaction(raw);
    expect(spans.map((s) => s.label)).toEqual(["private_person", "private_date"]);
    expect(spans[0].text).toBe("Alice");
  });

  it("backfills span text from offsets when omitted", () => {
    const { spans } = parseOpfRedaction({
      text: "call Bob",
      detected_spans: [{ label: "private_person", start: 5, end: 8 }],
    });
    expect(spans[0].text).toBe("Bob");
  });

  it("throws on an unknown OPF label", () => {
    expect(() =>
      parseOpfRedaction({
        text: "x",
        detected_spans: [{ label: "credit_score", start: 0, end: 1 }],
      }),
    ).toThrow(/unknown label/i);
  });
});

describe("opf-output — predictions shape", () => {
  it("parses the predicted_spans map keyed by 'label: surface'", () => {
    const pred = parseOpfPrediction({
      example_id: "sample_eval_5_01",
      text: "Quindle Testwick at quindle@openai.com",
      predicted_spans: {
        "private_person: Quindle Testwick": [[0, 16]],
        "private_email: quindle@openai.com": [[20, 38]],
      },
    });
    expect(pred.exampleId).toBe("sample_eval_5_01");
    expect(pred.spans).toHaveLength(2);
    expect(pred.spans[0].text).toBe("Quindle Testwick");
  });

  it("parses a multi-line predictions JSONL into an id-keyed map", () => {
    const body = [
      JSON.stringify({ example_id: "a", text: "Alice", predicted_spans: { "private_person: Alice": [[0, 5]] } }),
      "",
      JSON.stringify({ example_id: "b", text: "Bob", predicted_spans: {} }),
    ].join("\n");
    const map = parseOpfPredictionsJsonl(body);
    expect(map.size).toBe(2);
    expect(map.get("a")!.spans).toHaveLength(1);
    expect(map.get("b")!.spans).toHaveLength(0);
  });

  it("reports the line number on malformed JSONL", () => {
    const body = '{"example_id":"a","text":"x","predicted_spans":{}}\n{not json}';
    expect(() => parseOpfPredictionsJsonl(body)).toThrow(/line 2/);
  });
});
