import { describe, expect, it } from "vitest";
import {
  CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE,
  EXTERNAL_RECEIPT_CONTRACT_VERSION,
  EXTERNAL_RECEIPT_SCHEMA_VERSION,
  externalReceiptEnvelopeSchema,
  storedExternalReceiptSchema,
  type ExternalReceiptEnvelope,
} from "../src/external-receipt-schema.js";

function makeObservation(overrides: Partial<ExternalReceiptEnvelope> = {}): ExternalReceiptEnvelope {
  return {
    schemaVersion: EXTERNAL_RECEIPT_SCHEMA_VERSION,
    contractVersion: EXTERNAL_RECEIPT_CONTRACT_VERSION,
    surface: "codex_cli",
    kind: "observation",
    receiptId: "receipt-obs-1",
    capacityPrincipal: "codex-cli-work",
    identity: { provider: "openai", model: "gpt-5.1-codex", harness: "codex-cli@1.4.2" },
    instance: {
      taskInstanceId: "task-instance-1",
      sourceTaskRef: { system: "github-issue", id: "Magnus-Gille/hugin#237" },
    },
    occurredAt: "2026-07-20T10:00:00Z",
    producedAt: "2026-07-20T10:00:05Z",
    reviewerIndependenceNote: CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE,
    ...overrides,
  } as ExternalReceiptEnvelope;
}

function makeOutcome(overrides: Partial<ExternalReceiptEnvelope> = {}): ExternalReceiptEnvelope {
  return {
    ...makeObservation(),
    kind: "outcome",
    receiptId: "receipt-out-1",
    outcome: "completed",
    ...overrides,
  } as ExternalReceiptEnvelope;
}

describe("externalReceiptEnvelopeSchema", () => {
  it("accepts a well-formed observation receipt", () => {
    const result = externalReceiptEnvelopeSchema.safeParse(makeObservation());
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed outcome receipt", () => {
    const result = externalReceiptEnvelopeSchema.safeParse(makeOutcome());
    expect(result.success).toBe(true);
  });

  it("requires an outcome field only when kind is outcome", () => {
    const badOutcome = externalReceiptEnvelopeSchema.safeParse({
      ...makeObservation(),
      kind: "outcome",
      receiptId: "receipt-out-2",
      // outcome deliberately omitted
    });
    expect(badOutcome.success).toBe(false);

    const strayOutcome = externalReceiptEnvelopeSchema.safeParse({
      ...makeObservation(),
      outcome: "completed",
    });
    expect(strayOutcome.success).toBe(false); // observation must not carry an outcome field
  });

  it("rejects an unrecognised extra field (content-blindness at the wire boundary)", () => {
    const result = externalReceiptEnvelopeSchema.safeParse({
      ...makeObservation(),
      transcript: "the full private conversation would go here",
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("rejects free-text-shaped identity tokens (spaces / newlines)", () => {
    const withSpaces = externalReceiptEnvelopeSchema.safeParse(
      makeObservation({ identity: { provider: "openai", model: "gpt 5 codex full name", harness: "codex-cli@1.4.2" } }),
    );
    expect(withSpaces.success).toBe(false);

    const withNewline = externalReceiptEnvelopeSchema.safeParse(
      makeObservation({ capacityPrincipal: "codex-cli-work\nsome smuggled line" }),
    );
    expect(withNewline.success).toBe(false);
  });

  it("rejects an overlong identity token (bounding against pasted content)", () => {
    const result = externalReceiptEnvelopeSchema.safeParse(
      makeObservation({ identity: { provider: "openai", model: "x".repeat(500), harness: "codex-cli@1.4.2" } }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported schema version", () => {
    const result = externalReceiptEnvelopeSchema.safeParse({ ...makeObservation(), schemaVersion: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported contract version", () => {
    const result = externalReceiptEnvelopeSchema.safeParse({
      ...makeObservation(),
      contractVersion: "some.other/v9",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a surface outside the three supported external surfaces", () => {
    const result = externalReceiptEnvelopeSchema.safeParse({ ...makeObservation(), surface: "claude_desktop" });
    expect(result.success).toBe(false);
  });

  it("rejects producedAt strictly before occurredAt", () => {
    const result = externalReceiptEnvelopeSchema.safeParse(
      makeObservation({ occurredAt: "2026-07-20T10:00:05Z", producedAt: "2026-07-20T10:00:00Z" }),
    );
    expect(result.success).toBe(false);
  });

  it("requires the fixed capacity-principal-independence literal, not caller prose", () => {
    const result = externalReceiptEnvelopeSchema.safeParse(
      makeObservation({ reviewerIndependenceNote: "this producer is definitely independent, trust me" as never }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts an optional reconciliation target as an opaque token", () => {
    const result = externalReceiptEnvelopeSchema.safeParse(
      makeObservation({ instance: { ...makeObservation().instance, reconcilesHuginTaskId: "20260701-000000-abcd" } }),
    );
    expect(result.success).toBe(true);
  });
});

describe("storedExternalReceiptSchema", () => {
  it("round-trips a fully-populated stored record", () => {
    const stored = {
      schemaVersion: EXTERNAL_RECEIPT_SCHEMA_VERSION,
      receipt: makeObservation(),
      taskId: "ext-abc123",
      attemptId: "ext-attempt-def456",
      verifiedCapacityPrincipal: "codex-cli-work",
      keyId: "codex-cli-work",
      receivedAt: "2026-07-20T10:00:06Z",
      coverage: "imported",
      reconciledWithNativeTask: false,
    };
    expect(storedExternalReceiptSchema.safeParse(stored).success).toBe(true);
  });

  it("rejects an unrecognised extra field on the stored record too", () => {
    const stored = {
      schemaVersion: EXTERNAL_RECEIPT_SCHEMA_VERSION,
      receipt: makeObservation(),
      taskId: "ext-abc123",
      attemptId: "ext-attempt-def456",
      verifiedCapacityPrincipal: "codex-cli-work",
      keyId: "codex-cli-work",
      receivedAt: "2026-07-20T10:00:06Z",
      coverage: "imported",
      reconciledWithNativeTask: false,
      rawOutput: "smuggled content",
    };
    expect(storedExternalReceiptSchema.safeParse(stored).success).toBe(false);
  });
});
