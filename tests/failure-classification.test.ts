import { describe, expect, it } from "vitest";
import {
  AUTH_FAILURE_KIND,
  AUTH_FAILURE_TAG,
  DEPS_DRIFT_FAILURE_KIND,
  DEPS_DRIFT_FAILURE_TAG,
  classifyClaudeFailure,
} from "../src/failure-classification.js";

describe("classifyClaudeFailure", () => {
  it("classifies the real overnight 401 log excerpt (issue #129) as AUTH_FAILED", () => {
    // Verbatim shape from ~/.hugin/logs/<task>.log in the issue.
    const output = [
      '[system] {"type":"system","subtype":"init","apiKeySource":"none","mcp_servers":[]}',
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011CcdhH87LLqmvP9Fy5gbUe"}',
      "[SDK Error: Claude Code returned an error result: Failed to authenticate. API Error: 401 ...]",
    ].join("\n");

    const result = classifyClaudeFailure(output);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(AUTH_FAILURE_KIND);
    expect(result?.tag).toBe(AUTH_FAILURE_TAG);
    expect(result?.reason).toMatch(/401|authenticate/i);
  });

  it("detects a structured authentication_error error body", () => {
    expect(
      classifyClaudeFailure('{"error":{"type":"authentication_error"}}'),
    ).not.toBeNull();
  });

  it("does NOT classify on the apiKeySource:none tell-tale alone (needs a 401 envelope)", () => {
    // apiKeySource is a plain account field; on its own it is too weak a signal
    // (Codex review, #129). A real auth failure always also carries the 401.
    expect(classifyClaudeFailure('"apiKeySource":"none"')).toBeNull();
    expect(
      classifyClaudeFailure(
        '"apiKeySource":"none"\nFailed to authenticate. API Error: 401 ...',
      ),
    ).not.toBeNull();
  });

  it("does NOT classify a bare 'authentication_error' mention without the JSON envelope", () => {
    expect(
      classifyClaudeFailure("the tool logged authentication_error somewhere"),
    ).toBeNull();
  });

  it("returns null for a generic task-logic failure", () => {
    const output = [
      "Working on the task...",
      "[SDK Error: result error] tool execution failed: file not found",
    ].join("\n");
    expect(classifyClaudeFailure(output)).toBeNull();
  });

  it("does not misclassify a task whose prose merely mentions 401", () => {
    const output =
      "The HTTP spec defines 401 Unauthorized as an auth challenge status code.";
    expect(classifyClaudeFailure(output)).toBeNull();
  });

  it("returns null for empty / missing output", () => {
    expect(classifyClaudeFailure("")).toBeNull();
    expect(classifyClaudeFailure(null)).toBeNull();
    expect(classifyClaudeFailure(undefined)).toBeNull();
  });

  it("classifies a version-drift pre-flight short-circuit as DEPS_DRIFT (issue #123)", () => {
    const output =
      "Version-drift pre-flight check failed. DEPS_DRIFT: deps changed under live worker " +
      "(sdkVersion 0.2.81 → 0.2.82) — restart the worker to pick up the current on-disk SDK/binary.";
    const result = classifyClaudeFailure(output);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(DEPS_DRIFT_FAILURE_KIND);
    expect(result?.tag).toBe(DEPS_DRIFT_FAILURE_TAG);
    expect(result?.reason).toMatch(/restart the worker/i);
  });

  it("does not misclassify a task whose prose merely mentions dependency drift", () => {
    const output = "I noticed the dependency versions had drifted between environments.";
    expect(classifyClaudeFailure(output)).toBeNull();
  });

  it("prefers DEPS_DRIFT over AUTH_FAILED when (hypothetically) both markers are present", () => {
    const output =
      "DEPS_DRIFT: deps changed under live worker — restart the worker.\n" +
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}';
    const result = classifyClaudeFailure(output);
    expect(result?.kind).toBe(DEPS_DRIFT_FAILURE_KIND);
  });
});
