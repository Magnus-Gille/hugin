/**
 * Broker executor capability truth.
 *
 * Alias mappings are a durable protocol catalogue. This module answers the
 * separate operational question: can this Broker process actually drain a
 * submitted task for that resolved runtime/family right now?
 */

import { ACTIVE_ALIAS_MAP } from "../runtime-registry.js";
import { resolveAliasForBroker } from "./alias-resolution.js";
import type { Alias, AliasResolved } from "./types.js";

export interface BrokerExecutorCapabilities {
  m5Delegate: boolean;
}

export type BrokerAliasAvailability =
  | { executable: true }
  | {
      executable: false;
      reason: "no_executor_implemented" | "executor_disabled";
      retryable: boolean;
    };

export function brokerExecutorCapabilities(options: {
  homeserverEnabled: boolean;
}): BrokerExecutorCapabilities {
  return { m5Delegate: options.homeserverEnabled };
}

export function isBrokerExecutorImplemented(resolved: AliasResolved): boolean {
  return resolved.runtime === "homeserver" && resolved.family === "one-shot";
}

export function brokerAliasAvailability(
  resolved: AliasResolved,
  capabilities: BrokerExecutorCapabilities,
): BrokerAliasAvailability {
  if (!isBrokerExecutorImplemented(resolved)) {
    return {
      executable: false,
      reason: "no_executor_implemented",
      retryable: false,
    };
  }
  if (!capabilities.m5Delegate) {
    return {
      executable: false,
      reason: "executor_disabled",
      retryable: true,
    };
  }
  return { executable: true };
}

export function executableBrokerAliases(
  capabilities: BrokerExecutorCapabilities,
): Alias[] {
  return Object.values(ACTIVE_ALIAS_MAP.aliases)
    .map((entry) => entry.alias)
    .filter((alias) =>
      brokerAliasAvailability(
        resolveAliasForBroker(alias).alias_resolved,
        capabilities,
      ).executable,
    );
}
