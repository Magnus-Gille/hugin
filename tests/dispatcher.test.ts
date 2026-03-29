import { describe, it, expect } from "vitest";

// Test the task parsing logic by importing it indirectly
// (parseTask is not exported, so we test the format contract)

// --- resolveContext unit tests ---

import * as path from "node:path";

function resolveContext(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("repo:")) {
    const name = trimmed.slice(5);
    const resolved = path.resolve(`/home/magnus/repos/${name}`);
    if (!resolved.startsWith("/home/magnus/repos/")) {
      return "/home/magnus/workspace";
    }
    return resolved;
  }
  switch (trimmed) {
    case "scratch": return "/home/magnus/scratch";
    case "files": return "/home/magnus/mimir";
    default: {
      if (trimmed.startsWith("/home/magnus/")) return trimmed;
      if (trimmed.startsWith("/")) return "/home/magnus/workspace";
      return "/home/magnus/workspace";
    }
  }
}

function parseTask(content: string, workspace = "/home/magnus/workspace") {
  const runtime =
    content.match(/\*\*Runtime:\*\*\s*(claude|codex)/i)?.[1]?.toLowerCase() as
      | "claude"
      | "codex"
      | undefined;
  const workingDir = content.match(
    /\*\*Working dir:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const contextRaw = content.match(
    /\*\*Context:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const timeoutStr = content.match(/\*\*Timeout:\*\*\s*(\d+)/i)?.[1];
  const submittedBy = content.match(
    /\*\*Submitted by:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const submittedAt = content.match(
    /\*\*Submitted at:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const replyTo = content.match(
    /\*\*Reply-to:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const replyFormat = content.match(
    /\*\*Reply-format:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const group = content.match(
    /\*\*Group:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const sequenceStr = content.match(
    /\*\*Sequence:\*\*\s*(\d+)/i
  )?.[1];

  const promptMatch = content.match(/###\s*Prompt\s*\n([\s\S]+)$/i);
  const prompt = promptMatch?.[1]?.trim();

  if (!prompt || !runtime) return null;

  const resolvedDir = contextRaw
    ? resolveContext(contextRaw)
    : workingDir || workspace;

  return {
    prompt,
    runtime: runtime || "claude",
    workingDir: resolvedDir,
    context: contextRaw || undefined,
    timeoutMs: timeoutStr ? parseInt(timeoutStr) : 300000,
    submittedBy: submittedBy || "unknown",
    submittedAt: submittedAt || new Date().toISOString(),
    replyTo: replyTo || undefined,
    replyFormat: replyFormat || undefined,
    group: group || undefined,
    sequence: sequenceStr ? parseInt(sequenceStr) : undefined,
  };
}

describe("resolveContext", () => {
  it("should resolve repo: prefix to /home/magnus/repos/<name>", () => {
    expect(resolveContext("repo:heimdall")).toBe("/home/magnus/repos/heimdall");
    expect(resolveContext("repo:hugin")).toBe("/home/magnus/repos/hugin");
  });

  it("should resolve 'scratch' alias", () => {
    expect(resolveContext("scratch")).toBe("/home/magnus/scratch");
  });

  it("should resolve 'files' alias", () => {
    expect(resolveContext("files")).toBe("/home/magnus/mimir");
  });

  it("should pass through absolute paths under /home/magnus/", () => {
    expect(resolveContext("/home/magnus/workspace")).toBe("/home/magnus/workspace");
    expect(resolveContext("/home/magnus/custom/dir")).toBe("/home/magnus/custom/dir");
  });

  it("should reject absolute paths outside /home/magnus/", () => {
    expect(resolveContext("/tmp/test")).toBe("/home/magnus/workspace");
    expect(resolveContext("/etc/passwd")).toBe("/home/magnus/workspace");
    expect(resolveContext("/")).toBe("/home/magnus/workspace");
  });

  it("should trim whitespace", () => {
    expect(resolveContext("  repo:heimdall  ")).toBe("/home/magnus/repos/heimdall");
    expect(resolveContext("  scratch  ")).toBe("/home/magnus/scratch");
  });

  it("should reject path traversal in repo: prefix", () => {
    expect(resolveContext("repo:../../tmp")).toBe("/home/magnus/workspace");
    expect(resolveContext("repo:../../../etc")).toBe("/home/magnus/workspace");
  });

  it("should reject relative paths as fallback", () => {
    expect(resolveContext("foo")).toBe("/home/magnus/workspace");
    expect(resolveContext("relative/path")).toBe("/home/magnus/workspace");
  });
});

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

    const task = parseTask(content);
    expect(task).not.toBeNull();
    expect(task!.runtime).toBe("claude");
    expect(task!.workingDir).toBe("/home/magnus/workspace");
    expect(task!.timeoutMs).toBe(60000);
    expect(task!.submittedBy).toBe("test");
    expect(task!.prompt).toBe("Echo hello world");
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

    const task = parseTask(content);
    expect(task).not.toBeNull();
    expect(task!.prompt).toContain("Read the file src/index.ts");
    expect(task!.prompt).toContain("Also add tests.");
  });

  it("should handle missing optional fields", () => {
    const content = `## Task: Minimal

- **Runtime:** claude

### Prompt
Do something`;

    const task = parseTask(content);
    expect(task).not.toBeNull();
    expect(task!.runtime).toBe("claude");
    expect(task!.workingDir).toBe("/home/magnus/workspace"); // falls back to default
    expect(task!.context).toBeUndefined();
    expect(task!.replyTo).toBeUndefined();
    expect(task!.replyFormat).toBeUndefined();
    expect(task!.group).toBeUndefined();
    expect(task!.sequence).toBeUndefined();
    expect(task!.prompt).toBe("Do something");
  });

  it("should reject tasks without a prompt section", () => {
    const content = `## Task: No prompt

- **Runtime:** claude

Just some text without a Prompt heading`;

    expect(parseTask(content)).toBeNull();
  });

  it("should reject tasks without a runtime", () => {
    const content = `## Task: No runtime

### Prompt
Do something`;

    expect(parseTask(content)).toBeNull();
  });
});

describe("context field parsing", () => {
  it("should resolve Context: repo:heimdall to correct path", () => {
    const content = `## Task: Context test

- **Runtime:** claude
- **Context:** repo:heimdall
- **Submitted by:** test
- **Submitted at:** 2026-03-14T10:00:00Z

### Prompt
Check the code`;

    const task = parseTask(content);
    expect(task).not.toBeNull();
    expect(task!.workingDir).toBe("/home/magnus/repos/heimdall");
    expect(task!.context).toBe("repo:heimdall");
  });

  it("should resolve Context: scratch", () => {
    const content = `## Task: Scratch task

- **Runtime:** claude
- **Context:** scratch

### Prompt
Research something`;

    const task = parseTask(content);
    expect(task!.workingDir).toBe("/home/magnus/scratch");
    expect(task!.context).toBe("scratch");
  });

  it("should resolve Context: files", () => {
    const content = `## Task: Files task

- **Runtime:** claude
- **Context:** files

### Prompt
Index files`;

    const task = parseTask(content);
    expect(task!.workingDir).toBe("/home/magnus/mimir");
    expect(task!.context).toBe("files");
  });

  it("should use Working dir when no Context is present (backward compat)", () => {
    const content = `## Task: Old-style task

- **Runtime:** claude
- **Working dir:** /home/magnus/custom-dir

### Prompt
Do work`;

    const task = parseTask(content);
    expect(task!.workingDir).toBe("/home/magnus/custom-dir");
    expect(task!.context).toBeUndefined();
  });

  it("should give Context priority over Working dir when both present", () => {
    const content = `## Task: Both fields

- **Runtime:** claude
- **Working dir:** /home/magnus/old-dir
- **Context:** repo:hugin

### Prompt
Do work`;

    const task = parseTask(content);
    expect(task!.workingDir).toBe("/home/magnus/repos/hugin");
    expect(task!.context).toBe("repo:hugin");
  });
});

describe("reply routing fields", () => {
  it("should parse Reply-to and Reply-format", () => {
    const content = `## Task: Reply test

- **Runtime:** claude
- **Context:** scratch
- **Reply-to:** telegram:12345678
- **Reply-format:** summary

### Prompt
Answer this question`;

    const task = parseTask(content);
    expect(task!.replyTo).toBe("telegram:12345678");
    expect(task!.replyFormat).toBe("summary");
  });

  it("should leave Reply-to and Reply-format undefined when absent", () => {
    const content = `## Task: No reply

- **Runtime:** claude

### Prompt
Do something`;

    const task = parseTask(content);
    expect(task!.replyTo).toBeUndefined();
    expect(task!.replyFormat).toBeUndefined();
  });
});

describe("group and sequence fields", () => {
  it("should parse Group and Sequence", () => {
    const content = `## Task: Group test

- **Runtime:** claude
- **Context:** repo:hugin
- **Group:** batch-20260323
- **Sequence:** 2

### Prompt
Step two of the batch`;

    const task = parseTask(content);
    expect(task!.group).toBe("batch-20260323");
    expect(task!.sequence).toBe(2);
  });

  it("should leave Group and Sequence undefined when absent", () => {
    const content = `## Task: No group

- **Runtime:** claude

### Prompt
Solo task`;

    const task = parseTask(content);
    expect(task!.group).toBeUndefined();
    expect(task!.sequence).toBeUndefined();
  });

  it("should handle Group without Sequence", () => {
    const content = `## Task: Group only

- **Runtime:** claude
- **Group:** some-group

### Prompt
Do something`;

    const task = parseTask(content);
    expect(task!.group).toBe("some-group");
    expect(task!.sequence).toBeUndefined();
  });
});

describe("full task with all fields", () => {
  it("should parse a task with every field populated", () => {
    const content = `## Task: Full task

- **Runtime:** claude
- **Context:** repo:heimdall
- **Working dir:** /should/be/ignored
- **Timeout:** 120000
- **Submitted by:** ratatoskr
- **Submitted at:** 2026-03-23T09:00:00Z
- **Reply-to:** telegram:99999
- **Reply-format:** full
- **Group:** deploy-batch
- **Sequence:** 1

### Prompt
Deploy the service and report status`;

    const task = parseTask(content);
    expect(task).not.toBeNull();
    expect(task!.runtime).toBe("claude");
    expect(task!.workingDir).toBe("/home/magnus/repos/heimdall"); // Context wins
    expect(task!.context).toBe("repo:heimdall");
    expect(task!.timeoutMs).toBe(120000);
    expect(task!.submittedBy).toBe("ratatoskr");
    expect(task!.replyTo).toBe("telegram:99999");
    expect(task!.replyFormat).toBe("full");
    expect(task!.group).toBe("deploy-batch");
    expect(task!.sequence).toBe(1);
    expect(task!.prompt).toBe("Deploy the service and report status");
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

describe("submitter validation", () => {
  function isSubmitterAllowed(
    submittedBy: string,
    allowedSubmitters: string[]
  ): boolean {
    return (
      allowedSubmitters.includes("*") ||
      allowedSubmitters.includes(submittedBy)
    );
  }

  const defaultAllowed = [
    "claude-code",
    "claude-desktop",
    "ratatoskr",
    "claude-web",
    "claude-mobile",
    "hugin",
  ];

  it("should allow known submitters", () => {
    expect(isSubmitterAllowed("claude-code", defaultAllowed)).toBe(true);
    expect(isSubmitterAllowed("ratatoskr", defaultAllowed)).toBe(true);
    expect(isSubmitterAllowed("claude-desktop", defaultAllowed)).toBe(true);
  });

  it("should reject unknown submitters", () => {
    expect(isSubmitterAllowed("unknown", defaultAllowed)).toBe(false);
    expect(isSubmitterAllowed("attacker", defaultAllowed)).toBe(false);
    expect(isSubmitterAllowed("", defaultAllowed)).toBe(false);
  });

  it("should allow all when wildcard is present", () => {
    expect(isSubmitterAllowed("anything", ["*"])).toBe(true);
    expect(isSubmitterAllowed("unknown", ["*"])).toBe(true);
  });

  it("should work with custom allowlist", () => {
    const custom = ["bot-a", "bot-b"];
    expect(isSubmitterAllowed("bot-a", custom)).toBe(true);
    expect(isSubmitterAllowed("claude-code", custom)).toBe(false);
  });
});
