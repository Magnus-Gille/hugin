#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const journalPath = process.argv[2];
const nowMs = process.argv[3] ? Date.parse(process.argv[3]) : Date.now();
if (!journalPath || !Number.isFinite(nowMs)) {
  console.error("usage: build-daily-analysis-input.mjs JOURNAL_PATH [NOW_ISO]");
  process.exit(2);
}

const sinceMs = nowMs - 24 * 60 * 60 * 1_000;
const runtimeNames = [
  "claude",
  "codex",
  "ollama",
  "homeserver",
  "opencode",
  "orchestrator",
  "other",
];
const runtimes = Object.fromEntries(
  runtimeNames.map((name) => [
    name,
    {
      tasks: 0,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      duration_samples: 0,
      duration_sum_s: 0,
      max_duration_s: 0,
    },
  ]),
);
const quota = {
  q5: { first: null, last: null, min: null, max: null },
  q7: { first: null, last: null, min: null, max: null },
};
const longest = [];
let entries = 0;
let invalidLines = 0;
let succeeded = 0;
let failed = 0;
let timedOut = 0;
let totalCostUsd = 0;
let costSamples = 0;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeFiniteNumber(value) {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

function roundFinite(value, digits) {
  return Number(value.toFixed(digits));
}

function observeQuota(name, value) {
  const numeric = finiteNumber(value);
  if (numeric === null) return;
  const target = quota[name];
  if (target.first === null) target.first = numeric;
  target.last = numeric;
  target.min = target.min === null ? numeric : Math.min(target.min, numeric);
  target.max = target.max === null ? numeric : Math.max(target.max, numeric);
}

function observeLongest(event, durationS, outcome) {
  longest.push({
    task_id: String(event.task_id ?? "unknown").slice(0, 120),
    runtime: String(event.runtime ?? "unknown").slice(0, 40),
    duration_s: durationS,
    outcome,
  });
  longest.sort((a, b) => b.duration_s - a.duration_s);
  if (longest.length > 5) longest.length = 5;
}

const lines = createInterface({
  input: createReadStream(journalPath, { encoding: "utf8" }),
  crlfDelay: Infinity,
});

for await (const line of lines) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    invalidLines += 1;
    continue;
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    invalidLines += 1;
    continue;
  }
  const tsMs = Date.parse(event.ts);
  if (!Number.isFinite(tsMs) || tsMs <= sinceMs || tsMs > nowMs) continue;

  entries += 1;
  const runtime = runtimeNames.includes(event.runtime) ? event.runtime : "other";
  const row = runtimes[runtime];
  row.tasks += 1;

  const timeout = event.exit_code === "TIMEOUT";
  const success = event.exit_code === 0;
  const outcome = timeout ? "timed_out" : success ? "succeeded" : "failed";
  if (timeout) {
    timedOut += 1;
    row.timed_out += 1;
  } else if (success) {
    succeeded += 1;
    row.succeeded += 1;
  } else {
    failed += 1;
    row.failed += 1;
  }

  const durationS = nonNegativeFiniteNumber(event.duration_s);
  if (durationS !== null) {
    const durationSum = row.duration_sum_s + durationS;
    if (Number.isFinite(durationSum)) {
      row.duration_samples += 1;
      row.duration_sum_s = durationSum;
      row.max_duration_s = Math.max(row.max_duration_s, durationS);
      observeLongest(event, durationS, outcome);
    }
  }

  const cost = nonNegativeFiniteNumber(event.cost_usd);
  if (cost !== null) {
    const costTotal = totalCostUsd + cost;
    if (Number.isFinite(costTotal)) {
      totalCostUsd = costTotal;
      costSamples += 1;
    }
  }
  observeQuota("q5", event.quota_before?.q5);
  observeQuota("q5", event.quota_after?.q5);
  observeQuota("q7", event.quota_before?.q7);
  observeQuota("q7", event.quota_after?.q7);
}

const byRuntime = {};
for (const [name, row] of Object.entries(runtimes)) {
  if (row.tasks === 0) continue;
  byRuntime[name] = {
    tasks: row.tasks,
    succeeded: row.succeeded,
    failed: row.failed,
    timed_out: row.timed_out,
    average_duration_s: row.duration_samples === 0
      ? null
      : roundFinite(row.duration_sum_s / row.duration_samples, 1),
    max_duration_s: row.duration_samples === 0 ? null : row.max_duration_s,
  };
}

const rate = (count) => entries === 0 ? null : Math.round((count / entries) * 10_000) / 100;
process.stdout.write(JSON.stringify({
  window: {
    since: new Date(sinceMs).toISOString(),
    until: new Date(nowMs).toISOString(),
  },
  entries,
  invalid_lines: invalidLines,
  outcomes: {
    succeeded,
    failed,
    timed_out: timedOut,
    success_rate_pct: rate(succeeded),
    failure_rate_pct: rate(failed + timedOut),
  },
  by_runtime: byRuntime,
  cost: {
    total_usd: roundFinite(totalCostUsd, 6),
    samples: costSamples,
    missing: entries - costSamples,
  },
  quota,
  longest_tasks: longest,
}, null, 2));
