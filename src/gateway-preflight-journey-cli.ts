#!/usr/bin/env node
/**
 * gateway-preflight-journey-cli.ts — run one content-free `hugin-gateway-preflight` attempt and
 * deliver the closed synthetic-journey-outcome v1 document to Heimdall (HUGIN-388 / HEIM-49).
 *
 * Configuration comes only from the environment (host-owned private files, never argv):
 *   HOMESERVER_GATEWAY_URL               M5 gateway origin (already in Hugin's .env)
 *   HOMESERVER_GATEWAY_API_KEY           owner-scope key Hugin dispatches with (already in .env)
 *   HEIMDALL_SYNTHETIC_JOURNEYS_URL      https://<heimdall>/api/synthetic-journeys
 *   HEIMDALL_HUGIN_JOURNEY_TOKEN         dedicated Hugin journey credential
 *
 * Exit status: 0 when a runner-ok outcome (pass OR fail) was delivered — a failing gateway is
 * Heimdall's alert to raise, not a failed unit. Exit 1 when delivery failed or the runner itself
 * failed (bad config/credential), because Heimdall does not grade `unknown`. Output is one JSON
 * line of classes only: no token, key, URL, payload or response body.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  deliverOutcome,
  runPreflightAttempt,
  type DeliveryOptions,
  type PreflightJourneyOptions,
} from "./gateway-preflight-journey.js";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return `hugin@${pkg.version ?? "0.0.0"}`;
  } catch {
    return "hugin@0.0.0";
  }
}

export async function runCli(
  env: NodeJS.ProcessEnv,
  deps: { run?: Partial<PreflightJourneyOptions>; deliver?: Partial<DeliveryOptions>; write?: (line: string) => void } = {},
): Promise<number> {
  const outcome = await runPreflightAttempt({
    gatewayUrl: env.HOMESERVER_GATEWAY_URL,
    gatewayKey: env.HOMESERVER_GATEWAY_API_KEY,
    version: packageVersion(),
    ...deps.run,
  });
  const delivery = await deliverOutcome(outcome, {
    url: env.HEIMDALL_SYNTHETIC_JOURNEYS_URL,
    token: env.HEIMDALL_HUGIN_JOURNEY_TOKEN,
    ...deps.deliver,
  });
  (deps.write ?? ((line: string) => process.stdout.write(line)))(`${JSON.stringify({
    journey_id: outcome.journey_id,
    outcome: outcome.outcome,
    runner_outcome: outcome.runner_outcome,
    error_class: outcome.error_class,
    delivered: delivery.delivered,
    attempts: delivery.attempts,
    delivery_error: delivery.error ?? null,
  })}\n`);
  return delivery.delivered && outcome.runner_outcome === "ok" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.env);
}
