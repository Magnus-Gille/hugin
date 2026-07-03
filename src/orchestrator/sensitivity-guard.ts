import type { OrchestratorConfig } from "./engine.js";
import type { Sensitivity } from "../sensitivity.js";

/**
 * Providers that are permitted to process private-sensitivity data.
 *
 * "Sovereign" means data stays within the operator's control: on-prem
 * or in a jurisdiction that permits private data processing. Cloud
 * providers are excluded because they transmit data to third-party APIs.
 *
 * `homeserver` is the M5 local-inference gateway — owned hardware reached
 * over the tailnet, so private data never leaves the operator's machines.
 *
 * Future: add "ollama" / "local" once local execution is wired.
 */
const SOVEREIGN_OR_LOCAL_PROVIDERS = new Set<string>(["berget", "homeserver"]);

export type SensitivityGuardResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Assert that all providers used across the orchestrator roles are compatible
 * with the task's effective sensitivity.
 *
 * Rules:
 *   - `public` / `internal`: always allowed (cloud providers are fine).
 *   - `private`: every role provider MUST be sovereign-or-local; if any
 *     provider is not in that set the task is rejected before any model call
 *     is made (fail-closed to prevent accidental private-data leakage).
 *
 * This is a pure function — no side-effects, no I/O.
 */
export function assertProvidersAllowSensitivity(
  config: OrchestratorConfig,
  sensitivity: Sensitivity,
): SensitivityGuardResult {
  if (sensitivity !== "private") {
    // public and internal are allowed on any provider for now.
    return { ok: true };
  }

  // Build the set of distinct providers used across all roles.
  const nonSovereignProviders = Object.values(config.roles)
    .map((binding) => binding.provider)
    .filter((provider) => !SOVEREIGN_OR_LOCAL_PROVIDERS.has(provider));

  // Deduplicate for a clean error message.
  const distinct = [...new Set(nonSovereignProviders)];

  if (distinct.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `private task cannot use non-sovereign providers: ${distinct.join(", ")}`,
  };
}
