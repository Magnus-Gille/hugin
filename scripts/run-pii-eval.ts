#!/usr/bin/env tsx
/**
 * run-pii-eval — score PII detectors against the Grimnir fixtures (#56).
 *
 * Always runs the regex baseline (no external deps), so it produces numbers
 * today with zero OPF installed. If an OPF predictions JSONL is supplied
 * (produced on a host by scripts/bench-opf.sh → `opf eval --predictions-out`),
 * it folds OPF in as a second detector and prints the head-to-head.
 *
 * Outputs a human-readable markdown report to stdout (and optionally a file),
 * plus a machine-readable JSON report. The report mirrors the design doc's
 * decision criteria: per-label recall, false-positive load on clean content,
 * detection-recall (the leak-prevention metric), and — when timings are passed
 * — latency.
 *
 * Usage:
 *   npm run eval:pii
 *   tsx scripts/run-pii-eval.ts \
 *     --pii eval/privacy-filter/fixtures/grimnir-pii.jsonl \
 *     --clean eval/privacy-filter/fixtures/clean-technical.jsonl \
 *     [--opf <predictions.jsonl>] [--timings <bench.json>] \
 *     [--md <report.md>] [--json <report.json>]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonl } from "../src/privacy-filter/fixtures.js";
import { parseOpfPredictionsJsonl } from "../src/privacy-filter/opf-output.js";
import { regexBaselineDetector } from "../src/privacy-filter/pii-regex-baseline.js";
import {
  pct,
  scoreDetector,
  type ExamplePrediction,
  type ScoreReport,
} from "../src/privacy-filter/pii-scorer.js";
import type { LabelledExample } from "../src/privacy-filter/pii-types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "eval", "privacy-filter", "fixtures");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

interface Timings {
  host?: string;
  device?: string;
  model?: string;
  buckets?: Array<{ label: string; bytes: number; p50Ms: number; p95Ms: number }>;
  rssMb?: number;
  coldStartMs?: number;
}

function loadFixtures(piiPath: string, cleanPath: string): LabelledExample[] {
  const pii = parseJsonl(readFileSync(piiPath, "utf8"));
  const clean = parseJsonl(readFileSync(cleanPath, "utf8"));
  return [...pii, ...clean];
}

function regexPredictions(examples: LabelledExample[]): ExamplePrediction[] {
  return examples.map((example) => ({
    example,
    predicted: regexBaselineDetector.detect(example.text),
  }));
}

function opfPredictions(
  examples: LabelledExample[],
  predictionsPath: string,
): { preds: ExamplePrediction[]; missing: string[] } {
  // OPF assigns its own content-hashed example_id (it ignores our info.id), so
  // match predictions to fixtures by exact text rather than by id.
  const byId = parseOpfPredictionsJsonl(readFileSync(predictionsPath, "utf8"));
  const byText = new Map<string, ReturnType<typeof byId.get>>();
  for (const pred of byId.values()) byText.set(pred.text, pred);
  const missing: string[] = [];
  const preds = examples.map((example) => {
    const found = byText.get(example.text);
    if (!found) missing.push(example.id);
    return { example, predicted: found?.spans ?? [] };
  });
  return { preds, missing };
}

function renderReport(reports: ScoreReport[], timings: Timings | null): string {
  const lines: string[] = [];
  lines.push("# OPF PII evaluation report (#56)");
  lines.push("");
  lines.push(`Examples scored: **${reports[0]?.examples ?? 0}**`);
  lines.push("");

  // Headline comparison table
  lines.push("## Headline (micro-averaged)");
  lines.push("");
  lines.push(
    "| Detector | Typed F1 (relaxed) | Typed P | Typed R | Detection R | Exact F1 | Clean contamination |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of reports) {
    lines.push(
      `| ${r.detector} | ${pct(r.micro.relaxed.f1)} | ${pct(r.micro.relaxed.precision)} | ${pct(
        r.micro.relaxed.recall,
      )} | ${pct(r.micro.detection.recall)} | ${pct(r.micro.exact.f1)} | ${pct(
        r.falsePositives.contaminationRate,
      )} (${r.falsePositives.spuriousSpans} spans) |`,
    );
  }
  lines.push("");
  lines.push(
    "> *Detection R* is label-agnostic recall — did the detector notice PII is present at all? " +
      "This is the leak-prevention metric: a miss before a cloud call is a leak.",
  );
  lines.push("");

  // Per-label recall (the most decision-relevant cut)
  lines.push("## Per-label recall (relaxed)");
  lines.push("");
  const labels = reports[0].perLabel.map((p) => p.label);
  lines.push(`| Label | ${reports.map((r) => r.detector).join(" | ")} |`);
  lines.push(`|---|${reports.map(() => "---").join("|")}|`);
  for (const label of labels) {
    const cells = reports.map((r) => {
      const m = r.perLabel.find((p) => p.label === label)!.metrics;
      const support = m.truePositives + m.falseNegatives;
      return support === 0 ? "—" : `${pct(m.recall)} (n=${support})`;
    });
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  // Per-label precision
  lines.push("## Per-label precision (relaxed)");
  lines.push("");
  lines.push(`| Label | ${reports.map((r) => r.detector).join(" | ")} |`);
  lines.push(`|---|${reports.map(() => "---").join("|")}|`);
  for (const label of labels) {
    const cells = reports.map((r) => {
      const m = r.perLabel.find((p) => p.label === label)!.metrics;
      const predicted = m.truePositives + m.falsePositives;
      return predicted === 0 ? "—" : pct(m.precision);
    });
    lines.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  if (timings) {
    lines.push("## Latency (OPF)");
    lines.push("");
    lines.push(`- Host: \`${timings.host ?? "?"}\`  device: \`${timings.device ?? "?"}\`  model: \`${timings.model ?? "?"}\``);
    if (timings.coldStartMs !== undefined)
      lines.push(`- Cold start: ${timings.coldStartMs} ms`);
    if (timings.rssMb !== undefined) lines.push(`- Peak RSS: ${timings.rssMb} MB`);
    if (timings.buckets?.length) {
      lines.push("");
      lines.push("| Content size | bytes | p50 | p95 |");
      lines.push("|---|---|---|---|");
      for (const b of timings.buckets) {
        lines.push(`| ${b.label} | ${b.bytes} | ${b.p50Ms} ms | ${b.p95Ms} ms |`);
      }
    }
    lines.push("");
  } else {
    lines.push("## Latency (OPF)");
    lines.push("");
    lines.push(
      "_No timings supplied. Run `scripts/bench-opf.sh` on the Pi and the laptop, then pass `--timings <bench.json>`._",
    );
    lines.push("");
  }

  // Decision-criteria checklist (from the design doc)
  lines.push("## Decision criteria (design doc §Decision criteria)");
  lines.push("");
  const opf = reports.find((r) => r.detector.startsWith("opf"));
  const base = reports.find((r) => r.detector === "regex-baseline");
  if (opf && base) {
    const recallWin = opf.micro.relaxed.recall - base.micro.relaxed.recall;
    const detWin = opf.micro.detection.recall - base.micro.detection.recall;
    lines.push(
      `- OPF typed recall vs baseline: ${pct(opf.micro.relaxed.recall)} vs ${pct(
        base.micro.relaxed.recall,
      )} (**${recallWin >= 0 ? "+" : ""}${pct(recallWin)}**)`,
    );
    lines.push(
      `- OPF detection recall vs baseline: ${pct(opf.micro.detection.recall)} vs ${pct(
        base.micro.detection.recall,
      )} (**${detWin >= 0 ? "+" : ""}${pct(detWin)}**)`,
    );
    lines.push(
      `- OPF clean contamination: ${pct(opf.falsePositives.contaminationRate)} (${opf.falsePositives.spuriousSpans} spurious spans)`,
    );
    lines.push("");
    lines.push(
      "Adopt integration #1 (`HUGIN_EXFIL_POLICY=opf`) iff: recall ≥ baseline + materially better " +
        "on names/addresses, p95 latency on the chosen host < poll interval, clean contamination tolerable.",
    );
  } else {
    lines.push(
      "_OPF predictions not supplied — only the regex baseline was scored. " +
        "Generate predictions with `scripts/bench-opf.sh` and re-run with `--opf`._",
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const piiPath = arg("--pii") ?? join(FIX, "grimnir-pii.jsonl");
  const cleanPath = arg("--clean") ?? join(FIX, "clean-technical.jsonl");
  const opfPath = arg("--opf");
  const timingsPath = arg("--timings");
  const mdPath = arg("--md");
  const jsonPath = arg("--json");

  const examples = loadFixtures(piiPath, cleanPath);
  const regexPreds = regexPredictions(examples);
  const reports: ScoreReport[] = [scoreDetector("regex-baseline", regexPreds)];

  if (opfPath) {
    const { preds, missing } = opfPredictions(examples, opfPath);
    if (missing.length) {
      console.error(
        `WARNING: OPF predictions missing for ${missing.length} example(s): ${missing
          .slice(0, 5)
          .join(", ")}${missing.length > 5 ? "…" : ""} (scored as zero-detection).`,
      );
    }
    reports.push(scoreDetector("opf", preds));

    // Union (regex ∪ OPF): the defense-in-depth configuration. Per example,
    // combine both detectors' spans, dropping exact (label,start,end) dupes.
    // Detection recall of the union is the practical leak-prevention ceiling.
    const union: ExamplePrediction[] = examples.map((example, i) => {
      const seen = new Set<string>();
      const merged = [...regexPreds[i].predicted, ...preds[i].predicted].filter((s) => {
        const k = `${s.label}:${s.start}:${s.end}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return { example, predicted: merged };
    });
    reports.push(scoreDetector("regex ∪ opf", union));
  }

  let timings: Timings | null = null;
  if (timingsPath) timings = JSON.parse(readFileSync(timingsPath, "utf8")) as Timings;

  const md = renderReport(reports, timings);
  process.stdout.write(md + "\n");

  if (mdPath) {
    writeFileSync(mdPath, md, "utf8");
    console.error(`Wrote markdown report → ${mdPath}`);
  }
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ reports, timings }, null, 2), "utf8");
    console.error(`Wrote JSON report → ${jsonPath}`);
  }
}

main();
