import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/experiment-cadence-cli.js";

describe("experiment cadence CLI arg parsing", () => {
  it("--candidates is optional -- absent means the default assembler is used", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, candidatesPath: undefined });
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true, candidatesPath: undefined });
  });

  it("parses --candidates", () => {
    expect(parseArgs(["--candidates", "/tmp/pool.json"])).toEqual({
      dryRun: false,
      candidatesPath: "/tmp/pool.json",
    });
  });

  it("parses --dry-run alongside --candidates", () => {
    expect(parseArgs(["--candidates", "/tmp/pool.json", "--dry-run"])).toEqual({
      dryRun: true,
      candidatesPath: "/tmp/pool.json",
    });
  });

  it("requires a value for --candidates", () => {
    expect(() => parseArgs(["--candidates"])).toThrow("--candidates requires a value");
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["--candidates", "/tmp/pool.json", "--bogus"])).toThrow("unknown option");
  });
});
