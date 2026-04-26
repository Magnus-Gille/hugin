import { describe, it, expect } from "vitest";
import {
  finalizeDelegatedOutput,
  type FinalizeDiffInput,
  type FinalizeTextInput,
} from "../src/finalize-delegated-output.js";

const baseTextInput: FinalizeTextInput = {
  task_id: "20260426-104000-test",
  alias_requested: "medium",
  model_effective: "qwen3:14b",
  runtime_effective: "ollama",
  runtime_row_id_effective: "ollama-laptop",
  host_effective: "mba",
  result_kind: "text",
  raw_output: "Hello, world.",
  policy_version: "zdr-v1+rlv-v1",
  duration_s: 1.5,
  cost_usd: 0,
};

const baseDiffInput: FinalizeDiffInput = {
  task_id: "20260426-104000-harness",
  alias_requested: "pi-large-coder",
  model_effective: "qwen/qwen3-coder-next",
  runtime_effective: "pi-harness",
  runtime_row_id_effective: "pi-harness",
  host_effective: "pi",
  result_kind: "diff",
  raw_diff: {
    base_sha: "abc123",
    head_sha: "def456",
    files_touched: ["src/foo.ts"],
    unified_diff: "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n",
    stats: { files: 1, insertions: 1, deletions: 1 },
    worktree_path: "/home/magnus/.hugin/worktrees/20260426-104000-harness",
  },
  policy_version: "zdr-v1+rlv-v1",
  harness_version: "pi@1.2.3",
  duration_s: 129,
  cost_usd: 0.045,
};

describe("finalizeDelegatedOutput — text path", () => {
  it("returns clean scanner_pass when output has no patterns", () => {
    const outcome = finalizeDelegatedOutput(baseTextInput);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const r = outcome.result;
    expect(r.result_kind).toBe("text");
    expect(r.output).toBe("Hello, world.");
    expect(r.diff).toBeUndefined();
    expect(r.provenance.source).toBe("delegated");
    expect(r.provenance.scanner_pass).toBe("clean");
    expect(r.provenance.policy_version).toBe("zdr-v1+rlv-v1");
    expect(r.provenance.harness_version).toBeUndefined();
  });

  it("propagates token counts, duration, cost", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseTextInput,
      prompt_tokens: 120,
      completion_tokens: 80,
      total_tokens: 200,
      load_ms: 50,
      duration_s: 3.25,
      cost_usd: 0.0021,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const r = outcome.result;
    expect(r.prompt_tokens).toBe(120);
    expect(r.completion_tokens).toBe(80);
    expect(r.total_tokens).toBe(200);
    expect(r.load_ms).toBe(50);
    expect(r.duration_s).toBe(3.25);
    expect(r.cost_usd).toBeCloseTo(0.0021);
  });

  it("flags warn (default policy) when output contains an exfil pattern", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseTextInput,
      raw_output:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBA...\n-----END RSA PRIVATE KEY-----",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("warn");
    expect(outcome.result.output).toContain("-----BEGIN RSA PRIVATE KEY-----");
  });

  it("redacts when scanner_policy=redact and content has matches", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseTextInput,
      raw_output:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBA...\n-----END RSA PRIVATE KEY-----",
      scanner_policy: "redact",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("redact");
    // The scanner regex matches the BEGIN header; redaction replaces that span.
    expect(outcome.result.output).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(outcome.result.output).toMatch(/\[redacted: private-key\]/);
  });

  it("clean scan stays clean even under redact policy", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseTextInput,
      scanner_policy: "redact",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("clean");
    expect(outcome.result.output).toBe("Hello, world.");
  });

  it("finalized_at is a parseable ISO timestamp", () => {
    const outcome = finalizeDelegatedOutput(baseTextInput);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => new Date(outcome.result.finalized_at).toISOString()).not.toThrow();
  });

  it("stamps result_schema_version=1 and runtime_row_id_effective", () => {
    const outcome = finalizeDelegatedOutput(baseTextInput);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.result_schema_version).toBe(1);
    expect(outcome.result.runtime_row_id_effective).toBe("ollama-laptop");
  });

  it("policy=off skips the scanner and preserves payload exactly", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseTextInput,
      raw_output:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBA...\n-----END RSA PRIVATE KEY-----",
      scanner_policy: "off",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("skipped");
    expect(outcome.result.output).toContain("BEGIN RSA PRIVATE KEY");
  });

  it("policy=flag preserves payload and reports scanner_pass=flag on match", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseTextInput,
      raw_output:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBA...\n-----END RSA PRIVATE KEY-----",
      scanner_policy: "flag",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("flag");
    expect(outcome.result.output).toContain("BEGIN RSA PRIVATE KEY");
  });

  it("policy=flag reports scanner_pass=clean when payload has no matches", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseTextInput,
      scanner_policy: "flag",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("clean");
  });
});

