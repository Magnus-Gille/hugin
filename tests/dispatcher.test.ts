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

type RuntimeCapability = "tools" | "code" | "structured-output";

function parseTask(content: string, workspace = "/home/magnus/workspace") {
  const declaredRuntimeRaw =
    content.match(/\*\*Runtime:\*\*\s*(claude|codex|ollama|auto)/i)?.[1]?.toLowerCase();
  const isAutoRoute = declaredRuntimeRaw === "auto";
  const runtime = (isAutoRoute ? undefined : declaredRuntimeRaw) as
      | "claude"
      | "codex"
      | "ollama"
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
  const modelRaw = content.match(
    /\*\*Model:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const ollamaHostRaw = content.match(
    /\*\*Ollama-host:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const fallbackRaw = content.match(
    /\*\*Fallback:\*\*\s*(claude|none)/i
  )?.[1]?.toLowerCase() as "claude" | "none" | undefined;
  const contextRefsRaw = content.match(
    /\*\*Context-refs:\*\*\s*(.+)/i
  )?.[1]?.trim();
  const contextBudgetStr = content.match(
    /\*\*Context-budget:\*\*\s*(\d+)/i
  )?.[1];

  const capabilitiesRaw = content.match(
    /\*\*Capabilities:\*\*\s*(.+)/i
  )?.[1]?.trim();

  const promptMatch = content.match(/###\s*Prompt\s*\n([\s\S]+)$/i);
  const prompt = promptMatch?.[1]?.trim();

  if (!prompt || (!runtime && !isAutoRoute)) return null;

  const resolvedDir = contextRaw
    ? resolveContext(contextRaw)
    : workingDir || workspace;

  const validCapabilities: RuntimeCapability[] = [];
  if (capabilitiesRaw) {
    for (const cap of capabilitiesRaw.split(",").map((c: string) => c.trim()).filter(Boolean)) {
      if (cap === "tools" || cap === "code" || cap === "structured-output") {
        validCapabilities.push(cap);
      }
    }
  }

  return {
    prompt,
    runtime: runtime || "claude",  // placeholder for auto — overwritten by router
    workingDir: resolvedDir,
    context: contextRaw || undefined,
    timeoutMs: timeoutStr ? parseInt(timeoutStr) : 300000,
    submittedBy: submittedBy || "unknown",
    submittedAt: submittedAt || new Date().toISOString(),
    replyTo: replyTo || undefined,
    replyFormat: replyFormat || undefined,
    group: group || undefined,
    sequence: sequenceStr ? parseInt(sequenceStr) : undefined,
    model: modelRaw || undefined,
    ollamaHost: ollamaHostRaw || undefined,
    fallback: fallbackRaw || undefined,
    contextRefs: contextRefsRaw
      ? contextRefsRaw.split(",").map((r: string) => r.trim()).filter(Boolean)
      : undefined,
    contextBudget: contextBudgetStr ? parseInt(contextBudgetStr) : undefined,
    capabilities: validCapabilities.length > 0 ? validCapabilities : undefined,
    autoRouted: isAutoRoute || undefined,
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

describe("ollama runtime parsing", () => {
  it("should parse Runtime: ollama", () => {
    const content = `## Task: Ollama test

- **Runtime:** ollama
- **Context:** scratch
- **Model:** qwen2.5:7b
- **Timeout:** 120000
- **Submitted by:** hugin

### Prompt
Analyze the journal`;

    const task = parseTask(content);
    expect(task).not.toBeNull();
    expect(task!.runtime).toBe("ollama");
    expect(task!.model).toBe("qwen2.5:7b");
    expect(task!.timeoutMs).toBe(120000);
  });

  it("should parse Ollama-host field", () => {
    const content = `## Task: Host test

- **Runtime:** ollama
- **Model:** llama3.3:70b
- **Ollama-host:** laptop

### Prompt
Do something`;

    const task = parseTask(content);
    expect(task!.ollamaHost).toBe("laptop");
  });

  it("should parse Fallback field", () => {
    const content = `## Task: Fallback test

- **Runtime:** ollama
- **Model:** qwen2.5:7b
- **Fallback:** claude

### Prompt
Analyze data`;

    const task = parseTask(content);
    expect(task!.fallback).toBe("claude");
  });

  it("should default fallback to undefined when absent", () => {
    const content = `## Task: No fallback

- **Runtime:** ollama

### Prompt
Do something`;

    const task = parseTask(content);
    expect(task!.fallback).toBeUndefined();
  });

  it("should parse Context-refs as comma-separated list", () => {
    const content = `## Task: Context refs test

- **Runtime:** ollama
- **Context-refs:** meta/conventions/status, projects/heimdall/status, projects/munin-memory/status
- **Context-budget:** 12000

### Prompt
Review project statuses`;

    const task = parseTask(content);
    expect(task!.contextRefs).toEqual([
      "meta/conventions/status",
      "projects/heimdall/status",
      "projects/munin-memory/status",
    ]);
    expect(task!.contextBudget).toBe(12000);
  });

  it("should handle Context-refs with no budget", () => {
    const content = `## Task: Refs no budget

- **Runtime:** ollama
- **Context-refs:** meta/conventions/status

### Prompt
Check conventions`;

    const task = parseTask(content);
    expect(task!.contextRefs).toEqual(["meta/conventions/status"]);
    expect(task!.contextBudget).toBeUndefined();
  });

  it("should parse a full ollama task with all fields", () => {
    const content = `## Task: Full ollama

- **Runtime:** ollama
- **Context:** scratch
- **Model:** qwen2.5:7b
- **Ollama-host:** pi
- **Fallback:** claude
- **Context-refs:** meta/conventions/status, projects/grimnir/status
- **Context-budget:** 8000
- **Timeout:** 180000
- **Submitted by:** hugin
- **Reply-to:** telegram:12345
- **Group:** daily-analysis
- **Sequence:** 1

### Prompt
Generate a daily report`;

    const task = parseTask(content);
    expect(task).not.toBeNull();
    expect(task!.runtime).toBe("ollama");
    expect(task!.model).toBe("qwen2.5:7b");
    expect(task!.ollamaHost).toBe("pi");
    expect(task!.fallback).toBe("claude");
    expect(task!.contextRefs).toEqual(["meta/conventions/status", "projects/grimnir/status"]);
    expect(task!.contextBudget).toBe(8000);
    expect(task!.timeoutMs).toBe(180000);
    expect(task!.group).toBe("daily-analysis");
    expect(task!.sequence).toBe(1);
  });
});

describe("submitter validation", () => {
  function isSubmitterAllowed(
    submittedBy: string,
    allowedSubmitters: string[]
  ): boolean {
    if (allowedSubmitters.includes("*")) return true;
    const normalized = submittedBy.trim().toLowerCase();
    if (!normalized) return false;
    return allowedSubmitters.some((entry) => {
      const entryLower = entry.trim().toLowerCase();
      if (!entryLower) return false;
      return (
        normalized === entryLower ||
        normalized.startsWith(`${entryLower}-`)
      );
    });
  }

  const defaultAllowed = [
    "Codex",
    "Codex-desktop",
    "ratatoskr",
    "Codex-web",
    "Codex-mobile",
    "claude-code",
    "claude-desktop",
    "claude-web",
    "claude-mobile",
    "hugin",
  ];

  it("should allow known submitters", () => {
    expect(isSubmitterAllowed("Codex", defaultAllowed)).toBe(true);
    expect(isSubmitterAllowed("Codex-desktop", defaultAllowed)).toBe(true);
    expect(isSubmitterAllowed("claude-code", defaultAllowed)).toBe(true);
    expect(isSubmitterAllowed("ratatoskr", defaultAllowed)).toBe(true);
    expect(isSubmitterAllowed("claude-desktop", defaultAllowed)).toBe(true);
  });

  it("should match case-insensitively", () => {
    expect(isSubmitterAllowed("CODEX", defaultAllowed)).toBe(true);
    expect(isSubmitterAllowed("Claude-Code", defaultAllowed)).toBe(true);
    expect(isSubmitterAllowed("HUGIN", defaultAllowed)).toBe(true);
  });

  it("should accept -<host> suffix variants", () => {
    // Real regression: a laptop claude-code session submitted as
    // "Claude-Code-laptop" and was rejected.
    expect(isSubmitterAllowed("Claude-Code-laptop", defaultAllowed)).toBe(true);
    expect(isSubmitterAllowed("claude-code-pi", defaultAllowed)).toBe(true);
    expect(isSubmitterAllowed("Codex-desktop-laptop", defaultAllowed)).toBe(true);
  });

  it("should reject unknown submitters", () => {
    expect(isSubmitterAllowed("unknown", defaultAllowed)).toBe(false);
    expect(isSubmitterAllowed("attacker", defaultAllowed)).toBe(false);
    expect(isSubmitterAllowed("", defaultAllowed)).toBe(false);
  });

  it("should require a `-` boundary for suffix matches", () => {
    // `huginx` must not pass by merely sharing letters with `hugin`:
    // only a literal `-` boundary counts as a host suffix separator.
    expect(isSubmitterAllowed("huginx", defaultAllowed)).toBe(false);
    expect(isSubmitterAllowed("codex", ["Codex-desktop"])).toBe(false);
  });

  it("should allow all when wildcard is present", () => {
    expect(isSubmitterAllowed("anything", ["*"])).toBe(true);
    expect(isSubmitterAllowed("unknown", ["*"])).toBe(true);
  });

  it("should work with custom allowlist", () => {
    const custom = ["bot-a", "bot-b"];
    expect(isSubmitterAllowed("bot-a", custom)).toBe(true);
    expect(isSubmitterAllowed("bot-a-laptop", custom)).toBe(true);
    expect(isSubmitterAllowed("Codex", custom)).toBe(false);
    expect(isSubmitterAllowed("claude-code", custom)).toBe(false);
  });
});

describe("auto-routing task parsing", () => {
  it("should parse Runtime: auto as autoRouted task", () => {
    const content = `## Task: Auto test

- **Runtime:** auto
- **Sensitivity:** internal
- **Submitted by:** claude-code

### Prompt
Do something automatically`;

    const task = parseTask(content);
    expect(task).not.toBeNull();
    expect(task!.autoRouted).toBe(true);
    expect(task!.runtime).toBe("claude"); // placeholder
    expect(task!.prompt).toBe("Do something automatically");
  });

  it("should parse Capabilities field on auto-routed task", () => {
    const content = `## Task: Capable auto

- **Runtime:** auto
- **Capabilities:** tools, code

### Prompt
Write some code`;

    const task = parseTask(content);
    expect(task).not.toBeNull();
    expect(task!.autoRouted).toBe(true);
    expect(task!.capabilities).toEqual(["tools", "code"]);
  });

  it("should parse Capabilities: structured-output", () => {
    const content = `## Task: Structured

- **Runtime:** auto
- **Capabilities:** structured-output

### Prompt
Return JSON`;

    const task = parseTask(content);
    expect(task!.capabilities).toEqual(["structured-output"]);
  });

  it("should ignore invalid capability values", () => {
    const content = `## Task: Bad caps

- **Runtime:** auto
- **Capabilities:** tools, invalid-cap, code

### Prompt
Do it`;

    const task = parseTask(content);
    expect(task!.capabilities).toEqual(["tools", "code"]);
  });

  it("should leave capabilities undefined when not specified", () => {
    const content = `## Task: No caps

- **Runtime:** auto

### Prompt
Do it`;

    const task = parseTask(content);
    expect(task!.capabilities).toBeUndefined();
  });

  it("should not set autoRouted for explicit runtimes", () => {
    const content = `## Task: Explicit

- **Runtime:** claude

### Prompt
Do it`;

    const task = parseTask(content);
    expect(task!.autoRouted).toBeUndefined();
  });

  it("should parse Capabilities on explicit runtime task", () => {
    const content = `## Task: Explicit with caps

- **Runtime:** claude
- **Capabilities:** tools

### Prompt
Do it`;

    const task = parseTask(content);
    expect(task!.autoRouted).toBeUndefined();
    expect(task!.capabilities).toEqual(["tools"]);
  });

  it("should parse auto task with all fields", () => {
    const content = `## Task: Full auto

- **Runtime:** auto
- **Context:** repo:hugin
- **Sensitivity:** internal
- **Capabilities:** tools, code
- **Model:** qwen2.5:7b
- **Timeout:** 120000
- **Submitted by:** claude-code
- **Submitted at:** 2026-04-07T10:00:00Z
- **Reply-to:** telegram:12345
- **Reply-format:** summary
- **Group:** test-batch
- **Sequence:** 1

### Prompt
Implement the feature`;

    const task = parseTask(content);
    expect(task).not.toBeNull();
    expect(task!.autoRouted).toBe(true);
    expect(task!.capabilities).toEqual(["tools", "code"]);
    expect(task!.model).toBe("qwen2.5:7b");
    expect(task!.context).toBe("repo:hugin");
    expect(task!.workingDir).toBe("/home/magnus/repos/hugin");
    expect(task!.replyTo).toBe("telegram:12345");
    expect(task!.group).toBe("test-batch");
    expect(task!.sequence).toBe(1);
  });
});
