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

  it("reports an evidence-driven route change once the policy enforces on evidence for THAT pair", () => {
    const policy = deriveRoutePolicy(
      [task({
        delegation: {
          policyMode: "enforce", policyAction: "delegate-local",
          modelId: "mellum", taskType: "extract",
        },
      })],
      computeCapabilityPlane(
        ledger([{ taskType: "extract", modelId: "mellum", attempts: 20, passes: 18, fails: 2, recommendation: "delegate-local" }])
      )
    );
    expect(policy.evidenceDrivenRouteChange).toBe(true);
    expect(policy.explanation).toMatch(/delegate-local/);
    expect(policy.explanation).toMatch(/extract×mellum/);
  });

  // Codex review: "any verified sample anywhere in the ledger" asserts a causal
  // link that was never established. The evidence must be evidence for THIS route.
  it("does not claim causation from verified evidence about a DIFFERENT model or task type", () => {
    const policy = deriveRoutePolicy(
      [task({
        delegation: {
          policyMode: "enforce", policyAction: "delegate-local",
          modelId: "mellum", taskType: "extract",
        },
      })],
      // Plenty of verified evidence — but all of it about a different pair.
      computeCapabilityPlane(
        ledger([{ taskType: "summarize", modelId: "gemma4", attempts: 50, passes: 50, fails: 0 }])
      )
    );
    expect(policy.evidenceDrivenRouteChange).toBe(false);
    expect(policy.explanation).toMatch(/no verified ledger evidence for that specific/i);
  });

  it("does not claim an evidence-driven change when the policy enforces but nothing is verified", () => {
    const policy = deriveRoutePolicy(
      [task({
        delegation: {
          policyMode: "enforce", policyAction: "delegate-local",
          modelId: "mellum", taskType: "extract",
        },
      })],
      computeCapabilityPlane(
        ledger([{ taskType: "extract", modelId: "mellum", attempts: 20, passes: 0, fails: 0 }])
      )
    );
    expect(policy.evidenceDrivenRouteChange).toBe(false);
  });

  it("picks the latest policy deterministically by time, not by array order", () => {
    const policy = deriveRoutePolicy(
      [
        task({ taskId: "new", updatedAt: "2026-07-12T00:00:00Z", delegation: { policyMode: "enforce" } }),
        task({ taskId: "old", updatedAt: "2026-01-01T00:00:00Z", delegation: { policyMode: "shadow" } }),
      ],
      computeCapabilityPlane(null)
    );
    expect(policy.policyMode).toBe("enforce"); // newest wins regardless of position
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

  // Codex review: a `partial` the human had to REWRITE or DISCARD is not a
  // useful completion — counting it as one would inflate the gate with exactly
  // the outcomes that prove the delegation failed.
  it("counts a partial as useful only when the human actually used it", () => {
    const plane = computeProductPlane([
      task({ taskId: "a", rating: "pass" }),
      task({ taskId: "b", rating: "partial", verificationOutcome: "minor_edit" }),
      task({ taskId: "c", rating: "partial", verificationOutcome: "major_rewrite" }),
      task({ taskId: "d", rating: "partial", verificationOutcome: "discarded" }),
      task({ taskId: "e", rating: "partial", verificationOutcome: "escalated_to_claude" }),
      task({ taskId: "f", rating: "redo" }),
      task({ taskId: "g", rating: "wrong" }),
    ]);
    expect(plane.ratedTasks).toBe(7);
    expect(plane.usefulTasks).toBe(2); // pass + minor_edit partial only
    expect(plane.rescueRedo).toBe(5); // rewritten/discarded/escalated partials count as rescue
  });

  // Only a completed task is a completed task.
  it("does not count pending, running or cancelled work as a completed task", () => {
    const plane = computeProductPlane([
      task({ taskId: "a", lifecycle: "completed" }),
      task({ taskId: "b", lifecycle: "running" }),
      task({ taskId: "c", lifecycle: "cancelled" }),
      task({ taskId: "d", lifecycle: "failed" }),
    ]);
    expect(plane.substantiveTasks).toBe(1);
  });

  // Codex review: a rate over a self-selected handful is a lie of selection.
  it("refuses to judge useful-completion from too thin a rating coverage", () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ taskId: `t${i}`, rating: i === 0 ? "pass" : null })
    );
    const plane = computeProductPlane(tasks);
    const useful = plane.criteria.find((c) => c.id === "useful-completion")!;
    // 1 rated pass out of 10 completed is NOT "100% useful, gate met".
    expect(useful.state).toBe("not-instrumented");
    expect(useful.note).toMatch(/coverage/i);
  });

  // Codex review: the corpus failing to load must not render as a measured zero.
  it("reports every count as unmeasured when the task corpus could not be read", () => {
    const plane = computeProductPlane([], { available: false });
    expect(plane.available).toBe(false);
    for (const c of plane.criteria) {
      expect(c.observed).toBeNull();
      expect(c.state).toBe("not-instrumented");
    }
    const subs = plane.criteria.find((c) => c.id === "substantive-tasks")!;
    expect(subs.note).toMatch(/unmeasured, NOT zero/i);
  });

  it("flags a partially-read corpus as a lower bound rather than a fact", () => {
    const plane = computeProductPlane([task()], {
      available: true, readFailures: 3, truncated: true,
    });
    const subs = plane.criteria.find((c) => c.id === "substantive-tasks")!;
    expect(subs.note).toMatch(/LOWER BOUND/);
    expect(subs.note).toMatch(/3 read failure/);
  });

  it("reports rescue/redo as a cost, never as a satisfied gate", () => {
    const plane = computeProductPlane([task({ rating: "pass" })]);
    const rescue = plane.criteria.find((c) => c.id === "rescue-redo")!;
    expect(rescue.state).toBe("informational"); // a count with no threshold cannot be "met"
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

  // THE consumer-contract test. Heimdall's normalizer
  // (heimdall src/contract/panel-data.js) keeps only rows passing
  //   isObj = v != null && typeof v === 'object' && !Array.isArray(v)
  // and SILENTLY DROPS the rest. An array-of-arrays table therefore renders
  // completely empty on the real dashboard while every local test passes —
  // which is exactly what happened until Codex cross-checked the consumer.
  // Replicate Heimdall's rule here so the contract can never silently rot again.
  it("emits table rows Heimdall will actually keep (objects, not arrays)", () => {
    const isObj = (v: unknown) => v != null && typeof v === "object" && !Array.isArray(v);

    const panels = buildLearningLoopPanels({
      capability: computeCapabilityPlane(ledger([{ attempts: 5, passes: 4, fails: 1 }])),
      product: computeProductPlane([task({ rating: "pass" })]),
      policy: deriveRoutePolicy([], computeCapabilityPlane(null)),
    });

    for (const panel of panels.filter((p) => p.kind === "table")) {
      const rows = panel.rows as unknown[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(isObj(row)).toBe(true); // an array row would be dropped by Heimdall
      }
      // Every row must key off the declared columns, or its cells vanish.
      const cols = panel.cols as string[];
      for (const row of rows as Record<string, string>[]) {
        for (const key of Object.keys(row)) expect(cols).toContain(key);
      }
    }
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
    const rows = table.rows as Record<string, string>[];
    expect(rows.length).toBeLessThanOrEqual(16); // 15 rows + 1 disclosure row
    // Ranked: the most-evidenced row leads, not an arbitrary one.
    expect(rows[0]!["Task type"]).toBe("type-39");
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
