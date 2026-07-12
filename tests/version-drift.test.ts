import { describe, expect, it } from "vitest";
import {
  buildVersionSnapshot,
  compareVersionSnapshots,
  type VersionSnapshot,
} from "../src/version-drift.js";

const BASELINE: VersionSnapshot = {
  sdkVersion: "0.2.81",
  cliPath: "/home/magnus/repos/hugin/node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
  cliSizeBytes: 1_234_567,
  cliMtimeMs: 1_750_000_000_000,
};

describe("buildVersionSnapshot", () => {
  it("normalizes a full raw reading", () => {
    const snap = buildVersionSnapshot({
      sdkVersion: "0.2.81",
      cliPath: BASELINE.cliPath,
      cliSizeBytes: 1_234_567,
      cliMtimeMs: 1_750_000_000_000,
    });
    expect(snap).toEqual(BASELINE);
  });

  it.each([undefined, null, ""])(
    "defaults sdkVersion to 'unknown' for %j",
    (raw) => {
      const snap = buildVersionSnapshot({
        sdkVersion: raw,
        cliPath: BASELINE.cliPath,
        cliSizeBytes: 1,
        cliMtimeMs: 1,
      });
      expect(snap.sdkVersion).toBe("unknown");
    },
  );

  it("trims whitespace from sdkVersion", () => {
    const snap = buildVersionSnapshot({
      sdkVersion: "  0.2.81  ",
      cliPath: BASELINE.cliPath,
      cliSizeBytes: 1,
      cliMtimeMs: 1,
    });
    expect(snap.sdkVersion).toBe("0.2.81");
  });
});

describe("compareVersionSnapshots", () => {
  it("reports no drift for identical snapshots", () => {
    const result = compareVersionSnapshots(BASELINE, { ...BASELINE });
    expect(result.drifted).toBe(false);
    expect(result.changedFields).toEqual([]);
  });

  it("detects an sdkVersion bump (the 2026-06-17 incident class)", () => {
    const current: VersionSnapshot = { ...BASELINE, sdkVersion: "0.2.82" };
    const result = compareVersionSnapshots(BASELINE, current);
    expect(result.drifted).toBe(true);
    expect(result.changedFields).toEqual(["sdkVersion"]);
    expect(result.message).toMatch(/0\.2\.81.*0\.2\.82/);
    expect(result.message).toMatch(/restart the worker/i);
  });

  it("detects a changed resolved cli.js path", () => {
    const current: VersionSnapshot = {
      ...BASELINE,
      cliPath: "/some/other/path/cli.js",
    };
    const result = compareVersionSnapshots(BASELINE, current);
    expect(result.drifted).toBe(true);
    expect(result.changedFields).toEqual(["cliPath"]);
  });

  it("detects a changed cli.js size (binary content changed)", () => {
    const current: VersionSnapshot = { ...BASELINE, cliSizeBytes: 9_999_999 };
    const result = compareVersionSnapshots(BASELINE, current);
    expect(result.drifted).toBe(true);
    expect(result.changedFields).toEqual(["cliSizeBytes"]);
  });

  it("detects a changed cli.js mtime (rewritten in place, same size)", () => {
    const current: VersionSnapshot = {
      ...BASELINE,
      cliMtimeMs: BASELINE.cliMtimeMs + 5_000,
    };
    const result = compareVersionSnapshots(BASELINE, current);
    expect(result.drifted).toBe(true);
    expect(result.changedFields).toEqual(["cliMtimeMs"]);
  });

  it("reports every changed field when several drift at once", () => {
    const current: VersionSnapshot = {
      sdkVersion: "0.3.0",
      cliPath: BASELINE.cliPath,
      cliSizeBytes: BASELINE.cliSizeBytes + 100,
      cliMtimeMs: BASELINE.cliMtimeMs + 100,
    };
    const result = compareVersionSnapshots(BASELINE, current);
    expect(result.drifted).toBe(true);
    expect(result.changedFields).toEqual(
      expect.arrayContaining(["sdkVersion", "cliSizeBytes", "cliMtimeMs"]),
    );
    expect(result.changedFields).toHaveLength(3);
  });

  it("is order-independent for the changedFields check (baseline vs current swapped still drifts)", () => {
    const current: VersionSnapshot = { ...BASELINE, sdkVersion: "0.2.82" };
    const forward = compareVersionSnapshots(BASELINE, current);
    const backward = compareVersionSnapshots(current, BASELINE);
    expect(forward.drifted).toBe(true);
    expect(backward.drifted).toBe(true);
  });
});
