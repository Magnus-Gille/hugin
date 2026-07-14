import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseArgs,
  taskExposureFingerprintsForLookup,
  writeManifestFile,
} from "../src/daily-exam-harvest-cli.js";
import { TASK_EXPOSURE_SMOKE_FINGERPRINT } from "../src/learning/m5-task-exposure.js";

describe("daily exam factory CLI", () => {
  it("normalizes timestamps and keeps a bounded default", () => {
    expect(parseArgs(["--since", "2026-07-14T10:00:00+02:00"])).toEqual({
      since: "2026-07-14T08:00:00.000Z",
      limit: 500,
    });
  });

  it("rejects an inverted time window", () => {
    expect(() => parseArgs([
      "--since", "2026-07-15T00:00:00Z",
      "--until", "2026-07-14T00:00:00Z",
    ])).toThrow("--since must not be later than --until");
  });

  it("computes a bounded rolling window for the daily systemd job", () => {
    expect(parseArgs(
      ["--lookback-hours", "48"],
      Date.parse("2026-07-14T12:00:00.000Z"),
    )).toEqual({
      since: "2026-07-12T12:00:00.000Z",
      limit: 500,
    });
    expect(() => parseArgs(["--since", "2026-07-14T00:00:00Z", "--lookback-hours", "48"]))
      .toThrow("mutually exclusive");
  });

  it("rejects unbounded or unknown options", () => {
    expect(() => parseArgs(["--limit", "10001"])).toThrow("--limit");
    expect(() => parseArgs(["--publish", "yes"])).toThrow("unknown option");
  });

  it("queries only unique provisional fingerprints and smokes an empty eligible day", () => {
    const fingerprint = "a".repeat(64);
    expect(taskExposureFingerprintsForLookup([
      { lane: "provisional-holdout", crossClientExposure: { fingerprintSha256: fingerprint } },
      { lane: "provisional-holdout", crossClientExposure: { fingerprintSha256: fingerprint } },
      { lane: "quarantine", crossClientExposure: { fingerprintSha256: "b".repeat(64) } },
      { lane: "regression", crossClientExposure: { fingerprintSha256: "c".repeat(64) } },
    ])).toEqual([fingerprint]);
    expect(taskExposureFingerprintsForLookup([
      { lane: "quarantine", crossClientExposure: { fingerprintSha256: fingerprint } },
    ])).toEqual([TASK_EXPOSURE_SMOKE_FINGERPRINT]);
  });

  it("atomically writes mode-0600 output without following a destination symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "hugin-daily-exam-cli-"));
    try {
      const victim = join(dir, "victim.txt");
      const output = join(dir, "manifest.json");
      writeFileSync(victim, "do-not-overwrite", "utf8");
      symlinkSync(victim, output);

      writeManifestFile(output, "{\"ok\":true}\n");

      expect(readFileSync(victim, "utf8")).toBe("do-not-overwrite");
      expect(lstatSync(output).isSymbolicLink()).toBe(false);
      expect(readFileSync(output, "utf8")).toBe("{\"ok\":true}\n");
      expect(statSync(output).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
