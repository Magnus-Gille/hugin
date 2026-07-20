import { describe, expect, it } from "vitest";
import {
  HARNESS_LANE_ELIGIBLE_TASK_TYPES,
  HARNESS_LANE_FRACTION_ENV,
  decideHarnessLane,
  isHarnessLaneEligibleTaskType,
} from "../src/harness-lane-sampler.js";

const ELIGIBLE_TYPE = "code-edit";
const INELIGIBLE_TYPE = "extract";

describe("isHarnessLaneEligibleTaskType", () => {
  it("marks bounded multi-file code-edit task types eligible", () => {
    for (const taskType of HARNESS_LANE_ELIGIBLE_TASK_TYPES) {
      expect(isHarnessLaneEligibleTaskType(taskType)).toBe(true);
    }
  });

  it("excludes one-shot judgment/extraction task types", () => {
    for (const taskType of ["extract", "classify", "qa-factual", "summarize", "rewrite", "translate"]) {
      expect(isHarnessLaneEligibleTaskType(taskType)).toBe(false);
    }
  });
});

describe("decideHarnessLane — eligibility filter", () => {
  it("always resolves an ineligible task type to one-shot, even at fraction 1", () => {
    const decision = decideHarnessLane(
      { taskId: "task-1", taskType: INELIGIBLE_TYPE },
      { env: { [HARNESS_LANE_FRACTION_ENV]: "1" } },
    );
    expect(decision.lane).toBe("one-shot");
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("not-eligible-task-type");
    expect(decision.fraction).toBe(0);
  });
});

describe("decideHarnessLane — default/absent env", () => {
  it("defaults to one-shot when the env var is entirely absent", () => {
    const decision = decideHarnessLane({ taskId: "task-1", taskType: ELIGIBLE_TYPE }, { env: {} });
    expect(decision.lane).toBe("one-shot");
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe("fraction-zero-or-absent");
    expect(decision.fraction).toBe(0);
  });

  it("defaults to one-shot when the env var is explicitly \"0\"", () => {
    const decision = decideHarnessLane(
      { taskId: "task-1", taskType: ELIGIBLE_TYPE },
      { env: { [HARNESS_LANE_FRACTION_ENV]: "0" } },
    );
    expect(decision.lane).toBe("one-shot");
    expect(decision.reason).toBe("fraction-zero-or-absent");
  });

  it("defaults to one-shot when the env var is blank", () => {
    const decision = decideHarnessLane(
      { taskId: "task-1", taskType: ELIGIBLE_TYPE },
      { env: { [HARNESS_LANE_FRACTION_ENV]: "   " } },
    );
    expect(decision.lane).toBe("one-shot");
    expect(decision.reason).toBe("fraction-zero-or-absent");
  });

  it("never samples into harness lane across a keyspace when off", () => {
    for (let i = 0; i < 500; i += 1) {
      const decision = decideHarnessLane({ taskId: `task-${i}`, taskType: ELIGIBLE_TYPE }, { env: {} });
      expect(decision.lane).toBe("one-shot");
    }
  });
});

describe("decideHarnessLane — determinism", () => {
  it("the same task key always yields the same lane, repeatedly", () => {
    const env = { [HARNESS_LANE_FRACTION_ENV]: "0.5" };
    const first = decideHarnessLane({ taskId: "task-42", taskType: ELIGIBLE_TYPE }, { env });
    for (let i = 0; i < 20; i += 1) {
      const again = decideHarnessLane({ taskId: "task-42", taskType: ELIGIBLE_TYPE }, { env });
      expect(again.lane).toBe(first.lane);
      expect(again.keyDigestHex).toBe(first.keyDigestHex);
    }
  });

  it("is reproducible across independent processes (no hidden shared state)", () => {
    const env = { [HARNESS_LANE_FRACTION_ENV]: "0.3" };
    const keys = Array.from({ length: 50 }, (_, i) => `reproducible-${i}`);
    const firstPass = keys.map((taskId) => decideHarnessLane({ taskId, taskType: ELIGIBLE_TYPE }, { env }).lane);
    const secondPass = keys.map((taskId) => decideHarnessLane({ taskId, taskType: ELIGIBLE_TYPE }, { env }).lane);
    expect(secondPass).toEqual(firstPass);
  });

  it("different task ids do not all collapse onto the same lane", () => {
    const env = { [HARNESS_LANE_FRACTION_ENV]: "0.5" };
    const lanes = new Set(
      Array.from({ length: 100 }, (_, i) =>
        decideHarnessLane({ taskId: `distinct-${i}`, taskType: ELIGIBLE_TYPE }, { env }).lane),
    );
    expect(lanes.size).toBe(2);
  });
});

