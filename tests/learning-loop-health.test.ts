import { describe, expect, it } from "vitest";
import {
  computeCapabilityPlane,
  computeProductPlane,
  deriveRoutePolicy,
  buildLearningLoopPanels,
  type ProductTaskEvidence,
} from "../src/learning-loop-health.js";
import type { Ledger } from "../src/orchestrator/ledger-client.js";

const ledger = (rows: Partial<Ledger["report"][number]>[]): Ledger => ({
  report: rows.map((r) => ({
    taskType: "extract", modelId: "mellum", verdict: "unknown",
    attempts: 0, passes: 0, fails: 0, errors: 0, successRate: 0,
    frozen: false, recommendation: "explore",
    ...r,
  })) as Ledger["report"],
});

const task = (o: Partial<ProductTaskEvidence> = {}): ProductTaskEvidence => ({
  taskId: "t1", lifecycle: "completed", submitter: "claude-code",
  rating: null, verificationOutcome: null, durableHandoff: false,
  ...o,
});

describe("computeCapabilityPlane (M5 evidence)", () => {
  it("reports no signal when the ledger is unreachable — never a fabricated zero", () => {
    const plane = computeCapabilityPlane(null);
    expect(plane.available).toBe(false);
    expect(plane.evidenceArriving).toBe(false);
    expect(plane.rows).toEqual([]);
  });

  // #164: "Show denominators and sample maturity; no percentage without n."
  it("emits a null quality rate when there are no VERIFIED samples", () => {
    const plane = computeCapabilityPlane(
      ledger([{ taskType: "extract", modelId: "mellum", attempts: 12, passes: 0, fails: 0, errors: 0 }])
    );
    const row = plane.rows[0]!;
    expect(row.attempts).toBe(12);
    expect(row.verifiedSamples).toBe(0);
    expect(row.qualityRate).toBeNull(); // 12 attempts, ZERO verified — no percentage
    expect(row.maturity).toBe("unverified");
    expect(plane.evidenceArriving).toBe(true); // calls are happening...
    expect(plane.actionable).toBe(false); // ...but nothing is strong enough to act on
  });

  it("computes a quality rate only from verified pass/fail, excluding infra errors", () => {
    const plane = computeCapabilityPlane(
      ledger([{ attempts: 20, passes: 8, fails: 2, errors: 5 }])
    );
    const row = plane.rows[0]!;
    expect(row.verifiedSamples).toBe(10); // 8 + 2 — errors are NOT quality signal
    expect(row.qualityRate).toBe(0.8);
    expect(row.maturity).toBe("verified");
    expect(plane.actionable).toBe(true);
  });

  it("marks a never-attempted row aspirational, not failing", () => {
    const plane = computeCapabilityPlane(ledger([{ attempts: 0 }]));
    expect(plane.rows[0]!.maturity).toBe("aspirational");
    expect(plane.evidenceArriving).toBe(false);
  });
});

describe("deriveRoutePolicy", () => {
  // #164: "Show at least one explainable route change caused by verified
  // evidence, or explicitly state that routing is still shadow/manual."
  it("states plainly that routing is shadow when the gateway policy is in shadow mode", () => {
    const policy = deriveRoutePolicy(
      [task({ delegation: { policyMode: "shadow", policyAction: "shadow", priceCatalogVersion: "2026-07-08" } })],
      computeCapabilityPlane(ledger([{ attempts: 20, passes: 8, fails: 2 }]))
    );
    expect(policy.policyMode).toBe("shadow");
    expect(policy.priceCatalogVersion).toBe("2026-07-08");
    expect(policy.evidenceDrivenRouteChange).toBe(false);
    expect(policy.explanation).toMatch(/shadow/i);
  });

  it("reports an evidence-driven route change once the policy actually enforces on verified evidence", () => {
    const policy = deriveRoutePolicy(
      [task({ delegation: { policyMode: "enforce", policyAction: "delegate-local" } })],
      computeCapabilityPlane(ledger([{ attempts: 20, passes: 18, fails: 2, recommendation: "delegate-local" }]))
    );
    expect(policy.evidenceDrivenRouteChange).toBe(true);
    expect(policy.explanation).toMatch(/delegate-local/);
  });

  it("does not claim an evidence-driven change when the policy enforces but no verified evidence backs it", () => {
    const policy = deriveRoutePolicy(
      [task({ delegation: { policyMode: "enforce", policyAction: "delegate-local" } })],
      computeCapabilityPlane(ledger([{ attempts: 20, passes: 0, fails: 0 }])) // all unverified
    );
    expect(policy.evidenceDrivenRouteChange).toBe(false);
  });

  it("reports unknown policy rather than guessing when no task carries provenance", () => {
    const policy = deriveRoutePolicy([task()], computeCapabilityPlane(null));
    expect(policy.policyMode).toBeNull();
    expect(policy.explanation).toMatch(/no route-policy provenance/i);
  });
});

