import { describe, expect, it, vi } from "vitest";
import { MuninWriteRejectedError, type MuninClient } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import { buildTaskLifecycleTimeline } from "../src/learning-registry-view.js";
import {
  ingestExternalReceipt,
  type ExternalReceiptIntakeDeps,
} from "../src/external-receipt-intake.js";
import { signExternalReceipt } from "../src/external-receipt-signing.js";
import {
  CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE,
  EXTERNAL_RECEIPT_CONTRACT_VERSION,
  EXTERNAL_RECEIPT_SCHEMA_VERSION,
  storedExternalReceiptSchema,
  type ExternalReceiptEnvelope,
} from "../src/external-receipt-schema.js";

interface StoredEntry {
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

/** Same in-memory create-if-absent / CAS Munin double used by
 * tests/learning-registry-store.test.ts, with deterministic write
 * timestamps so registry storage stays stable in these tests. */
class InMemoryMunin {
  private entries: StoredEntry[] = [];
  private seq = 0;

  private clock(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 6, 20, 0, 0, 0, 0) + this.seq).toISOString();
  }

  private find(namespace: string, key: string): StoredEntry | undefined {
    return this.entries.find((e) => e.namespace === namespace && e.key === key);
  }

  async read(namespace: string, key: string) {
    const entry = this.find(namespace, key);
    if (!entry) return null;
    return { ...entry, found: true } as unknown as Record<string, unknown>;
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
    createIfAbsent?: boolean,
  ) {
    const existing = this.find(namespace, key);
    if (createIfAbsent && existing) {
      throw new MuninWriteRejectedError(namespace, key, {
        error: "conflict",
        conflict_reason: "already_exists",
        current_updated_at: existing.updated_at,
      });
    }
    if (expectedUpdatedAt !== undefined && (!existing || existing.updated_at !== expectedUpdatedAt)) {
      throw new MuninWriteRejectedError(namespace, key, {
        error: "conflict",
        conflict_reason: "version_mismatch",
        current_updated_at: existing?.updated_at,
      });
    }
    const updated_at = this.clock();
    const created_at = existing?.created_at ?? updated_at;
    const next: StoredEntry = { namespace, key, content, tags: tags ?? [], classification, created_at, updated_at };
    this.entries = [...this.entries.filter((e) => !(e.namespace === namespace && e.key === key)), next];
    return { ok: true, status: existing ? "updated" : "created", updated_at };
  }

  async query(opts: { namespace?: string; tags?: string[]; entry_type?: string; cursor?: string }) {
    let results = this.entries;
    if (opts.namespace) results = results.filter((e) => e.namespace === opts.namespace);
    if (opts.tags?.length) results = results.filter((e) => opts.tags!.every((t) => e.tags.includes(t)));
    return { results: results.map((e) => ({ namespace: e.namespace, key: e.key })), truncated: false };
  }
}

const SECRET_HEX = "c".repeat(64);
const CODEX_CLI_KEY = "codex-cli-work";
const PI_KEY = "pi-app-home";
const KEYS = { [CODEX_CLI_KEY]: SECRET_HEX, [PI_KEY]: SECRET_HEX };
const PROMPTLY_RECEIVED_AT = "2026-07-20T09:05:00Z";

function makeReceipt(overrides: Partial<ExternalReceiptEnvelope> = {}): ExternalReceiptEnvelope {
  return {
    schemaVersion: EXTERNAL_RECEIPT_SCHEMA_VERSION,
    contractVersion: EXTERNAL_RECEIPT_CONTRACT_VERSION,
    surface: "codex_cli",
    kind: "observation",
    receiptId: "receipt-obs-1",
    capacityPrincipal: CODEX_CLI_KEY,
    identity: { provider: "openai", model: "gpt-5.1-codex", harness: "codex-cli@1.4.2" },
    instance: {
      taskInstanceId: "task-instance-1",
      sourceTaskRef: { system: "github-issue", id: "Magnus-Gille/hugin#237" },
    },
    occurredAt: "2026-07-20T09:00:00Z",
    producedAt: "2026-07-20T09:00:05Z",
    reviewerIndependenceNote: CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE,
    ...overrides,
  } as ExternalReceiptEnvelope;
}

function makeDeps(munin: MuninClient, receivedAt = PROMPTLY_RECEIVED_AT): ExternalReceiptIntakeDeps {
  return {
    munin,
    registry: new LearningRegistryStore(munin, { now: () => receivedAt }),
    keys: KEYS,
    now: () => receivedAt,
  };
}

