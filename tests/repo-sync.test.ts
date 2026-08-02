import { describe, it, expect, vi, beforeEach } from "vitest";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";

// Mock child_process.spawn before importing the module
const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
let spawnBehaviors: Array<{
  exitCode: number;
  stdout?: string;
  stderr?: string;
}> = [];
let spawnCallIndex = 0;
let autoResolveMain = true;
let autoResolveShowTopLevel = true;
const realpathResults = new Map<string, { value?: string; error?: Error & { code?: string } }>();

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    const child = new MockChildProcess();
    const autoBehavior = cmd === "git"
      ? autoResolveShowTopLevel && args[0] === "rev-parse" && args[1] === "--show-toplevel"
        ? { exitCode: 0, stdout: `${String(opts.cwd ?? "")}\n` }
        : autoResolveMain && args[0] === "symbolic-ref"
        ? { exitCode: 0, stdout: "origin/main\n" }
        : autoResolveMain && args[0] === "rev-parse" && args.includes("refs/remotes/origin/main^{commit}")
          ? { exitCode: 0, stdout: `${"a".repeat(40)}\n` }
          : null
      : null;
    const behavior = autoBehavior ?? spawnBehaviors[spawnCallIndex] ?? { exitCode: 0 };
    if (!autoBehavior) {
      spawnCalls.push({ cmd, args, opts });
      spawnCallIndex++;
    }

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

vi.mock("node:fs/promises", () => ({
  realpath: async (input: string) => {
    const key = path.resolve(input);
    const entry = realpathResults.get(key);
    if (entry?.error) throw entry.error;
    return entry?.value ?? key;
  },
}));

// Import after mocking
const {
  checkoutTaskBranch,
  deriveRepositoryOutcome,
  finalizeTaskBranch,
  isValidBaseBranchName,
  parseBaseBranchOverride,
  buildPublicationRecoveryRecord,
  recoverPublication,
} = await import("../src/task-helpers.js");
type PublicationRecoveryRecord = Awaited<ReturnType<typeof buildPublicationRecoveryRecord>>;

beforeEach(() => {
  spawnCalls.length = 0;
  spawnBehaviors = [];
  spawnCallIndex = 0;
  autoResolveMain = true;
  autoResolveShowTopLevel = true;
  realpathResults.clear();
});

function setRealpath(
  rawPath: string,
  value: string = rawPath,
  error?: Error & { code?: string },
) {
  realpathResults.set(path.resolve(rawPath), error ? { error } : { value });
}

describe("deriveRepositoryOutcome", () => {
  const managed = {
    action: "created" as const,
    branchName: "hugin/t1",
    baseBranch: "master",
    baseCommit: "a".repeat(40),
  };

  it("distinguishes managed no-op, changes, and publication failure", () => {
    expect(deriveRepositoryOutcome(managed, "no-changes").state).toBe("no-changes");
    expect(deriveRepositoryOutcome(managed, "pr-created").state).toBe("changes-present");
    expect(deriveRepositoryOutcome(managed, "push-failed").state).toBe("publication-failed");
  });

  it("fails closed when a created branch lacks pinned base evidence", () => {
    expect(deriveRepositoryOutcome({ action: "created", branchName: "hugin/t2" }, "no-changes"))
      .toEqual({ state: "not-finalized" });
  });
});

