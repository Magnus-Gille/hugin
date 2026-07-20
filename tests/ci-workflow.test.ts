import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("CI workflow", () => {
  it("does not invoke deleted shell test files", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const shellTests = [...workflow.matchAll(/^\s*-\s+run:\s+bash\s+([^\s]+)\s*$/gm)].map(
      (match) => match[1],
    );

    expect(shellTests.length).toBeGreaterThan(0);
    for (const file of shellTests) {
      expect(existsSync(file), `CI target does not exist: ${file}`).toBe(true);
    }
  });
});
