import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MuninEntry } from "../src/munin-client.js";

// The git/gh mechanics of recoverPublication are covered end-to-end in
// repo-sync.test.ts and publication-recovery-no-rerun.test.ts. Here we mock
// it so the orchestration layer (Munin reads/writes, tag transitions,
// idempotency, result patching) can be tested against controlled outcomes
// without spawning anything.
const recoverPublicationMock = vi.fn();

vi.mock("../src/task-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../src/task-helpers.js")>(
    "../src/task-helpers.js",
  );
  return {
    ...actual,
    recoverPublication: (...args: unknown[]) => recoverPublicationMock(...args),
  };
});

const {
  persistPublicationFailure,
  readPublicationRecoveryRecord,
  recoverPublicationForTask,
  PUBLICATION_RECOVERY_KEY,
} = await import("../src/publication-recovery.js");
const {
  PUBLICATION_FAILED_TAG,
  PUBLICATION_RECOVERED_TAG,
  PUBLICATION_ABANDONED_TAG,
} = await import("../src/task-helpers.js");

interface FakeEntry {
  content: string;
  tags: string[];
  updated_at: string;
  classification?: string;
}

function makeClient(initial: Record<string, Record<string, FakeEntry>> = {}) {
  const store = new Map<string, Map<string, FakeEntry>>();
  for (const [ns, keys] of Object.entries(initial)) {
    store.set(ns, new Map(Object.entries(keys)));
  }
  const writeCalls: Array<{ namespace: string; key: string; content: string; tags?: string[] }> = [];
  const logs: string[] = [];
  let writeSeq = 0;

  const client = {
    async read(namespace: string, key: string): Promise<(MuninEntry & { found: true }) | null> {
      const entry = store.get(namespace)?.get(key);
      if (!entry) return null;
      return {
        id: `${namespace}/${key}`,
        namespace,
        key,
        content: entry.content,
        tags: entry.tags,
        classification: entry.classification,
        created_at: entry.updated_at,
        updated_at: entry.updated_at,
        found: true as const,
      };
    },
    async write(
      namespace: string,
      key: string,
      content: string,
      tags?: string[],
      expectedUpdatedAt?: string,
      classification?: string,
    ): Promise<unknown> {
      writeCalls.push({ namespace, key, content, tags });
      const nsMap = store.get(namespace) ?? new Map<string, FakeEntry>();
      const existing = nsMap.get(key);
      if (expectedUpdatedAt !== undefined && existing?.updated_at !== expectedUpdatedAt) {
        throw new Error("expected_updated_at mismatch");
      }
      writeSeq += 1;
      nsMap.set(key, {
        content,
        tags: tags ?? existing?.tags ?? [],
        updated_at: `2026-07-15T09:00:${String(writeSeq).padStart(2, "0")}.000Z`,
        classification: classification ?? existing?.classification,
      });
      store.set(namespace, nsMap);
      return {};
    },
    async log(_namespace: string, content: string): Promise<void> {
      logs.push(content);
    },
  };

  return { client, store, writeCalls, logs };
}

const NS = "tasks/20260715t093850z-dogfood-cassette4";

beforeEach(() => {
  recoverPublicationMock.mockReset();
});

describe("persistPublicationFailure / readPublicationRecoveryRecord", () => {
  it("round-trips a durable record", async () => {
    const { client } = makeClient();
    const now = new Date("2026-07-15T09:38:50.000Z");
    const written = await persistPublicationFailure(client, {
      taskId: "20260715t093850z-dogfood-cassette4",
      taskNamespace: NS,
      workingDir: "/home/magnus/repos/cassette",
      branchName: "hugin/20260715t093850z-dogfood-cassette4",
      baseBranch: "master",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      prBody: "pr body",
      allowedEgressHosts: ["github.com"],
      failureReason: "GitHub denied grimnir-bot write access",
      classification: "internal",
      now,
    });
    expect(written.attempts).toBe(0);

    const read = await readPublicationRecoveryRecord(client, NS);
    expect(read).toEqual(written);
  });

  it("returns null for malformed content instead of throwing", async () => {
    const { client } = makeClient({
      [NS]: { [PUBLICATION_RECOVERY_KEY]: { content: "not json", tags: [], updated_at: "x" } },
    });
    const read = await readPublicationRecoveryRecord(client, NS);
    expect(read).toBeNull();
  });

  it("returns null when the record is absent", async () => {
    const { client } = makeClient();
    const read = await readPublicationRecoveryRecord(client, NS);
    expect(read).toBeNull();
  });
});

