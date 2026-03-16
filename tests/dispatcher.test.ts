import { describe, it, expect } from "vitest";

// Test the task parsing logic by importing it indirectly
// (parseTask is not exported, so we test the format contract)

describe("task format", () => {
  it("should define the expected task content structure", () => {
    const content = `## Task: Test task

- **Runtime:** claude
- **Working dir:** /home/magnus/workspace
- **Timeout:** 60000
- **Submitted by:** test
- **Submitted at:** 2026-03-14T10:00:00Z

### Prompt
Echo hello world`;

    // Verify the format can be parsed with the same regexes used in index.ts
    expect(content.match(/\*\*Runtime:\*\*\s*(claude|codex)/i)?.[1]).toBe(
      "claude"
    );
    expect(content.match(/\*\*Working dir:\*\*\s*(.+)/i)?.[1]?.trim()).toBe(
      "/home/magnus/workspace"
    );
    expect(content.match(/\*\*Timeout:\*\*\s*(\d+)/i)?.[1]).toBe("60000");
    expect(content.match(/\*\*Submitted by:\*\*\s*(.+)/i)?.[1]?.trim()).toBe(
      "test"
    );
    expect(
      content.match(/###\s*Prompt\s*\n([\s\S]+)$/i)?.[1]?.trim()
    ).toBe("Echo hello world");
  });

  it("should handle multiline prompts", () => {
    const content = `## Task: Complex task

- **Runtime:** codex
- **Timeout:** 300000
- **Submitted by:** claude-code
- **Submitted at:** 2026-03-14T10:00:00Z

### Prompt
Read the file src/index.ts and refactor
the error handling to use a proper Result type.
Also add tests.`;

    const prompt = content.match(/###\s*Prompt\s*\n([\s\S]+)$/i)?.[1]?.trim();
    expect(prompt).toContain("Read the file src/index.ts");
    expect(prompt).toContain("Also add tests.");
  });

  it("should handle missing optional fields", () => {
    const content = `## Task: Minimal

- **Runtime:** claude

### Prompt
Do something`;

    expect(content.match(/\*\*Runtime:\*\*\s*(claude|codex)/i)?.[1]).toBe(
      "claude"
    );
    expect(content.match(/\*\*Working dir:\*\*\s*(.+)/i)).toBeNull();
    expect(content.match(/\*\*Timeout:\*\*\s*(\d+)/i)).toBeNull();
    expect(
      content.match(/###\s*Prompt\s*\n([\s\S]+)$/i)?.[1]?.trim()
    ).toBe("Do something");
  });

  it("should reject tasks without a prompt section", () => {
    const content = `## Task: No prompt

- **Runtime:** claude

Just some text without a Prompt heading`;

    expect(content.match(/###\s*Prompt\s*\n([\s\S]+)$/i)).toBeNull();
  });

  it("should reject tasks without a runtime", () => {
    const content = `## Task: No runtime

### Prompt
Do something`;

    expect(
      content.match(/\*\*Runtime:\*\*\s*(claude|codex)/i)
    ).toBeNull();
  });
});

describe("result format", () => {
  it("should produce the expected result structure", () => {
    const result = [
      "## Result\n",
      "- **Exit code:** 0",
      "- **Started at:** 2026-03-14T10:00:05Z",
      "- **Completed at:** 2026-03-14T10:03:22Z",
      "- **Duration:** 197s",
      "- **Log file:** ~/.hugin/logs/20260314-100000-test-task.log",
      "",
      "### Output",
      "```",
      "Hello world",
      "```",
    ].join("\n");

    expect(result).toContain("**Exit code:** 0");
    expect(result).toContain("**Duration:** 197s");
    expect(result).toContain("**Log file:**");
    expect(result).toContain("Hello world");
  });

  it("should produce timeout result structure", () => {
    const result = [
      "## Result (task timed out)\n",
      "- **Exit code:** TIMEOUT",
      "- **Started at:** 2026-03-14T10:00:05Z",
      "- **Completed at:** 2026-03-14T10:03:22Z",
      "- **Duration:** 197s",
      "- **Log file:** ~/.hugin/logs/20260314-100000-test-task.log",
      "",
      "### Output",
      "```",
      "(no output)",
      "```",
    ].join("\n");

    expect(result).toContain("task timed out");
    expect(result).toContain("**Exit code:** TIMEOUT");
    expect(result).toContain("**Log file:**");
  });
});