// Sequences for checkoutTaskBranch:
//   1. git rev-parse --git-dir
//   2. git remote get-url origin
//   3. git fetch origin  (+ retries)
//   4+. resolve + verify the base, then git checkout -b hugin/<taskId> origin/<base>

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
    autoResolveShowTopLevel = false;
    spawnBehaviors = [
      { exitCode: 128 }, // git rev-parse --show-toplevel fails
    ];
    const result = await checkoutTaskBranch("/home/magnus/repos/some-dir", "test-id");
    expect(result.action).toBe("skipped");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toEqual(["rev-parse", "--show-toplevel"]);
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

  it("pins origin/main before checkout when repository evidence is requested", async () => {
    const base = "a".repeat(40);
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: `${base}\n` },
      { exitCode: 0 },
    ];
    const result = await checkoutTaskBranch(
      "/home/magnus/repos/grimnir",
      "task-pinned",
      { fetchRetryDelaysMs: [0, 0], captureBaseCommit: true },
    );
    expect(result).toEqual({
      action: "created",
      branchName: "hugin/task-pinned",
      baseBranch: "main",
      baseCommit: base,
    });
    expect(spawnCalls[3].args).toEqual([
      "checkout", "-b", "hugin/task-pinned", "origin/main",
    ]);
  });

  it("honors a configured reposRoot: treats it as managed (#139)", async () => {
    spawnBehaviors = [
      { exitCode: 0 }, // git rev-parse --git-dir
      { exitCode: 0 }, // git remote get-url origin
      { exitCode: 0 }, // git fetch origin
      { exitCode: 0 }, // git checkout -b hugin/task-iso origin/main
    ];
    const result = await checkoutTaskBranch(
      "/home/magnus/hugin-workspace/grimnir",
      "task-iso",
      { fetchRetryDelaysMs: [0, 0], reposRoot: "/home/magnus/hugin-workspace" },
    );
    expect(result.action).toBe("created");
    expect(result.branchName).toBe("hugin/task-iso");
    expect(spawnCalls).toHaveLength(4);
  });

  it("honors a configured reposRoot: skips the old default location (#139)", async () => {
    // With an isolated root configured, a production checkout under the old
    // default is no longer managed — the task can't branch/re-point it.
    const result = await checkoutTaskBranch(
      "/home/magnus/repos/grimnir",
      "task-prod",
      { reposRoot: "/home/magnus/hugin-workspace" },
    );
    expect(result.action).toBe("skipped");
    expect(spawnCalls).toHaveLength(0);
  });

  it("recognizes a canonical checkout reached through a symlinked configured root", async () => {
    setRealpath("/home/magnus/hugin-workspace", "/private/hugin-root");
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
    ];

    const result = await checkoutTaskBranch(
      "/private/hugin-root/grimnir",
      "task-canonical-root",
      { fetchRetryDelaysMs: [0, 0], reposRoot: "/home/magnus/hugin-workspace" },
    );

    expect(result.action).toBe("created");
    expect(result.branchName).toBe("hugin/task-canonical-root");
    expect(spawnCalls).toHaveLength(4);
  });

  it("fails closed before any git mutation when the selected worktree path is not already canonical", async () => {
    setRealpath("/home/magnus/hugin-workspace", "/private/hugin-root");
    setRealpath(
      "/home/magnus/hugin-workspace/link/grimnir",
      "/private/hugin-root/grimnir",
    );

    const result = await checkoutTaskBranch(
      "/home/magnus/hugin-workspace/link/grimnir",
      "task-alias",
      { reposRoot: "/home/magnus/hugin-workspace" },
    );

    expect(result.action).toBe("fetch-failed");
    expect(result.error).toContain("must already be canonical");
    expect(spawnCalls).toHaveLength(0);
  });

  it("fails closed before any git mutation when the selected worktree resolves outside the canonical managed root", async () => {
    setRealpath("/home/magnus/hugin-workspace", "/private/hugin-root");
    setRealpath(
      "/home/magnus/hugin-workspace/linked-prod/grimnir",
      "/home/magnus/repos/grimnir",
    );

    const result = await checkoutTaskBranch(
      "/home/magnus/hugin-workspace/linked-prod/grimnir",
      "task-escape",
      { reposRoot: "/home/magnus/hugin-workspace" },
    );

    expect(result.action).toBe("fetch-failed");
    expect(result.error).toContain("must resolve beneath the configured managed repos root");
    expect(spawnCalls).toHaveLength(0);
  });

  it("fails closed before any git mutation when a ../ path string-matches but escapes the reposRoot (#139)", async () => {
    setRealpath("/home/magnus/hugin-workspace", "/private/hugin-root");
    setRealpath(
      "/home/magnus/hugin-workspace/../repos/grimnir",
      "/home/magnus/repos/grimnir",
    );

    const result = await checkoutTaskBranch(
      "/home/magnus/hugin-workspace/../repos/grimnir",
      "task-dotdot",
      { reposRoot: "/home/magnus/hugin-workspace" },
    );

    expect(result.action).toBe("fetch-failed");
    expect(result.error).toContain("must resolve beneath the configured managed repos root");
    expect(spawnCalls).toHaveLength(0);
  });

  it("fails closed before any git mutation when the selected worktree is only a subdirectory of the repo", async () => {
    autoResolveShowTopLevel = false;
    spawnBehaviors = [{ exitCode: 0, stdout: "/home/magnus/repos/grimnir\n" }];

    const result = await checkoutTaskBranch(
      "/home/magnus/repos/grimnir/src",
      "task-subdir",
      { reposRoot: "/home/magnus/repos" },
    );

    expect(result.action).toBe("fetch-failed");
    expect(result.error).toContain("exact git toplevel selected for this task");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toEqual(["rev-parse", "--show-toplevel"]);
    expect(spawnCalls.some((call) => call.args[0] === "fetch")).toBe(false);
    expect(spawnCalls.some((call) => call.args[0] === "checkout")).toBe(false);
  });

  it("tolerates a trailing slash on the configured reposRoot (#139)", async () => {
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
    ];
    const result = await checkoutTaskBranch(
      "/home/magnus/hugin-workspace/heimdall",
      "task-slash",
      { fetchRetryDelaysMs: [0, 0], reposRoot: "/home/magnus/hugin-workspace/" },
    );
    expect(result.action).toBe("created");
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

  it("resolves origin/HEAD and works when the repository has master but no main", async () => {
    autoResolveMain = false;
    const base = "b".repeat(40);
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "origin/master\n" },
      { exitCode: 0, stdout: `${base}\n` },
      { exitCode: 0 },
    ];

    const result = await checkoutTaskBranch(
      "/home/magnus/repos/cassette-ai",
      "task-master",
      { fetchRetryDelaysMs: [0, 0], captureBaseCommit: true },
    );

    expect(result).toEqual({
      action: "created",
      branchName: "hugin/task-master",
      baseBranch: "master",
      baseCommit: base,
    });
    expect(spawnCalls[3].args).toEqual([
      "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD",
    ]);
    expect(spawnCalls[4].args).toEqual([
      "rev-parse", "--verify", "refs/remotes/origin/master^{commit}",
    ]);
    expect(spawnCalls[5].args).toEqual([
      "checkout", "-b", "hugin/task-master", "origin/master",
    ]);
    expect(spawnCalls.flatMap((call) => call.args)).not.toContain("origin/main");
  });

  it("falls back to the remote HEAD symref when origin/HEAD is stale", async () => {
    autoResolveMain = false;
    const base = "c".repeat(40);
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "origin/main\n" },
      { exitCode: 128, stderr: "unknown revision" },
      { exitCode: 0, stdout: "ref: refs/heads/master\tHEAD\n" },
      { exitCode: 0, stdout: `${base}\n` },
      { exitCode: 0 },
    ];

    const result = await checkoutTaskBranch(
      "/home/magnus/repos/cassette-ai",
      "task-remote-head",
      { fetchRetryDelaysMs: [0, 0], captureBaseCommit: true },
    );

    expect(result.baseBranch).toBe("master");
    expect(result.baseCommit).toBe(base);
    expect(spawnCalls[5].args).toEqual([
      "ls-remote", "--symref", "origin", "HEAD",
    ]);
    expect(spawnCalls[7].args.at(-1)).toBe("origin/master");
  });

  it("uses a validated override with an existing ref when fetch is unavailable", async () => {
    autoResolveMain = false;
    const base = "d".repeat(40);
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 128, stderr: "offline" },
      { exitCode: 128, stderr: "offline" },
      { exitCode: 128, stderr: "offline" },
      { exitCode: 0, stdout: `${base}\n` },
      { exitCode: 0 },
    ];

    const result = await checkoutTaskBranch(
      "/home/magnus/repos/cassette-ai",
      "task-explicit",
      {
        fetchRetryDelaysMs: [0, 0],
        captureBaseCommit: true,
        baseBranchOverride: "release/stable",
      },
    );

    expect(result).toMatchObject({
      action: "created",
      baseBranch: "release/stable",
      baseCommit: base,
    });
    expect(spawnCalls[5].args).toEqual([
      "rev-parse", "--verify", "refs/remotes/origin/release/stable^{commit}",
    ]);
    expect(spawnCalls[6].args.at(-1)).toBe("origin/release/stable");
  });

  it("validates Base branch task overrides before Git execution", async () => {
    expect(parseBaseBranchOverride("- **Base branch:** release/stable")).toEqual({
      baseBranch: "release/stable",
    });
    expect(parseBaseBranchOverride("- **Base branch:** origin/main").error).toContain(
      "invalid Base branch",
    );
    expect(parseBaseBranchOverride(`## Task\n### Prompt\nDiscuss **Base branch:** evil`)).toEqual({});
    expect(isValidBaseBranchName("main; touch owned")).toBe(false);

    const result = await checkoutTaskBranch(
      "/home/magnus/repos/demo",
      "task-invalid",
      { baseBranchOverride: "../main" },
    );
    expect(result.action).toBe("fetch-failed");
    expect(spawnCalls).toHaveLength(0);
  });
});

