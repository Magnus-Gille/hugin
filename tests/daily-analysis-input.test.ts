import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runSummary(lines: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-daily-analysis-"));
  tempDirs.push(dir);
  const journal = path.join(dir, "journal.jsonl");
  fs.writeFileSync(journal, lines.join("\n") + "\n");
  const output = execFileSync(
    process.execPath,
    [
      path.resolve("scripts/build-daily-analysis-input.mjs"),
      journal,
      "2026-07-13T12:00:00.000Z",
    ],
    { encoding: "utf8" },
  );
  return { parsed: JSON.parse(output), output };
}

describe("bounded Daily Analysis evidence", () => {
  it("aggregates outcomes, runtimes, cost, quota, and longest tasks", () => {
    const { parsed } = runSummary([
      JSON.stringify({
        ts: "2026-07-13T10:00:00.000Z",
        task_id: "ok",
        runtime: "claude",
        exit_code: 0,
        duration_s: 10,
        cost_usd: 0.25,
        quota_before: { q5: 10, q7: 20 },
        quota_after: { q5: 11, q7: 21 },
      }),
      JSON.stringify({
        ts: "2026-07-13T11:00:00.000Z",
        task_id: "slow",
        runtime: "ollama",
        exit_code: "TIMEOUT",
        duration_s: 300,
        cost_usd: null,
      }),
      // Outside the 24h window and therefore excluded.
      JSON.stringify({
        ts: "2026-07-11T11:00:00.000Z",
        task_id: "old",
        runtime: "codex",
        exit_code: 1,
        duration_s: 1,
      }),
    ]);

    expect(parsed.entries).toBe(2);
    expect(parsed.outcomes).toMatchObject({
      succeeded: 1,
      failed: 0,
      timed_out: 1,
      success_rate_pct: 50,
      failure_rate_pct: 50,
    });
    expect(parsed.by_runtime.claude.average_duration_s).toBe(10);
    expect(parsed.by_runtime.ollama.timed_out).toBe(1);
    expect(parsed.cost).toEqual({ total_usd: 0.25, samples: 1, missing: 1 });
    expect(parsed.quota.q5).toEqual({ first: 10, last: 11, min: 10, max: 11 });
    expect(parsed.longest_tasks[0].task_id).toBe("slow");
  });

  it("counts malformed and non-object JSON as invalid without aborting", () => {
    const { parsed } = runSummary([
      "{not-json",
      "null",
      "[]",
      '"string"',
      "42",
      JSON.stringify({
        ts: "2026-07-13T10:00:00.000Z",
        task_id: "valid",
        runtime: "claude",
        exit_code: 0,
        duration_s: 4,
        cost_usd: 0.01,
      }),
    ]);

    expect(parsed.invalid_lines).toBe(5);
    expect(parsed.entries).toBe(1);
    expect(parsed.outcomes.succeeded).toBe(1);
    expect(parsed.longest_tasks).toEqual([
      { task_id: "valid", runtime: "claude", duration_s: 4, outcome: "succeeded" },
    ]);
  });

  it("ignores negative, non-finite, and overflowing aggregate samples", () => {
    const { parsed } = runSummary([
      JSON.stringify({
        ts: "2026-07-13T09:00:00.000Z",
        task_id: "negative",
        runtime: "claude",
        exit_code: 0,
        duration_s: -1,
        cost_usd: -1,
      }),
      '{"ts":"2026-07-13T10:00:00.000Z","task_id":"non-finite","runtime":"claude","exit_code":0,"duration_s":1e309,"cost_usd":1e309}',
      '{"ts":"2026-07-13T11:00:00.000Z","task_id":"huge-1","runtime":"ollama","exit_code":0,"duration_s":1e308,"cost_usd":1e308}',
      '{"ts":"2026-07-13T11:30:00.000Z","task_id":"huge-2","runtime":"ollama","exit_code":0,"duration_s":1e308,"cost_usd":1e308}',
    ]);

    expect(parsed.entries).toBe(4);
    expect(parsed.by_runtime.claude).toMatchObject({
      average_duration_s: null,
      max_duration_s: null,
    });
    expect(parsed.by_runtime.ollama).toMatchObject({
      average_duration_s: 1e308,
      max_duration_s: 1e308,
    });
    expect(parsed.cost).toEqual({ total_usd: 1e308, samples: 1, missing: 3 });
    expect(parsed.longest_tasks).toHaveLength(1);
  });

  it("keeps model input bounded as journal volume grows", () => {
    const rows = Array.from({ length: 2_000 }, (_, index) =>
      JSON.stringify({
        ts: "2026-07-13T10:00:00.000Z",
        task_id: `task-${index}`,
        runtime: index % 2 ? "ollama" : "claude",
        exit_code: index % 10 === 0 ? "TIMEOUT" : 0,
        duration_s: index,
        cost_usd: null,
      }),
    );
    const { parsed, output } = runSummary(rows);

    expect(parsed.entries).toBe(2_000);
    expect(parsed.longest_tasks).toHaveLength(5);
    expect(output.length).toBeLessThan(5_000);
  });
});
