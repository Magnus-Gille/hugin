import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchM5LedgerAttemptBinding,
  type M5LedgerAttemptBinding,
} from "../src/m5-ledger-attempt-binding.js";

const binding: M5LedgerAttemptBinding = {
  id: "ledger:attempt-1",
  evidenceIdentityHash: "a".repeat(64),
  taskInstanceId: "task-1",
  attemptId: "hugin-attempt:11111111-1111-4111-8111-111111111111",
  taskType: "code-edit",
  modelId: "qwen3-coder-next",
};
const wireBinding = {
  ...binding,
  evidenceIdentityHash: `sha256:${binding.evidenceIdentityHash}`,
};

afterEach(() => vi.unstubAllGlobals());

describe("fetchM5LedgerAttemptBinding", () => {
  it("reads the exact authenticated, id-addressable content-blind join", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ...wireBinding,
      outcome: "pass",
      score: 1,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchM5LedgerAttemptBinding(
      { baseUrl: "http://m5.internal:8080", apiKey: "test-owner-key" },
      binding.id,
    )).resolves.toEqual(binding);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://m5.internal:8080/ledger/ledger%3Aattempt-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer test-owner-key" }),
      }),
    );
  });

  it.each([
    ["missing evidence identity", { ...wireBinding, evidenceIdentityHash: undefined }],
    ["unprefixed evidence identity", binding],
    ["legacy unstamped row", { ...wireBinding, taskInstanceId: null, attemptId: null }],
    ["different ledger row", { ...wireBinding, id: "ledger:other" }],
  ])("fails closed for %s", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    await expect(fetchM5LedgerAttemptBinding(
      { baseUrl: "http://m5.internal:8080", apiKey: "test-owner-key" },
      binding.id,
    )).rejects.toThrow(/binding response/);
  });

  it("bounds an untrusted gateway response while reading it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(65 * 1024), { status: 200 })));
    await expect(fetchM5LedgerAttemptBinding(
      { baseUrl: "http://m5.internal:8080", apiKey: "test-owner-key" },
      binding.id,
    )).rejects.toThrow(/size limit/);
  });
});