// Sequences for finalizeTaskBranch (happy path — commits exist):
//   1. git status --porcelain  (dirty check)
//   2. git rev-list --count <pinned-base>..HEAD
//   3. git remote get-url --push origin
//   4. git push -u origin <branch>
//   5. gh pr create ...

describe("finalizeTaskBranch", () => {
  const allowedHosts = ["github.com"];

  it("returns no-changes and cleans up when no commits and clean tree", async () => {
    const base = "e".repeat(40);
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
      { baseBranch: "master", baseCommit: base },
    );
    expect(result.action).toBe("no-changes");
    expect(spawnCalls[1].args).toContain(`${base}..HEAD`);
    expect(spawnCalls[2].args).toEqual(["checkout", "--detach", base]);
  });

  it("preserves the task branch when comparison with the pinned base fails", async () => {
    const base = "f".repeat(40);
    spawnBehaviors = [
      { exitCode: 0, stdout: "" },
      { exitCode: 128, stderr: "bad revision" },
    ];

    const result = await finalizeTaskBranch(
      "/home/magnus/repos/grimnir",
      "hugin/task-compare-failed",
      "body",
      allowedHosts,
      { baseBranch: "master", baseCommit: base },
    );

    expect(result.action).toBe("push-failed");
    expect(result.error).toContain("pinned base");
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls.some((call) => call.args.includes("branch"))).toBe(false);
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
    expect(commitCall.args).toEqual([
      "commit",
      "-m",
      "hugin: auto-commit task output",
    ]);
    expect(commitCall.args.join(" ")).not.toContain("skip ci");
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

  it("captures exact content-blind repository evidence when requested", async () => {
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    spawnBehaviors = [
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "1\n" },
      { exitCode: 0, stdout: `${head}\n` },
      { exitCode: 0, stdout: "src/parser.ts\0tests/parser.test.ts\0" },
      { exitCode: 0, stdout: "diff --git a/src/parser.ts b/src/parser.ts\n" },
      { exitCode: 0, stdout: "git@github.com:Magnus-Gille/grimnir.git\n" },
      { exitCode: 0 },
      { exitCode: 0, stdout: "https://github.com/Magnus-Gille/grimnir/pull/8\n" },
    ];
    const result = await finalizeTaskBranch(
      "/home/magnus/repos/grimnir",
      "hugin/task-evidence",
      "body",
      allowedHosts,
      { captureRepositoryChange: true, baseBranch: "master", baseCommit: base },
    );
    expect(result.action).toBe("pr-created");
    expect(result.repositoryChange).toEqual(expect.objectContaining({
      baseBranch: "master",
      baseCommit: base,
      headCommit: head,
      changedFiles: ["src/parser.ts", "tests/parser.test.ts"],
      diffSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(spawnCalls[3].args).toEqual([
      "diff", "--name-only", "-z", "--no-ext-diff", `${base}..${head}`,
    ]);
    expect(spawnCalls[4].args).toEqual([
      "diff", "--binary", "--no-ext-diff", "--no-textconv", `${base}..${head}`,
    ]);
    expect(spawnCalls[1].args).toContain(`${base}..HEAD`);
    const ghCall = spawnCalls.find((call) => call.cmd === "gh");
    expect(ghCall?.args).toEqual(expect.arrayContaining(["--base", "master"]));
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

describe("buildPublicationRecoveryRecord", () => {
  it("captures a durable, resumable snapshot at the moment publication fails", () => {
    const now = new Date("2026-07-15T09:38:50.000Z");
    const record = buildPublicationRecoveryRecord({
      taskId: "t-1",
      taskNamespace: "tasks/t-1",
      workingDir: "/home/magnus/repos/cassette",
      branchName: "hugin/t-1",
      baseBranch: "master",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      prBody: "pr body",
      allowedEgressHosts: ["github.com"],
      failureReason: "git push failed",
      now,
    });
    expect(record).toEqual({
      schemaVersion: 1,
      taskId: "t-1",
      taskNamespace: "tasks/t-1",
      workingDir: "/home/magnus/repos/cassette",
      branchName: "hugin/t-1",
      baseBranch: "master",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      prBody: "pr body",
      allowedEgressHosts: ["github.com"],
      failureReason: "git push failed",
      attempts: 0,
      firstFailedAt: now.toISOString(),
      lastAttemptAt: now.toISOString(),
    });
  });
});

describe("recoverPublication", () => {
  const allowedHosts = ["github.com"];
  const head = "b".repeat(40);
  const base = "a".repeat(40);

  function record(overrides: Partial<PublicationRecoveryRecord> = {}): PublicationRecoveryRecord {
    return {
      schemaVersion: 1,
      taskId: "t-1",
      taskNamespace: "tasks/t-1",
      workingDir: "/home/magnus/repos/cassette",
      branchName: "hugin/t-1",
      baseBranch: "master",
      baseCommit: base,
      headCommit: head,
      prBody: "pr body",
      allowedEgressHosts: allowedHosts,
      failureReason: "git push failed",
      attempts: 0,
      firstFailedAt: "2026-07-15T09:38:50.000Z",
      lastAttemptAt: "2026-07-15T09:38:50.000Z",
      ...overrides,
    };
  }

  it("abandons without touching git when the base branch is invalid", async () => {
    const result = await recoverPublication(record({ baseBranch: "origin/master" }));
    expect(result.outcome).toBe("abandoned");
    expect(spawnCalls).toHaveLength(0);
  });

  it("abandons without touching git when no head commit was ever captured", async () => {
    const result = await recoverPublication(record({ headCommit: undefined }));
    expect(result.outcome).toBe("abandoned");
    expect(result.reason).toContain("no repository-change evidence");
    expect(spawnCalls).toHaveLength(0);
  });

  it("abandons when the local task branch no longer exists", async () => {
    spawnBehaviors = [
      { exitCode: 128, stderr: "unknown revision" }, // rev-parse --verify
    ];
    const result = await recoverPublication(record());
    expect(result.outcome).toBe("abandoned");
    expect(result.reason).toContain("no longer exists");
    expect(spawnCalls).toHaveLength(1);
  });

  it("abandons when the checkout was reused and no longer points at the recorded head", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: `${"c".repeat(40)}\n` }, // rev-parse --verify: different commit
    ];
    const result = await recoverPublication(record());
    expect(result.outcome).toBe("abandoned");
    expect(result.reason).toContain("checkout was reused");
    expect(spawnCalls).toHaveLength(1);
  });

  it("reconciles instead of duplicating when a PR already exists (partial success)", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: `${head}\n` }, // rev-parse --verify: matches
      { exitCode: 0, stdout: `[{"url":"https://github.com/Magnus-Gille/cassette/pull/28"}]\n` }, // gh pr list
    ];
    const result = await recoverPublication(record());
    expect(result.outcome).toBe("reconciled");
    expect(result.prUrl).toBe("https://github.com/Magnus-Gille/cassette/pull/28");
    expect(result.headCommit).toBe(head);
    // Must not push or attempt to create a second PR.
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls.some((c) => c.args.includes("push"))).toBe(false);
    expect(spawnCalls.some((c) => c.args.includes("create"))).toBe(false);
  });

  it("publishes fresh (push + PR) when nothing was published yet", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: `${head}\n` },       // rev-parse --verify
      { exitCode: 0, stdout: "[]\n" },              // gh pr list: none
      { exitCode: 0, stdout: "git@github.com:Magnus-Gille/cassette.git\n" }, // remote get-url
      { exitCode: 0, stdout: "\n" },                // ls-remote: branch not on remote yet
      { exitCode: 0 },                              // git push
      { exitCode: 0, stdout: "https://github.com/Magnus-Gille/cassette/pull/29\n" }, // gh pr create
    ];
    const result = await recoverPublication(record());
    expect(result.outcome).toBe("published");
    expect(result.prUrl).toBe("https://github.com/Magnus-Gille/cassette/pull/29");
    const pushCall = spawnCalls.find((c) => c.args.includes("push"));
    expect(pushCall).toBeDefined();
    expect(pushCall?.args).toContain("hugin/t-1");
  });

  it("skips the redundant push when the remote already has the exact recorded commit", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: `${head}\n` },
      { exitCode: 0, stdout: "[]\n" },
      { exitCode: 0, stdout: "git@github.com:Magnus-Gille/cassette.git\n" },
      { exitCode: 0, stdout: `${head}\trefs/heads/hugin/t-1\n` }, // ls-remote: already has exact head
      { exitCode: 0, stdout: "https://github.com/Magnus-Gille/cassette/pull/30\n" }, // gh pr create
    ];
    const result = await recoverPublication(record());
    expect(result.outcome).toBe("published");
    expect(spawnCalls.some((c) => c.args.includes("push"))).toBe(false);
  });

  it("returns a retryable failure when the remote is not in the egress allowlist", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: `${head}\n` },
      { exitCode: 0, stdout: "[]\n" },
      { exitCode: 0, stdout: "https://gitlab.com/user/repo.git\n" },
    ];
    const result = await recoverPublication(record());
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("egress");
  });

  it("returns a retryable failure when git push fails again", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: `${head}\n` },
      { exitCode: 0, stdout: "[]\n" },
      { exitCode: 0, stdout: "git@github.com:Magnus-Gille/cassette.git\n" },
      { exitCode: 0, stdout: "\n" },
      { exitCode: 1, stderr: "permission denied" },
    ];
    const result = await recoverPublication(record());
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("push failed");
  });

  it("returns a retryable failure when gh pr create fails again", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: `${head}\n` },
      { exitCode: 0, stdout: "[]\n" },
      { exitCode: 0, stdout: "git@github.com:Magnus-Gille/cassette.git\n" },
      { exitCode: 0, stdout: "\n" },
      { exitCode: 0 },
      { exitCode: 1, stderr: "GraphQL error" },
    ];
    const result = await recoverPublication(record());
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("gh pr create");
  });
});
