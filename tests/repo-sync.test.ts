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

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin");
    expect(result.action).toBe("up-to-date");
    expect(result.commitsBehind).toBe(0);
    expect(spawnCalls).toHaveLength(4);
  });

  it("syncs when behind and fast-forward succeeds", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                 // git rev-parse --git-dir
      { exitCode: 0 },                 // git remote get-url origin
      { exitCode: 0 },                 // git fetch origin
      { exitCode: 0, stdout: "3\n" },  // git rev-list --count: 3 behind
      { exitCode: 0 },                 // git pull --ff-only
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin");
    expect(result.action).toBe("synced");
    expect(result.commitsBehind).toBe(3);
    expect(spawnCalls).toHaveLength(5);
    // Verify the pull used --ff-only
    expect(spawnCalls[4].args).toContain("--ff-only");
  });

  it("fails when behind and fast-forward fails (conflicts/dirty worktree)", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                 // git rev-parse --git-dir
      { exitCode: 0 },                 // git remote get-url origin
      { exitCode: 0 },                 // git fetch origin
      { exitCode: 0, stdout: "5\n" },  // git rev-list --count: 5 behind
      { exitCode: 1, stderr: "fatal: Not possible to fast-forward" }, // git pull --ff-only fails
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin");
    expect(result.action).toBe("failed");
    expect(result.commitsBehind).toBe(5);
    expect(result.error).toContain("5 commits behind origin/main");
    expect(result.error).toContain("cannot fast-forward");
    expect(result.error).toContain("Manual intervention required");
  });

  it("fails when git fetch fails", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                 // git rev-parse --git-dir
      { exitCode: 0 },                 // git remote get-url origin
      { exitCode: 128, stderr: "fatal: Could not read from remote repository" }, // git fetch fails
    ];

    const result = await syncRepoBeforeTask("/home/magnus/repos/hugin");
    expect(result.action).toBe("failed");
    expect(result.error).toContain("git fetch origin failed");
  });

  it("uses correct working directory for all spawn calls", async () => {
    spawnBehaviors = [
      { exitCode: 0 },                 // git rev-parse --git-dir
      { exitCode: 0 },                 // git remote get-url origin
      { exitCode: 0 },                 // git fetch origin
      { exitCode: 0, stdout: "0\n" },  // git rev-list --count
    ];

    const dir = "/home/magnus/repos/my-project";
    await syncRepoBeforeTask(dir);

    for (const call of spawnCalls) {
      expect(call.opts.cwd).toBe(dir);
    }
  });
});
