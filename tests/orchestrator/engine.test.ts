import { describe, it, expect, vi } from "vitest";
import type { ModelInvoker, ModelInvokeOptions } from "../../src/orchestrator/model-invoker.js";
import type { OrchestratorRole } from "../../src/orchestrator/plan.js";
import type { WorkerResult } from "../../src/orchestrator/worker-executor.js";
import { runOrchestration, DEFAULT_ORCHESTRATOR_CONFIG } from "../../src/orchestrator/engine.js";

function ok(output: string, costUsd: number | null = 0.001): WorkerResult {
  return {
    ok: true, output, provider: "openrouter", model: "m",
    inputTokens: 10, outputTokens: 10, costUsd, latencyMs: 5,
  };
}
function fail(error = "boom"): WorkerResult {
  return {
    ok: false, output: "", provider: "openrouter", model: "m",
    inputTokens: null, outputTokens: null, costUsd: null, latencyMs: 5, error,
  };
}

function okTrunc(output: string, costUsd: number | null = 0.001): WorkerResult {
  return { ...ok(output, costUsd), truncated: true };
}

const VALID_PLAN_3 = JSON.stringify({
  subtasks: [
    { id: "1", prompt: "Step 1" },
    { id: "2", prompt: "Step 2" },
    { id: "3", prompt: "Step 3" },
  ],
});

/** Build a mock invoker from a map of role → ordered responses. */
function buildMockInvoker(
  responses: Map<OrchestratorRole, WorkerResult[]>,
  onInvoke?: (role: OrchestratorRole, prompt: string, opts?: ModelInvokeOptions) => void,
): ModelInvoker {
  const counters = new Map<OrchestratorRole, number>();
  return {
    invoke: vi.fn(async (role: OrchestratorRole, prompt: string, opts?: ModelInvokeOptions) => {
      onInvoke?.(role, prompt, opts);
      const queue = responses.get(role) ?? [];
      const idx = counters.get(role) ?? 0;
      counters.set(role, idx + 1);
      return queue[idx] ?? fail(`No response queued for ${role}[${idx}]`);
    }),
  };
}

