/**
 * Hugin-owned macro routing for the reviewed Orin Nano lane (issue #160).
 *
 * The homeserver gateway deliberately does not choose fleet nodes. Hugin makes
 * the explicit decision after its normal task-type and sensitivity gates have
 * run, and the gateway records that decision on its authoritative ledger.
 */

import type { Sensitivity } from "../sensitivity.js";
import { selectHuginMacroRoute } from "../autonomy/hugin-config-adapter.js";

export const ORIN_NODE_ID = "orin";
export const ORIN_MODEL_ID = "qwen2.5-coder:3b";

export interface OrinWorkerRoute {
  nodeId: typeof ORIN_NODE_ID;
  modelId: typeof ORIN_MODEL_ID;
}

/**
 * Return the explicit gateway node pin for a reviewed small leaf, or null to
 * leave the configured worker route unchanged. Private work is deliberately
 * excluded even though both machines are local: this lane has only been
 * reviewed for public/internal classify and extract workloads.
 */
export function selectOrinMacroRoute(input: {
  workerProvider: string;
  taskType: string;
  sensitivity: Sensitivity;
}): OrinWorkerRoute | null {
  return selectHuginMacroRoute(input);
}
