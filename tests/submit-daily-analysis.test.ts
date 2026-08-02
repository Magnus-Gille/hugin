import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), "utf8");
}

describe("submit-daily-analysis prompt contract", () => {
  it("preserves the retired Telegram-safe output contract in historical documentation", () => {
    const scopingDoc = readRepoFile("docs/research/journal-analysis-scoping.md");

    expect(scopingDoc).toContain("Historical draft");
    expect(scopingDoc).toMatch(
      /not an active[\s>]+operational path or a specification to restore the retired daily timer\./i,
    );
    expect(scopingDoc).toMatch(/No markdown tables/i);
    expect(scopingDoc).toMatch(/compact prose|key-value lines/i);
    expect(scopingDoc).toMatch(/read cleanly if line breaks collapse to spaces/i);
    expect(scopingDoc).toMatch(
      /Front-load total tasks, success rate, failure rate, average duration or[\s-]+runtime summary, cost, and the most important anomaly\./,
    );
    expect(scopingDoc).toMatch(/quota trend/i);
    expect(scopingDoc).toContain("Keep the entire answer under 120 words.");
  });
});
