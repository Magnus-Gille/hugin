import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock child_process.spawn before importing the module — same style as
// repo-sync.test.ts (#217/#225), but with NO auto-resolution shortcuts: every
// git call in a scenario is scripted explicitly so the exact sequence issued
// by the #236 pre-execution gate is visible and asserted.
const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
let spawnBehaviors: Array<{ exitCode: number; stdout?: string; stderr?: string }> = [];
let spawnCallIndex = 0;

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    const child = new MockChildProcess();
    spawnCalls.push({ cmd, args, opts });
    const behavior = spawnBehaviors[spawnCallIndex] ?? { exitCode: 0 };
    spawnCallIndex++;
    setImmediate(() => {
      if (behavior.stdout) child.stdout.emit("data", Buffer.from(behavior.stdout));
      if (behavior.stderr) child.stderr.emit("data", Buffer.from(behavior.stderr));
      child.emit("close", behavior.exitCode);
    });
    return child;
  },
}));

const {
  markCheckoutContaminated,
  readCheckoutContamination,
  clearCheckoutContamination,
  verifyCleanCheckout,
  recoverCleanCheckout,
  prepareManagedCheckout,
} = await import("../src/task-helpers.js");

beforeEach(() => {
  spawnCalls.length = 0;
  spawnBehaviors = [];
  spawnCallIndex = 0;
});

const WORKDIR = "/home/magnus/repos/demo";

describe("checkout contamination marker (durable, git-native)", () => {
  it("marks contamination via `git config --local` scoped to exactly this working directory", async () => {
    spawnBehaviors = [{ exitCode: 0 }];
    const ok = await markCheckoutContaminated(WORKDIR, "task-1", "checkout is dirty");
    expect(ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe("git");
    expect(spawnCalls[0].args[0]).toBe("config");
    expect(spawnCalls[0].args).toContain("--local");
    expect(spawnCalls[0].args).toContain("hugin.checkout-contaminated");
    expect(spawnCalls[0].opts.cwd).toBe(WORKDIR);
  });

  it("round-trips the record through an independent later read (durability)", async () => {
    spawnBehaviors = [{ exitCode: 0 }];
    await markCheckoutContaminated(WORKDIR, "task-1", "checkout is dirty");
    const storedValue = spawnCalls[0].args[3];

    spawnCalls.length = 0;
    spawnCallIndex = 0;
    spawnBehaviors = [{ exitCode: 0, stdout: `${storedValue}\n` }];
    const record = await readCheckoutContamination(WORKDIR);
    expect(record).toMatchObject({ taskId: "task-1", reason: "checkout is dirty" });
    expect(record?.contaminatedAt).toEqual(expect.any(String));
  });

  it("reads no contamination when the git config key was never set", async () => {
    spawnBehaviors = [{ exitCode: 1 }]; // `git config --get`: key not found
    const record = await readCheckoutContamination(WORKDIR);
    expect(record).toBeNull();
  });

  it("sanitizes newlines/pipes in the reason so the encoded record cannot be corrupted", async () => {
    spawnBehaviors = [{ exitCode: 0 }];
    await markCheckoutContaminated(WORKDIR, "task-2", "line one\nline two|with a pipe");
    const storedValue = spawnCalls[0].args[3];
    expect(storedValue).not.toContain("\n");

    spawnCalls.length = 0;
    spawnCallIndex = 0;
    spawnBehaviors = [{ exitCode: 0, stdout: `${storedValue}\n` }];
    const record = await readCheckoutContamination(WORKDIR);
    expect(record?.taskId).toBe("task-2");
    expect(record?.reason).not.toContain("\n");
  });

  it("clears the marker via --unset-all (idempotent: safe even when nothing was set)", async () => {
    spawnBehaviors = [{ exitCode: 5 }]; // --unset-all: key not found — still a success postcondition
    await expect(clearCheckoutContamination(WORKDIR)).resolves.toBeUndefined();
    expect(spawnCalls[0].args).toContain("--unset-all");
    expect(spawnCalls[0].args).toContain("hugin.checkout-contaminated");
  });
});

describe("verifyCleanCheckout", () => {
  const commit = "a".repeat(40);

  it("fails closed on an invalid expected commit without touching git", async () => {
    const result = await verifyCleanCheckout(WORKDIR, "not-a-commit");
    expect(result.clean).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  it("passes only when the tree is clean AND HEAD matches the expected commit", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: "" }, // status --porcelain
      { exitCode: 0, stdout: `${commit}\n` }, // rev-parse HEAD
    ];
    const result = await verifyCleanCheckout(WORKDIR, commit);
    expect(result).toEqual({ clean: true, headCommit: commit });
  });

  it("fails when the working tree has uncommitted or untracked changes", async () => {
    spawnBehaviors = [{ exitCode: 0, stdout: "M leftover.txt\n" }];
    const result = await verifyCleanCheckout(WORKDIR, commit);
    expect(result.clean).toBe(false);
    expect(result.reason).toContain("tracked or untracked leftover state");
    // Never bothers checking HEAD once dirtiness is already proven.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toEqual(["status", "--porcelain", "--ignored=matching"]);
  });

  it("fails when the working tree only differs by ignored leftovers", async () => {
    spawnBehaviors = [{ exitCode: 0, stdout: "!! node_modules/\n" }];
    const result = await verifyCleanCheckout(WORKDIR, commit);
    expect(result.clean).toBe(false);
    expect(result.reason).toContain("ignored leftover state");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toEqual(["status", "--porcelain", "--ignored=matching"]);
  });

  it("reports mixed tracked and ignored leftovers without collapsing them into the wrong category", async () => {
    spawnBehaviors = [{ exitCode: 0, stdout: "M src/index.ts\n!! node_modules/\n" }];
    const result = await verifyCleanCheckout(WORKDIR, commit);
    expect(result.clean).toBe(false);
    expect(result.reason).toContain("tracked/untracked and ignored leftover state");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toEqual(["status", "--porcelain", "--ignored=matching"]);
  });

  it("fails when HEAD does not match the expected commit even though the tree is clean", async () => {
    const other = "b".repeat(40);
    spawnBehaviors = [
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: `${other}\n` },
    ];
    const result = await verifyCleanCheckout(WORKDIR, commit);
    expect(result.clean).toBe(false);
    expect(result.reason).toContain(other);
    expect(result.reason).toContain(commit);
  });

  it("fails closed when `git status` itself errors", async () => {
    spawnBehaviors = [{ exitCode: 128, stderr: "fatal: not a git repository" }];
    const result = await verifyCleanCheckout(WORKDIR, commit);
    expect(result.clean).toBe(false);
    expect(result.reason).toContain("git status failed");
  });

  it("is idempotent: calling it repeatedly on an already-clean tree keeps returning clean", async () => {
    spawnBehaviors = [
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: `${commit}\n` },
    ];
    const first = await verifyCleanCheckout(WORKDIR, commit);
    spawnCallIndex = 0;
    const second = await verifyCleanCheckout(WORKDIR, commit);
    expect(first).toEqual(second);
    expect(second.clean).toBe(true);
  });
});