describe("finalizeDelegatedOutput — diff path", () => {
  it("returns diff with scanned unified_diff and no top-level output", () => {
    const outcome = finalizeDelegatedOutput(baseDiffInput);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const r = outcome.result;
    expect(r.result_kind).toBe("diff");
    expect(r.output).toBeUndefined();
    expect(r.diff).toBeDefined();
    expect(r.diff!.base_sha).toBe("abc123");
    expect(r.diff!.head_sha).toBe("def456");
    expect(r.diff!.files_touched).toEqual(["src/foo.ts"]);
    expect(r.diff!.unified_diff).toContain("-old");
    expect(r.diff!.stats).toEqual({ files: 1, insertions: 1, deletions: 1 });
    expect(r.provenance.scanner_pass).toBe("clean");
    expect(r.provenance.harness_version).toBe("pi@1.2.3");
  });

  it("flags warn when the diff contains an exfil pattern (default policy)", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseDiffInput,
      raw_diff: {
        ...baseDiffInput.raw_diff,
        unified_diff:
          "+const k = '-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXkt...';\n",
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("warn");
    expect(outcome.result.diff!.unified_diff).toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("escalates to scanner_blocked error when diff contains exfil pattern under redact policy", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseDiffInput,
      scanner_policy: "redact",
      raw_diff: {
        ...baseDiffInput.raw_diff,
        unified_diff:
          "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBA...\n-----END RSA PRIVATE KEY-----",
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("scanner_blocked");
    expect(outcome.error.task_id).toBe("20260426-104000-harness");
    expect(outcome.error.retryable).toBe(false);
    expect(outcome.error.message).toMatch(/redact/i);
    expect(outcome.error.message).toMatch(/diff/i);
  });

  it("does NOT escalate when diff is clean under redact policy", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseDiffInput,
      scanner_policy: "redact",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("clean");
    expect(outcome.result.diff!.unified_diff).toBe(
      baseDiffInput.raw_diff.unified_diff,
    );
  });

  it("does NOT escalate when diff matches under default warn policy", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseDiffInput,
      raw_diff: {
        ...baseDiffInput.raw_diff,
        unified_diff:
          "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBA...\n-----END RSA PRIVATE KEY-----",
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("warn");
    expect(outcome.result.diff!.unified_diff).toContain("BEGIN RSA PRIVATE KEY");
  });

  it("propagates harness_version into provenance on success", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseDiffInput,
      harness_version: "pi@2.0.0-rc1",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.harness_version).toBe("pi@2.0.0-rc1");
  });

  it("diff under policy=off preserves payload and never escalates", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseDiffInput,
      scanner_policy: "off",
      raw_diff: {
        ...baseDiffInput.raw_diff,
        unified_diff:
          "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBA...\n-----END RSA PRIVATE KEY-----",
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("skipped");
    expect(outcome.result.diff!.unified_diff).toContain("BEGIN RSA PRIVATE KEY");
  });

  it("diff under policy=flag preserves payload and never escalates", () => {
    const outcome = finalizeDelegatedOutput({
      ...baseDiffInput,
      scanner_policy: "flag",
      raw_diff: {
        ...baseDiffInput.raw_diff,
        unified_diff:
          "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBA...\n-----END RSA PRIVATE KEY-----",
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.provenance.scanner_pass).toBe("flag");
    expect(outcome.result.diff!.unified_diff).toContain("BEGIN RSA PRIVATE KEY");
  });

  it("stamps result_schema_version=1 and runtime_row_id_effective on diff path", () => {
    const outcome = finalizeDelegatedOutput(baseDiffInput);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.result_schema_version).toBe(1);
    expect(outcome.result.runtime_row_id_effective).toBe("pi-harness");
  });
});