function seededStatus(tags: string[]): Record<string, Record<string, FakeEntry>> {
  return {
    [NS]: {
      status: { content: "## Task", tags, updated_at: "2026-07-15T09:39:00.000Z" },
      "result-structured": {
        content: JSON.stringify({
          schemaVersion: 1,
          taskId: "20260715t093850z-dogfood-cassette4",
          taskNamespace: NS,
          lifecycle: "completed",
          outcome: "completed",
          runtime: "codex",
          executor: "codex",
          resultSource: "codex",
          exitCode: 0,
          completedAt: "2026-07-15T09:40:00.000Z",
          bodyKind: "response",
          bodyText: "done",
          repositoryOutcome: { state: "publication-failed", baseBranch: "master", baseCommit: "a".repeat(40) },
          repositoryChange: {
            baseBranch: "master",
            baseCommit: "a".repeat(40),
            headCommit: "b".repeat(40),
            changedFiles: ["src/index.ts"],
            diffSha256: "c".repeat(64),
          },
        }),
        tags: ["type:task-result", "type:task-result-structured"],
        updated_at: "2026-07-15T09:40:00.000Z",
      },
      result: { content: "## Result\n\n- **Exit code:** 0\n", tags: [], updated_at: "2026-07-15T09:40:00.000Z" },
      [PUBLICATION_RECOVERY_KEY]: {
        content: JSON.stringify({
          schemaVersion: 1,
          taskId: "20260715t093850z-dogfood-cassette4",
          taskNamespace: NS,
          workingDir: "/home/magnus/repos/cassette",
          branchName: "hugin/20260715t093850z-dogfood-cassette4",
          baseBranch: "master",
          baseCommit: "a".repeat(40),
          headCommit: "b".repeat(40),
          prBody: "pr body",
          allowedEgressHosts: ["github.com"],
          failureReason: "GitHub denied grimnir-bot write access",
          attempts: 0,
          firstFailedAt: "2026-07-15T09:39:00.000Z",
          lastAttemptAt: "2026-07-15T09:39:00.000Z",
        }),
        tags: [],
        updated_at: "2026-07-15T09:39:00.000Z",
      },
    },
  };
}

