import { describe, expect, it, vi } from "vitest";
import {
  TASK_EXPOSURE_FINGERPRINT_VERSION,
  TASK_EXPOSURE_REQUIRED_LANES,
  TaskExposureClient,
} from "../src/learning/task-exposure-client.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

function responseFor(
  fingerprints: string[],
  input: {
    from?: string;
    through?: string;
    coverageComplete?: boolean;
    lanes?: string[];
    results?: unknown[];
  } = {},
): Response {
  return new Response(JSON.stringify({
    schema_version: 1,
    fingerprint_version: TASK_EXPOSURE_FINGERPRINT_VERSION,
    coverage: {
      coverage_complete: input.coverageComplete ?? true,
      from: input.from ?? "2026-07-14T10:00:00.000Z",
      through: input.through ?? "2026-07-14T12:00:00.000Z",
      lanes: input.lanes ?? TASK_EXPOSURE_REQUIRED_LANES,
      historical_backfill_complete: false,
      historical_backfill_from: null,
      historical_backfill_through: null,
      historical_events_imported: 0,
      historical_rows_skipped_inexact: 7,
      incomplete_before: input.from ?? "2026-07-14T10:00:00.000Z",
      incomplete_reasons: ["legacy history is incomplete"],
    },
    results: input.results ?? fingerprints.map((fingerprint) => ({
      fingerprint_sha256: fingerprint,
      seen: false,
      first_seen_at: null,
      last_seen_at: null,
      lanes: [],
      model_ids: [],
      harness_ids: [],
    })),
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("TaskExposureClient", () => {
  it("sends only content-blind fingerprints and binds ordered results", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe("http://100.76.72.59:8080/admin/task-exposures/lookup");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer owner-token");
      expect(init?.redirect).toBe("error");
      expect(String(init?.body)).not.toContain("owner-token");
      expect(JSON.parse(String(init?.body))).toEqual({
        fingerprint_version: TASK_EXPOSURE_FINGERPRINT_VERSION,
        fingerprints: [A, B],
      });
      return responseFor([A, B]);
    });
    const client = new TaskExposureClient({
      baseUrl: "http://100.76.72.59:8080",
      bearerToken: "owner-token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const evidence = await client.lookup([A, B]);
    expect(evidence.results.map((result) => result.fingerprintSha256)).toEqual([A, B]);
    expect(evidence.coverage.coverageComplete).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("batches more than 100 fingerprints and uses the safe coverage intersection", async () => {
    const fingerprints = Array.from({ length: 101 }, (_, index) =>
      index.toString(16).padStart(64, "0"));
    let call = 0;
    const client = new TaskExposureClient({
      baseUrl: "http://100.76.72.59:8080",
      bearerToken: "owner-token",
      fetchImpl: (async (_url, init) => {
        const batch = JSON.parse(String(init?.body)).fingerprints as string[];
        call += 1;
        return responseFor(batch, {
          from: call === 1 ? "2026-07-14T10:00:00.000Z" : "2026-07-14T10:05:00.000Z",
          through: call === 1 ? "2026-07-14T12:00:00.000Z" : "2026-07-14T11:55:00.000Z",
        });
      }) as typeof fetch,
    });
    const evidence = await client.lookup(fingerprints);
    expect(call).toBe(2);
    expect(evidence.results).toHaveLength(101);
    expect(evidence.coverage.from).toBe("2026-07-14T10:05:00.000Z");
    expect(evidence.coverage.through).toBe("2026-07-14T11:55:00.000Z");
  });

  it("rejects reordered results and dishonest unseen metadata", async () => {
    const reordered = new TaskExposureClient({
      baseUrl: "http://100.76.72.59:8080",
      bearerToken: "owner-token",
      fetchImpl: (async () => responseFor([B, A])) as typeof fetch,
    });
    await expect(reordered.lookup([A, B])).rejects.toMatchObject({ kind: "contract" });

    const dishonest = new TaskExposureClient({
      baseUrl: "http://100.76.72.59:8080",
      bearerToken: "owner-token",
      fetchImpl: (async () => responseFor([A], { results: [{
        fingerprint_sha256: A,
        seen: false,
        first_seen_at: "2026-07-14T10:00:00.000Z",
        last_seen_at: null,
        lanes: [],
        model_ids: [],
        harness_ids: [],
      }] })) as typeof fetch,
    });
    await expect(dishonest.lookup([A])).rejects.toMatchObject({ kind: "contract" });
  });

  it("classifies authorization and transport failures without exposing credentials", async () => {
    const denied = new TaskExposureClient({
      baseUrl: "http://100.76.72.59:8080",
      bearerToken: "owner-token",
      fetchImpl: (async () => new Response("denied", { status: 403 })) as typeof fetch,
    });
    await expect(denied.lookup([A])).rejects.toMatchObject({ kind: "authentication" });

    const offline = new TaskExposureClient({
      baseUrl: "http://100.76.72.59:8080",
      bearerToken: "owner-token",
      fetchImpl: (async () => { throw new TypeError("owner-token network failure"); }) as typeof fetch,
    });
    await expect(offline.lookup([A])).rejects.toMatchObject({
      kind: "transport",
      message: "task exposure lookup transport failed",
    });
    expect(() => new TaskExposureClient({
      baseUrl: "https://public.example.com",
      bearerToken: "owner-token",
    })).toThrow(/sovereign/);
  });
});
