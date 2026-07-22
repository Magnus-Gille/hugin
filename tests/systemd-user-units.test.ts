import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const USER_UNITS = [
  "hugin.service",
  "systemd/hugin-daily-analysis.service",
  "systemd/hugin-daily-exam-factory.service",
  "systemd/hugin-experiment-cadence.service",
];

describe("systemd user services", () => {
  it.each(USER_UNITS)("%s inherits the user manager identity", (unitPath) => {
    const unit = readFileSync(resolve(unitPath), "utf8");

    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/^Group=/m);
    expect(unit).not.toMatch(/^SupplementaryGroups=/m);
  });
});
