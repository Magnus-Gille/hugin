import { describe, expect, it } from "vitest";
import {
  buildVersionSnapshot,
  compareVersionSnapshots,
  hydrateVersionDriftAlertLifecycle,
  recordVersionDriftFiring,
  recordVersionDriftResolutionAttempt,
  VERSION_DRIFT_DEDUP_KEY,
  versionDriftStartupResolution,
  type VersionSnapshot,
} from "../src/version-drift.js";

const BASELINE: VersionSnapshot = {
  sdkVersion: "0.2.81",
  cliPath: "/var/lib/hugin/repos/hugin/node_modules/@anthropic-ai/claude-agent-sdk/cli.js",
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

  it("detects a cliPath change even when sdkVersion is 'unknown' on both sides", () => {
    const unknownBaseline: VersionSnapshot = { ...BASELINE, sdkVersion: "unknown", cliPath: "/old/cli" };
    const current: VersionSnapshot = { ...unknownBaseline, cliPath: "/new/cli" };
    const result = compareVersionSnapshots(unknownBaseline, current);
    expect(result.drifted).toBe(true);
    expect(result.changedFields).toEqual(["cliPath"]);
  });

  it("detects cliSizeBytes rising from 0 (e.g. a stat race mid-write)", () => {
    const zeroBaseline: VersionSnapshot = { ...BASELINE, cliSizeBytes: 0 };
    const current: VersionSnapshot = { ...zeroBaseline, cliSizeBytes: 1024 };
    const result = compareVersionSnapshots(zeroBaseline, current);
    expect(result.drifted).toBe(true);
    expect(result.changedFields).toEqual(["cliSizeBytes"]);
  });
});

describe("version-drift alert lifecycle", () => {
  it("resolves a previously firing alert after a successful fresh baseline", () => {
    const lifecycle = hydrateVersionDriftAlertLifecycle(true, true);
    expect(versionDriftStartupResolution(lifecycle)).toEqual({
      state: "resolved",
      dedup_key: VERSION_DRIFT_DEDUP_KEY,
    });
  });

  it("does not resolve when fresh baseline capture failed", () => {
    const lifecycle = hydrateVersionDriftAlertLifecycle(true, false);
    expect(versionDriftStartupResolution(lifecycle)).toBeNull();
  });

  it("does not emit a resolution when no drift alert was active", () => {
    const lifecycle = hydrateVersionDriftAlertLifecycle(false, true);
    expect(versionDriftStartupResolution(lifecycle)).toBeNull();
  });

  it("never resolves a firing created by the current process", () => {
    const lifecycle = recordVersionDriftFiring();
    expect(lifecycle).toEqual({ active: true, restartResolutionPending: false });
    expect(versionDriftStartupResolution(lifecycle)).toBeNull();
  });

  it("retains restart resolution for retry until delivery and persistence both succeed", () => {
    const hydrated = hydrateVersionDriftAlertLifecycle(true, true);
    const deliveryFailed = recordVersionDriftResolutionAttempt(hydrated, false, false);
    expect(versionDriftStartupResolution(deliveryFailed)).not.toBeNull();

    const persistenceFailed = recordVersionDriftResolutionAttempt(hydrated, true, false);
    expect(versionDriftStartupResolution(persistenceFailed)).not.toBeNull();

    const cleared = recordVersionDriftResolutionAttempt(hydrated, true, true);
    expect(cleared).toEqual({ active: false, restartResolutionPending: false });
    expect(versionDriftStartupResolution(cleared)).toBeNull();
  });
});
