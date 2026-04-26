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
    expect(idx.inspect(req.idempotency_key, req).kind).toBe("fresh");
    idx.record(req.idempotency_key, req, "task-1");
    const second = idx.inspect(req.idempotency_key, req);
    expect(second).toEqual({ kind: "retry", task_id: "task-1" });
  });

  it("returns collision when payload changes for same key", () => {
    const idx = new IdempotencyIndex();
    const req = makeRequest({ prompt: "first" });
    idx.record(req.idempotency_key, req, "task-1");
    const variant = makeRequest({ prompt: "second" });
    expect(idx.inspect(variant.idempotency_key, variant)).toEqual({
      kind: "collision",
      existing_task_id: "task-1",
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
    expect(idx.inspect(req.idempotency_key, req).kind).toBe("fresh");
  });

  it("prune removes expired entries", () => {
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
