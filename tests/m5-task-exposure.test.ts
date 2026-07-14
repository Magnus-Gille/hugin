import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  REQUIRED_TASK_EXPOSURE_LANES,
  TASK_EXPOSURE_FINGERPRINT_VERSION,
  TASK_EXPOSURE_SMOKE_FINGERPRINT,
  lookupTaskExposureSnapshots,
  resolveTaskExposureLookupEndpoint,
  taskTextFingerprint,
} from "../src/learning/m5-task-exposure.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

function responseFor(fingerprints: string[], options: {
  seen?: Set<string>;
  coverageComplete?: boolean;
  from?: string;
  through?: string;
  lanes?: string[];
} = {}) {
  return {
    schema_version: 1,
    fingerprint_version: TASK_EXPOSURE_FINGERPRINT_VERSION,
    coverage: {
      coverage_complete: options.coverageComplete ?? true,
      from: options.from ?? "2026-07-14T20:00:00.000Z",
      through: options.through ?? "2026-07-14T21:00:00.000Z",
      lanes: options.lanes ?? [...REQUIRED_TASK_EXPOSURE_LANES],
      historical_backfill_complete: false,
      historical_backfill_from: "2026-06-01T00:00:00.000Z",
      historical_backfill_through: "2026-07-14T19:59:59.000Z",
      historical_events_imported: 120,
      historical_rows_skipped_inexact: 7,
      incomplete_before: "2026-07-14T20:00:00.000Z",
      incomplete_reasons: ["legacy rows are incomplete"],
    },
    results: fingerprints.map((fingerprint) => ({
      fingerprint_sha256: fingerprint,
      seen: options.seen?.has(fingerprint) ?? false,
      first_seen_at: options.seen?.has(fingerprint) ? "2026-07-14T20:30:00.000Z" : null,
      last_seen_at: options.seen?.has(fingerprint) ? "2026-07-14T20:30:00.000Z" : null,
      lanes: options.seen?.has(fingerprint) ? ["chat"] : [],
      model_ids: options.seen?.has(fingerprint) ? ["mellum"] : [],
      harness_ids: options.seen?.has(fingerprint) ? ["openai-chat"] : [],
    })),
  };
}

describe("M5 task exposure lookup", () => {
  it("matches trim-utf8-sha256-v1 without Unicode or internal-whitespace normalization", () => {
    const raw = " \t e\u0301  x \n";
    expect(taskTextFingerprint(raw)).toBe(
      createHash("sha256").update(raw.trim(), "utf8").digest("hex"),
    );
    expect(taskTextFingerprint("é")).not.toBe(taskTextFingerprint("e\u0301"));
    expect(taskTextFingerprint("a  b")).not.toBe(taskTextFingerprint("a b"));
    expect(taskTextFingerprint("hugin-task-exposure-lookup-healthcheck-v1"))
      .toBe(TASK_EXPOSURE_SMOKE_FINGERPRINT);
  });

  it("normalizes a gateway root or /v1 base to the root admin endpoint", () => {
    expect(resolveTaskExposureLookupEndpoint("https://host"))
      .toBe("https://host/admin/task-exposures/lookup");
    expect(resolveTaskExposureLookupEndpoint("https://host/v1/"))
      .toBe("https://host/admin/task-exposures/lookup");
    expect(() => resolveTaskExposureLookupEndpoint("https://host/v1/chat"))
      .toThrow(expect.objectContaining({ code: "invalid-gateway-url" }));
  });

  it("deduplicates fingerprints, batches at 100, and fans snapshots back by digest", async () => {
    const fingerprints = Array.from({ length: 101 }, (_, index) =>
      index.toString(16).padStart(64, "0"));
    fingerprints.push(fingerprints[0]!);
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return new Response(JSON.stringify(responseFor(body.fingerprints)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const snapshots = await lookupTaskExposureSnapshots({
      gatewayBaseUrl: "https://host/v1",
      apiKey: "owner-token",
      fingerprints,
      fetchImpl,
      now: () => "2026-07-14T21:00:01.000Z",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((bodies[0] as { fingerprints: string[] }).fingerprints).toHaveLength(100);
    expect((bodies[1] as { fingerprints: string[] }).fingerprints).toHaveLength(1);
    expect(snapshots.size).toBe(101);
    expect(snapshots.get(fingerprints[0]!)?.checkedAt).toBe("2026-07-14T21:00:01.000Z");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({
      authorization: "Bearer owner-token",
    }));
  });

  it("accepts a positive match even when coverage is incomplete", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(responseFor([A], {
      seen: new Set([A]),
      coverageComplete: false,
      lanes: ["chat"],
    })), { status: 200 }));

    const snapshots = await lookupTaskExposureSnapshots({
      gatewayBaseUrl: "https://host",
      apiKey: "owner-token",
      fingerprints: [A],
      fetchImpl,
    });

    expect(snapshots.get(A)?.result.seen).toBe(true);
    expect(snapshots.get(A)?.coverage.coverage_complete).toBe(false);
  });

  it("preserves a positive match even when its negative-coverage window is invalid", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(responseFor([A], {
      seen: new Set([A]),
      from: "2026-07-14T22:00:00.000Z",
      through: "2026-07-14T21:00:00.000Z",
    })), { status: 200 }));

    const snapshots = await lookupTaskExposureSnapshots({
      gatewayBaseUrl: "https://host",
      apiKey: "owner-token",
      fingerprints: [A],
      fetchImpl,
    });
    expect(snapshots.get(A)?.result.seen).toBe(true);
  });

  it("fails closed on auth, version, schema, cardinality, or result-order ambiguity", async () => {
    const base = {
      gatewayBaseUrl: "https://host",
      apiKey: "owner-token",
      fingerprints: [A, B],
    };
    await expect(lookupTaskExposureSnapshots({
      ...base,
      fetchImpl: vi.fn(async () => new Response("no", { status: 401 })),
    })).rejects.toMatchObject({ code: "http-401" });
    await expect(lookupTaskExposureSnapshots({
      ...base,
      fetchImpl: vi.fn(async () => {
        const value = responseFor([A, B]);
        value.fingerprint_version = "future-version";
        return new Response(JSON.stringify(value), { status: 200 });
      }),
    })).rejects.toMatchObject({ code: "invalid-response" });
    await expect(lookupTaskExposureSnapshots({
      ...base,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(responseFor([B, A])), { status: 200 })),
    })).rejects.toMatchObject({ code: "result-mismatch" });
  });
});