describe("runOrchestration — happy fanout", () => {
  it("planner returns 3 subtasks → 3 worker calls → synthesizer merges → ok:true", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1", 0.002), ok("W2", 0.003), ok("W3", 0.004)]],
      ["synthesizer", [ok("Final answer", 0.005)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Do a complex task", invoker, { maxSubtasks: 12 });

    expect(result.ok).toBe(true);
    expect(result.finalOutput).toBe("Final answer");
    expect(result.plan.strategy).toBe("fanout");
    expect(result.outcomes).toHaveLength(3);
    // totalCostUsd = planner(0.01) + workers(0.002+0.003+0.004) + synth(0.005) = 0.024
    expect(result.totalCostUsd).toBeCloseTo(0.024, 6);
  });

  it("passes planner taskType through to each worker invocation", async () => {
    const plan = JSON.stringify({
      subtasks: [
        { id: "a", prompt: "Summarize the notes", taskType: "summarize" },
        { id: "b", prompt: "Compute the answer", taskType: "reason-math" },
      ],
    });
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(plan, 0.01)]],
      ["worker", [ok("W1"), ok("W2")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const workerTaskTypes: Array<string | undefined> = [];
    const invoker = buildMockInvoker(responses, (role, _prompt, opts) => {
      if (role === "worker") workerTaskTypes.push(opts?.taskType);
    });

    await runOrchestration("Do a complex task", invoker, { maxSubtasks: 12 });

    expect(workerTaskTypes).toEqual(["summarize", "reason-math"]);
  });

  it("forwards a macro route only to the reviewed worker task type", async () => {
    const plan = JSON.stringify({
      subtasks: [
        { id: "a", prompt: "Classify", taskType: "classify" },
        { id: "b", prompt: "Broad work", taskType: "other" },
      ],
    });
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(plan)]],
      ["worker", [ok("classification"), ok("broad")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const routes: Array<ModelInvokeOptions["workerRoute"]> = [];
    const invoker = buildMockInvoker(responses, (role, _prompt, opts) => {
      if (role === "worker") routes.push(opts?.workerRoute);
    });

    await runOrchestration("task", invoker, undefined, {
      workerRoute: (taskType) =>
        taskType === "classify" ? { nodeId: "orin", modelId: "qwen2.5-coder:3b" } : null,
    });

    expect(routes).toEqual([
      { nodeId: "orin", modelId: "qwen2.5-coder:3b" },
      undefined,
    ]);
  });
});

describe("runOrchestration — truncation warnings (issue #112)", () => {
  it("no truncation → warnings is an empty array", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const result = await runOrchestration("task", buildMockInvoker(responses));
    expect(result.warnings).toEqual([]);
  });

  it("a truncated worker surfaces a warning naming the subtask id", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), okTrunc("W2 cut off"), ok("W3")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const result = await runOrchestration("task", buildMockInvoker(responses));
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("2"); // subtask id
    expect(result.warnings[0].toLowerCase()).toContain("truncat");
  });

  it("a truncated synthesizer surfaces a warning", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["synthesizer", [okTrunc("truncated merge")]],
    ]);
    const result = await runOrchestration("task", buildMockInvoker(responses));
    expect(result.warnings.some((w) => w.toLowerCase().includes("synthesizer"))).toBe(true);
  });

  it("a truncated planner surfaces a warning", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [okTrunc(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const result = await runOrchestration("task", buildMockInvoker(responses));
    expect(result.warnings.some((w) => w.toLowerCase().includes("planner"))).toBe(true);
  });

  it("a truncated verifier surfaces a warning naming the subtask (verify pass on)", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      // verifier called once per successful worker; only the 2nd is truncated.
      // Content still parses cleanly as PASS (Fix #4 tightened parsing so a
      // bare truncated fragment like "PA" is no longer readable as a verdict
      // at all) — this test isolates the truncation warning specifically.
      ["verifier", [ok("PASS"), okTrunc("PASS - cut off mid"), ok("PASS")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const result = await runOrchestration("task", buildMockInvoker(responses), {
      verifyWorkers: true,
    });
    const verifierWarnings = result.warnings.filter((w) => w.toLowerCase().includes("verifier"));
    expect(verifierWarnings.length).toBe(1);
    expect(verifierWarnings[0]).toContain("2"); // subtask id
    expect(verifierWarnings[0].toLowerCase()).toContain("truncat");
  });
});

describe("runOrchestration — AbortSignal threading (issue #110)", () => {
  it("forwards opts.signal into every invoke call (planner, workers, synthesizer)", async () => {
    const controller = new AbortController();
    const seenSignals: (AbortSignal | undefined)[] = [];
    const counters = new Map<OrchestratorRole, number>();
    const queues = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: OrchestratorRole, _prompt: string, opts?: { signal?: AbortSignal }) => {
        seenSignals.push(opts?.signal);
        const idx = counters.get(role) ?? 0;
        counters.set(role, idx + 1);
        return (queues.get(role) ?? [])[idx] ?? fail(`none for ${role}[${idx}]`);
      }),
    };

    await runOrchestration("task", invoker, undefined, { signal: controller.signal });

    // planner + 3 workers + synthesizer = 5 calls, all carrying the signal
    expect(seenSignals.length).toBe(5);
    expect(seenSignals.every((s) => s === controller.signal)).toBe(true);
  });
});

describe("runOrchestration — single fallback", () => {
  it("planner returns garbage → strategy single → 1 worker → finalOutput == worker output, no synth call", async () => {
    const synthSpy = vi.fn();
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok("this is definitely not json")]],
      ["worker", [ok("Solo worker output", 0.005)]],
    ]);
    const invoker = buildMockInvoker(responses, (role) => {
      if (role === "synthesizer") synthSpy();
    });

    const result = await runOrchestration("Simple task", invoker);

    expect(result.ok).toBe(true);
    expect(result.plan.strategy).toBe("single");
    expect(result.outcomes).toHaveLength(1);
    expect(result.finalOutput).toBe("Solo worker output");
    expect(synthSpy).not.toHaveBeenCalled();
  });
});

