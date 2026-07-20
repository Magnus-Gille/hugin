import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { MuninEntry } from "../src/munin-client.js";

// End-to-end guarantee for issue #225's core acceptance criterion: recovering
// a publication failure must NEVER re-run the paid model work. This test
// exercises the REAL recoverPublication (no task-helpers mocking) through
// recoverPublicationForTask, with only `child_process.spawn` intercepted, and
// asserts every spawned command is git/gh plumbing — nothing that could be an
// executor (codex, claude, an SDK runtime, a shell wrapping either).
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    const child = new MockChildProcess();
    setImmediate(() => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--verify") {
        child.stdout.emit("data", Buffer.from(`${"b".repeat(40)}\n`));
        child.emit("close", 0);
      } else if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        child.stdout.emit("data", Buffer.from("[]\n"));
        child.emit("close", 0);
      } else if (cmd === "git" && args[0] === "remote") {
        child.stdout.emit("data", Buffer.from("git@github.com:Magnus-Gille/cassette.git\n"));
        child.emit("close", 0);
      } else if (cmd === "git" && args[0] === "ls-remote") {
        child.stdout.emit("data", Buffer.from("\n"));
        child.emit("close", 0);
      } else if (cmd === "git" && args[0] === "push") {
        child.emit("close", 0);
      } else if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        child.stdout.emit("data", Buffer.from("https://github.com/Magnus-Gille/cassette/pull/28\n"));
        child.emit("close", 0);
      } else {
        child.emit("close", 1);
      }
    });
    return child;
  },
}));

const { recoverPublicationForTask } = await import("../src/publication-recovery.js");
const { PUBLICATION_FAILED_TAG, PUBLICATION_RECOVERY_KEY } = await import("../src/task-helpers.js");
void PUBLICATION_RECOVERY_KEY; // referenced for readability of the seeded namespace map below

const NS = "tasks/20260715t093850z-dogfood-cassette4";
const RECOVERY_KEY = "publication-recovery";

interface FakeEntry {
  content: string;
  tags: string[];
  updated_at: string;
}

function makeClient(seed: Record<string, FakeEntry>) {
  const store = new Map<string, FakeEntry>(Object.entries(seed));
  return {
    async read(_ns: string, key: string): Promise<(MuninEntry & { found: true }) | null> {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        id: key,
        namespace: NS,
        key,
        content: entry.content,
        tags: entry.tags,
        created_at: entry.updated_at,
        updated_at: entry.updated_at,
        found: true as const,
      };
    },
    async write(_ns: string, key: string, content: string, tags?: string[]): Promise<unknown> {
      const existing = store.get(key);
      store.set(key, { content, tags: tags ?? existing?.tags ?? [], updated_at: new Date().toISOString() });
      return {};
    },
    async log(): Promise<void> {},
  };
}

beforeEach(() => {
  spawnCalls.length = 0;
});

describe("recoverPublicationForTask — no re-execution guarantee (#225)", () => {
  it("recovers publication using only git/gh plumbing, never an executor", async () => {
    const client = makeClient({
      status: { content: "## Task", tags: ["completed", "runtime:codex", PUBLICATION_FAILED_TAG], updated_at: "t0" },
      [RECOVERY_KEY]: {
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
          firstFailedAt: "t0",
          lastAttemptAt: "t0",
        }),
        tags: [],
        updated_at: "t0",
      },
    });

    const result = await recoverPublicationForTask(client, NS);

    expect(result.status).toBe("published");
    expect(result.prUrl).toBe("https://github.com/Magnus-Gille/cassette/pull/28");
    expect(spawnCalls.length).toBeGreaterThan(0);
    // The whole point of durable publication recovery: only git/gh commands
    // ever run. No codex/claude/npx/tsx/sdk process — i.e. no re-invocation
    // of anything that could re-run the paid model work.
    for (const call of spawnCalls) {
      expect(["git", "gh"]).toContain(call.cmd);
    }
  });
});
