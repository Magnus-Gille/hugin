/**
 * Heimdall self-describe descriptor for the hugin service.
 *
 * Returned verbatim by GET /heimdall.json — no auth required, same posture as /health.
 * Schema: https://heimdall.gille.ai/schema/service/v1
 */

import type { Application } from "express";
import { hostname as runtimeHostname } from "node:os";
import { isIP } from "node:net";
import {
  buildLearningLoopPanels,
  computeCapabilityPlane,
  computeProductPlane,
  deriveRoutePolicy,
  type TypedPanel,
} from "./learning-loop-health.js";
import type { LearningLoopCollector } from "./learning-loop-collector.js";

const INSTANCE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const HOST_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function isValidDeployHost(value: string): boolean {
  if (isIP(value) !== 0) return true;
  return value.length <= 253 && value.split(".").every((label) => HOST_LABEL_RE.test(label));
}

function safeRuntimeHost(hostname: string): string {
  const candidate = hostname.trim();
  return isValidDeployHost(candidate) ? candidate : "localhost";
}

function runtimeInstanceId(hostname: string): string {
  const candidate = hostname
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 64);
  return INSTANCE_ID_RE.test(candidate) ? candidate : "hugin";
}

const BASE_HEIMDALL_DESCRIPTOR = {
  _schema: "https://heimdall.gille.ai/schema/service/v1",
  service: {
    name: "hugin",
    label: "Hugin",
    namespace: "grimnir",
    criticality: "normal",
  },
  kind: "http-service",
  status: "pass",
  version: "0.1.0",
  deploy: {
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

export function buildHeimdallDescriptor(
  env: NodeJS.ProcessEnv = process.env,
  hostname: string = runtimeHostname()
) {
  const fallbackHost = safeRuntimeHost(hostname);
  const configuredHost = env.HUGIN_DEPLOY_HOST?.trim() ?? "";
  if (configuredHost && !isValidDeployHost(configuredHost)) {
    throw new Error(
      "Invalid HUGIN_DEPLOY_HOST: expected an IPv4/IPv6 address or DNS hostname"
    );
  }
  const deployHost = configuredHost || fallbackHost;

  const configuredInstanceId = env.HUGIN_INSTANCE_ID?.trim() ?? "";
  if (configuredInstanceId && !INSTANCE_ID_RE.test(configuredInstanceId)) {
    throw new Error(
      "Invalid HUGIN_INSTANCE_ID: expected 1-64 letters, numbers, dots, underscores, or hyphens"
    );
  }
  const instanceId = configuredInstanceId || runtimeInstanceId(fallbackHost);

  return {
    ...BASE_HEIMDALL_DESCRIPTOR,
    service: {
      ...BASE_HEIMDALL_DESCRIPTOR.service,
      instance_id: instanceId,
    },
    deploy: {
      ...BASE_HEIMDALL_DESCRIPTOR.deploy,
      host: deployHost,
    },
  } as const;
}

export const HEIMDALL_DESCRIPTOR = buildHeimdallDescriptor();

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
