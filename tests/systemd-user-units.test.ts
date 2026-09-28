import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const USER_UNITS = [
  "hugin.service",
  "systemd/hugin-daily-exam-factory.service",
  "systemd/hugin-experiment-cadence.service",
];

const RETIRED_DAILY_ANALYSIS_ARTIFACTS = [
  "systemd/hugin-daily-analysis.service",
  "systemd/hugin-daily-analysis.timer",
  "scripts/submit-daily-analysis.sh",
  "scripts/build-daily-analysis-input.mjs",
  "tests/daily-analysis-input.test.ts",
];

describe("systemd user services", () => {
  it.each(USER_UNITS)("%s inherits the user manager identity", (unitPath) => {
    const unit = readFileSync(resolve(unitPath), "utf8");

    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/^Group=/m);
    expect(unit).not.toMatch(/^SupplementaryGroups=/m);
  });

  it.each(RETIRED_DAILY_ANALYSIS_ARTIFACTS)("does not retain %s", (artifactPath) => {
    expect(existsSync(resolve(artifactPath))).toBe(false);
  });
});

describe("hugin.service PATH (issue #390)", () => {
  it("orders .npm-global/bin before .local/bin so the pinned research Pi wins", () => {
    const unit = readFileSync(resolve("hugin.service"), "utf8");
    const match = unit.match(/^Environment=PATH=(.+)$/m);
    expect(match).not.toBeNull();
    const entries = (match as RegExpMatchArray)[1].split(":");

    const npmGlobalIndex = entries.indexOf("/home/magnus/.npm-global/bin");
    const localBinIndex = entries.indexOf("/home/magnus/.local/bin");

    expect(npmGlobalIndex).toBeGreaterThanOrEqual(0);
    expect(localBinIndex).toBeGreaterThanOrEqual(0);
    expect(npmGlobalIndex).toBeLessThan(localBinIndex);
  });
});
