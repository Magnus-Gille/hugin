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
  writeManifestFile,
} from "../scripts/harvest-daily-exam-candidates.js";

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

  it("rejects unbounded or unknown options", () => {
    expect(() => parseArgs(["--limit", "10001"])).toThrow("--limit");
    expect(() => parseArgs(["--publish", "yes"])).toThrow("unknown option");
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
