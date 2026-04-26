import { describe, expect, it } from "vitest";
import {
  IdempotencyIndex,
  canonicalizeRequest,
  hashPayload,
} from "../../src/broker/idempotency.js";
import type { DelegationRequest } from "../../src/broker/types.js";

function makeRequest(
  overrides: Partial<DelegationRequest> = {},
): DelegationRequest {
  return {
    envelope_version: 1,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    orchestrator_session_id: "sess-1",
    orchestrator_submitter: "claude-code",
    task_type: "summarize",
    prompt: "Summarize the README.",
    alias_requested: "tiny",
    alias_map_version: 1,
    ...overrides,
  };
}

describe("canonicalizeRequest", () => {
  it("produces the same string for semantically equal payloads", () => {
    const a = makeRequest({ prompt: "hi" });
    const b = makeRequest({ prompt: "hi" });
    expect(canonicalizeRequest(a)).toBe(canonicalizeRequest(b));
  });

  it("produces different strings for different prompts", () => {
    const a = makeRequest({ prompt: "hi" });
    const b = makeRequest({ prompt: "bye" });
    expect(canonicalizeRequest(a)).not.toBe(canonicalizeRequest(b));
  });
});

describe("hashPayload", () => {
  it("returns 64-char hex sha256", () => {
    expect(hashPayload(makeRequest())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("IdempotencyIndex", () => {
  it("returns fresh on first call, retry on identical payload", () => {
    const idx = new IdempotencyIndex();
    const req = makeRequest();
    expect(idx.reserve(req.idempotency_key, req).kind).toBe("fresh");
    idx.record(req.idempotency_key, req, "task-1");
    const second = idx.reserve(req.idempotency_key, req);
    expect(second).toEqual({ kind: "retry", task_id: "task-1" });
  });

  it("returns collision when payload changes for same key", () => {
    const idx = new IdempotencyIndex();
    const req = makeRequest({ prompt: "first" });
    idx.record(req.idempotency_key, req, "task-1");
    const variant = makeRequest({ prompt: "second" });
    expect(idx.reserve(variant.idempotency_key, variant)).toEqual({
      kind: "collision",
      existing_task_id: "task-1",
    });
  });

  it("returns in_flight when a concurrent reservation has not yet committed", () => {
    const idx = new IdempotencyIndex();
    const req = makeRequest();
    expect(idx.reserve(req.idempotency_key, req).kind).toBe("fresh");
    expect(idx.reserve(req.idempotency_key, req).kind).toBe("in_flight");
  });

  it("release frees a reservation so a retry observes fresh", () => {
    const idx = new IdempotencyIndex();
    const req = makeRequest();
    expect(idx.reserve(req.idempotency_key, req).kind).toBe("fresh");
    idx.release(req.idempotency_key);
    expect(idx.reserve(req.idempotency_key, req).kind).toBe("fresh");
  });

  it("record commits the reservation and clears in-flight state", () => {
    const idx = new IdempotencyIndex();
    const req = makeRequest();
    idx.reserve(req.idempotency_key, req);
    idx.record(req.idempotency_key, req, "task-1");
    expect(idx.reserve(req.idempotency_key, req)).toEqual({
      kind: "retry",
      task_id: "task-1",
    });
  });

  it("treats expired entries as fresh", () => {
    let now = 1_000_000;
    const idx = new IdempotencyIndex({
      windowMs: 1000,
      now: () => now,
    });
    const req = makeRequest();
    idx.record(req.idempotency_key, req, "task-1");
    now += 10_000;
    expect(idx.reserve(req.idempotency_key, req).kind).toBe("fresh");
  });

  it("canonicalizeRequest hashes nested worktree fields", () => {
    const a = makeRequest({
      alias_requested: "pi-large-coder",
      worktree: { repo: "hugin", base_ref: "main", target_files: ["a.ts"] },
    } as Partial<DelegationRequest>);
    const b = makeRequest({
      alias_requested: "pi-large-coder",
      worktree: { repo: "hugin", base_ref: "main", target_files: ["b.ts"] },
    } as Partial<DelegationRequest>);
    expect(canonicalizeRequest(a)).not.toBe(canonicalizeRequest(b));
    expect(hashPayload(a)).not.toBe(hashPayload(b));
  });

  it("canonicalizeRequest is stable under key insertion order", () => {
    const a = makeRequest({ prompt: "hi" });
    const b: DelegationRequest = {
      alias_map_version: 1,
      alias_requested: "tiny",
      prompt: "hi",
      task_type: "summarize",
      orchestrator_submitter: "claude-code",
      orchestrator_session_id: "sess-1",
      idempotency_key: "11111111-1111-4111-8111-111111111111",
      envelope_version: 1,
    };
    expect(canonicalizeRequest(a)).toBe(canonicalizeRequest(b));
  });

  it("prune removes expired entries and stale reservations", () => {
    let now = 1_000_000;
    const idx = new IdempotencyIndex({
      windowMs: 1000,
      now: () => now,
    });
    const req = makeRequest();
    idx.record(req.idempotency_key, req, "task-1");
    expect(idx.size()).toBe(1);
    now += 10_000;
    expect(idx.prune()).toBe(1);
    expect(idx.size()).toBe(0);
  });
});
