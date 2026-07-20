import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/publication-recovery-cli.js";

describe("publication recovery CLI arg parsing", () => {
  it("requires either --task or --all", () => {
    expect(() => parseArgs([])).toThrow("--task <taskId> or --all is required");
  });

  it("parses --task", () => {
    expect(parseArgs(["--task", "20260715t093850z-dogfood-cassette4"])).toEqual({
      all: false,
      taskId: "20260715t093850z-dogfood-cassette4",
      limit: 100,
    });
  });

  it("parses --all with a default limit", () => {
    expect(parseArgs(["--all"])).toEqual({ all: true, limit: 100 });
  });

  it("parses a custom --limit with --all", () => {
    expect(parseArgs(["--all", "--limit", "5"])).toEqual({ all: true, limit: 5 });
  });

  it("rejects --task and --all together", () => {
    expect(() => parseArgs(["--task", "t1", "--all"])).toThrow("mutually exclusive");
  });

  it("rejects an out-of-range limit", () => {
    expect(() => parseArgs(["--all", "--limit", "0"])).toThrow("--limit must be an integer");
    expect(() => parseArgs(["--all", "--limit", "10001"])).toThrow("--limit must be an integer");
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("unknown option");
  });
});
