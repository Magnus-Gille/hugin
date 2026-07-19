/**
 * Heimdall self-describe descriptor for the hugin service.
 *
 * Returned verbatim by GET /heimdall.json — no auth required, same posture as /health.
 * Schema: https://heimdall.gille.ai/schema/service/v1
 */

import type { Application } from "express";
import {
  buildLearningLoopPanels,
  computeCapabilityPlane,
  computeProductPlane,
  deriveRoutePolicy,
  type TypedPanel,
} from "./learning-loop-health.js";
import type { LearningLoopCollector } from "./learning-loop-collector.js";

export const HEIMDALL_DESCRIPTOR = {
  _schema: "https://heimdall.gille.ai/schema/service/v1",
  service: {
    name: "hugin",
    label: "Hugin",
    namespace: "grimnir",
    instance_id: "huginmunin",
    criticality: "normal",
  },
  kind: "http-service",
  status: "pass",
  version: "0.1.0",
  deploy: {
    host: "huginmunin",
    platform: "bare-metal",
  },
  metrics: [],
  // Tier-1 services own their panels: Heimdall's static known-panels fallback is
  // not consulted once /heimdall.json exists, so the task views must be declared
  // here (#135). Rendered live by Heimdall's plugins/hugin.js from the Munin DB.
  panels: [
    { id: "hugin-tasks", plugin: "hugin", view: "tasks", label: "Tasks", refresh: 60, fullWidth: true },
    { id: "hugin-history", plugin: "hugin", view: "history", label: "Task history", refresh: 120, fullWidth: true },
  ],
  alerts: { rules: [], active_count: 0, firing: [] },
  links: {
    repo: "https://github.com/Magnus-Gille/hugin",
  },
  ui: { icon: "cpu", category: "infra" },
} as const;

/**
 * Build the learning-loop health panels (#164) from collected evidence.
 *
 * These are Heimdall TYPED panels (`stat`/`table`/`status`), which Heimdall
 * renders natively with zero per-panel code — unlike the `plugin`/`view` panels
 * above, which require a matching renderer in the heimdall repo. That is what
 * keeps this a Hugin-only change.
 *
 * Fail-open: any collection failure yields honest "no evidence available"
 * panels rather than a broken descriptor.
 */
export function buildLearningLoopHealthPanels(
  collector: LearningLoopCollector
): TypedPanel[] {
  // Synchronous by design: `collect()` is stale-while-revalidate and returns
  // immediately. The descriptor must never wait on a cold corpus walk — hanging
  // /heimdall.json blanks Hugin's whole Heimdall page (#135).
  const {
    ledger,
    tasks,
    available,
    readFailures,
    truncated,
    experiments,
    experimentsAvailable,
    experimentsTruncated,
  } = collector.collect();
  const capability = computeCapabilityPlane(ledger);
  const product = computeProductPlane(tasks, { available, readFailures, truncated });
  const policy = deriveRoutePolicy(tasks, capability);
  return buildLearningLoopPanels({
    capability,
    product,
    policy,
    experiments: {
      available: experimentsAvailable,
      states: experiments,
      truncated: experimentsTruncated,
    },
  });
}

/**
 * Register the GET /heimdall.json route on the given Express app.
 * No auth required — same open posture as /health.
 *
 * When a collector is supplied, the learning-loop health panels (#164) are
 * appended to the static descriptor panels. The route NEVER fails on their
 * account: a collector error degrades to the static descriptor, because a
 * broken /heimdall.json would blank Hugin's whole Heimdall page (#135).
 */
export function registerHeimdallDescriptorRoute(
  app: Application,
  collector?: LearningLoopCollector
): void {
  app.get("/heimdall.json", (_req, res) => {
    if (!collector) {
      res.json(HEIMDALL_DESCRIPTOR);
      return;
    }
    try {
      const learningPanels = buildLearningLoopHealthPanels(collector);
      res.json({
        ...HEIMDALL_DESCRIPTOR,
        panels: [...HEIMDALL_DESCRIPTOR.panels, ...learningPanels],
      });
    } catch (err) {
      console.warn(
        `[heimdall] learning-loop panels unavailable, serving static descriptor: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      res.json(HEIMDALL_DESCRIPTOR);
    }
  });
}
