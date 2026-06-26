/**
 * Heimdall self-describe descriptor for the hugin service.
 *
 * Returned verbatim by GET /heimdall.json — no auth required, same posture as /health.
 * Schema: https://heimdall.gille.ai/schema/service/v1
 */

import type { Application } from "express";

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
  panels: [],
  alerts: { rules: [], active_count: 0, firing: [] },
  links: {
    self: "/heimdall.json",
    health: "/health",
    repo: "https://github.com/Magnus-Gille/hugin",
  },
  ui: { icon: "cpu", category: "infra" },
} as const;

/**
 * Register the GET /heimdall.json route on the given Express app.
 * No auth required — same open posture as /health.
 */
export function registerHeimdallDescriptorRoute(app: Application): void {
  app.get("/heimdall.json", (_req, res) => {
    res.json(HEIMDALL_DESCRIPTOR);
  });
}
