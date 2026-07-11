import { describe, expect, it } from "vitest";
import { resolveAliasForBroker } from "../../src/broker/alias-resolution.js";
import {
  brokerAliasAvailability,
  brokerExecutorCapabilities,
  executableBrokerAliases,
  isBrokerExecutorImplemented,
} from "../../src/broker/executor-capabilities.js";

describe("Broker executor capabilities", () => {
  const enabled = brokerExecutorCapabilities({ openrouterEnabled: true });
  const disabled = brokerExecutorCapabilities({ openrouterEnabled: false });

  it("marks only the implemented OpenRouter one-shot alias executable", () => {
    expect(executableBrokerAliases(enabled)).toEqual(["large-reasoning"]);
    expect(
      isBrokerExecutorImplemented(
        resolveAliasForBroker("large-reasoning").alias_resolved,
      ),
    ).toBe(true);
  });

  it.each(["tiny", "medium", "pi-large-coder"] as const)(
    "classifies %s as unimplemented and non-retryable",
    (alias) => {
      expect(
        brokerAliasAvailability(
          resolveAliasForBroker(alias).alias_resolved,
          enabled,
        ),
      ).toEqual({
        executable: false,
        reason: "no_executor_implemented",
        retryable: false,
      });
    },
  );

  it("advertises no alias when the OpenRouter executor is disabled", () => {
    expect(executableBrokerAliases(disabled)).toEqual([]);
    expect(
      brokerAliasAvailability(
        resolveAliasForBroker("large-reasoning").alias_resolved,
        disabled,
      ),
    ).toEqual({
      executable: false,
      reason: "executor_disabled",
      retryable: true,
    });
  });
});
