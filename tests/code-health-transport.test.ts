import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  deliverCodeHealth,
  validateCodeHealthRecord,
  type CodeHealthAppendRequest,
} from "../src/code-health-transport.js";
import { createFrictionOutbox } from "../src/friction/outbox.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_kind: "assessment",
    version: "1.0",
    repo_owner: "Magnus-Gille",
    repo_name: "grimnir",
    task_id: "task-1",
    task_class: "qa",
    attempt_id: "attempt-1",
    parent_attempt_id: null,
    child_attempt_ids: [],
    record_id: "ref:assessment-1",
    observed_at: "2026-10-10T11:00:00Z",
    before_sha: null,
    after_sha: null,
    module_refs: [],
    reporter: {
      id: "ref:worker-1",
      kind: "worker",
      requested_model: null,
      observed_model: null,
      observed_effort: null,
    },
    actual_worker: {
      id: "ref:worker-1",
      kind: "worker",
      requested_model: null,
      observed_model: null,
      observed_effort: null,
    },
    rubric_version: "changeability-1.0",
    applicability: "not_applicable",
    outcome: "completed",
    completeness: "complete",
    environment: "unknown",
    observation_refs: [],
    ratings: ["locate", "understand", "verify"].map((dimension) => ({
      dimension,
      value: "not-assessable",
      reason: "not_applicable",
      evidence_refs: [],
    })),
    supersedes_record_id: null,
    correction_ref: null,
    ...overrides,
  };
}

function request(overrides: Partial<CodeHealthAppendRequest> = {}): CodeHealthAppendRequest {
  return {
    action: "append",
    namespace: "projects/grimnir/code-health",
    idempotency_key: "a6b4c114-caa3-4cc0-9f31-2d6a8af8f4ef",
    record: record(),
    classification: "internal",
    ...overrides,
  };
}

function receipt(input: CodeHealthAppendRequest, overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    action: "code_health",
    status: "stored",
    id: "entry-1",
    record_id: input.record.record_id,
    namespace: input.namespace,
    idempotency_key: input.idempotency_key,
    collected_at: "2026-10-10T12:00:00.000Z",
    expires_at: "2027-04-10T12:00:00.000Z",
    updated_at: "2026-10-10T12:00:00.000Z",
    classification: input.classification,
    ...overrides,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function temporaryDirectory(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "hugin-code-health-outbox-"));
}

