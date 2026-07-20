import { describe, expect, it } from "vitest";
import {
  buildExternalReceiptCanonicalPayload,
  loadReceiptProducerKeyStoreFromEnv,
  signExternalReceipt,
  verifyExternalReceiptSignature,
} from "../src/external-receipt-signing.js";
import {
  CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE,
  EXTERNAL_RECEIPT_CONTRACT_VERSION,
  EXTERNAL_RECEIPT_SCHEMA_VERSION,
  type ExternalReceiptEnvelope,
} from "../src/external-receipt-schema.js";

const SECRET_HEX = "b".repeat(64);
const KEY_ID = "codex-cli-work";
const KEYS = { [KEY_ID]: SECRET_HEX };

function makeReceipt(overrides: Partial<ExternalReceiptEnvelope> = {}): ExternalReceiptEnvelope {
  return {
    schemaVersion: EXTERNAL_RECEIPT_SCHEMA_VERSION,
    contractVersion: EXTERNAL_RECEIPT_CONTRACT_VERSION,
    surface: "codex_cli",
    kind: "observation",
    receiptId: "receipt-1",
    capacityPrincipal: KEY_ID,
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

describe("buildExternalReceiptCanonicalPayload", () => {
  it("is sorted and newline-terminated", () => {
    const payload = buildExternalReceiptCanonicalPayload(makeReceipt());
    expect(payload.endsWith("\n")).toBe(true);
    const lines = payload.trimEnd().split("\n");
    expect(lines).toEqual([...lines].sort());
  });

  it("differs when any bound field changes", () => {
    const base = buildExternalReceiptCanonicalPayload(makeReceipt());
    expect(buildExternalReceiptCanonicalPayload(makeReceipt({ capacityPrincipal: "codex-cli-personal" }))).not.toEqual(base);
    expect(
      buildExternalReceiptCanonicalPayload(makeReceipt({ instance: { ...makeReceipt().instance, taskInstanceId: "other" } })),
    ).not.toEqual(base);
    expect(buildExternalReceiptCanonicalPayload(makeReceipt({ occurredAt: "2026-07-20T10:00:01Z" }))).not.toEqual(base);
  });

  it("binds the outcome field only for outcome receipts", () => {
    const observation = buildExternalReceiptCanonicalPayload(makeReceipt());
    expect(observation).not.toContain("outcome=");
    const outcome = buildExternalReceiptCanonicalPayload(
      makeReceipt({ kind: "outcome", receiptId: "receipt-2", outcome: "completed" } as Partial<ExternalReceiptEnvelope>),
    );
    expect(outcome).toContain("outcome=completed");
  });
});

describe("verifyExternalReceiptSignature", () => {
  it("verifies a correctly signed receipt", () => {
    const receipt = makeReceipt();
    const signature = signExternalReceipt(receipt, KEY_ID, SECRET_HEX);
    const result = verifyExternalReceiptSignature(receipt, signature, KEYS);
    expect(result).toEqual({ status: "valid", keyId: KEY_ID });
  });

  it("rejects a missing signature", () => {
    const result = verifyExternalReceiptSignature(makeReceipt(), null, KEYS);
    expect(result.status).toBe("missing");
  });

  it("rejects an unknown producer key", () => {
    const receipt = makeReceipt();
    const signature = signExternalReceipt(receipt, "someone-else", SECRET_HEX);
    const result = verifyExternalReceiptSignature(receipt, signature, KEYS);
    expect(result.status).toBe("unknown-producer");
  });

  it("rejects a keyId that does not alias the claimed capacity principal", () => {
    const receipt = makeReceipt();
    const keys = { ...KEYS, "another-principal": SECRET_HEX };
    const signature = signExternalReceipt(receipt, "another-principal", SECRET_HEX);
    const result = verifyExternalReceiptSignature(receipt, signature, keys);
    expect(result.status).toBe("producer-mismatch");
  });

  it("accepts a rotation-alias keyId of the form <principal>-<rotation>", () => {
    const receipt = makeReceipt();
    const rotatedKeyId = `${KEY_ID}-2026q3`;
    const keys = { [rotatedKeyId]: SECRET_HEX };
    const signature = signExternalReceipt(receipt, rotatedKeyId, SECRET_HEX);
    const result = verifyExternalReceiptSignature(receipt, signature, keys);
    expect(result.status).toBe("valid");
  });

  it("rejects a tampered field even with a structurally valid signature", () => {
    const receipt = makeReceipt();
    const signature = signExternalReceipt(receipt, KEY_ID, SECRET_HEX);
    const tampered = { ...receipt, occurredAt: "2026-07-20T11:00:00Z" };
    const result = verifyExternalReceiptSignature(tampered, signature, KEYS);
    expect(result.status).toBe("invalid");
  });

  it("rejects a malformed signature string", () => {
    const result = verifyExternalReceiptSignature(makeReceipt(), "not-a-signature", KEYS);
    expect(result.status).toBe("malformed");
  });

  it("rejects an unsupported signature version", () => {
    const receipt = makeReceipt();
    const result = verifyExternalReceiptSignature(receipt, `v2:${KEY_ID}:${"0".repeat(64)}`, KEYS);
    expect(result.status).toBe("unsupported-version");
  });

  it("enforces maxAgeS when configured", () => {
    const receipt = makeReceipt({ producedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const signature = signExternalReceipt(receipt, KEY_ID, SECRET_HEX);
    const result = verifyExternalReceiptSignature(receipt, signature, KEYS, { maxAgeS: 60 });
    expect(result.status).toBe("expired");
  });
});

describe("loadReceiptProducerKeyStoreFromEnv", () => {
  it("loads from HUGIN_RECEIPT_PRODUCER_KEYS inline JSON", () => {
    const store = loadReceiptProducerKeyStoreFromEnv({
      HUGIN_RECEIPT_PRODUCER_KEYS: JSON.stringify({ [KEY_ID]: SECRET_HEX }),
    } as NodeJS.ProcessEnv);
    expect(store[KEY_ID]).toBe(SECRET_HEX);
  });

  it("returns an empty store when nothing is configured", () => {
    const store = loadReceiptProducerKeyStoreFromEnv({} as NodeJS.ProcessEnv);
    expect(store).toEqual({});
  });

  it("is independent from HUGIN_SUBMITTER_KEYS", () => {
    const store = loadReceiptProducerKeyStoreFromEnv({
      HUGIN_SUBMITTER_KEYS: JSON.stringify({ [KEY_ID]: SECRET_HEX }),
    } as NodeJS.ProcessEnv);
    expect(store).toEqual({});
  });
});
