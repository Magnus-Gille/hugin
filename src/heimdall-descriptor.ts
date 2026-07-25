/**
 * Heimdall self-describe descriptor for the hugin service.
 *
 * Returned verbatim by GET /heimdall.json — no auth required, same posture as /health.
 * Schema: https://heimdall.gille.ai/schema/service/v1
 *
 * DESCRIBE, DON'T EMBED (#317-follow-up). This file's job is to say what
 * exists and how to fetch it — identity, status, real deploy facts, and panel
 * *declarations* — not to ship bulk data. The learning-loop capability/product
 * evidence (issue #164) used to be inlined here as full table rows on every
 * ~60s Heimdall poll; it is now pushed on a much slower cadence to Heimdall's
 * `POST /api/panels` store (src/heimdall-report.ts) and rendered on Hugin's
 * service page independently of this descriptor. That is the established,
 * already-deployed "panel data endpoint fetched on demand" pattern (heimdall
 * issue #57 — see mimir's src/heimdall-report.ts for a live producer example),
 * not a new contract.
 */

import type { Application } from "express";
import { readFileSync } from "node:fs";
import * as path from "node:path";
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
  // Base/fallback status when no live health input is wired (e.g. the bare
  // `registerHeimdallDescriptorRoute(app)` call in tests). The real server
  // always supplies `opts.health` so the wire response reflects live state —
  // see deriveDescriptorStatus below. This literal is deliberately NOT what
  // ships from the running service.
  status: "pass",
  version: "0.1.0",
  // Only facts Hugin genuinely knows about its own runtime placement.
  // `deployed_commit` is added per-request from the `.deployed-commit` stamp
  // (same file Heimdall's drift.js reads authoritatively) when present — see
  // readDeployedCommit. `latest_commit`/`drift`/`deployed_at` are intentionally
  // OMITTED rather than published as null: Hugin cannot know origin/main's
  // latest commit without duplicating Heimdall's own drift computation, and a
  // structure of nulls reads as "failed to determine" when it should read as
  // "not this service's job to say" (munin-memory's descriptor — the 648-byte
  // reference — follows the same omission pattern).
  deploy: {
    host: "huginmunin",
    systemd_unit: "hugin",
    platform: "bare-metal",
  },
  metrics: [],
  // Tier-1 services own their panels: Heimdall's static known-panels fallback is
  // not consulted once /heimdall.json exists, so the task views must be declared
  // here (#135). Rendered live by Heimdall's plugins/hugin.js from the Munin DB.
  // These ARE thin declarations (id/plugin/view/label) — no data — unlike the
  // learning-loop typed panels, which are pushed, not declared here.
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

const DEPLOYED_COMMIT_FILENAME = ".deployed-commit";

/**
 * Read the commit Hugin was actually deployed at, from the same
 * `.deployed-commit` stamp that `scripts/deploy-pi.sh` writes atomically after
 * every accepted deploy and that Heimdall's drift.js reads authoritatively
 * (rsync deploys exclude .git/, so an on-disk git checkout would be stale or
 * absent — the stamp is the one honest source). Returns null — never a
 * fabricated or partial value — when the file is absent or its content
 * doesn't look like a hex commit sha (e.g. a fresh dev checkout).
 */