function sign(receipt: ExternalReceiptEnvelope, keyId = CODEX_CLI_KEY): string {
  return signExternalReceipt(receipt, keyId, SECRET_HEX);
}

describe("ingestExternalReceipt — admission of an authentic complete codex_cli receipt", () => {
  it("ingests observation + outcome into the registry as submission/attempt-reference/terminal-outcome, and is reconstructable", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);

    const observation = makeReceipt();
    const observationResult = await ingestExternalReceipt(deps, observation, sign(observation));
    expect(observationResult.status).toBe("admitted");
    if (observationResult.status !== "admitted") throw new Error("unreachable");
    expect(observationResult.admission).toBe("created");
    expect(observationResult.coverage).toBe("imported");
    expect(observationResult.reconciledWithNativeTask).toBe(false);

    const outcome = makeReceipt({
      kind: "outcome",
      receiptId: "receipt-out-1",
      outcome: "completed",
      occurredAt: "2026-07-20T09:04:00Z",
      producedAt: "2026-07-20T09:04:05Z",
    });
    const outcomeResult = await ingestExternalReceipt(deps, outcome, sign(outcome));
    expect(outcomeResult.status).toBe("admitted");
    if (outcomeResult.status !== "admitted") throw new Error("unreachable");
    expect(outcomeResult.taskId).toBe(observationResult.taskId);
    expect(outcomeResult.attemptId).toBe(observationResult.attemptId);

    const timeline = await buildTaskLifecycleTimeline(deps.registry, outcomeResult.taskId);
    expect(timeline.truncated).toBe(false);
    const kinds = timeline.entries.map((e) => e.event.recordKind);
    // submission and attempt-reference share the observation receipt's
    // occurredAt (a tie broken arbitrarily by eventId), but terminal-outcome
    // strictly postdates both, so it must sort last.
    expect(kinds).toHaveLength(3);
    expect(kinds).toContain("submission");
    expect(kinds).toContain("attempt-reference");
    expect(kinds[2]).toBe("terminal-outcome");
    expect(timeline.entries.every((e) => !e.superseded && !e.excluded)).toBe(true);

    const submission = timeline.entries.find((e) => e.event.recordKind === "submission")!;
    expect(submission.event.recordKind === "submission" && submission.event.payload.originComponent).toBe("codex_cli");

    const terminal = timeline.entries.find((e) => e.event.recordKind === "terminal-outcome")!;
    expect(terminal.event.recordKind === "terminal-outcome" && terminal.event.payload.outcome).toBe("completed");
  });

  it("ingests a pi surface receipt equivalently", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = makeReceipt({
      surface: "pi",
      capacityPrincipal: PI_KEY,
      identity: { provider: "anthropic", model: "claude-sonnet-5", harness: "pi-app@4.5.0" },
    });
    const result = await ingestExternalReceipt(deps, receipt, sign(receipt, PI_KEY));
    expect(result.status).toBe("admitted");
    if (result.status !== "admitted") throw new Error("unreachable");

    const timeline = await buildTaskLifecycleTimeline(deps.registry, result.taskId);
    const submission = timeline.entries.find((e) => e.event.recordKind === "submission")!;
    expect(submission.event.recordKind === "submission" && submission.event.payload.originComponent).toBe("pi");
  });
});

describe("ingestExternalReceipt — idempotent re-ingestion", () => {
  it("re-ingesting the exact same receipt is a no-op", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = makeReceipt();

    const first = await ingestExternalReceipt(deps, receipt, sign(receipt));
    expect(first.status).toBe("admitted");
    if (first.status !== "admitted") throw new Error("unreachable");
    expect(first.admission).toBe("created");

    const second = await ingestExternalReceipt(deps, receipt, sign(receipt));
    expect(second.status).toBe("admitted");
    if (second.status !== "admitted") throw new Error("unreachable");
    expect(second.admission).toBe("exact-existing");
    expect(second.taskId).toBe(first.taskId);
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.eventIds).toEqual(first.eventIds);

    const timeline = await buildTaskLifecycleTimeline(deps.registry, first.taskId);
    // One observation receipt yields exactly submission + attempt-reference;
    // re-ingesting it must not add a third or fourth duplicate row.
    expect(timeline.entries).toHaveLength(2);
  });

  it("rejects a redelivered receiptId whose content actually changed", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = makeReceipt();
    await ingestExternalReceipt(deps, receipt, sign(receipt));

    const mutated = { ...receipt, instance: { ...receipt.instance, sourceTaskRef: { system: "github-issue", id: "Magnus-Gille/hugin#999" } } };
    const result = await ingestExternalReceipt(deps, mutated, sign(mutated));
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("receipt-id-reused-with-different-content");
  });
});

