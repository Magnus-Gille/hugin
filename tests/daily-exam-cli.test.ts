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
  lookupCrossClientExposure,
  parseArgs,
  writeManifestFile,
} from "../src/daily-exam-harvest-cli.js";
import {
  TASK_EXPOSURE_FINGERPRINT_VERSION,
  TASK_EXPOSURE_REQUIRED_LANES,
} from "../src/learning/task-exposure-client.js";
import type { DailyTaskHarvestSource } from "../src/learning/daily-task-exam-factory.js";

describe("daily exam factory CLI", () => {
  const lookupSource: DailyTaskHarvestSource = {
    status: {
      id: "tasks/lookup/status",
      namespace: "tasks/lookup",
      key: "status",
      content: "## Task: Lookup\n\n- **Submitted at:** 2026-07-14T10:00:00Z\n\n### Prompt\nExact private task text",
      tags: ["completed"],
      classification: "internal",
      created_at: "2026-07-14T10:00:00.000Z",
      updated_at: "2026-07-14T11:00:00.000Z",
    },
  };

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

  it("looks up only the content-blind task fingerprint through the sovereign gateway", async () => {
    const lookup = await lookupCrossClientExposure(
      [lookupSource],
      {
        HOMESERVER_GATEWAY_URL: "http://100.76.72.59:8080",
        HOMESERVER_GATEWAY_API_KEY: "owner-token",
      },
      (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          fingerprint_version: string;
          fingerprints: string[];
        };
        expect(body.fingerprint_version).toBe(TASK_EXPOSURE_FINGERPRINT_VERSION);
        expect(body.fingerprints).toHaveLength(1);
        expect(String(init?.body)).not.toContain("Exact private task text");
        return new Response(JSON.stringify({
          schema_version: 1,
          fingerprint_version: TASK_EXPOSURE_FINGERPRINT_VERSION,
          coverage: {
            coverage_complete: true,
            from: "2026-07-14T09:00:00.000Z",
            through: "2026-07-14T12:00:00.000Z",
            lanes: TASK_EXPOSURE_REQUIRED_LANES,
            historical_backfill_complete: false,
            historical_backfill_from: null,
            historical_backfill_through: null,
            historical_events_imported: 0,
            historical_rows_skipped_inexact: 1,
            incomplete_before: "2026-07-14T09:00:00.000Z",
            incomplete_reasons: ["legacy history incomplete"],
          },
          results: [{
            fingerprint_sha256: body.fingerprints[0],
            seen: false,
            first_seen_at: null,
            last_seen_at: null,
            lanes: [],
            model_ids: [],
            harness_ids: [],
          }],
        }), { status: 200 });
      }) as typeof fetch,
    );
    expect(lookup).toMatchObject({ status: "queried" });
  });

  it("fails lookup configuration closed and skips only when no prompt can be fingerprinted", async () => {
    expect(await lookupCrossClientExposure([lookupSource], {})).toEqual({
      status: "unavailable",
      failureKind: "configuration",
    });
    const withoutPrompt = structuredClone(lookupSource);
    withoutPrompt.status.content = "## Task: no prompt section";
    expect(await lookupCrossClientExposure([withoutPrompt], {})).toEqual({ status: "not-needed" });
  });
});