describe("decideHarnessLane — fraction respected across a keyspace", () => {
  it("samples roughly the configured fraction into the harness lane at 10%", () => {
    const env = { [HARNESS_LANE_FRACTION_ENV]: "0.1" };
    const total = 4000;
    let harnessCount = 0;
    for (let i = 0; i < total; i += 1) {
      const decision = decideHarnessLane({ taskId: `key-${i}`, taskType: ELIGIBLE_TYPE }, { env });
      if (decision.lane === "harness") harnessCount += 1;
    }
    const rate = harnessCount / total;
    // Statistical tolerance, not an exact match — this is a hash-derived
    // sample, not a precise counter.
    expect(rate).toBeGreaterThan(0.07);
    expect(rate).toBeLessThan(0.13);
  });

  it("samples ~100% into the harness lane at fraction 1", () => {
    const env = { [HARNESS_LANE_FRACTION_ENV]: "1" };
    for (let i = 0; i < 200; i += 1) {
      const decision = decideHarnessLane({ taskId: `all-${i}`, taskType: ELIGIBLE_TYPE }, { env });
      expect(decision.lane).toBe("harness");
      expect(decision.reason).toBe("sampled-harness");
    }
  });
});

describe("decideHarnessLane — sampler malfunction", () => {
  it("falls back to one-shot on a non-numeric fraction env value", () => {
    const decision = decideHarnessLane(
      { taskId: "task-1", taskType: ELIGIBLE_TYPE },
      { env: { [HARNESS_LANE_FRACTION_ENV]: "not-a-number" } },
    );
    expect(decision.lane).toBe("one-shot");
    expect(decision.reason).toBe("sampler-malfunction");
    expect(decision.malfunctionDetail).toMatch(/not a finite number/);
  });

  it("falls back to one-shot on an out-of-range fraction env value", () => {
    for (const raw of ["-0.1", "1.5", "100"]) {
      const decision = decideHarnessLane(
        { taskId: "task-1", taskType: ELIGIBLE_TYPE },
        { env: { [HARNESS_LANE_FRACTION_ENV]: raw } },
      );
      expect(decision.lane).toBe("one-shot");
      expect(decision.reason).toBe("sampler-malfunction");
      expect(decision.malfunctionDetail).toMatch(/outside the valid \[0, 1\] range/);
    }
  });

  it("falls back to one-shot when the digest function itself throws", () => {
    const decision = decideHarnessLane(
      { taskId: "task-1", taskType: ELIGIBLE_TYPE },
      {
        env: { [HARNESS_LANE_FRACTION_ENV]: "0.5" },
        digest: () => {
          throw new Error("simulated hash backend failure");
        },
      },
    );
    expect(decision.lane).toBe("one-shot");
    expect(decision.reason).toBe("sampler-malfunction");
    expect(decision.malfunctionDetail).toMatch(/simulated hash backend failure/);
    expect(decision.keyDigestHex).toBe("");
  });

  it("falls back to one-shot when the digest function returns unusable output", () => {
    const decision = decideHarnessLane(
      { taskId: "task-1", taskType: ELIGIBLE_TYPE },
      {
        env: { [HARNESS_LANE_FRACTION_ENV]: "0.5" },
        digest: () => "not-hex!!",
      },
    );
    expect(decision.lane).toBe("one-shot");
    expect(decision.reason).toBe("sampler-malfunction");
  });

  it("never throws out of decideHarnessLane itself", () => {
    expect(() =>
      decideHarnessLane(
        { taskId: "task-1", taskType: ELIGIBLE_TYPE },
        { env: { [HARNESS_LANE_FRACTION_ENV]: "NaN" }, digest: () => {
          throw new Error("boom");
        } },
      ),
    ).not.toThrow();
  });
});
