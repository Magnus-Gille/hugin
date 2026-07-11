/**
 * Alias resolution helpers for the broker.
 *
 * Translates a stable alias (`tiny`, `medium`, `large-reasoning`,
 * `pi-large-coder`) plus the live alias map and runtime registry into a
 * concrete `AliasResolved` annotation, plus produces the `policy_version`
 * stamp used downstream for ZDR/reasoning-level pinning audits.
 *
 * Kept separate from the registry module so the broker can layer extra
 * audit fields (harness_version capture, policy version composition) on
 * top of the bare registry rows without polluting the registry types.
 */

import {
  ACTIVE_ALIAS_MAP,
  RUNTIME_REGISTRY,
  resolveAlias,
} from "../runtime-registry.js";
import type { Alias, AliasResolved } from "./types.js";

export const POLICY_VERSION = "zdr-v1+rlv-v1";

export interface AliasResolutionResult {
  alias_resolved: AliasResolved;
  alias_map_version: number;
  policy_version: string;
}

export function resolveAliasForBroker(alias: Alias): AliasResolutionResult {
  const resolution = resolveAlias(alias);
  const registryRow = RUNTIME_REGISTRY.find(
    (row) => row.id === resolution.runtimeId,
  );
  if (!registryRow) {
    throw new Error(
      `Alias ${alias} maps to runtime ${resolution.runtimeId} but no registry row exists`,
    );
  }

  const runtime = mapRuntimeToEffective(registryRow.dispatcherRuntime);

  const aliasResolved: AliasResolved = {
    alias,
    family: resolution.family,
    model_requested: resolution.model,
    runtime,
    runtime_row_id: registryRow.id,
    host: resolution.host ?? "openrouter",
  };
  if (resolution.harness === "pi") aliasResolved.harness = "pi";
  if (resolution.reasoningLevel) {
    aliasResolved.reasoning_level = resolution.reasoningLevel;
  }

  return {
    alias_resolved: aliasResolved,
    alias_map_version: ACTIVE_ALIAS_MAP.version,
    policy_version: POLICY_VERSION,
  };
}

function mapRuntimeToEffective(
  dispatcherRuntime: string,
): AliasResolved["runtime"] {
  if (dispatcherRuntime === "ollama") return "ollama";
  if (dispatcherRuntime === "openrouter") return "openrouter";
  if (dispatcherRuntime === "pi-harness") return "pi-harness";
  if (dispatcherRuntime === "homeserver") return "homeserver";
  throw new Error(
    `Alias resolved to non-orchestrator dispatcher runtime: ${dispatcherRuntime}`,
  );
}