describe("computeProductPlane (#165 trial gate)", () => {
  it("counts substantive tasks and distinct producers", () => {
    const plane = computeProductPlane([
      task({ taskId: "a", submitter: "claude-code" }),
      task({ taskId: "b", submitter: "claude-code" }),
      task({ taskId: "c", submitter: "codex-cli" }),
    ]);
    expect(plane.substantiveTasks).toBe(3);
    expect(plane.producers).toEqual(["claude-code", "codex-cli"]);
  });

  it("emits a null useful rate when nothing has been rated — no percentage without n", () => {
    const plane = computeProductPlane([task({ rating: null }), task({ taskId: "b", rating: null })]);
    expect(plane.substantiveTasks).toBe(2);
    expect(plane.ratedTasks).toBe(0);
    expect(plane.usefulRate).toBeNull();
    const useful = plane.criteria.find((c) => c.id === "useful-completion")!;
    expect(useful.state).toBe("not-instrumented"); // unrated ≠ unuseful
  });

  it("treats pass and partial as useful, redo and wrong as rescue/redo", () => {
    const plane = computeProductPlane([
      task({ taskId: "a", rating: "pass" }),
      task({ taskId: "b", rating: "partial" }),
      task({ taskId: "c", rating: "redo" }),
      task({ taskId: "d", rating: "wrong" }),
    ]);
    expect(plane.ratedTasks).toBe(4);
    expect(plane.usefulTasks).toBe(2);
    expect(plane.usefulRate).toBe(0.5);
    expect(plane.rescueRedo).toBe(2);
  });

  it("counts durable handoffs — the criterion that proves the DURABLE broker earns its keep", () => {
    const plane = computeProductPlane([
      task({ taskId: "a", durableHandoff: true }),
      task({ taskId: "b", durableHandoff: true }),
      task({ taskId: "c", durableHandoff: false }),
    ]);
    expect(plane.durableHandoffs).toBe(2);
    const c = plane.criteria.find((x) => x.id === "durable-handoff")!;
    expect(c.observed).toBe(2);
    expect(c.target).toBe(5);
    expect(c.state).toBe("not-met"); // 2 < 5
  });

  it("marks the gate met once the thresholds are cleared", () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ taskId: `t${i}`, submitter: i % 2 ? "codex-cli" : "claude-code", rating: "pass", durableHandoff: i < 5 })
    );
    const plane = computeProductPlane(tasks);
    const byId = Object.fromEntries(plane.criteria.map((c) => [c.id, c]));
    expect(byId["substantive-tasks"]!.state).toBe("met"); // 10 >= 10
    expect(byId["producers"]!.state).toBe("met"); // 2 >= 2
    expect(byId["useful-completion"]!.state).toBe("met"); // 100% >= 70%
    expect(byId["durable-handoff"]!.state).toBe("met"); // 5 >= 5
  });

  // The honesty requirement: metrics with no data source must say so, never
  // render as a satisfied zero.
  it("marks uninstrumented gate criteria explicitly instead of reporting a flattering zero", () => {
    const plane = computeProductPlane([task()]);
    const byId = Object.fromEntries(plane.criteria.map((c) => [c.id, c]));
    for (const id of ["maintenance-time", "incidents"]) {
      expect(byId[id]!.state).toBe("not-instrumented");
      expect(byId[id]!.observed).toBeNull();
      expect(byId[id]!.note).toBeTruthy();
    }
  });
});

describe("buildLearningLoopPanels", () => {
  it("keeps the two evidence planes separate rather than collapsing them into one verdict", () => {
    const panels = buildLearningLoopPanels({
      capability: computeCapabilityPlane(ledger([{ attempts: 20, passes: 8, fails: 2 }])),
      product: computeProductPlane([task({ rating: "pass", durableHandoff: true })]),
      policy: deriveRoutePolicy([task({ delegation: { policyMode: "shadow" } })], computeCapabilityPlane(null)),
    });
    const ids = panels.map((p) => p.id);
    expect(ids).toContain("hugin-capability-evidence");
    expect(ids).toContain("hugin-trial-gate");
    expect(ids).toContain("hugin-route-policy");
    // No panel claims a single fused "learning loop is healthy" verdict.
    expect(ids).not.toContain("hugin-learning-loop");
  });

  it("emits only Heimdall's typed-panel kinds, so no Heimdall code change is needed", () => {
    const panels = buildLearningLoopPanels({
      capability: computeCapabilityPlane(null),
      product: computeProductPlane([]),
      policy: deriveRoutePolicy([], computeCapabilityPlane(null)),
    });
    for (const p of panels) {
      expect(["stat", "timeseries", "table", "status"]).toContain(p.kind);
    }
  });

  // Real M5 ledger returns 106 rows — unusable on a dashboard. Cap it, but
  // DISCLOSE the cap: a silently truncated table reads as "this is everything".
  it("ranks and caps the capability table, disclosing what it dropped", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      taskType: `type-${i}`, modelId: "m", attempts: i, passes: i, fails: 0,
    }));
    const panels = buildLearningLoopPanels({
      capability: computeCapabilityPlane(ledger(many)),
      product: computeProductPlane([]),
      policy: deriveRoutePolicy([], computeCapabilityPlane(null)),
    });
    const table = panels.find((p) => p.id === "hugin-capability-evidence")!;
    const rows = table.rows as string[][];
    expect(rows.length).toBeLessThanOrEqual(16); // 15 rows + 1 disclosure row
    // Ranked: the most-evidenced row leads, not an arbitrary one.
    expect(rows[0]![0]).toBe("type-39");
    // The drop is stated, not hidden.
    expect(JSON.stringify(rows)).toMatch(/25 more/);
  });

  it("is content-blind — no prompt or result text can reach the panel", () => {
    const panels = buildLearningLoopPanels({
      capability: computeCapabilityPlane(ledger([{ attempts: 1, passes: 1 }])),
      product: computeProductPlane([task({ rating: "pass" })]),
      policy: deriveRoutePolicy([], computeCapabilityPlane(null)),
    });
    const serialized = JSON.stringify(panels);
    expect(serialized).not.toMatch(/prompt|bodyText|secret/i);
  });
});
