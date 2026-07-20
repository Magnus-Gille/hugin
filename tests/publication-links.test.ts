import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

  it("uses the canonical GitHub organization in every public Markdown link", () => {
    const markdownFiles = ["README.md", ...findMarkdownFiles("docs")];
    const legacyOwner = /https:\/\/github\.com\/magnusgille\//i;

    for (const file of markdownFiles) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(legacyOwner);
    }
    expect(readFileSync("README.md", "utf8")).toContain(
      "https://github.com/Magnus-Gille/munin-memory"
    );
  });
});

function findMarkdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findMarkdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}
