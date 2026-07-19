import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const staleArchiveLinks = [
  ["docs/daily-exam-factory.md", "https://github.com/Magnus-Gille/gille-inference/issues/257"],
  ["docs/continuous-learning-loop.md", "https://github.com/Magnus-Gille/gille-inference/issues/247"],
  ["docs/research/m5-task-solver-dogfood-2026-07.md", "https://github.com/Magnus-Gille/heimdall/pull/122"],
] as const;

describe("clean-history publication links", () => {
  it.each(staleArchiveLinks)("does not publish archived tracker URL in %s", (file, url) => {
    expect(readFileSync(file, "utf8")).not.toContain(url);
  });
});
