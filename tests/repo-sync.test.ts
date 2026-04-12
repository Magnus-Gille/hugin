import { describe, it, expect, vi, beforeEach } from "vitest";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

// Mock child_process.spawn before importing the module
const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
let spawnBehaviors: Array<{
  exitCode: number;
  stdout?: string;
  stderr?: string;
}> = [];
let spawnCallIndex = 0;

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ cmd, args, opts });
    const child = new MockChildProcess();
    const behavior = spawnBehaviors[spawnCallIndex] ?? { exitCode: 0 };
    spawnCallIndex++;

    // Emit stdout/stderr and close asynchronously
    setImmediate(() => {
      if (behavior.stdout) {
        child.stdout.emit("data", Buffer.from(behavior.stdout));
      }
      if (behavior.stderr) {
        child.stderr.emit("data", Buffer.from(behavior.stderr));
      }
      child.emit("close", behavior.exitCode);
    });

    return child;
  },
}));

// Import after mocking
const { syncRepoBeforeTask } = await import("../src/task-helpers.js");

beforeEach(() => {
  spawnCalls.length = 0;
  spawnBehaviors = [];
  spawnCallIndex = 0;
});

describe("syncRepoBeforeTask", () => {
  it("skips directories outside /home/magnus/repos/", async () => {
    const result = await syncRepoBeforeTask("/home/magnus/workspace");
    expect(result.action).toBe("skipped");
    expect(spawnCalls).toHaveLength(0);
  });

  it("skips directories like /home/magnus/scratch", async () => {
    const result = await syncRepoBeforeTask("/home/magnus/scratch");
    expect(result.action).toBe("skipped");
    expect(spawnCalls).toHaveLength(0);
  });

  it("skips if not a git repo", async () => {
    spawnBehaviors = [
      { exitCode: 128 }, // git rev-parse --git-dir fails
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/some-dir");
    expect(result.action).toBe("skipped");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain("--git-dir");
  });

  it("skips if no remote origin", async () => {
    spawnBehaviors = [
      { exitCode: 0 },   // git rev-parse --git-dir succeeds
      { exitCode: 128 },  // git remote get-url origin fails
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/no-remote");
    expect(result.action).toBe("skipped");
    expect(spawnCalls).toHaveLength(2);
  });

  it("returns up-to-date when 0 commits behind", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                 // git rev-parse --git-dir
      { exitCode: 0 },                 // git remote get-url origin
      { exitCode: 0 },                 // git fetch origin
      { exitCode: 0, stdout: "0\n" },  // git rev-list --count HEAD..origin/main
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin", {
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.action).toBe("up-to-date");
    expect(result.commitsBehind).toBe(0);
    expect(spawnCalls).toHaveLength(4);
    // First fetch attempt should NOT set GIT_SSH_COMMAND
    const fetchCall = spawnCalls[2];
    expect((fetchCall.opts.env as Record<string, string>).GIT_SSH_COMMAND).toBeUndefined();
  });

  it("retries fetch and bypasses system SSH config on retry", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                 // git rev-parse --git-dir
      { exitCode: 0 },                 // git remote get-url origin
      { exitCode: 128, stderr: "Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf" }, // fetch #1 fails
      { exitCode: 0 },                 // fetch #2 succeeds (with bypass)
      { exitCode: 0, stdout: "0\n" },  // git rev-list --count
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin", {
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.action).toBe("up-to-date");
    expect(spawnCalls).toHaveLength(5);

    // Attempt #1: no bypass
    const firstFetch = spawnCalls[2];
    expect(firstFetch.args).toEqual(["fetch", "origin"]);
    expect((firstFetch.opts.env as Record<string, string>).GIT_SSH_COMMAND).toBeUndefined();

    // Attempt #2: bypass system SSH config via -F ~/.ssh/config
    const secondFetch = spawnCalls[3];
    expect(secondFetch.args).toEqual(["fetch", "origin"]);
    expect((secondFetch.opts.env as Record<string, string>).GIT_SSH_COMMAND).toBe(
      "ssh -F /home/magnus/.ssh/config",
    );
  });

  it("fetch-failed only after all retries are exhausted", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                 // git rev-parse --git-dir
      { exitCode: 0 },                 // git remote get-url origin
      { exitCode: 128, stderr: "fail 1" }, // fetch #1
      { exitCode: 128, stderr: "fail 2" }, // fetch #2 (retry, bypass)
      { exitCode: 128, stderr: "fail 3" }, // fetch #3 (retry, bypass)
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin", {
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.action).toBe("fetch-failed");
    expect(result.error).toContain("after 3 attempts");
    // 2 probes + 3 fetch attempts
    expect(spawnCalls).toHaveLength(5);
  });

  it("syncs when behind and fast-forward succeeds", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                 // git rev-parse --git-dir
      { exitCode: 0 },                 // git remote get-url origin
      { exitCode: 0 },                 // git fetch origin
      { exitCode: 0, stdout: "3\n" },  // git rev-list --count: 3 behind
      { exitCode: 0 },                 // git pull --ff-only
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin", {
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.action).toBe("synced");
    expect(result.commitsBehind).toBe(3);
    expect(spawnCalls).toHaveLength(5);
    // Verify the pull used --ff-only
    expect(spawnCalls[4].args).toContain("--ff-only");
  });

  it("fails when ff-pull fails and worktree is clean (real divergence)", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                 // git rev-parse --git-dir
      { exitCode: 0 },                 // git remote get-url origin
      { exitCode: 0 },                 // git fetch origin
      { exitCode: 0, stdout: "5\n" },  // git rev-list --count: 5 behind
      { exitCode: 1, stderr: "fatal: Not possible to fast-forward" }, // git pull --ff-only fails
      { exitCode: 0, stdout: "" },     // git status --porcelain: clean
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin", {
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.action).toBe("failed");
    expect(result.commitsBehind).toBe(5);
    expect(result.error).toContain("5 commits behind origin/main");
    expect(result.error).toContain("cannot fast-forward");
    expect(result.error).toContain("worktree clean");
    expect(result.error).toContain("Manual intervention required");
    expect(result.autoStashed).toBeUndefined();
    // Should NOT have attempted a stash (worktree was clean)
    const stashCalls = spawnCalls.filter((c) => c.args[0] === "stash");
    expect(stashCalls).toHaveLength(0);
  });

  it("auto-stashes dirty worktree and retries fast-forward (#45)", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                          // git rev-parse --git-dir
      { exitCode: 0 },                          // git remote get-url origin
      { exitCode: 0 },                          // git fetch origin
      { exitCode: 0, stdout: "6\n" },           // rev-list --count: 6 behind
      { exitCode: 1, stderr: "error: Your local changes would be overwritten" }, // first pull fails
      { exitCode: 0, stdout: " M STATUS.md\n?? .claude/\n" },                    // porcelain: dirty
      { exitCode: 0, stdout: "Saved working directory\n" },                       // stash push
      { exitCode: 0 },                                                           // second pull succeeds
    ];

    const fixedNow = new Date("2026-04-12T22:30:00.000Z");
    const result = await syncRepoBeforeTask("/home/magnus/repos/heimdall", {
      fetchRetryDelaysMs: [0, 0],
      taskId: "20260412-223000-abcd",
      now: () => fixedNow,
    });

    expect(result.action).toBe("synced");
    expect(result.commitsBehind).toBe(6);
    expect(result.autoStashed).toBe(true);

    // Validate stash invocation
    const stashCall = spawnCalls.find((c) => c.args[0] === "stash");
    expect(stashCall).toBeDefined();
    expect(stashCall!.args).toEqual([
      "stash",
      "push",
      "-u",
      "-m",
      "hugin-autosave 2026-04-12T22:30:00Z task=20260412-223000-abcd",
    ]);

    // Two ff-only pulls attempted
    const pullCalls = spawnCalls.filter((c) => c.args[0] === "pull");
    expect(pullCalls).toHaveLength(2);
    expect(pullCalls[0].args).toContain("--ff-only");
    expect(pullCalls[1].args).toContain("--ff-only");
  });

  it("fails when dirty worktree + stash succeeds but second pull still fails", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                          // rev-parse
      { exitCode: 0 },                          // remote get-url
      { exitCode: 0 },                          // fetch
      { exitCode: 0, stdout: "2\n" },           // rev-list
      { exitCode: 1, stderr: "ff fail" },       // first pull
      { exitCode: 0, stdout: "?? untracked\n" }, // porcelain: dirty
      { exitCode: 0 },                          // stash push ok
      { exitCode: 1, stderr: "still fails" },   // second pull fails (real divergence + debris)
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin", {
      fetchRetryDelaysMs: [0, 0],
      taskId: "t1",
      now: () => new Date("2026-04-12T22:30:00.000Z"),
    });

    expect(result.action).toBe("failed");
    expect(result.autoStashed).toBe(true);
    expect(result.error).toContain("even after auto-stashing");
    expect(result.error).toContain("hugin-autosave 2026-04-12T22:30:00Z task=t1");
  });

  it("fails when dirty worktree but stash itself fails", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                          // rev-parse
      { exitCode: 0 },                          // remote get-url
      { exitCode: 0 },                          // fetch
      { exitCode: 0, stdout: "1\n" },           // rev-list
      { exitCode: 1, stderr: "ff fail" },       // first pull
      { exitCode: 0, stdout: " M foo\n" },       // porcelain: dirty
      { exitCode: 1, stderr: "stash failed" },  // stash push fails
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin", {
      fetchRetryDelaysMs: [0, 0],
    });

    expect(result.action).toBe("failed");
    expect(result.autoStashed).toBeUndefined();
    expect(result.error).toContain("dirty worktree detected but auto-stash failed");
    // Only one pull attempt (no retry after stash failure)
    const pullCalls = spawnCalls.filter((c) => c.args[0] === "pull");
    expect(pullCalls).toHaveLength(1);
  });

  it("uses correct working directory for all spawn calls", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                 // git rev-parse --git-dir
      { exitCode: 0 },                 // git remote get-url origin
      { exitCode: 0 },                 // git fetch origin
      { exitCode: 0, stdout: "0\n" },  // git rev-list --count
    ];

    const dir = "/home/magnus/repos/my-project";
    await syncRepoBeforeTask(dir, { fetchRetryDelaysMs: [0, 0] });

    for (const call of spawnCalls) {
      expect(call.opts.cwd).toBe(dir);
    }
  });
});
