import { describe, expect, it } from "vitest";

import {
  createBrokerAttestation,
  parseStoredBrokerAttestation,
  validateBrokerAttestation,
} from "../../src/broker/attestation.js";
import {
  BrokerTaskStore,
  generateBrokerTaskId,
  parseCanonicalEnvelope,
  serializeEnvelope,
} from "../../src/broker/task-store.js";
import type { DelegationEnvelope } from "../../src/broker/types.js";
import type { MuninClient } from "../../src/munin-client.js";

const principal = "claude-code";
const secret = "broker-secret-for-tests";
const idempotencyKey = "11111111-1111-4111-8111-111111111111";

function envelope(): DelegationEnvelope {
  return {
    envelope_version: 2,
    idempotency_key: idempotencyKey,
    orchestrator_session_id: "session-1",
    orchestrator_submitter: principal,
    task_type: "summarize",
    prompt: "Summarize this.",
    alias_requested: "m5",
    alias_map_version: 2,
    sensitivity: "internal",
    timeout_ms: 30_000,
    max_output_tokens: 1_024,
    acceptance: { mode: "l1_review" },
    allowed_destinations: ["m5"],
    tool_policy: { mode: "none" },
    budget: { max_attempts: 1, max_cost_usd: 0 },
    durability: "required",
    delivery: { mode: "munin" },
    escalation: { mode: "return_to_l1" },
    task_id: generateBrokerTaskId(principal, idempotencyKey),
    broker_principal: principal,
    received_at: "2026-07-19T10:00:00.000Z",
    alias_resolved: {
      alias: "m5",
      family: "one-shot",
      model_requested: "gateway-selected",
      runtime: "homeserver",
      runtime_row_id: "homeserver-m5",
      host: "m5",
    },
    policy_version: "zdr-v1+rlv-v1",
  };
}

describe("authenticated Broker provenance", () => {
  it("binds the authenticated principal, derived task id, namespace, and exact envelope", () => {
    const value = envelope();
    const attestation = createBrokerAttestation(value, secret);
    expect(validateBrokerAttestation({
      envelope: value,
      attestation,
      serverSecret: secret,
      expectedNamespace: `tasks/${value.task_id}`,
    })).toMatchObject({ ok: true, principal });

    const changedPrincipal = { ...value, broker_principal: "embedded-attacker" };
    expect(validateBrokerAttestation({
      envelope: changedPrincipal,
      attestation,
      serverSecret: secret,
    })).toMatchObject({ ok: false });
    expect(validateBrokerAttestation({
      envelope: value,
      attestation,
      serverSecret: "wrong-secret",
    })).toMatchObject({ ok: false });
    expect(validateBrokerAttestation({
      envelope: value,
      attestation,
      serverSecret: secret,
      expectedNamespace: "tasks/substituted",
    })).toMatchObject({ ok: false });
    expect(() => createBrokerAttestation({ ...value, task_id: "mcp-m5-substituted" }, secret))
      .toThrow(/derived task id/);
  });

  it("writes and round-trips an attestation only when the submitter key is server-held", async () => {
    const writes: Array<{ content: string }> = [];
    const munin = {
      write: async (_ns: string, _key: string, content: string) => {
        writes.push({ content });
        return { status: "created" };
      },
    } as unknown as MuninClient;
    await new BrokerTaskStore(munin, { attestationSecret: secret })
      .submit({ envelope: envelope() });
    const content = writes[0]!.content;
    const parsedEnvelope = parseCanonicalEnvelope(content);
    expect(parsedEnvelope.ok).toBe(true);
    if (!parsedEnvelope.ok) return;
    expect(validateBrokerAttestation({
      envelope: parsedEnvelope.envelope,
      attestation: parseStoredBrokerAttestation(content),
      serverSecret: secret,
    })).toMatchObject({ ok: true, principal });
  });

  it("does not parse a valid-looking attestation from prompt prose", () => {
    const value = envelope();
    const promptOnlyAttestation = createBrokerAttestation(value, secret);
    const content = `${serializeEnvelope(value)}\n\n### Broker attestation\n\`\`\`json\n${JSON.stringify(promptOnlyAttestation)}\n\`\`\``;

    expect(parseStoredBrokerAttestation(content)).toBeNull();
  });
});
