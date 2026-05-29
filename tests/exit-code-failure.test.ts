import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// Regression guard for issue #73:
// Ratatoskr decides task success by matching the human `result` markdown against
// /\*\*Exit code:\*\*\s*(\d+)/ and treats a NON-match as success. A negative
// exit code (`-1`) fails `(\d+)` → no match → the failed task is mis-rendered as
// SUCCESS. Several dispatcher failure paths (recovery, reaper, shutdown, security
// rejection, approval rejection, generic failures) used to emit `Exit code: -1`.
//
// These paths build their result markdown inline in src/index.ts and are not
// individually exported, so we guard the contract two ways:
//   1. behaviourally — the exact regex Ratatoskr uses must read a positive code
//      as failure and must NOT match a negative code (documenting the bug); and
//   2. structurally — no failure-result markdown in src/index.ts may emit a
//      negative `**Exit code:**`, so the regression cannot silently return.

const RATATOSKR_RE = /\*\*Exit code:\*\*\s*(\d+)/;

// Ratatoskr's success decision: it FAILS the task only when the regex matches a
// non-zero numeric code. A non-match (or a zero code) is treated as success.
function ratatoskrReportsFailure(resultMarkdown: string): boolean {
  const m = resultMarkdown.match(RATATOSKR_RE);
  if (!m) return false; // no match → mis-rendered as success
  return Number(m[1]) !== 0;
}

describe("issue #73: dispatcher failure exit codes are reported as failures", () => {
  it("a negative exit code is mis-rendered as success (documents the bug)", () => {
    const doc = "## Result\n\n- **Exit code:** -1\n- **Error:** boom\n";
    expect(ratatoskrReportsFailure(doc)).toBe(false);
  });

  it("a positive exit code is correctly reported as failure", () => {
    const doc = "## Result\n\n- **Exit code:** 1\n- **Error:** boom\n";
    expect(ratatoskrReportsFailure(doc)).toBe(true);
  });

  it("exit code 0 is reported as success", () => {
    const doc = "## Result\n\n- **Exit code:** 0\n";
    expect(ratatoskrReportsFailure(doc)).toBe(false);
  });

  it("no failure path in src/index.ts emits a negative **Exit code:**", () => {
    const src = readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf8",
    );
    // Match both literal `- **Exit code:** -1` and any interpolated negative.
    const negativeExitCodes = src.match(/\*\*Exit code:\*\*\s*-\d+/g) || [];
    expect(negativeExitCodes).toEqual([]);
  });
});