export function readDeployedCommit(repoRoot: string = process.cwd()): string | null {
  try {
    const raw = readFileSync(path.join(repoRoot, DEPLOYED_COMMIT_FILENAME), "utf8").trim();
    return /^[0-9a-f]{7,40}$/i.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Live signals the descriptor's `status` is actually derived from. */
export interface DescriptorHealthInput {
  /** The dispatcher poll loop is alive (false once shutdown has begun). */
  polling: boolean;
  /** Whether the Broker surface is configured at all (HUGIN_BROKER_KEYS set). */
  brokerConfigured: boolean;
  /** Broker configured but its bind is retrying or has failed. */
  brokerDegraded: boolean;
  /** Tasks stuck in the `blocked` lifecycle — the dispatcher is running fine,
   * this is a finding that needs attention, not a binary failure. */
  blockedTasks: number;
}

export interface DerivedDescriptorStatus {
  status: "pass" | "warn" | "fail";
  /** IETF health+json `output` — human-readable detail behind a non-pass
   * status. null for a clean pass (nothing to say). */
  output: string | null;
}

/**
 * Derive the descriptor's `status` from real dispatcher signals instead of a
 * hardcoded literal. Deliberately does NOT fold in learning-loop capability/
 * product evidence (#164) or deploy-commit staleness — those are separate
 * evidence planes with their own owners (Heimdall's drift.js is authoritative
 * for deploy freshness) and collapsing them here would be exactly the kind of
 * "competing capability truth" this codebase avoids elsewhere.
 *
 * `fail` only for the dispatcher genuinely not running. `warn` — the "ran
 * fine, here are N findings" shape, not a flat pass/fail — for a degraded
 * broker or a nonzero blocked-task count. Otherwise `pass`.
 */
export function deriveDescriptorStatus(input: DescriptorHealthInput): DerivedDescriptorStatus {
  if (!input.polling) {
    return { status: "fail", output: "dispatcher poll loop is not running" };
  }
  if (input.brokerConfigured && input.brokerDegraded) {
    return { status: "warn", output: "broker bind is degraded (retrying or failed)" };
  }
  if (input.blockedTasks > 0) {
    return {
      status: "warn",
      output: `${input.blockedTasks} blocked task(s) awaiting attention`,
    };
  }
  return { status: "pass", output: null };
}

/**
 * Build the learning-loop health panels (#164) from collected evidence.
 *
 * These are Heimdall TYPED panels (`stat`/`table`/`status`), which Heimdall
 * renders natively with zero per-panel code. They are no longer embedded in
 * the descriptor (see module docstring) — src/heimdall-report.ts pushes them
 * to Heimdall's panel store on its own slower cadence. Kept here (rather than
 * moved into heimdall-report.ts) because it is pure evidence-plane
 * computation shared conceptually with the descriptor's health story, and
 * because moving it would churn the existing #164 test coverage for no
 * behavioral gain.
 *
 * Fail-open: any collection failure yields honest "no evidence available"
 * panels rather than a broken descriptor/push cycle.
 */
export function buildLearningLoopHealthPanels(
  collector: LearningLoopCollector
): TypedPanel[] {
  // Synchronous by design: `collect()` is stale-while-revalidate and returns
  // immediately. Neither the descriptor nor the push cycle should ever wait
  // on a cold corpus walk.
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

export interface RegisterDescriptorRouteOptions {
  /** Live health snapshot. Called per-request; when absent the base
   * (fallback) `status: "pass"` ships as-is — see HEIMDALL_DESCRIPTOR. */
  health?: () => DescriptorHealthInput;
  /** Root directory to read `.deployed-commit` from. Defaults to
   * process.cwd(), which is the systemd unit's WorkingDirectory in
   * production. Overridable for tests. */
  repoRoot?: string;
}

/**
 * Register the GET /heimdall.json route on the given Express app.
 * No auth required — same open posture as /health.
 *
 * The route NEVER fails on account of live-health derivation: a `health`
 * callback error degrades to the static descriptor, because a broken
 * /heimdall.json would blank Hugin's whole Heimdall page (#135).
 */
export function registerHeimdallDescriptorRoute(
  app: Application,
  opts?: RegisterDescriptorRouteOptions
): void {
  app.get("/heimdall.json", (_req, res) => {
    const deployedCommit = readDeployedCommit(opts?.repoRoot);
    const base = {
      ...HEIMDALL_DESCRIPTOR,
      deploy: {
        ...HEIMDALL_DESCRIPTOR.deploy,
        ...(deployedCommit ? { deployed_commit: deployedCommit } : {}),
      },
    };
    if (!opts?.health) {
      res.json(base);
      return;
    }
    try {
      const { status, output } = deriveDescriptorStatus(opts.health());
      res.json({ ...base, status, ...(output ? { output } : {}) });
    } catch (err) {
      console.warn(
        `[heimdall] status derivation failed, serving base descriptor: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      res.json(base);
    }
  });
}