describe("runOrchestration — partial failure", () => {
  it("1 of 3 workers fails → synthesizes from 2 survivors, ok:true, failed outcome retained", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1", 0.002), fail("worker 2 exploded"), ok("W3", 0.004)]],
      ["synthesizer", [ok("Merged output", 0.005)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Partial fail task", invoker);

    expect(result.ok).toBe(true);
    expect(result.outcomes).toHaveLength(3);
    const failedOutcome = result.outcomes.find((o) => !o.result.ok);
    expect(failedOutcome).toBeDefined();
    expect(failedOutcome!.result.error).toBe("worker 2 exploded");
    // Issue #157: the synthesized answer is kept, but the final output must
    // also carry the deterministic degraded-coverage notice (see the
    // degraded-coverage describe block below).
    expect(result.finalOutput).toContain("Merged output");
  });
});

describe("runOrchestration — all workers fail", () => {
  it("ok:false, error set, finalOutput empty string", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [fail("err1"), fail("err2"), fail("err3")]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Doomed task", invoker);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.finalOutput).toBe("");
    expect(result.outcomes).toHaveLength(3);
  });
});

describe("runOrchestration — synthesizer fallback", () => {
  it("synthesizer returns ok:true but empty output → finalOutput is joined worker outputs, ok:true", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1", 0.002), ok("W2", 0.003), ok("W3", 0.004)]],
      // synthesizer responds ok:true but with whitespace-only content
      ["synthesizer", [ok("   ", 0.005)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Synth empty task", invoker);

    expect(result.ok).toBe(true);
    // Should contain all three worker outputs labeled by subtask id
    expect(result.finalOutput).toContain("## 1");
    expect(result.finalOutput).toContain("W1");
    expect(result.finalOutput).toContain("## 2");
    expect(result.finalOutput).toContain("W2");
    expect(result.finalOutput).toContain("## 3");
    expect(result.finalOutput).toContain("W3");
  });

  it("synthesizer returns ok:false → finalOutput is joined worker outputs, ok:true", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("Alpha", 0.002), ok("Beta", 0.003), ok("Gamma", 0.004)]],
      ["synthesizer", [fail("synthesizer model error")]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Synth fail task", invoker);

    expect(result.ok).toBe(true);
    expect(result.finalOutput).toContain("Alpha");
    expect(result.finalOutput).toContain("Beta");
    expect(result.finalOutput).toContain("Gamma");
    // Each section labeled with the subtask id
    expect(result.finalOutput).toContain("## 1");
    expect(result.finalOutput).toContain("## 2");
    expect(result.finalOutput).toContain("## 3");
  });
});

describe("runOrchestration — verify on", () => {
  it("verifier invoked per successful worker, verdict attached", async () => {
    const PLAN_2 = JSON.stringify({
      subtasks: [
        { id: "1", prompt: "Step 1" },
        { id: "2", prompt: "Step 2" },
      ],
    });
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(PLAN_2, 0.01)]],
      ["worker", [ok("W1", 0.002), ok("W2", 0.003)]],
      ["verifier", [ok("PASS looks good", 0.001), ok("PASS", 0.001)]],
      ["synthesizer", [ok("Final", 0.002)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Verify task", invoker, { verifyWorkers: true });

    expect(result.ok).toBe(true);
    expect(result.outcomes.every((o) => o.verdict !== undefined)).toBe(true);
    expect(result.outcomes[0].verdict!.ok).toBe(true);
  });
});