describe("recoverCleanCheckout", () => {
  const commit = "a".repeat(40);

  it("rejects an invalid recovery target before touching git", async () => {
    const result = await recoverCleanCheckout(WORKDIR, "not-a-commit");
    expect(result.ok).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  it("resets and cleans the tree on success", async () => {
    spawnBehaviors = [
      { exitCode: 0 }, // reset --hard
      { exitCode: 0 }, // clean -fdx
    ];
    const result = await recoverCleanCheckout(WORKDIR, commit);
    expect(result.ok).toBe(true);
    expect(spawnCalls[0].args).toEqual(["reset", "--hard", commit]);
    expect(spawnCalls[1].args).toEqual(["clean", "-fdx"]);
  });

  it("stops before attempting clean when `git reset --hard` fails", async () => {
    spawnBehaviors = [{ exitCode: 128, stderr: "fatal: ambiguous argument" }];
    const result = await recoverCleanCheckout(WORKDIR, commit);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("reset --hard");
    expect(spawnCalls).toHaveLength(1);
  });

  it("fails when `git clean -fdx` fails after a successful reset", async () => {
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 1, stderr: "permission denied" },
    ];
    const result = await recoverCleanCheckout(WORKDIR, commit);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("clean -fdx");
  });
});

// Sequence for prepareManagedCheckout's happy-path checkoutTaskBranch leg
// (baseBranchOverride is always used here to keep the resolution to a single
// `rev-parse --verify` call instead of the full origin/HEAD probing chain —
// that chain is already covered by repo-sync.test.ts):
//   1. git rev-parse --git-dir
//   2. git remote get-url origin
//   3. git fetch origin
//   4. git rev-parse --verify refs/remotes/origin/<override>^{commit}
//   5. git checkout -b hugin/<taskId> origin/<override>
//   6. git config --local --get hugin.checkout-contaminated  (readCheckoutContamination)
describe("prepareManagedCheckout — the #236 pre-execution isolation/verification gate", () => {
  it("passes through unchanged when the directory is not managed (skipped)", async () => {
    const result = await prepareManagedCheckout("/home/magnus/workspace", "task-skip", {
      mutationCapable: true,
    });
    expect(result.branch.action).toBe("skipped");
    expect(result.refusalReason).toBeUndefined();
    expect(result.degraded).toBeUndefined();
    expect(spawnCalls).toHaveLength(0);
  });

  it("marks the directory contaminated durably and refuses a mutation-capable task when the managed checkout itself fails", async () => {
    spawnBehaviors = [
      { exitCode: 0 }, // rev-parse --git-dir
      { exitCode: 0 }, // remote get-url origin
      { exitCode: 128, stderr: "network unreachable" }, // fetch attempt 1
      { exitCode: 128, stderr: "network unreachable" }, // fetch attempt 2
      { exitCode: 128, stderr: "network unreachable" }, // fetch attempt 3
      { exitCode: 1 }, // readCheckoutContamination: not previously set
      { exitCode: 0 }, // markCheckoutContaminated
    ];
    const result = await prepareManagedCheckout(WORKDIR, "task-fetchfail", {
      mutationCapable: true,
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.branch.action).toBe("fetch-failed");
    expect(result.refusalReason).toContain("cannot be trusted");
    expect(result.degraded).toBeUndefined();

    const markCall = spawnCalls[6];
    expect(markCall.args[0]).toBe("config");
    expect(markCall.args).toContain("hugin.checkout-contaminated");
    expect(markCall.args).not.toContain("--get");

    // Durable: an independent later read call proves the marker persists
    // (a spy proving "the next task can see this" without re-running the gate).
    spawnCalls.length = 0;
    spawnCallIndex = 0;
    spawnBehaviors = [{ exitCode: 0, stdout: `${markCall.args[3]}\n` }];
    const marker = await readCheckoutContamination(WORKDIR);
    expect(marker?.taskId).toBe("task-fetchfail");
  });

  it("still marks contamination for a read-only task when the checkout itself fails, but proceeds in explicit degraded mode", async () => {
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 128 },
      { exitCode: 128 },
      { exitCode: 128 },
      { exitCode: 1 }, // readCheckoutContamination: not set
      { exitCode: 0 }, // markCheckoutContaminated — detection is unconditional
    ];
    const result = await prepareManagedCheckout(WORKDIR, "task-readonly-fetchfail", {
      mutationCapable: false,
      fetchRetryDelaysMs: [0, 0],
    });
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain("checkout failed");
    expect(result.refusalReason).toBeUndefined();
    expect(spawnCalls).toHaveLength(7);
    expect(spawnCalls[6].args).toContain("hugin.checkout-contaminated");
  });

  it("recovers a checkout that succeeded but was left dirty: explicit reset+clean, re-verified, marker cleared only after independent proof", async () => {
    const commit = "c".repeat(40);
    spawnBehaviors = [
      { exitCode: 0 }, // 0 rev-parse --git-dir
      { exitCode: 0 }, // 1 remote get-url origin
      { exitCode: 0 }, // 2 fetch origin
      { exitCode: 0, stdout: `${commit}\n` }, // 3 rev-parse --verify (override)
      { exitCode: 0 }, // 4 checkout -b
      { exitCode: 1 }, // 5 readCheckoutContamination: not set
      { exitCode: 0, stdout: "M leftover.txt\n" }, // 6 status --porcelain: dirty
      { exitCode: 0 }, // 7 markCheckoutContaminated
      { exitCode: 0 }, // 8 reset --hard
      { exitCode: 0 }, // 9 clean -fdx
      { exitCode: 0, stdout: "" }, // 10 status --porcelain: clean
      { exitCode: 0, stdout: `${commit}\n` }, // 11 rev-parse HEAD
      { exitCode: 0 }, // 12 clearCheckoutContamination
    ];
    const result = await prepareManagedCheckout(WORKDIR, "task-recover", {
      mutationCapable: true,
      fetchRetryDelaysMs: [0, 0],
      baseBranchOverride: "main",
    });
    expect(result.branch).toMatchObject({ action: "created", baseBranch: "main", baseCommit: commit });
    expect(result.recovered).toBe(true);
    expect(result.refusalReason).toBeUndefined();
    expect(spawnCalls).toHaveLength(13);
    expect(spawnCalls[8].args).toEqual(["reset", "--hard", commit]);
    expect(spawnCalls[9].args).toEqual(["clean", "-fdx"]);
    expect(spawnCalls[12].args).toContain("--unset-all");
  });

  it("fails closed and leaves the marker in place (durable) when the tree is still dirty after an explicit recovery attempt — never re-contaminates by assuming success", async () => {
    const commit = "d".repeat(40);
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: `${commit}\n` },
      { exitCode: 0 },
      { exitCode: 1 }, // readCheckoutContamination: not set
      { exitCode: 0, stdout: "M leftover.txt\n" }, // dirty
      { exitCode: 0 }, // markCheckoutContaminated
      { exitCode: 0 }, // reset --hard succeeds
      { exitCode: 0 }, // clean -fdx succeeds
      { exitCode: 0, stdout: "?? still-dirty.txt\n" }, // re-verify: STILL dirty
    ];
    const result = await prepareManagedCheckout(WORKDIR, "task-recover-fail", {
      mutationCapable: true,
      fetchRetryDelaysMs: [0, 0],
      baseBranchOverride: "main",
    });
    expect(result.recovered).toBeUndefined();
    expect(result.refusalReason).toContain("could not be verified clean");
    expect(spawnCalls).toHaveLength(11);
    expect(spawnCalls.some((c) => c.args.includes("--unset-all"))).toBe(false);

    const markCall = spawnCalls[7];
    expect(markCall.args).toContain("hugin.checkout-contaminated");

    // The marker set at step 7 is exactly what a LATER task would see —
    // proving contamination durably outlives this single gate invocation.
    spawnCalls.length = 0;
    spawnCallIndex = 0;
    spawnBehaviors = [{ exitCode: 0, stdout: `${markCall.args[3]}\n` }];
    const marker = await readCheckoutContamination(WORKDIR);
    expect(marker?.taskId).toBe("task-recover-fail");
    expect(marker?.reason).toContain("tracked or untracked leftover state");
  });

  it("includes ignored leftovers in the global checkout gate, so stale caches/env/dependencies trigger recovery", async () => {
    const commit = "3".repeat(40);
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: `${commit}\n` },
      { exitCode: 0 },
      { exitCode: 1 }, // readCheckoutContamination: not set
      // The issue #236 gate must include ignored leftovers so stale env files,
      // caches, or dependency directories cannot bleed across managed tasks.
      { exitCode: 0, stdout: "!! node_modules/\n" },
      { exitCode: 0 }, // markCheckoutContaminated
      { exitCode: 0 }, // reset --hard
      { exitCode: 0 }, // clean -fdx
      { exitCode: 0, stdout: "" }, // re-verify clean
      { exitCode: 0, stdout: `${commit}\n` },
      { exitCode: 0 }, // clearCheckoutContamination
    ];
    const result = await prepareManagedCheckout(WORKDIR, "task-ignored-leftover", {
      mutationCapable: true,
      fetchRetryDelaysMs: [0, 0],
      baseBranchOverride: "main",
    });
    expect(result.recovered).toBe(true);
    expect(result.refusalReason).toBeUndefined();
    const statusCall = spawnCalls[6];
    expect(statusCall.args).toEqual(["status", "--porcelain", "--ignored=matching"]);
  });

  it("marks contamination for a read-only task when the checkout is dirty, but never attempts recovery (no reset/clean calls)", async () => {
    const commit = "e".repeat(40);
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: `${commit}\n` },
      { exitCode: 0 },
      { exitCode: 1 }, // readCheckoutContamination: not set
      { exitCode: 0, stdout: "M leftover.txt\n" }, // dirty
      { exitCode: 0 }, // markCheckoutContaminated
    ];
    const result = await prepareManagedCheckout(WORKDIR, "task-readonly-dirty", {
      mutationCapable: false,
      fetchRetryDelaysMs: [0, 0],
      baseBranchOverride: "main",
    });
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain("checkout unverified");
    expect(spawnCalls).toHaveLength(8);
    expect(spawnCalls.some((c) => c.args.includes("reset"))).toBe(false);
    expect(spawnCalls.some((c) => c.args.includes("clean"))).toBe(false);
  });

  it("proceeds normally and clears any stale prior marker when the checkout is verified clean on the first try", async () => {
    const commit = "f".repeat(40);
    spawnBehaviors = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: `${commit}\n` },
      { exitCode: 0 },
      { exitCode: 0, stdout: `${"2026-01-01T00:00:00.000Z"}|old-task|old dirt\n` }, // priorContamination present
      { exitCode: 0, stdout: "" }, // status --porcelain: clean
      { exitCode: 0, stdout: `${commit}\n` }, // rev-parse HEAD matches
      { exitCode: 0 }, // clearCheckoutContamination — explicit, only after independent proof
    ];
    const result = await prepareManagedCheckout(WORKDIR, "task-clean", {
      mutationCapable: true,
      fetchRetryDelaysMs: [0, 0],
      baseBranchOverride: "main",
    });
    expect(result.recovered).toBeUndefined();
    expect(result.refusalReason).toBeUndefined();
    expect(result.degraded).toBeUndefined();
    expect(result.priorContamination).toMatchObject({ taskId: "old-task" });
    expect(spawnCalls.at(-1)?.args).toContain("--unset-all");
  });

  it("is idempotent: two consecutive gate runs against a checkout that never becomes clean both refuse, without duplicating side effects beyond the expected recovery attempt each time", async () => {
    const commit = "1".repeat(40);
    const dirtySequence = () => [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: `${commit}\n` },
      { exitCode: 0 },
      { exitCode: 1 },
      { exitCode: 0, stdout: "M forever-dirty.txt\n" },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "M forever-dirty.txt\n" },
    ];

    spawnBehaviors = dirtySequence();
    const first = await prepareManagedCheckout(WORKDIR, "task-a", {
      mutationCapable: true,
      fetchRetryDelaysMs: [0, 0],
      baseBranchOverride: "main",
    });
    expect(first.refusalReason).toBeDefined();

    spawnCalls.length = 0;
    spawnCallIndex = 0;
    spawnBehaviors = dirtySequence();
    const second = await prepareManagedCheckout(WORKDIR, "task-b", {
      mutationCapable: true,
      fetchRetryDelaysMs: [0, 0],
      baseBranchOverride: "main",
    });
    expect(second.refusalReason).toBeDefined();
    expect(spawnCalls.some((c) => c.args.includes("--unset-all"))).toBe(false);
  });
});

