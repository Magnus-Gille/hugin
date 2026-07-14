import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodeLoopOnce } from "../scripts/harbor_pilot/m5-code-loop-once.js";
import { harborLearningImportFromReport } from "../scripts/harbor_pilot/import-learning-report.js";
import {
  HARBOR_PILOT_CAMPAIGN_ID,
  HARBOR_PILOT_HOLDOUT_IDS,
  HARBOR_PILOT_TASK_IDS,
  HARBOR_PILOT_VERSION,
  prepareGateDHarborPilot,
} from "../scripts/harbor_pilot/prepare-gate-d.js";
import {
  bindDeclaration,
  customBasePreflightScript,
  sourceBaselinePreflightScript,
  summarizeHarborJob,
} from "../scripts/harbor_pilot/run-pilot.js";

const roots: string[] = [];
const advertisedCodeLoopStart = {
  name: "code_loop_start",
  description: "Start work. contract[harness=code-loop-pi-2026-07-14-v6;agent_checks=pi-bash-events-v3;schema=3;max_attempts=1000]",
  inputSchema: {
    properties: {
      client_run_id: {},
      caps: { properties: { edit_deadline_turn: {} } },
    },
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.M5_API_KEY;
  delete process.env.M5_MCP_URL;
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

function fakeGateDRepo(root: string, helperContent = "export const marker = 'one';\n"): string {
  const repo = join(root, "gille-inference");
  mkdirSync(repo);
  write(join(repo, "gate-d", "check.sh"), "#!/usr/bin/env bash\nexit 0\n");
  write(join(repo, "gate-d", "check-test-assertions.mjs"), "export const assertions = true;\n");
  write(join(repo, "gate-d", "check-ts-contract.mjs"), helperContent);
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
  it("preflights the tools the task and verifier actually execute", () => {
    const script = customBasePreflightScript();
    expect(script).toContain("command -v bash");
    expect(script).toContain("command -v diff");
    expect(script).toContain("command -v grep");
    expect(script).toContain("@types/node/package.json");
    expect(script).not.toContain("command -v git");
  });

  it("preflights worker-native Gate D dependencies before live calls", () => {
    const script = sourceBaselinePreflightScript();
    expect(script).toContain("test -x ./node_modules/.bin/tsx");
    expect(script).toContain("test -x ./node_modules/.bin/tsc");
    expect(script).toContain("require('esbuild').transformSync");
    expect(script).toContain("./node_modules/.bin/tsc --version");
    expect(script).not.toContain("npx");
  });

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
      holdout: false,
      protected: ["test/sum.oracle.ts", "tsconfig.json"],
      client_run_ids: {
        baseline: expect.stringContaining(":baseline"),
        live: expect.stringContaining(":live"),
      },
    });
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      campaign_id: HARBOR_PILOT_CAMPAIGN_ID,
      corpus_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      verifier_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      harbor_verifier_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      verifier_support: [
        { path: "check-test-assertions.mjs", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { path: "check-ts-contract.mjs", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
    });
    expect(readFileSync(join(task, "tests", "test.sh"), "utf8"))
      .toContain("ln -s /opt/gate-d/node_modules /app/node_modules");
    expect(readFileSync(join(task, "tests", "test.sh"), "utf8"))
      .toContain("ln -s /opt/gate-d/node_modules /tests/node_modules");
    expect(readFileSync(join(task, "tests", "test.sh"), "utf8"))
      .toContain("gate_d_all_gates");
    expect(readFileSync(join(task, "tests", "Dockerfile"), "utf8"))
      .toContain("COPY . /tests/");
    expect(readFileSync(join(task, "tests", "Dockerfile"), "utf8"))
      .toContain("@types/node@22.13.0");
    expect(readFileSync(join(task, "tests", "check-test-assertions.mjs"), "utf8"))
      .toContain("assertions");
    expect(readFileSync(join(task, "tests", "check-ts-contract.mjs"), "utf8"))
      .toContain("marker");
  });

  it("binds verifier support content into the host and Harbor verifier digests", () => {
    const firstRoot = tempRoot();
    const first = prepareGateDHarborPilot({
      sourceRepo: fakeGateDRepo(firstRoot, "export const marker = 'one';\n"),
      outputDir: join(firstRoot, "prepared"),
      taskIds: ["01-make-failing-test-pass"],
    });
    const secondRoot = tempRoot();
    const second = prepareGateDHarborPilot({
      sourceRepo: fakeGateDRepo(secondRoot, "export const marker = 'two';\n"),
      outputDir: join(secondRoot, "prepared"),
      taskIds: ["01-make-failing-test-pass"],
    });

    expect(first.verifierSha256).not.toBe(second.verifierSha256);
    expect(first.harborVerifierSha256).not.toBe(second.harborVerifierSha256);
  });

  it("rejects a verifier support symlink before packaging", () => {
    const root = tempRoot();
    const repo = fakeGateDRepo(root);
    const support = join(repo, "gate-d", "check-ts-contract.mjs");
    rmSync(support);
    symlinkSync("../check.sh", support);

    expect(() => prepareGateDHarborPilot({
      sourceRepo: repo,
      outputDir: join(root, "prepared"),
      taskIds: ["01-make-failing-test-pass"],
    })).toThrow(/unsafe Gate D verifier support file/);
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

  it("binds generated assets to an immutable pre-inference declaration", () => {
    const root = tempRoot();
    const repo = fakeGateDRepo(root);
    const prepared = prepareGateDHarborPilot({
      sourceRepo: repo,
      outputDir: join(root, "prepared"),
      taskIds: ["01-make-failing-test-pass"],
      networkMode: "no-network",
    });
    const declarationPath = join(root, "declaration.json");
    const declaration = {
      schema_version: 1,
      status: "declared-not-run",
      campaign_id: prepared.campaignId,
      pilot_version: HARBOR_PILOT_VERSION,
      harbor_version: "0.18.0",
      source_commit: prepared.sourceCommit,
      task_ids: prepared.taskIds,
      holdout_ids: prepared.holdoutIds,
      holdout_revision: prepared.holdoutRevision,
      corpus_sha256: prepared.corpusSha256,
      verifier_sha256: prepared.verifierSha256,
      harbor_verifier_sha256: prepared.harborVerifierSha256,
      model: "qwen3-coder-next-80b",
      harness_version: "code-loop-pi-2026-07-14-v6",
      caps: { wall_s: 600, turns: 13, completion_tokens: 60_000 },
      required_capabilities: {
        start_idempotency: "client-run-id-v1",
        agent_checks: "pi-bash-events-v3",
      },
      network_mode: "no-network",
      base_image: prepared.baseImage,
      harbor_concurrency: 1,
      attempts_per_task: 1,
      model_calls_at_declaration: 0,
    };
    writeFileSync(declarationPath, JSON.stringify(declaration));
    expect(bindDeclaration({
      path: declarationPath,
      prepared,
      networkMode: "no-network",
    })).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(declarationPath, JSON.stringify({ ...declaration, corpus_sha256: "0".repeat(64) }));
    expect(() => bindDeclaration({
      path: declarationPath,
      prepared,
      networkMode: "no-network",
    })).toThrow(/does not match/);
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

  it("recovers an ambiguous live start with the same durable client binding", async () => {
    const caps = { wall_s: 600, turns: 13, completion_tokens: 60_000 };
    const clientRunId = "harbor:test-campaign:task-11:live";
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let startAttempts = 0;
    const result = {
      status: "completed",
      diff: "diff --git a/a.ts b/a.ts",
      diff_truncated: false,
      changed_files: ["a.ts"],
      protected_violations: [],
      summary: "done",
      check: { ran: false, exit_code: null, output_tail: "" },
      usage: { turns: 2, wall_ms: 100, prompt_tokens: 10, completion_tokens: 20 },
      work_id: "cl-durable",
      detail: "",
      execution: {
        schema_version: 1,
        model: "qwen3-coder-next-80b",
        engine: "pi",
        harness_version: "code-loop-pi-2026-07-14-v6",
        effective_caps: caps,
        capabilities: {
          start_idempotency: "client-run-id-v1",
          agent_checks: "pi-bash-events-v3",
        },
      },
      telemetry: {
        schema_version: 1,
        phase_ms: {},
        mutation_evidence: "diff-only",
        observability_coverage: 0.5,
      },
      agent_checks: {
        schema_version: 3,
        source: "pi-bash-events",
        state: "none",
        unparseable_lines: 0,
        coverage_loss_events: 0,
        work_id: "cl-durable",
        attempts: [],
      },
    };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      calls.push({ method: body.method, params: body.params });
      if (body.method === "tools/list") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [advertisedCodeLoopStart] },
        }));
      }
      const tool = body.params.name;
      if (tool === "code_loop_start") {
        startAttempts += 1;
        if (startAttempts === 1) throw new TypeError("lost response");
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({
              work_id: "cl-durable",
              status: "completed",
              client_run_id: clientRunId,
              request_fingerprint: `sha256:${"e".repeat(64)}`,
              recovered: true,
              capabilities: {
                start_idempotency: "client-run-id-v1",
                agent_checks: "pi-bash-events-v3",
              },
              result,
            }) }],
          },
        }));
      }
      if (tool === "code_loop_result") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        }));
      }
      throw new Error(`unexpected tool ${String(tool)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.M5_API_KEY = "owner-secret";
    process.env.M5_MCP_URL = "http://m5.test:8080/mcp";

    const output = await runCodeLoopOnce({
      request: {
        client_run_id: clientRunId,
        instruction: "fix",
        files: [{ path: "a.ts", content: "x" }],
        caps,
      },
      expected: {
        model: "qwen3-coder-next-80b",
        harnessVersion: "code-loop-pi-2026-07-14-v6",
        caps,
        capabilities: {
          startIdempotency: "client-run-id-v1",
          agentChecks: "pi-bash-events-v3",
        },
      },
      pollMs: 250,
      resultDeadlineS: 60,
    });

    expect(output.start).toMatchObject({
      client_run_id: clientRunId,
      recovered: true,
      work_id: "cl-durable",
    });
    const starts = calls.filter((call) => call.params.name === "code_loop_start");
    expect(starts).toHaveLength(2);
    expect(starts[0]).toEqual(starts[1]);
  });

  it("rejects live result evidence from a different work id", async () => {
    const caps = { wall_s: 600, turns: 13, completion_tokens: 60_000 };
    const clientRunId = "harbor:test-campaign:task-11:live";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      if (body.method === "tools/list") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [advertisedCodeLoopStart] },
        }));
      }
      const tool = body.params.name;
      const text = tool === "code_loop_start"
        ? {
            work_id: "cl-start",
            status: "completed",
            client_run_id: clientRunId,
            request_fingerprint: `sha256:${"e".repeat(64)}`,
            recovered: false,
            capabilities: {
              start_idempotency: "client-run-id-v1",
              agent_checks: "pi-bash-events-v3",
            },
          }
        : {
            status: "completed",
            diff: "",
            diff_truncated: false,
            changed_files: [],
            protected_violations: [],
            summary: "wrong result",
            check: { ran: false, exit_code: null, output_tail: "" },
            usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 },
            work_id: "cl-other",
            detail: "",
            execution: {
              schema_version: 1,
              model: "qwen3-coder-next-80b",
              engine: "pi",
              harness_version: "code-loop-pi-2026-07-14-v6",
              effective_caps: caps,
              capabilities: {
                start_idempotency: "client-run-id-v1",
                agent_checks: "pi-bash-events-v3",
              },
            },
            agent_checks: {
              schema_version: 3,
              source: "pi-bash-events",
              state: "none",
              unparseable_lines: 0,
              coverage_loss_events: 0,
              work_id: "cl-other",
              attempts: [],
            },
          };
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(text) }] },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.M5_API_KEY = "owner-secret";
    process.env.M5_MCP_URL = "http://m5.test:8080/mcp";

    await expect(runCodeLoopOnce({
      request: {
        client_run_id: clientRunId,
        instruction: "fix",
        files: [{ path: "a.ts", content: "x" }],
        caps,
      },
      expected: {
        model: "qwen3-coder-next-80b",
        harnessVersion: "code-loop-pi-2026-07-14-v6",
        caps,
        capabilities: {
          startIdempotency: "client-run-id-v1",
          agentChecks: "pi-bash-events-v3",
        },
      },
      pollMs: 250,
      resultDeadlineS: 60,
    })).rejects.toThrow(/durable start binding/);
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

  it("predeclares four fresh cases and two hash-selected holdouts", () => {
    expect(HARBOR_PILOT_TASK_IDS).toEqual([
      "11-node-path-containment",
      "12-add-csv-cli-format",
      "13-type-safe-slug-tests",
      "14-shared-handle-validation",
    ]);
    expect(HARBOR_PILOT_HOLDOUT_IDS).toEqual([
      "11-node-path-containment",
      "12-add-csv-cli-format",
    ]);
  });

  it("builds only content-blind matched learning observations from a reviewed v2 report", () => {
    const tasks = [...HARBOR_PILOT_TASK_IDS];
    const holdouts = new Set<string>(HARBOR_PILOT_HOLDOUT_IDS);
    const baseline = tasks.map((taskId, index) => ({
      taskId,
      holdout: holdouts.has(taskId),
      passed: index !== 3,
      applyReturnCode: 0,
      checkReturnCode: index !== 3 ? 0 : 1,
      checkDurationMs: 10,
      failureKind: index !== 3 ? null : "check-failed",
      workId: `cl-${index}`,
      status: "completed",
      diffBytes: 42,
      secret_prompt: "never import me",
    }));
    const replay = baseline.map((row) => ({
      taskId: row.taskId,
      holdout: row.holdout,
      baselinePassed: row.passed,
      harborPassed: row.passed,
      rewardMeasured: true,
      rewardParity: true,
      diffParity: true,
      workParity: true,
      clientRunParity: true,
      applyReturnCode: 0,
      exceptionType: null,
      verifier_log: "never import me either",
    }));
    const live = baseline.map((row, index) => ({
      taskId: row.taskId,
      holdout: row.holdout,
      reward: row.passed ? 1 : 0,
      workId: `cl-live-${index}`,
      clientRunId: `harbor:${HARBOR_PILOT_CAMPAIGN_ID}:${row.taskId}:live`,
      requestFingerprint: `sha256:${String(index).padStart(64, "0")}`,
      startCapabilities: {
        start_idempotency: "client-run-id-v1",
        agent_checks: "pi-bash-events-v3",
      },
      execution: {
        model: "qwen3-coder-next-80b",
        harness_version: "code-loop-pi-2026-07-14-v6",
        effective_caps: { wall_s: 600, turns: 13, completion_tokens: 60_000 },
        capabilities: {
          start_idempotency: "client-run-id-v1",
          agent_checks: "pi-bash-events-v3",
        },
      },
      agentChecks: {
        schema_version: 3,
        source: "pi-bash-events",
        state: "none",
        unparseable_lines: 0,
        coverage_loss_events: 0,
        work_id: `cl-live-${index}`,
        attempts: [],
      },
      exceptionType: null,
    }));
    const payload = harborLearningImportFromReport({
      schema_version: 2,
      pilot_version: HARBOR_PILOT_VERSION,
      campaign_id: HARBOR_PILOT_CAMPAIGN_ID,
      harbor_version: "0.18.0",
      runner_commit: "f".repeat(64),
      declaration_sha256: "e".repeat(64),
      source_commit: "a".repeat(64),
      task_ids: tasks,
      holdout_ids: [...HARBOR_PILOT_HOLDOUT_IDS],
      holdout_revision: "sha256-lowest-two-of-four-v1",
      corpus_sha256: "b".repeat(64),
      verifier_sha256: "c".repeat(64),
      harbor_verifier_sha256: "d".repeat(64),
      caps: { wall_s: 600, turns: 13, completion_tokens: 60_000 },
      model: "qwen3-coder-next-80b",
      harness_version: "code-loop-pi-2026-07-14-v6",
      network_mode: "no-network",
      network_isolation_met: true,
      base_image: "node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0",
      standard_base_image_met: true,
      exact_replay_parity: true,
      baseline_decisions_verified: true,
      live_adapter_completed: true,
      recommendation: "go",
      baseline,
      replay_parity: replay,
      live_adapter: live,
      raw_diff: "secret diff",
    });

    expect(payload.experiment.change_axis).toBe("test-harness");
    expect(payload.observations).toHaveLength(8);
    expect(payload.observations.filter((row) => row.holdout)).toHaveLength(4);
    expect(JSON.stringify(payload)).not.toContain("never import me");
    expect(JSON.stringify(payload)).not.toContain("secret diff");
  });
});