describe("runOrchestration — cost aggregation (Fix #9)", () => {
  it("totalCostUsd is null when any invocation has costUsd:null (mixed priced + unpriced)", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      // One worker priced, one unpriced, one priced
      ["worker", [ok("W1", 0.002), ok("W2", null), ok("W3", 0.004)]],
      ["synthesizer", [ok("Final", 0.005)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Cost test task", invoker, { maxSubtasks: 12 });

    expect(result.ok).toBe(true);
    expect(result.totalCostUsd).toBeNull();
  });

  it("totalCostUsd is a numeric sum when ALL invocations are priced", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1", 0.002), ok("W2", 0.003), ok("W3", 0.004)]],
      ["synthesizer", [ok("Final", 0.005)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("All priced task", invoker, { maxSubtasks: 12 });

    expect(result.ok).toBe(true);
    // 0.01 + 0.002 + 0.003 + 0.004 + 0.005 = 0.024
    expect(result.totalCostUsd).toBeCloseTo(0.024, 6);
  });
});

describe("runOrchestration — verifier infra failure is UNKNOWN, not PASS (V3)", () => {
  it("a failed verifier CALL leaves verdict undefined and adds a warning, not a silent PASS", async () => {
    const PLAN_2 = JSON.stringify({
      subtasks: [
        { id: "1", prompt: "Step 1" },
        { id: "2", prompt: "Step 2" },
      ],
    });
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(PLAN_2, 0.01)]],
      ["worker", [ok("W1", 0.002), ok("W2", 0.003)]],
      // First verifier call fails outright (infra); second succeeds.
      ["verifier", [fail("verifier outage"), ok("PASS", 0.001)]],
      ["synthesizer", [ok("Final", 0.002)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Verify task", invoker, { verifyWorkers: true });

    expect(result.outcomes[0].verdict).toBeUndefined();
    expect(result.outcomes[1].verdict!.ok).toBe(true);
    expect(result.warnings.some((w) => w.toLowerCase().includes("verifier"))).toBe(true);
  });
});

describe("runOrchestration — parseVerdict robustness (Fix #4)", () => {
  it("a leading PASS with 'FAIL' mentioned later in notes is still a PASS (no substring-FAIL-first bug)", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(JSON.stringify({ subtasks: [{ id: "1", prompt: "Step 1" }] }), 0.01)]],
      ["worker", [ok("W1", 0.002)]],
      ["verifier", [ok("PASS — would otherwise FAIL on a stricter reading, but this is acceptable.", 0.001)]],
      // single outcome → no synthesizer call needed
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("task", invoker, { verifyWorkers: true });

    expect(result.outcomes[0].verdict).toBeDefined();
    expect(result.outcomes[0].verdict!.ok).toBe(true);
  });

  it("a leading FAIL is FAIL even when 'PASS' appears later in notes", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(JSON.stringify({ subtasks: [{ id: "1", prompt: "Step 1" }] }), 0.01)]],
      ["worker", [ok("W1", 0.002)]],
      ["verifier", [ok("FAIL — close, would PASS with a minor fix.", 0.001)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("task", invoker, { verifyWorkers: true });

    expect(result.outcomes[0].verdict).toBeDefined();
    expect(result.outcomes[0].verdict!.ok).toBe(false);
  });

  it("empty verifier output leaves verdict undefined (never a fake PASS) and warns", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(JSON.stringify({ subtasks: [{ id: "1", prompt: "Step 1" }] }), 0.01)]],
      ["worker", [ok("W1", 0.002)]],
      ["verifier", [ok("", 0.001)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("task", invoker, { verifyWorkers: true });

    expect(result.outcomes[0].verdict).toBeUndefined();
    expect(result.warnings.some((w) => w.toLowerCase().includes("verif"))).toBe(true);
  });

  it("gibberish verifier output (no PASS/FAIL at all) leaves verdict undefined and warns", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(JSON.stringify({ subtasks: [{ id: "1", prompt: "Step 1" }] }), 0.01)]],
      ["worker", [ok("W1", 0.002)]],
      ["verifier", [ok("asdkfj qwoeiru zpxcv nonsense output", 0.001)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("task", invoker, { verifyWorkers: true });

    expect(result.outcomes[0].verdict).toBeUndefined();
    expect(result.warnings.some((w) => w.toLowerCase().includes("verif"))).toBe(true);
  });

  it("ambiguous output containing BOTH PASS and FAIL with neither leading leaves verdict undefined", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(JSON.stringify({ subtasks: [{ id: "1", prompt: "Step 1" }] }), 0.01)]],
      ["worker", [ok("W1", 0.002)]],
      ["verifier", [ok("This could go either way: PASS on some criteria, FAIL on others.", 0.001)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("task", invoker, { verifyWorkers: true });

    expect(result.outcomes[0].verdict).toBeUndefined();
  });

  it("still parses a JSON verdict object ({\"ok\":true}) even without a leading PASS/FAIL token", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(JSON.stringify({ subtasks: [{ id: "1", prompt: "Step 1" }] }), 0.01)]],
      ["worker", [ok("W1", 0.002)]],
      ["verifier", [ok('{"ok": true, "notes": "looks fine"}', 0.001)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("task", invoker, { verifyWorkers: true });

    expect(result.outcomes[0].verdict?.ok).toBe(true);
  });
});

