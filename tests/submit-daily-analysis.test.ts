import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), "utf8");
}

describe("submit-daily-analysis prompt contract", () => {
  it("pins a Telegram-safe compact output format within the 192-token budget", () => {
    const script = readRepoFile("scripts/submit-daily-analysis.sh");

    expect(script).toContain("- **Max output tokens:** 192");
    expect(script).not.toContain("Use markdown tables where appropriate.");
    expect(script).toMatch(/No markdown tables/i);
    expect(script).toMatch(/compact prose|key-value lines/i);
    expect(script).toMatch(/read cleanly if line breaks collapse to spaces/i);
    expect(script).toContain(
      "Front-load total tasks, success rate, failure rate, average duration or runtime summary, cost, and the most important anomaly.",
    );
    expect(script).toMatch(/quota trend/i);
    expect(script).not.toContain("Keep the entire answer under 160 words.");
    expect(script).toContain("Keep the entire answer under 120 words.");
  });

  it("documents the actual repository timer as 07:00 local time", () => {
    const script = readRepoFile("scripts/submit-daily-analysis.sh");
    const timer = readRepoFile("systemd/hugin-daily-analysis.timer");

    expect(timer).toContain("OnCalendar=*-*-* 07:00:00");
    expect(script).toContain(
      "# Intended to run via systemd timer at 07:00 local time daily.",
    );
  });
});
