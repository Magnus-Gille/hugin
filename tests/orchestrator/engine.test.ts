import { describe, it, expect, vi } from "vitest";
import type { ModelInvoker } from "../../src/orchestrator/model-invoker.js";
import type { OrchestratorRole } from "../../src/orchestrator/plan.js";
import type { WorkerResult } from "../../src/orchestrator/worker-executor.js";
import { runOrchestration } from "../../src/orchestrator/engine.js";

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
  onInvoke?: (role: OrchestratorRole, prompt: string) => void,
): ModelInvoker {
  const counters = new Map<OrchestratorRole, number>();
  return {
    invoke: vi.fn(async (role: OrchestratorRole, prompt: string) => {
      onInvoke?.(role, prompt);
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
      // verifier called once per successful worker; only the 2nd is truncated
      ["verifier", [ok("PASS"), okTrunc("PA"), ok("PASS")]],
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
    expect(result.finalOutput).toBe("Merged output");
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