// Proves the actual policy index.ts wires around the gate: a task that
// receives a `refusalReason` must never reach the executor. This mirrors the
// spy-based assertion style of publication-recovery-no-rerun.test.ts (#225),
// applied to the pre-execution seam instead of the post-execution one.
describe("gate-refusal-must-block-execution contract", () => {
  it("never invokes the executor when the gate reports a refusal, and always does when it does not", async () => {
    const executeAgent = vi.fn().mockResolvedValue({ exitCode: 0 });

    async function runTaskUnderGate(mutationCapable: boolean, dirty: boolean) {
      const commit = "9".repeat(40);
      spawnBehaviors = dirty
        ? [
            { exitCode: 0 },
            { exitCode: 0 },
            { exitCode: 0 },
            { exitCode: 0, stdout: `${commit}\n` },
            { exitCode: 0 },
            { exitCode: 1 },
            { exitCode: 0, stdout: "M x.txt\n" },
            { exitCode: 0 },
            { exitCode: 0 },
            { exitCode: 0 },
            { exitCode: 0, stdout: "M x.txt\n" },
          ]
        : [
            { exitCode: 0 },
            { exitCode: 0 },
            { exitCode: 0 },
            { exitCode: 0, stdout: `${commit}\n` },
            { exitCode: 0 },
            { exitCode: 1 },
            { exitCode: 0, stdout: "" },
            { exitCode: 0, stdout: `${commit}\n` },
            { exitCode: 0 },
          ];
      const gate = await prepareManagedCheckout(WORKDIR, "task-x", {
        mutationCapable,
        fetchRetryDelaysMs: [0, 0],
        baseBranchOverride: "main",
      });
      // This is the exact policy wired in src/index.ts around the dispatch
      // chain: `if (checkoutGateRefusalReason) { <synthesize failure> } else
      // { <run executor> }` — never both.
      if (!gate.refusalReason) {
        await executeAgent();
      }
      return gate;
    }

    executeAgent.mockClear();
    spawnCalls.length = 0;
    spawnCallIndex = 0;
    const refused = await runTaskUnderGate(true, true);
    expect(refused.refusalReason).toBeDefined();
    expect(executeAgent).not.toHaveBeenCalled();

    executeAgent.mockClear();
    spawnCalls.length = 0;
    spawnCallIndex = 0;
    const clean = await runTaskUnderGate(true, false);
    expect(clean.refusalReason).toBeUndefined();
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });
});
