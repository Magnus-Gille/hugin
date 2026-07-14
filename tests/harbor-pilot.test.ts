import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCodeLoopOnce } from "../scripts/harbor_pilot/m5-code-loop-once.js";
import {
  HARBOR_PILOT_VERSION,
  prepareGateDHarborPilot,
} from "../scripts/harbor_pilot/prepare-gate-d.js";
import { summarizeHarborJob } from "../scripts/harbor_pilot/run-pilot.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hugin-harbor-test-"));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function fakeGateDRepo(root: string): string {
  const repo = join(root, "gille-inference");
  mkdirSync(repo);
  write(join(repo, "gate-d", "check.sh"), "#!/usr/bin/env bash\nexit 0\n");
  const task = join(repo, "gate-d", "tasks", "01-make-failing-test-pass");
  write(join(task, "INSTRUCTION.md"), "Make the test pass.\n");
  write(join(task, "meta.json"), `${JSON.stringify({
    id: "01-make-failing-test-pass",
    edit: ["src/sum.ts"],
    oracleFiles: ["test/sum.oracle.ts", "tsconfig.json"],
    oracleCmd: "test/sum.oracle.ts",
  })}\n`);
  write(join(task, "repo", "src", "sum.ts"), "export const sum = () => 0;\n");
  write(join(task, "repo", "test", "sum.oracle.ts"), "// protected\n");
  write(join(task, "repo", "tsconfig.json"), "{}\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "fixture"]);
  return repo;
}

describe("Harbor Gate D pilot", () => {
  it("generates a content-pinned task with a separate no-network verifier", () => {
    const root = tempRoot();
    const repo = fakeGateDRepo(root);
    const out = join(root, "prepared");
    const prepared = prepareGateDHarborPilot({
      sourceRepo: repo,
      outputDir: out,
      taskIds: ["01-make-failing-test-pass"],
      networkMode: "no-network",
    });

    expect(prepared.taskIds).toEqual(["01-make-failing-test-pass"]);
    const task = join(out, "tasks", "01-make-failing-test-pass");
    const toml = readFileSync(join(task, "task.toml"), "utf8");
    expect(toml).toContain('environment_mode = "separate"');
    expect(toml.match(/network_mode = "no-network"/g)).toHaveLength(4);
    expect(toml).toContain('source = "/app"');
    expect(toml).toContain(HARBOR_PILOT_VERSION);
    const control = JSON.parse(readFileSync(
      join(task, "environment", "control.json"),
      "utf8",
    ));
    expect(control).toMatchObject({
      task_id: "01-make-failing-test-pass",
      protected: ["test/sum.oracle.ts", "tsconfig.json"],
    });
    expect(readFileSync(join(task, "tests", "test.sh"), "utf8"))
      .toContain("ln -s /opt/gate-d/node_modules /app/node_modules");
    expect(readFileSync(join(task, "tests", "test.sh"), "utf8"))
      .toContain("gate_d_all_gates");
    expect(readFileSync(join(task, "tests", "Dockerfile"), "utf8"))
      .toContain("COPY . /tests/");
    expect(readFileSync(join(task, "tests", "Dockerfile"), "utf8"))
      .toContain("@types/node@22.13.0");
  });

  it("refuses a dirty source corpus", () => {
    const root = tempRoot();
    const repo = fakeGateDRepo(root);
    write(join(repo, "dirty.txt"), "not committed\n");
    expect(() => prepareGateDHarborPilot({
      sourceRepo: repo,
      outputDir: join(root, "prepared"),
      taskIds: ["01-make-failing-test-pass"],
      networkMode: "no-network",
    })).toThrow(/must be clean/);
  });

  it("validates replayed M5 results against the declared execution binding", async () => {
    const root = tempRoot();
    const replay = join(root, "replay.json");
    const caps = { wall_s: 600, turns: 13, completion_tokens: 60_000 };
    writeFileSync(replay, JSON.stringify({
      status: "completed",
      diff: "diff --git a/a.ts b/a.ts",
      diff_truncated: false,
      changed_files: ["a.ts"],
      protected_violations: [],
      summary: "done",
      check: { ran: false, exit_code: null, output_tail: "" },
      usage: { turns: 2, wall_ms: 100, prompt_tokens: 10, completion_tokens: 20 },
      work_id: "cl-replay",
      detail: "",
      execution: {
        schema_version: 1,
        model: "qwen3-coder-next-80b",
        engine: "pi",
        harness_version: "code-loop-pi-2026-07-13-v2",
        effective_caps: caps,
      },
      telemetry: {
        schema_version: 1,
        phase_ms: {},
        mutation_evidence: "diff-only",
        observability_coverage: 0.5,
      },
    }));

    await expect(runCodeLoopOnce({
      request: { instruction: "fix", files: [{ path: "a.ts", content: "x" }], caps },
      expected: {
        model: "wrong-model",
        harnessVersion: "code-loop-pi-2026-07-13-v2",
        caps,
      },
      pollMs: 250,
      resultDeadlineS: 60,
      replayPath: replay,
    })).rejects.toThrow(/effective model/);
  });

  it("summarizes Harbor rewards without importing prompts, diffs, or verifier logs", () => {
    const root = tempRoot();
    const job = join(root, "jobs", "replay");
    write(join(job, "trial-b", "result.json"), JSON.stringify({
      task_name: "04-add-cli-flag",
      verifier_result: { rewards: { reward: 0, gate_d_all_gates: 0 } },
      exception_info: null,
      agent_result: { metadata: { work_id: "cl-b", diff_sha256: "b".repeat(64) } },
      secret_prompt: "must not be copied",
    }));
    write(join(job, "trial-a", "result.json"), JSON.stringify({
      task_name: "01-make-failing-test-pass",
      verifier_result: { rewards: { reward: 1, gate_d_all_gates: 1 } },
      exception_info: null,
      agent_result: { metadata: { work_id: "cl-a", diff_sha256: "a".repeat(64) } },
    }));
    write(join(job, "result.json"), JSON.stringify({ n_total_trials: 2 }));

    const summary = summarizeHarborJob(job);
    expect(summary.map((row) => [row.taskId, row.reward])).toEqual([
      ["01-make-failing-test-pass", 1],
      ["04-add-cli-flag", 0],
    ]);
    expect(JSON.stringify(summary)).not.toContain("must not be copied");
  });
});