describe("code-health transport", () => {
  it("validates a record with the frozen contract and rejects malformed records", async () => {
    await expect(validateCodeHealthRecord(record())).resolves.toMatchObject({ valid: true, errors: [] });
    const malformed = await validateCodeHealthRecord({ ...record(), unexpected: true });
    expect(malformed.valid).toBe(false);
    expect(malformed.errors.length).toBeGreaterThan(0);
    expect(malformed.errors.join(" ")).not.toContain("unexpected");
  });

  it("stores the exact request before one bounded delivery and removes it only after a strict receipt", async () => {
    const directory = await temporaryDirectory();
    try {
      const outbox = createFrictionOutbox({ directory, now: () => NOW });
      const input = request();
      const writer = {
        codeHealthAppend: vi.fn(async (value: CodeHealthAppendRequest) => {
          const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
          expect(files).toHaveLength(1);
          const persisted = JSON.parse(await fs.readFile(path.join(directory, files[0]!), "utf8"));
          expect(persisted.request).toEqual(value);
          return receipt(value);
        }),
      };

      const result = await deliverCodeHealth(input, { outbox, writer });

      expect(result).toEqual({
        status: "acknowledged",
        recordId: "ref:assessment-1",
        receipt: {
          record_id: "ref:assessment-1",
          collected_at: "2026-10-10T12:00:00.000Z",
          expires_at: "2027-04-10T12:00:00.000Z",
          updated_at: "2026-10-10T12:00:00.000Z",
          classification: "internal",
        },
      });
      expect(writer.codeHealthAppend).toHaveBeenCalledTimes(1);
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the same CAS request after an ambiguous timeout and restart, then replays only that entry", async () => {
    const directory = await temporaryDirectory();
    try {
      const input = request({
        expected_updated_at: "2026-10-10T11:30:00.000Z",
        record: record({
          supersedes_record_id: "ref:assessment-old",
          correction_ref: "ref:correction-1",
        }),
      });
      const first = await deliverCodeHealth(input, {
        outbox: createFrictionOutbox({ directory, now: () => NOW, codeHealthTimeoutMs: 10 }),
        writer: { codeHealthAppend: () => new Promise(() => {}) },
      });
      expect(first).toMatchObject({ status: "queued", recordId: "ref:assessment-1" });
      const queuedFiles = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
      expect(queuedFiles).toHaveLength(1);
      const beforeRestart = await fs.readFile(path.join(directory, queuedFiles[0]!), "utf8");

      const restarted = createFrictionOutbox({ directory, now: () => NOW });
      const retry = await deliverCodeHealth(input, {
        outbox: restarted,
        writer: { codeHealthAppend: async (value) => receipt(value, { status: "corrected" }) },
      });

      expect(retry.status).toBe("acknowledged");
      expect(JSON.parse(beforeRestart).request).toEqual(input);
      expect((await fs.readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not acknowledge a response whose receipt conflicts with the request", async () => {
    const directory = await temporaryDirectory();
    try {
      const input = request();
      const result = await deliverCodeHealth(input, {
        outbox: createFrictionOutbox({ directory, now: () => NOW }),
        writer: { codeHealthAppend: async (value) => receipt(value, { record_id: "ref:other-record" }) },
      });
      expect(result).toMatchObject({ status: "queued", recordId: "ref:assessment-1" });
      expect((await fs.readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("retains v2 entries during replay through a legacy v1 writer and replays them when v2 is available", async () => {
    const directory = await temporaryDirectory();
    try {
      const outbox = createFrictionOutbox({ directory, now: () => NOW });
      const input = request();
      await expect(outbox.enqueueCodeHealth(input)).resolves.toMatchObject({ stored: true });

      const legacyReplay = await outbox.replay({ write: vi.fn(async () => ({ status: "created" })) });
      expect(legacyReplay.failed).toBe(1);
      expect(legacyReplay.pendingCount).toBe(1);

      const append = vi.fn(async (value: CodeHealthAppendRequest) => receipt(value));
      const v2Replay = await outbox.replay({
        write: vi.fn(async () => ({ status: "created" })),
        codeHealthAppend: append,
      });
      expect(append).toHaveBeenCalledWith(input);
      expect(v2Replay.replayed).toBe(1);
      expect(v2Replay.pendingCount).toBe(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("marks an explicit terminal refusal unsaved without retaining its raw message", async () => {
    const directory = await temporaryDirectory();
    const diagnostics: string[] = [];
    try {
      const input = request();
      const result = await deliverCodeHealth(input, {
        outbox: createFrictionOutbox({ directory, now: () => NOW, stderr: (line) => diagnostics.push(line) }),
        writer: {
          codeHealthAppend: async () => {
            throw Object.assign(new Error("classification denied: private payload"), {
              name: "MuninCodeHealthRejectedError",
              errorCode: "access_denied",
            });
          },
        },
      });
      expect(result).toMatchObject({ status: "unsaved", reason: "permanent_refusal" });
      expect(await fs.readdir(directory)).toEqual(["terminal"]);
      expect((await createFrictionOutbox({ directory }).status()).codeHealthPermanentRefusalCount).toBe(1);
      expect(diagnostics.join(" ")).not.toContain("private payload");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("expires queued records after 30 days from observed_at and counts expiry", async () => {
    const directory = await temporaryDirectory();
    try {
      let now = new Date("2026-10-10T12:00:00.000Z");
      const input = request({ record: record({ observed_at: "2026-10-10T11:00:00Z" }) });
      const outbox = createFrictionOutbox({ directory, now: () => now });
      await expect(outbox.enqueueCodeHealth(input)).resolves.toMatchObject({ stored: true });
      now = new Date("2026-11-10T12:00:01.000Z");
      const status = await createFrictionOutbox({ directory, now: () => now }).status();
      expect(status).toMatchObject({ pendingCount: 0, codeHealthExpiredCount: 1 });
      expect((await fs.readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects future observations and expires recovered entries by enqueued_at even if observed_at is future", async () => {
    const directory = await temporaryDirectory();
    try {
      const outbox = createFrictionOutbox({ directory, now: () => NOW });
      const futureRequest = request({ record: record({ observed_at: "2026-10-11T12:00:00Z" }) });
      await expect(outbox.enqueueCodeHealth(futureRequest)).resolves.toMatchObject({
        stored: false,
        reason: "invalid_request",
      });

      // Model recovery of a pre-hardening entry with an adversarial future
      // observation. The local enqueue clock still caps pending life.
      const agedRequest = request({ record: record({ observed_at: "2027-10-10T12:00:00Z" }) });
      const entry = {
        version: 2,
        enqueuedAt: new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        request: agedRequest,
      };
      const digest = createHash("sha256")
        .update(stableJson({ version: 2, request: agedRequest }))
        .digest("hex");
      await fs.writeFile(path.join(directory, `${digest}.json`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });

      const status = await outbox.status();
      expect(status).toMatchObject({ pendingCount: 0, codeHealthExpiredCount: 1 });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts Munin's millisecond receipt timestamp and enforces its six-month retention", async () => {
    const directory = await temporaryDirectory();
    try {
      const input = request();
      const valid = await deliverCodeHealth(input, {
        outbox: createFrictionOutbox({ directory, now: () => NOW }),
        writer: { codeHealthAppend: async (value) => receipt(value) },
      });
      expect(valid.status).toBe("acknowledged");
      expect(valid.receipt?.collected_at).toBe("2026-10-10T12:00:00.000Z");

      const tooLong = await deliverCodeHealth(request({
        idempotency_key: "c6b4c114-caa3-4cc0-9f31-2d6a8af8f4ef",
        record: record({ record_id: "ref:assessment-too-long" }),
      }), {
        outbox: createFrictionOutbox({ directory, now: () => NOW }),
        writer: { codeHealthAppend: async (value) => receipt(value, { expires_at: "2027-04-10T12:00:00.001Z" }) },
      });
      expect(tooLong).toMatchObject({ status: "queued", reason: "receipt_unverified" });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a second request visibly when the shared bounded queue is full", async () => {
    const directory = await temporaryDirectory();
    try {
      const outbox = createFrictionOutbox({ directory, now: () => NOW, maxEntries: 1 });
      const first = request();
      await expect(outbox.enqueueCodeHealth(first)).resolves.toMatchObject({ stored: true });
      const second = request({
        idempotency_key: "b6b4c114-caa3-4cc0-9f31-2d6a8af8f4ef",
        record: record({ record_id: "ref:assessment-2" }),
      });
      const result = await deliverCodeHealth(second, {
        outbox,
        writer: { codeHealthAppend: vi.fn(async (value) => receipt(value)) },
      });
      expect(result).toMatchObject({ status: "unsaved", reason: "outbox_full" });
      expect((await fs.readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("loads the same frozen validator from the built distribution", async () => {
    const builtModule = path.resolve(process.cwd(), "dist/code-health-transport.js");
    const module = await import(`${pathToFileURL(builtModule).href}?test=${Date.now()}`) as typeof import("../src/code-health-transport.js");
    await expect(module.validateCodeHealthRecord(record())).resolves.toMatchObject({ valid: true });
    expect(module.CODE_HEALTH_CONTRACT_SOURCE_REVISION).toBe("7df005ce952a52816597d9888da977d689a631fd");
  });
});
