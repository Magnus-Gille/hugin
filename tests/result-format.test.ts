import { describe, expect, it } from "vitest";
import { buildTaskResultDocument } from "../src/result-format.js";

describe("task result formatting", () => {
  it("omits empty placeholder lines for absent optional metadata", () => {
    const result = buildTaskResultDocument({
      exitCode: 0,
      startedAt: "2026-04-02T08:50:59.124Z",
      completedAt: "2026-04-02T08:51:02.092Z",
      durationSeconds: 3,
      executor: "ollama",
      resultSource: "ollama",
      logFile: "~/.hugin/logs/test.log",
      body: "### Response\n\nSTEP2_SYNTHESIZE",
    });

    expect(result).toContain("- **Log file:** ~/.hugin/logs/test.log\n\n### Response");
    expect(result).not.toContain("- **Log file:** ~/.hugin/logs/test.log\n\n\n");
  });

  it("renders routing metadata when present", () => {
    const result = buildTaskResultDocument({
      exitCode: 0,
      startedAt: "2026-04-02T08:50:59.124Z",
      completedAt: "2026-04-02T08:51:02.092Z",
      durationSeconds: 3,
      executor: "ollama",
      resultSource: "ollama",
      logFile: "~/.hugin/logs/test.log",
      replyTo: "telegram:12345",
      replyFormat: "summary",
      group: "pipeline:abc",
      sequence: 2,
      body: "### Response\n\nSTEP2_SYNTHESIZE",
    });

    expect(result).toContain("- **Reply-to:** telegram:12345");
    expect(result).toContain("- **Reply-format:** summary");
    expect(result).toContain("- **Group:** pipeline:abc");
    expect(result).toContain("- **Sequence:** 2");
  });

  it("renders a homeserver non-execution failure kind", () => {
    const result = buildTaskResultDocument({
      exitCode: 1,
      failureKind: "HOMESERVER_ESCALATED",
      startedAt: "2026-09-28T08:50:59.124Z",
      completedAt: "2026-09-28T08:51:02.092Z",
      durationSeconds: 3,
      executor: "homeserver-delegate",
      resultSource: "homeserver-delegate",
      logFile: "~/.hugin/logs/escalated.log",
      body: "[Homeserver delegation not executed locally: route gap → escalate]",
    });

    expect(result).toContain("- **Exit code:** 1");
    expect(result).toContain("- **Failure kind:** HOMESERVER_ESCALATED");
    expect(result).toContain("route gap → escalate");
  });
});