describe("recoverPublicationForTask", () => {
  it("is a no-op when the task has no status entry", async () => {
    const { client } = makeClient();
    const result = await recoverPublicationForTask(client, NS);
    expect(result.status).toBe("noop");
    expect(recoverPublicationMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the task was never tagged publication:failed", async () => {
    const { client } = makeClient(seededStatus(["completed", "runtime:codex"]));
    const result = await recoverPublicationForTask(client, NS);
    expect(result.status).toBe("noop");
    expect(recoverPublicationMock).not.toHaveBeenCalled();
  });

  it("returns no-record when tagged failed but the durable record is missing", async () => {
    const seeded = seededStatus(["completed", "runtime:codex", PUBLICATION_FAILED_TAG]);
    delete seeded[NS]![PUBLICATION_RECOVERY_KEY];
    const { client } = makeClient(seeded);
    const result = await recoverPublicationForTask(client, NS);
    expect(result.status).toBe("no-record");
    expect(recoverPublicationMock).not.toHaveBeenCalled();
  });

  it("reconciles a partial success, flips tags, and patches the durable results", async () => {
    recoverPublicationMock.mockResolvedValueOnce({
      outcome: "reconciled",
      prUrl: "https://github.com/Magnus-Gille/cassette/pull/28",
      headCommit: "b".repeat(40),
    });
    const { client, store } = makeClient(
      seededStatus(["completed", "runtime:codex", PUBLICATION_FAILED_TAG]),
    );

    const result = await recoverPublicationForTask(client, NS);

    expect(result).toMatchObject({
      status: "reconciled",
      taskNamespace: NS,
      prUrl: "https://github.com/Magnus-Gille/cassette/pull/28",
    });
    // Executor is never re-invoked — recoverPublication (the only thing that
    // touches git/gh) was called exactly once with the durable record, and
    // nothing else in this module can start a task.
    expect(recoverPublicationMock).toHaveBeenCalledTimes(1);

    const status = store.get(NS)!.get("status")!;
    expect(status.tags).toContain(PUBLICATION_RECOVERED_TAG);
    expect(status.tags).not.toContain(PUBLICATION_FAILED_TAG);
    expect(status.tags).toContain("completed");
    expect(status.tags).toContain("runtime:codex");

    const resultStructured = JSON.parse(store.get(NS)!.get("result-structured")!.content);
    expect(resultStructured.repositoryOutcome.state).toBe("publication-recovered");
    expect(resultStructured.prUrl).toBe("https://github.com/Magnus-Gille/cassette/pull/28");

    const resultDoc = store.get(NS)!.get("result")!.content;
    expect(resultDoc).toContain("### Publication Recovery");
    expect(resultDoc).toContain("https://github.com/Magnus-Gille/cassette/pull/28");

    const record = await readPublicationRecoveryRecord(client, NS);
    expect(record?.attempts).toBe(1);
  });

  it("double-recovery after a terminal outcome is a no-op (idempotent)", async () => {
    recoverPublicationMock.mockResolvedValueOnce({
      outcome: "published",
      prUrl: "https://github.com/Magnus-Gille/cassette/pull/29",
      headCommit: "b".repeat(40),
    });
    const { client } = makeClient(
      seededStatus(["completed", "runtime:codex", PUBLICATION_FAILED_TAG]),
    );

    const first = await recoverPublicationForTask(client, NS);
    expect(first.status).toBe("published");
    expect(recoverPublicationMock).toHaveBeenCalledTimes(1);

    const second = await recoverPublicationForTask(client, NS);
    expect(second.status).toBe("noop");
    // The second call must not touch git/gh again.
    expect(recoverPublicationMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the failed tag and preserves work when recovery fails again (retryable)", async () => {
    recoverPublicationMock.mockResolvedValueOnce({
      outcome: "failed",
      error: "git push failed",
      headCommit: "b".repeat(40),
    });
    const { client, store, logs } = makeClient(
      seededStatus(["completed", "runtime:codex", PUBLICATION_FAILED_TAG]),
    );

    const result = await recoverPublicationForTask(client, NS);

    expect(result.status).toBe("failed");
    const status = store.get(NS)!.get("status")!;
    expect(status.tags).toContain(PUBLICATION_FAILED_TAG);
    expect(status.tags).not.toContain(PUBLICATION_RECOVERED_TAG);
    expect(logs.some((l) => l.includes("retryable"))).toBe(true);

    const record = await readPublicationRecoveryRecord(client, NS);
    expect(record?.attempts).toBe(1);
    expect(record?.lastError).toBe("git push failed");

    // A subsequent call retries (not a no-op) because the tag is unchanged.
    recoverPublicationMock.mockResolvedValueOnce({
      outcome: "published",
      prUrl: "https://github.com/Magnus-Gille/cassette/pull/30",
      headCommit: "b".repeat(40),
    });
    const retried = await recoverPublicationForTask(client, NS);
    expect(retried.status).toBe("published");
    expect(recoverPublicationMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces an unrecoverable failure durably and preserves the completed work", async () => {
    recoverPublicationMock.mockResolvedValueOnce({
      outcome: "abandoned",
      reason: "local branch no longer exists — checkout was reused",
    });
    const { client, store } = makeClient(
      seededStatus(["completed", "runtime:codex", PUBLICATION_FAILED_TAG]),
    );

    const result = await recoverPublicationForTask(client, NS);

    expect(result.status).toBe("abandoned");
    const status = store.get(NS)!.get("status")!;
    expect(status.tags).toContain(PUBLICATION_ABANDONED_TAG);
    expect(status.tags).not.toContain(PUBLICATION_FAILED_TAG);

    const resultStructured = JSON.parse(store.get(NS)!.get("result-structured")!.content);
    expect(resultStructured.repositoryOutcome.state).toBe("publication-abandoned");
    // repositoryChange evidence (the completed, exact commit reference) is
    // never dropped by an abandoned recovery.
    expect(resultStructured.repositoryChange.headCommit).toBe("b".repeat(40));

    const resultDoc = store.get(NS)!.get("result")!.content;
    expect(resultDoc).toContain("Action required");

    // Abandoned is terminal too — a further call is a no-op.
    const again = await recoverPublicationForTask(client, NS);
    expect(again.status).toBe("noop");
    expect(recoverPublicationMock).toHaveBeenCalledTimes(1);
  });
});