describe("ingestExternalReceipt — fail-closed rejections", () => {
  it("rejects a completely unauthenticated body", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const result = await ingestExternalReceipt(deps, makeReceipt(), null);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("missing-signature");
  });

  it("rejects a signature from an unregistered producer", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = makeReceipt();
    const badSignature = signExternalReceipt(receipt, "not-a-registered-producer", SECRET_HEX);
    const result = await ingestExternalReceipt(deps, receipt, badSignature);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("unknown-producer");
  });

  it("rejects an incomplete envelope (required field missing) with a specific reason", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = makeReceipt() as unknown as Record<string, unknown>;
    delete receipt.instance;
    const result = await ingestExternalReceipt(deps, receipt, "v1:codex-cli-work:" + "0".repeat(64));
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("incomplete-envelope");
  });

  it("rejects a non-content-blind envelope (extra field) with a specific reason, never silently stripping it", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = { ...makeReceipt(), transcript: "the full private conversation" };
    const result = await ingestExternalReceipt(deps, receipt, "v1:codex-cli-work:" + "0".repeat(64));
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("non-content-blind");
  });

  it("never admits an unverifiable receipt even when every other field looks plausible", async () => {
    const rawMunin = new InMemoryMunin();
    const munin = rawMunin as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = makeReceipt();
    const wrongSignature = signExternalReceipt(receipt, CODEX_CLI_KEY, "d".repeat(64)); // wrong secret
    const result = await ingestExternalReceipt(deps, receipt, wrongSignature);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("invalid-signature");

    // A rejected receipt must leave no trace in durable storage — no
    // receipt doc, no registry event, nothing to accidentally later count.
    const everything = await rawMunin.query({});
    expect(everything.results).toHaveLength(0);
  });
});

describe("ingestExternalReceipt — reconciliation with a native Hugin task", () => {
  it("reconciles an external receipt onto an existing native submission instead of double-counting the task", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);

    const nativeTaskId = "20260715-100000-native1";
    await deps.registry.recordSubmission({
      taskId: nativeTaskId,
      taskOutcomeRef: { namespace: `tasks/${nativeTaskId}`, key: "result-structured" },
      occurredAt: "2026-07-15T10:00:00Z",
    });

    const receipt = makeReceipt({
      instance: { ...makeReceipt().instance, reconcilesHuginTaskId: nativeTaskId },
    });
    const result = await ingestExternalReceipt(deps, receipt, sign(receipt));
    expect(result.status).toBe("admitted");
    if (result.status !== "admitted") throw new Error("unreachable");
    expect(result.taskId).toBe(nativeTaskId);
    expect(result.reconciledWithNativeTask).toBe(true);

    const timeline = await buildTaskLifecycleTimeline(deps.registry, nativeTaskId);
    const submissions = timeline.entries.filter((e) => e.event.recordKind === "submission");
    expect(submissions).toHaveLength(1); // still exactly one submission — the native one
    expect(submissions[0].event.recordKind === "submission" && submissions[0].event.payload.originComponent).toBe("hugin");
    const attemptRefs = timeline.entries.filter((e) => e.event.recordKind === "attempt-reference");
    expect(attemptRefs).toHaveLength(1); // the imported attempt, added alongside
  });

  it("rejects a reconciliation claim against a task with no native submission", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = makeReceipt({
      instance: { ...makeReceipt().instance, reconcilesHuginTaskId: "does-not-exist" },
    });
    const result = await ingestExternalReceipt(deps, receipt, sign(receipt));
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("reconciliation-target-not-found");
  });

  it("rejects a reconciliation claim against a task whose submission is itself an import, not native", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const first = makeReceipt();
    const firstResult = await ingestExternalReceipt(deps, first, sign(first));
    if (firstResult.status !== "admitted") throw new Error("unreachable");

    const second = makeReceipt({
      receiptId: "receipt-obs-2",
      instance: { ...makeReceipt().instance, taskInstanceId: "task-instance-2", reconcilesHuginTaskId: firstResult.taskId },
    });
    const result = await ingestExternalReceipt(deps, second, sign(second));
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("reconciliation-target-conflict");
  });
});