describe("runOrchestration — adaptive verify gate (V5)", () => {
  it("verifyWorkers:false, adaptiveVerify:false → verifier never invoked even with a confidence fn", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const invoker = buildMockInvoker(responses);
    const confidence = vi.fn(() => "escalate-frontier" as const);

    const result = await runOrchestration("task", invoker, {}, { confidence });

    expect(confidence).not.toHaveBeenCalled();
    expect(result.outcomes.every((o) => o.verdict === undefined)).toBe(true);
  });

  it("adaptiveVerify:true, recommendation delegate-local → verifier skipped (trust)", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const invoker = buildMockInvoker(responses);
    const confidence = vi.fn(() => "delegate-local" as const);

    const result = await runOrchestration(
      "task",
      invoker,
      { adaptiveVerify: true },
      { confidence },
    );

    expect(confidence).toHaveBeenCalled();
    expect(result.outcomes.every((o) => o.verdict === undefined)).toBe(true);
  });

  it("adaptiveVerify:true, recommendation escalate-frontier → verifier runs", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["verifier", [ok("PASS"), ok("PASS"), ok("PASS")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const invoker = buildMockInvoker(responses);
    const confidence = vi.fn(() => "escalate-frontier" as const);

    const result = await runOrchestration(
      "task",
      invoker,
      { adaptiveVerify: true },
      { confidence },
    );

    expect(result.outcomes.every((o) => o.verdict?.ok === true)).toBe(true);
  });

  it("adaptiveVerify:true, confidence returns null (unknown) → verifier runs", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["verifier", [ok("PASS"), ok("PASS"), ok("PASS")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const invoker = buildMockInvoker(responses);
    const confidence = vi.fn(() => null);

    const result = await runOrchestration(
      "task",
      invoker,
      { adaptiveVerify: true },
      { confidence },
    );

    expect(result.outcomes.every((o) => o.verdict?.ok === true)).toBe(true);
  });

  it("verifyWorkers:true overrides adaptiveVerify — always verifies regardless of confidence", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["verifier", [ok("PASS"), ok("PASS"), ok("PASS")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const invoker = buildMockInvoker(responses);
    const confidence = vi.fn(() => "delegate-local" as const);

    const result = await runOrchestration(
      "task",
      invoker,
      { verifyWorkers: true, adaptiveVerify: true },
      { confidence },
    );

    expect(result.outcomes.every((o) => o.verdict?.ok === true)).toBe(true);
  });
});

describe("runOrchestration — verified-fail outputs excluded from synthesis (V6)", () => {
  it("a subtask with an explicit failed verdict is excluded from the synthesizer input + warned", async () => {
    // 3 subtasks so 2 survivors still trigger a real synth call (a lone
    // survivor takes the "skip synth to save cost" path instead).
    let synthPrompt = "";
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("GOOD_OUTPUT_1"), ok("GOOD_OUTPUT_2"), ok("BAD_OUTPUT")]],
      ["verifier", [ok("PASS"), ok("PASS"), ok("FAIL - wrong")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const invoker = buildMockInvoker(responses, (role, prompt) => {
      if (role === "synthesizer") synthPrompt = prompt;
    });

    const result = await runOrchestration("task", invoker, { verifyWorkers: true });

    expect(result.ok).toBe(true);
    expect(synthPrompt).toContain("GOOD_OUTPUT_1");
    expect(synthPrompt).toContain("GOOD_OUTPUT_2");
    expect(synthPrompt).not.toContain("BAD_OUTPUT");
    expect(result.warnings.some((w) => w.toLowerCase().includes("verif"))).toBe(true);
  });

  it("ALL successful outputs fail verification → included anyway with a warning (degraded beats none)", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["verifier", [ok("FAIL - a"), ok("FAIL - b"), ok("FAIL - c")]],
      ["synthesizer", [ok("Final synth")]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("task", invoker, { verifyWorkers: true });

    expect(result.ok).toBe(true);
    expect(result.finalOutput).toBe("Final synth");
    expect(
      result.warnings.some((w) => w.toLowerCase().includes("failed verification")),
    ).toBe(true);
  });

  it("single-strategy plan whose sole outcome fails verification still returns that output (no empty synthesis)", async () => {
    const invoker = buildMockInvoker(
      new Map<OrchestratorRole, WorkerResult[]>([
        ["planner", [ok("not valid json")]],
        ["worker", [ok("Solo output")]],
        ["verifier", [ok("FAIL - bad")]],
      ]),
    );

    const result = await runOrchestration("task", invoker, { verifyWorkers: true });

    expect(result.ok).toBe(true);
    expect(result.finalOutput).toBe("Solo output");
  });
});

describe("runOrchestration — modelCalls ledger (savings tracker S1)", () => {
  it("fanout run records planner + N workers + synth", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1", 0.002), ok("W2", 0.003), ok("W3", 0.004)]],
      ["synthesizer", [ok("Final", 0.005)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Do a complex task", invoker, { maxSubtasks: 12 });

    expect(result.modelCalls).toHaveLength(5); // planner + 3 workers + synth
    const roles = result.modelCalls.map((c) => c.role);
    expect(roles[0]).toBe("planner");
    expect(roles[roles.length - 1]).toBe("synthesizer");
    expect(roles.filter((r) => r === "worker")).toHaveLength(3);
    expect(result.modelCalls.every((c) => c.ok === true)).toBe(true);
    expect(result.modelCalls[0]).toMatchObject({
      role: "planner",
      provider: "openrouter",
      model: "m",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.01,
      latencyMs: 5,
    });
  });

  it("verify-enabled run records verifier calls in modelCalls", async () => {
    const PLAN_2 = JSON.stringify({
      subtasks: [
        { id: "1", prompt: "Step 1" },
        { id: "2", prompt: "Step 2" },
      ],
    });
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(PLAN_2, 0.01)]],
      ["worker", [ok("W1", 0.002), ok("W2", 0.003)]],
      ["verifier", [ok("PASS", 0.001), ok("PASS", 0.001)]],
      ["synthesizer", [ok("Final", 0.002)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Verify task", invoker, { verifyWorkers: true });

    const verifierCalls = result.modelCalls.filter((c) => c.role === "verifier");
    expect(verifierCalls).toHaveLength(2);
    expect(verifierCalls.every((c) => c.ok === true)).toBe(true);
  });

  it("worker and verifier calls carry the subtaskId they were spent on; planner/synth do not (issue #144)", async () => {
    const PLAN_2 = JSON.stringify({
      subtasks: [
        { id: "sub-a", prompt: "Step A" },
        { id: "sub-b", prompt: "Step B" },
      ],
    });
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(PLAN_2, 0.01)]],
      ["worker", [ok("W1", 0.002), ok("W2", 0.003)]],
      ["verifier", [ok("PASS", 0.001), ok("FAIL", 0.001)]],
      ["synthesizer", [ok("Final", 0.002)]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Attribute costs", invoker, { verifyWorkers: true });

    const workerIds = result.modelCalls.filter((c) => c.role === "worker").map((c) => c.subtaskId);
    expect(workerIds.sort()).toEqual(["sub-a", "sub-b"]);
    const verifierIds = result.modelCalls
      .filter((c) => c.role === "verifier")
      .map((c) => c.subtaskId);
    expect(verifierIds.sort()).toEqual(["sub-a", "sub-b"]);
    for (const call of result.modelCalls.filter((c) => c.role === "planner" || c.role === "synthesizer")) {
      expect(call.subtaskId).toBeUndefined();
    }
  });

  it("failed calls are recorded with ok:false and null tokens/cost", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [fail("err1"), fail("err2"), fail("err3")]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Doomed task", invoker);

    expect(result.ok).toBe(false);
    const workerCalls = result.modelCalls.filter((c) => c.role === "worker");
    expect(workerCalls).toHaveLength(3);
    expect(workerCalls.every((c) => c.ok === false)).toBe(true);
    expect(workerCalls.every((c) => c.inputTokens === null && c.outputTokens === null && c.costUsd === null)).toBe(
      true,
    );
  });

  it("the early-return 'all workers failed' path still returns the modelCalls recorded so far (planner + workers, no synth)", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [fail("err1"), fail("err2"), fail("err3")]],
    ]);
    const invoker = buildMockInvoker(responses);

    const result = await runOrchestration("Doomed task", invoker);

    expect(result.modelCalls).toHaveLength(4); // planner + 3 failed workers
    expect(result.modelCalls.some((c) => c.role === "synthesizer")).toBe(false);
  });
});

