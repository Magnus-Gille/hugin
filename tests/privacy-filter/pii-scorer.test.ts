import { describe, expect, it } from "vitest";
import { scoreDetector, type ExamplePrediction } from "../../src/privacy-filter/pii-scorer.js";
import type { LabelledExample, PiiSpan } from "../../src/privacy-filter/pii-types.js";

function ex(id: string, text: string, spans: PiiSpan[]): LabelledExample {
  return { id, text, spans, info: { id, source: "test" } };
}

function span(label: PiiSpan["label"], start: number, end: number, text: string): PiiSpan {
  return { label, start, end, text };
}

describe("pii-scorer", () => {
  it("scores a perfect detector as P=R=F1=1", () => {
    const gold = ex("e1", "Alice called", [span("private_person", 0, 5, "Alice")]);
    const preds: ExamplePrediction[] = [
      { example: gold, predicted: [span("private_person", 0, 5, "Alice")] },
    ];
    const r = scoreDetector("perfect", preds);
    expect(r.micro.exact.f1).toBe(1);
    expect(r.micro.relaxed.recall).toBe(1);
    expect(r.micro.detection.recall).toBe(1);
  });

  it("counts a missed gold span as a false negative (recall < 1)", () => {
    const gold = ex("e1", "Alice called Bob", [
      span("private_person", 0, 5, "Alice"),
      span("private_person", 13, 16, "Bob"),
    ]);
    const preds: ExamplePrediction[] = [
      { example: gold, predicted: [span("private_person", 0, 5, "Alice")] },
    ];
    const r = scoreDetector("half", preds);
    expect(r.micro.relaxed.recall).toBeCloseTo(0.5, 5);
    expect(r.micro.relaxed.precision).toBe(1);
    expect(r.micro.relaxed.falseNegatives).toBe(1);
  });

  it("counts a spurious predicted span as a false positive (precision < 1)", () => {
    const gold = ex("e1", "Alice called", [span("private_person", 0, 5, "Alice")]);
    const preds: ExamplePrediction[] = [
      {
        example: gold,
        predicted: [
          span("private_person", 0, 5, "Alice"),
          span("private_phone", 6, 12, "called"),
        ],
      },
    ];
    const r = scoreDetector("noisy", preds);
    expect(r.micro.relaxed.precision).toBeCloseTo(0.5, 5);
    expect(r.micro.relaxed.recall).toBe(1);
  });

  it("relaxed matching accepts overlap; exact requires identical bounds", () => {
    const gold = ex("e1", "Anna Lindqvist", [span("private_person", 0, 14, "Anna Lindqvist")]);
    const preds: ExamplePrediction[] = [
      // predicted only the first name — overlaps, wrong bounds
      { example: gold, predicted: [span("private_person", 0, 4, "Anna")] },
    ];
    const r = scoreDetector("partial", preds);
    expect(r.micro.relaxed.recall).toBe(1); // overlap ⇒ relaxed match
    expect(r.micro.exact.recall).toBe(0); // bounds differ ⇒ no exact match
  });

  it("detection mode ignores label mismatch", () => {
    const gold = ex("e1", "2026-06-01", [span("private_date", 0, 10, "2026-06-01")]);
    const preds: ExamplePrediction[] = [
      // right span, wrong label
      { example: gold, predicted: [span("account_number", 0, 10, "2026-06-01")] },
    ];
    const r = scoreDetector("mislabel", preds);
    expect(r.micro.relaxed.recall).toBe(0); // typed: label wrong
    expect(r.micro.detection.recall).toBe(1); // detection: overlap is enough
  });

  it("greedy 1:1 matching prevents double-counting overlapping predictions", () => {
    const gold = ex("e1", "Alice", [span("private_person", 0, 5, "Alice")]);
    const preds: ExamplePrediction[] = [
      {
        example: gold,
        predicted: [
          span("private_person", 0, 5, "Alice"),
          span("private_person", 0, 5, "Alice"), // duplicate
        ],
      },
    ];
    const r = scoreDetector("dup", preds);
    expect(r.micro.relaxed.truePositives).toBe(1);
    expect(r.micro.relaxed.falsePositives).toBe(1); // the second one is spurious
  });

  it("reports false-positive load on clean examples", () => {
    const clean1 = ex("c1", "no pii here", []);
    const clean2 = ex("c2", "also clean", []);
    const preds: ExamplePrediction[] = [
      { example: clean1, predicted: [span("private_person", 0, 2, "no")] },
      { example: clean2, predicted: [] },
    ];
    const r = scoreDetector("fp", preds);
    expect(r.falsePositives.cleanExamples).toBe(2);
    expect(r.falsePositives.cleanExamplesWithPredictions).toBe(1);
    expect(r.falsePositives.spuriousSpans).toBe(1);
    expect(r.falsePositives.contaminationRate).toBeCloseTo(0.5, 5);
  });

  it("per-label metrics omit labels absent from gold and predictions", () => {
    const gold = ex("e1", "Alice", [span("private_person", 0, 5, "Alice")]);
    const r = scoreDetector("x", [{ example: gold, predicted: [span("private_person", 0, 5, "Alice")] }]);
    const person = r.perLabel.find((p) => p.label === "private_person")!;
    expect(person.metrics.recall).toBe(1);
    // a label with no support anywhere has zero counts
    const secret = r.perLabel.find((p) => p.label === "secret")!;
    expect(secret.metrics.truePositives + secret.metrics.falseNegatives).toBe(0);
  });
});
