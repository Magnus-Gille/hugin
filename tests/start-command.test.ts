import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("documented local startup contract", () => {
  it("loads the .env created by the README quick start", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
      engines: { node: string };
    };
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toMatch(/cp \.env\.example \.env[\s\S]*npm start/);
    expect(pkg.scripts.start).toContain("--env-file=.env");
    expect(pkg.scripts.dev).toContain("--env-file=.env");
    expect(pkg.engines.node).toBe(">=20.6");
  });
});