describe("runOrchestration — concurrency cap", () => {
  it("6 subtasks with maxConcurrency:2 — no more than 2 in-flight simultaneously", async () => {
    const PLAN_6 = JSON.stringify({
      subtasks: Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), prompt: `Step ${i + 1}` })),
    });

    let inFlight = 0;
    let maxInFlight = 0;

    const workerResults: WorkerResult[] = Array.from({ length: 6 }, (_, i) =>
      ok(`W${i + 1}`, 0.001),
    );

    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(PLAN_6, 0.01)]],
      ["worker", workerResults],
      ["synthesizer", [ok("Final", 0.002)]],
    ]);

    const counters = new Map<OrchestratorRole, number>();
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: OrchestratorRole, _prompt: string) => {
        const queue = responses.get(role) ?? [];
        const idx = counters.get(role) ?? 0;
        counters.set(role, idx + 1);

        if (role === "worker") {
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          // Simulate async work
          await new Promise<void>((res) => setImmediate(res));
          inFlight--;
        }
        return queue[idx] ?? fail("no result");
      }),
    };

    await runOrchestration("Concurrent task", invoker, { maxConcurrency: 2, maxSubtasks: 6 });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Homeserver-specific fanout cap (issue #157)
// ---------------------------------------------------------------------------

describe("runOrchestration — homeserver fanout concurrency cap (issue #157)", () => {
  const PLAN_5 = JSON.stringify({
    subtasks: Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), prompt: `Step ${i + 1}` })),
  });

  function buildInFlightTracker(workerCount: number) {
    let inFlight = 0;
    let maxInFlight = 0;
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(PLAN_5, 0.01)]],
      ["worker", Array.from({ length: workerCount }, (_, i) => ok(`W${i + 1}`, 0.001))],
      ["synthesizer", [ok("Final", 0.002)]],
    ]);
    const counters = new Map<OrchestratorRole, number>();
    const invoker: ModelInvoker = {
      invoke: vi.fn(async (role: OrchestratorRole) => {
        const queue = responses.get(role) ?? [];
        const idx = counters.get(role) ?? 0;
        counters.set(role, idx + 1);
        if (role === "worker") {
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await new Promise<void>((res) => setImmediate(res));
          inFlight--;
        }
        return queue[idx] ?? fail("no result");
      }),
    };
    return { invoker, getMaxInFlight: () => maxInFlight };
  }

  it("caps homeserver-bound workers at homeserverMaxConcurrency even when maxConcurrency is higher", async () => {
    const { invoker, getMaxInFlight } = buildInFlightTracker(5);

    await runOrchestration("M5 fanout", invoker, {
      roles: {
        ...DEFAULT_ORCHESTRATOR_CONFIG.roles,
        worker: { provider: "homeserver", model: "qwen3-coder-next-80b" },
      },
      maxConcurrency: 4,
      homeserverMaxConcurrency: 2,
      maxSubtasks: 6,
    });

    expect(getMaxInFlight()).toBeLessThanOrEqual(2);
    expect(getMaxInFlight()).toBeGreaterThanOrEqual(1);
  });

  it("homeserverMaxConcurrency defaults to 2", () => {
    expect(DEFAULT_ORCHESTRATOR_CONFIG.homeserverMaxConcurrency).toBe(2);
  });

  it("supports fully serial homeserver fanout (homeserverMaxConcurrency: 1)", async () => {
    const { invoker, getMaxInFlight } = buildInFlightTracker(5);

    await runOrchestration("M5 serial fanout", invoker, {
      roles: {
        ...DEFAULT_ORCHESTRATOR_CONFIG.roles,
        worker: { provider: "homeserver", model: "mellum" },
      },
      maxConcurrency: 4,
      homeserverMaxConcurrency: 1,
      maxSubtasks: 6,
    });

    expect(getMaxInFlight()).toBe(1);
  });

  it("does not throttle cloud-bound workers below maxConcurrency", async () => {
    const { invoker, getMaxInFlight } = buildInFlightTracker(5);

    await runOrchestration("cloud fanout", invoker, {
      roles: {
        ...DEFAULT_ORCHESTRATOR_CONFIG.roles,
        worker: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
      },
      maxConcurrency: 4,
      homeserverMaxConcurrency: 1,
      maxSubtasks: 6,
    });

    expect(getMaxInFlight()).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Degraded-coverage surfacing (issue #157)
// ---------------------------------------------------------------------------

describe("runOrchestration — degraded coverage when workers never ran (issue #157)", () => {
  it("a partial failure pushes a warning naming the failed subtask and its exact error", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      [
        "worker",
        [
          ok("W1", 0.002),
          fail("HTTP 503 server_busy retryAfterS=5 — gave up after 6 attempts"),
          ok("W3", 0.004),
        ],
      ],
      ["synthesizer", [ok("Merged", 0.005)]],
    ]);
    const result = await runOrchestration("task", buildMockInvoker(responses));

    expect(result.ok).toBe(true);
    const coverageWarnings = result.warnings.filter((w) =>
      w.toLowerCase().includes("coverage"),
    );
    expect(coverageWarnings.length).toBe(1);
    expect(coverageWarnings[0]).toContain("[2]");
    expect(coverageWarnings[0]).toContain("HTTP 503 server_busy retryAfterS=5");
  });

  it("the synthesizer prompt is told which planned subtasks never ran", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1", 0.002), fail("HTTP 503 server_busy"), ok("W3", 0.004)]],
      ["synthesizer", [ok("Merged", 0.005)]],
    ]);
    let synthPrompt = "";
    const invoker = buildMockInvoker(responses, (role, prompt) => {
      if (role === "synthesizer") synthPrompt = prompt;
    });

    await runOrchestration("task", invoker);

    expect(synthPrompt.toLowerCase()).toContain("degraded");
    expect(synthPrompt).toContain("Subtask 2");
  });

  it("no degraded-coverage warning when every worker ran", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), ok("W2"), ok("W3")]],
      ["synthesizer", [ok("Final")]],
    ]);
    const result = await runOrchestration("task", buildMockInvoker(responses));
    expect(result.warnings.filter((w) => w.toLowerCase().includes("coverage"))).toEqual([]);
    expect(result.finalOutput).toBe("Final");
  });

  // Codex review of #157: the degraded-coverage signal must live in the final
  // output ITSELF on every path — not only in warnings/synth prompt. The
  // synth-skip (single survivor) and synth-failure fallback paths bypass the
  // synthesizer prompt entirely, and structured-result consumers read
  // finalOutput as resultText.
  it("synthesis skipped (single survivor): finalOutput carries a deterministic degraded-coverage notice", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      [
        "worker",
        [
          ok("Only survivor", 0.002),
          fail("HTTP 503 server_busy retryAfterS=5"),
          fail("HTTP 503 server_busy retryAfterS=5"),
        ],
      ],
      // no synthesizer response queued — the single-survivor path must not call it
    ]);
    const result = await runOrchestration("task", buildMockInvoker(responses));

    expect(result.ok).toBe(true);
    expect(result.finalOutput).toContain("Only survivor");
    expect(result.finalOutput.toLowerCase()).toContain("degraded");
    expect(result.finalOutput).toContain("[2]");
    expect(result.finalOutput).toContain("[3]");
    expect(result.finalOutput).toContain("HTTP 503 server_busy retryAfterS=5");
  });

  it("synthesizer-failure fallback: the concatenated output carries the degraded-coverage notice", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), fail("HTTP 503 server_busy"), ok("W3")]],
      ["synthesizer", [fail("synthesizer model error")]],
    ]);
    const result = await runOrchestration("task", buildMockInvoker(responses));

    expect(result.ok).toBe(true);
    expect(result.finalOutput).toContain("W1");
    expect(result.finalOutput).toContain("W3");
    expect(result.finalOutput.toLowerCase()).toContain("degraded");
    expect(result.finalOutput).toContain("[2]");
  });

  it("successful synthesis with failures: the notice is appended deterministically too", async () => {
    const responses = new Map<OrchestratorRole, WorkerResult[]>([
      ["planner", [ok(VALID_PLAN_3, 0.01)]],
      ["worker", [ok("W1"), fail("HTTP 503 server_busy"), ok("W3")]],
      ["synthesizer", [ok("Merged")]],
    ]);
    const result = await runOrchestration("task", buildMockInvoker(responses));

    expect(result.ok).toBe(true);
    expect(result.finalOutput).toContain("Merged");
    expect(result.finalOutput.toLowerCase()).toContain("degraded");
    expect(result.finalOutput).toContain("[2]");
  });
});
