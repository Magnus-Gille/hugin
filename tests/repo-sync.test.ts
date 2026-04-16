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
const { checkoutTaskBranch, finalizeTaskBranch } = await import("../src/task-helpers.js");

beforeEach(() => {
  spawnCalls.length = 0;
  spawnBehaviors = [];
  spawnCallIndex = 0;
});

// Sequences for checkoutTaskBranch:
//   1. git rev-parse --git-dir
//   2. git remote get-url origin
//   3. git fetch origin  (+ retries)
//   4. git checkout -b hugin/<taskId> origin/main

describe("checkoutTaskBranch", () => {
  it("skips directories outside /home/magnus/repos/", async () => {
    const result = await checkoutTaskBranch("/home/magnus/workspace", "test-id");
    expect(result.action).toBe("skipped");
    expect(spawnCalls).toHaveLength(0);
  });

  it("skips scratch and other non-repo paths", async () => {
    const result = await checkoutTaskBranch("/home/magnus/scratch", "test-id");
    expect(result.action).toBe("skipped");
    expect(spawnCalls).toHaveLength(0);
  });

  it("skips if not a git repo", async () => {
    spawnBehaviors = [
      { exitCode: 128 }, // git rev-parse --git-dir fails
    ];
    const result = await checkoutTaskBranch("/home/magnus/repos/some-dir", "test-id");
    expect(result.action).toBe("skipped");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain("--git-dir");
  });

  it("skips if no remote origin", async () => {
    spawnBehaviors = [
      { exitCode: 0 },   // git rev-parse --git-dir
      { exitCode: 128 }, // git remote get-url origin fails
    ];
    const result = await checkoutTaskBranch("/home/magnus/repos/no-remote", "test-id");
    expect(result.action).toBe("skipped");
    expect(spawnCalls).toHaveLength(2);
  });

  it("returns created with branch name on success", async () => {
    spawnBehaviors = [
      { exitCode: 0 }, // git rev-parse --git-dir
      { exitCode: 0 }, // git remote get-url origin
      { exitCode: 0 }, // git fetch origin
      { exitCode: 0 }, // git checkout -b hugin/task-123 origin/main
    ];
    const result = await checkoutTaskBranch("/home/magnus/repos/grimnir", "task-123", {
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.action).toBe("created");
    expect(result.branchName).toBe("hugin/task-123");
    expect(spawnCalls).toHaveLength(4);
    const checkoutCall = spawnCalls[3];
    expect(checkoutCall.args).toEqual(["checkout", "-b", "hugin/task-123", "origin/main"]);
  });

  it("retries fetch and bypasses system SSH config on retry", async () => {
    spawnBehaviors = [
      { exitCode: 0 },   // git rev-parse --git-dir
      { exitCode: 0 },   // git remote get-url origin
      { exitCode: 128, stderr: "Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf" }, // fetch #1 fails
      { exitCode: 0 },   // fetch #2 succeeds (with bypass)
      { exitCode: 0 },   // git checkout -b
    ];
    const result = await checkoutTaskBranch("/home/magnus/repos/grimnir", "task-456", {
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.action).toBe("created");
    expect(result.branchName).toBe("hugin/task-456");
    expect(spawnCalls).toHaveLength(5);
    // Attempt #1: no bypass
    const firstFetch = spawnCalls[2];
    expect(firstFetch.args).toEqual(["fetch", "origin"]);
    expect((firstFetch.opts.env as Record<string, string>).GIT_SSH_COMMAND).toBeUndefined();
    // Attempt #2: bypass via explicit -F
    const secondFetch = spawnCalls[3];
    expect((secondFetch.opts.env as Record<string, string>).GIT_SSH_COMMAND).toBe(
      "ssh -F /home/magnus/.ssh/config",
    );
  });

  it("returns fetch-failed after all retries exhausted", async () => {
    spawnBehaviors = [
      { exitCode: 0 },   // git rev-parse --git-dir
      { exitCode: 0 },   // git remote get-url origin
      { exitCode: 128, stderr: "fail 1" },
      { exitCode: 128, stderr: "fail 2" },
      { exitCode: 128, stderr: "fail 3" },
    ];
    const result = await checkoutTaskBranch("/home/magnus/repos/grimnir", "task-789", {
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.action).toBe("fetch-failed");
    expect(result.error).toContain("after 3 attempts");
    expect(spawnCalls).toHaveLength(5); // 2 probes + 3 fetch attempts
  });

  it("returns fetch-failed when checkout fails", async () => {
    spawnBehaviors = [
      { exitCode: 0 },   // git rev-parse --git-dir
      { exitCode: 0 },   // git remote get-url origin
      { exitCode: 0 },   // git fetch origin
      { exitCode: 128, stderr: "branch already exists" }, // git checkout -b fails
    ];
    const result = await checkoutTaskBranch("/home/magnus/repos/grimnir", "task-dup", {
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.action).toBe("fetch-failed");
    expect(result.error).toContain("hugin/task-dup");
  });

  it("uses correct working directory for all spawn calls", async () => {
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
    ];
    const dir = "/home/magnus/repos/my-project";
    await checkoutTaskBranch(dir, "t1", { fetchRetryDelaysMs: [0, 0] });
    for (const call of spawnCalls) {
      expect(call.opts.cwd).toBe(dir);
    }
  });
});

// Sequences for finalizeTaskBranch (happy path — commits exist):
//   1. git status --porcelain  (dirty check)
//   2. git rev-list --count origin/main..HEAD
//   3. git remote get-url --push origin
//   4. git push -u origin <branch>
//   5. gh pr create ...

describe("finalizeTaskBranch", () => {
  const allowedHosts = ["github.com"];

  it("returns no-changes and cleans up when no commits and clean tree", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: "" },  // git status --porcelain: clean
      { exitCode: 0, stdout: "0\n" }, // git rev-list: 0 ahead
      { exitCode: 0 },              // git checkout --detach origin/main
      { exitCode: 0 },              // git branch -d
    ];
    const result = await finalizeTaskBranch(
      "/home/magnus/repos/grimnir",
      "hugin/task-123",
      "pr body",
      allowedHosts,
    );
    expect(result.action).toBe("no-changes");
    expect(spawnCalls[1].args).toContain("origin/main..HEAD");
  });

  it("auto-commits dirty tree and creates PR when commits exist after commit", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: "M README.md\n" }, // git status: dirty
      { exitCode: 0 },                           // git add -A
      { exitCode: 0 },                           // git commit
      { exitCode: 0, stdout: "2\n" },            // git rev-list: 2 ahead
      { exitCode: 0, stdout: "git@github.com:Magnus-Gille/grimnir.git\n" }, // git remote get-url
      { exitCode: 0 },                           // git push -u origin
      { exitCode: 0, stdout: "https://github.com/Magnus-Gille/grimnir/pull/42\n" }, // gh pr create
    ];
    const result = await finalizeTaskBranch(
      "/home/magnus/repos/grimnir",
      "hugin/task-abc",
      "pr body",
      allowedHosts,
    );
    expect(result.action).toBe("pr-created");
    expect(result.prUrl).toBe("https://github.com/Magnus-Gille/grimnir/pull/42");
    expect(result.branchName).toBe("hugin/task-abc");
    // Verify commit was called
    const commitCall = spawnCalls[2];
    expect(commitCall.args).toContain("commit");
    expect(commitCall.args).toContain("-m");
  });

  it("creates PR when commits exist without dirty tree", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: "" },  // git status: clean
      { exitCode: 0, stdout: "1\n" }, // git rev-list: 1 ahead
      { exitCode: 0, stdout: "git@github.com:Magnus-Gille/grimnir.git\n" }, // git remote
      { exitCode: 0 },              // git push
      { exitCode: 0, stdout: "https://github.com/Magnus-Gille/grimnir/pull/7\n" }, // gh pr create
    ];
    const result = await finalizeTaskBranch(
      "/home/magnus/repos/grimnir",
      "hugin/task-xyz",
      "body",
      allowedHosts,
    );
    expect(result.action).toBe("pr-created");
    expect(result.prUrl).toBe("https://github.com/Magnus-Gille/grimnir/pull/7");
    // Verify push used -u flag and correct branch
    const pushCall = spawnCalls.find((c) => c.args.includes("push"));
    expect(pushCall?.args).toContain("-u");
    expect(pushCall?.args).toContain("hugin/task-xyz");
  });

  it("returns push-failed when remote is not in egress allowlist", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: "" },     // git status: clean
      { exitCode: 0, stdout: "1\n" },  // git rev-list: 1 ahead
      { exitCode: 0, stdout: "https://gitlab.com/user/repo.git\n" }, // git remote: blocked
    ];
    const result = await finalizeTaskBranch(
      "/home/magnus/repos/grimnir",
      "hugin/task-blocked",
      "body",
      allowedHosts, // only github.com allowed
    );
    expect(result.action).toBe("push-failed");
    expect(result.error).toContain("egress");
  });

  it("returns push-failed when git push fails", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: "" },   // git status: clean
      { exitCode: 0, stdout: "1\n" }, // git rev-list: 1 ahead
      { exitCode: 0, stdout: "git@github.com:Magnus-Gille/grimnir.git\n" }, // git remote
      { exitCode: 1, stderr: "error: failed to push" }, // git push fails
    ];
    const result = await finalizeTaskBranch(
      "/home/magnus/repos/grimnir",
      "hugin/task-pushfail",
      "body",
      allowedHosts,
    );
    expect(result.action).toBe("push-failed");
    expect(result.error).toContain("push failed");
  });

  it("returns push-failed when gh pr create fails", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: "" },   // git status: clean
      { exitCode: 0, stdout: "1\n" }, // git rev-list: 1 ahead
      { exitCode: 0, stdout: "git@github.com:Magnus-Gille/grimnir.git\n" }, // git remote
      { exitCode: 0 },               // git push: ok
      { exitCode: 1, stderr: "GraphQL error" }, // gh pr create fails
    ];
    const result = await finalizeTaskBranch(
      "/home/magnus/repos/grimnir",
      "hugin/task-prfail",
      "body",
      allowedHosts,
    );
    expect(result.action).toBe("push-failed");
    expect(result.error).toContain("gh pr create");
  });

  it("passes correct title and base to gh pr create", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "1\n" },
      { exitCode: 0, stdout: "git@github.com:Magnus-Gille/grimnir.git\n" },
      { exitCode: 0 },
      { exitCode: 0, stdout: "https://github.com/Magnus-Gille/grimnir/pull/99\n" },
    ];
    await finalizeTaskBranch(
      "/home/magnus/repos/grimnir",
      "hugin/20260416-120000-a1b2",
      "the body",
      allowedHosts,
    );
    const ghCall = spawnCalls.find((c) => c.cmd === "gh");
    expect(ghCall).toBeDefined();
    expect(ghCall?.args).toContain("--base");
    expect(ghCall?.args).toContain("main");
    expect(ghCall?.args).toContain("--title");
    expect(ghCall?.args).toContain("hugin: 20260416-120000-a1b2");
    expect(ghCall?.args).toContain("--body");
    expect(ghCall?.args).toContain("the body");
  });
});