describe("ingestExternalReceipt — honest coverage state", () => {
  it("marks a promptly-received receipt as imported", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = makeReceipt({ occurredAt: "2026-07-20T09:00:00Z" });
    const result = await ingestExternalReceipt(deps, receipt, sign(receipt));
    expect(result.status).toBe("admitted");
    if (result.status !== "admitted") throw new Error("unreachable");
    expect(result.coverage).toBe("imported");
  });

  it("marks a receipt received long after the fact as imported-late, honestly", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = makeReceipt({ occurredAt: "2026-06-01T09:00:00Z", producedAt: "2026-06-01T09:00:05Z" });
    const result = await ingestExternalReceipt(deps, receipt, sign(receipt));
    expect(result.status).toBe("admitted");
    if (result.status !== "admitted") throw new Error("unreachable");
    expect(result.coverage).toBe("imported-late");
  });

  it("does not reclassify a prompt import merely because the calendar later advances", async () => {
    vi.useFakeTimers();
    try {
      const receipt = makeReceipt({
        receiptId: "receipt-obs-clock-independent",
        occurredAt: "2026-07-20T09:00:00Z",
        producedAt: "2026-07-20T09:00:05Z",
      });

      vi.setSystemTime(new Date("2026-07-20T09:05:00Z"));
      const promptMunin = new InMemoryMunin() as unknown as MuninClient;
      const promptResult = await ingestExternalReceipt(
        makeDeps(promptMunin, PROMPTLY_RECEIVED_AT),
        receipt,
        sign(receipt),
      );
      expect(promptResult.status).toBe("admitted");
      if (promptResult.status !== "admitted") throw new Error("unreachable");
      expect(promptResult.coverage).toBe("imported");

      vi.setSystemTime(new Date("2042-01-01T00:00:00Z"));
      const advancedCalendarMunin = new InMemoryMunin() as unknown as MuninClient;
      const advancedCalendarResult = await ingestExternalReceipt(
        makeDeps(advancedCalendarMunin, PROMPTLY_RECEIVED_AT),
        receipt,
        sign(receipt),
      );
      expect(advancedCalendarResult.status).toBe("admitted");
      if (advancedCalendarResult.status !== "admitted") throw new Error("unreachable");
      expect(advancedCalendarResult.coverage).toBe("imported");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ingestExternalReceipt — capacity principals never confer reviewer independence", () => {
  it("stores the fixed independence-disclaimer note verbatim on every admitted receipt", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);
    const receipt = makeReceipt();
    const result = await ingestExternalReceipt(deps, receipt, sign(receipt));
    if (result.status !== "admitted") throw new Error("unreachable");

    const timeline = await buildTaskLifecycleTimeline(deps.registry, result.taskId);
    const submission = timeline.entries.find((e) => e.event.recordKind === "submission")!;
    const docRef = submission.event.recordKind === "submission" ? submission.event.payload.taskOutcomeRef : undefined;
    expect(docRef).toBeDefined();
    const entry = await munin.read(docRef!.namespace, docRef!.key);
    const stored = storedExternalReceiptSchema.parse(JSON.parse((entry as { content: string }).content));
    expect(stored.receipt.reviewerIndependenceNote).toBe(CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE);
  });

  it("treats two different capacity principals (e.g. two subscriptions) as two distinct, unmerged tasks — never one independently-confirmed task", async () => {
    const munin = new InMemoryMunin() as unknown as MuninClient;
    const deps = makeDeps(munin);

    const receiptA = makeReceipt({ capacityPrincipal: "codex-cli-work" });
    const resultA = await ingestExternalReceipt(deps, receiptA, sign(receiptA, CODEX_CLI_KEY));
    if (resultA.status !== "admitted") throw new Error("unreachable");

    const secondKeyId = "codex-cli-personal";
    const receiptB = makeReceipt({ receiptId: "receipt-obs-1-personal", capacityPrincipal: secondKeyId });
    const keysWithSecond = { ...KEYS, [secondKeyId]: SECRET_HEX };
    const resultB = await ingestExternalReceipt(
      { ...deps, keys: keysWithSecond },
      receiptB,
      signExternalReceipt(receiptB, secondKeyId, SECRET_HEX),
    );
    if (resultB.status !== "admitted") throw new Error("unreachable");

    // Same underlying sourceTaskRef/taskInstanceId, different capacity
    // principal — this must never collapse into one merged/"independently
    // confirmed" task. Each capacity principal gets its own task identity.
    expect(resultB.taskId).not.toBe(resultA.taskId);
  });
});
