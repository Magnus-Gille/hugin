import { describe, expect, it } from "vitest";
import { parseFrictionCliArgs } from "../../src/friction-cli.js";

describe("hugin-friction CLI", () => {
  it("maps flags into the shared friction schema", () => {
    expect(parseFrictionCliArgs([
      "--friction-type", "tool_failure",
      "--severity", "blocking",
      "--summary", "bubblewrap failed",
      "--detail", "AF_NETLINK was unavailable",
      "--task-id", "task-1",
      "--tool-name", "codex-exec",
      "--tag", "repo:cassette-ai",
      "--tag", "issue:hugin-218",
    ])).toEqual({
      friction_type: "tool_failure",
      severity: "blocking",
      summary: "bubblewrap failed",
      detail: "AF_NETLINK was unavailable",
      task_id: "task-1",
      tool_name: "codex-exec",
      tags: ["repo:cassette-ai", "issue:hugin-218"],
    });
  });

  it("returns null for help before enforcing required fields", () => {
    expect(parseFrictionCliArgs(["--help"])).toBeNull();
  });

  it("rejects unknown taxonomy values", () => {
    expect(() => parseFrictionCliArgs([
      "--friction-type", "made_up",
      "--severity", "high",
      "--summary", "bad",
      "--detail", "bad",
    ])).toThrow();
  });
});
