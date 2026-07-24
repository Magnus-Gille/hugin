import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("CI workflow action runtime contract (#316)", () => {
  it("uses immutable Node 24-native action pins while preserving the Node 20 project runtime", async () => {
    const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

    expect(workflow).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1");
    expect(workflow).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0");
    expect(workflow).toContain("node-version: 20");
    expect(workflow).not.toMatch(/actions\/(checkout|setup-node)@v\d/);
  });
});
