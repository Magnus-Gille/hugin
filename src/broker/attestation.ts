import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  delegationEnvelopeSchema,
  type DelegationEnvelope,
} from "./types.js";

export const BROKER_ATTESTATION_VERSION = "hugin-broker-attestation/v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const brokerAttestationSchema = z.object({
  version: z.literal(BROKER_ATTESTATION_VERSION),
  namespace: z.string().regex(/^tasks\/[A-Za-z0-9._:-]+$/),
  task_id: z.string().min(1),
  broker_principal: z.string().min(1),
  envelope_digest: sha256Schema,
  issued_at: z.string().datetime({ offset: true }),
  hmac_sha256: sha256Schema,
}).strict();

export type BrokerAttestation = z.infer<typeof brokerAttestationSchema>;

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => {
      const child = object[key];
      if (child === undefined) throw new Error("Broker attestation cannot canonicalize undefined");
      return `${JSON.stringify(key)}:${canonicalize(child)}`;
    }).join(",")}}`;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  throw new Error("Broker attestation accepts only JSON values");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function derivedTaskId(principal: string, idempotencyKey: string): string {
  return `mcp-m5-${createHash("sha256")
    .update(`${principal}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function unsignedAttestation(
  envelope: DelegationEnvelope,
): Omit<BrokerAttestation, "hmac_sha256"> {
  return {
    version: BROKER_ATTESTATION_VERSION,
    namespace: `tasks/${envelope.task_id}`,
    task_id: envelope.task_id,
    broker_principal: envelope.broker_principal,
    envelope_digest: sha256(delegationEnvelopeSchema.parse(envelope)),
    issued_at: envelope.received_at,
  };
}

function attestationKey(serverSecret: string): Buffer {
  return createHmac("sha256", serverSecret)
    .update("hugin-broker-attestation/server-key/v1", "utf8")
    .digest();
}

export function createBrokerAttestation(
  envelope: DelegationEnvelope,
  secret: string,
): BrokerAttestation {
  if (secret.length === 0) throw new Error("Broker attestation secret is empty");
  const parsed = delegationEnvelopeSchema.parse(envelope);
  if (parsed.task_id !== derivedTaskId(parsed.broker_principal, parsed.idempotency_key)) {
    throw new Error("Broker attestation requires the principal-scoped derived task id");
  }
  const unsigned = unsignedAttestation(parsed);
  return brokerAttestationSchema.parse({
    ...unsigned,
    hmac_sha256: createHmac("sha256", attestationKey(secret))
      .update(canonicalize(unsigned), "utf8")
      .digest("hex"),
  });
}

export function validateBrokerAttestation(input: {
  envelope: DelegationEnvelope;
  attestation: unknown;
  serverSecret: string;
  expectedNamespace?: string;
}): { ok: true; principal: string; attestation: BrokerAttestation } | { ok: false; error: string } {
  const envelope = delegationEnvelopeSchema.safeParse(input.envelope);
  const attestation = brokerAttestationSchema.safeParse(input.attestation);
  if (!envelope.success || !attestation.success) {
    return { ok: false, error: "Broker attestation is missing or malformed" };
  }
  const expectedTaskId = derivedTaskId(
    envelope.data.broker_principal,
    envelope.data.idempotency_key,
  );
  const expected = unsignedAttestation(envelope.data);
  const value = attestation.data;
  if (envelope.data.task_id !== expectedTaskId
    || value.namespace !== expected.namespace
    || value.task_id !== expected.task_id
    || value.broker_principal !== expected.broker_principal
    || value.envelope_digest !== expected.envelope_digest
    || value.issued_at !== expected.issued_at
    || (input.expectedNamespace !== undefined && value.namespace !== input.expectedNamespace)) {
    return { ok: false, error: "Broker attestation binding mismatch" };
  }
  if (!input.serverSecret) return { ok: false, error: "Broker attestation server key is not configured" };
  const expectedMac = Buffer.from(
    createHmac("sha256", attestationKey(input.serverSecret))
      .update(canonicalize(expected), "utf8")
      .digest("hex"),
    "hex",
  );
  const actualMac = Buffer.from(value.hmac_sha256, "hex");
  if (expectedMac.length !== actualMac.length || !timingSafeEqual(expectedMac, actualMac)) {
    return { ok: false, error: "Broker attestation signature mismatch" };
  }
  return { ok: true, principal: value.broker_principal, attestation: value };
}

export function parseStoredBrokerAttestation(content: string): unknown | null {
  const match = content.match(/### Broker attestation\s*\n```json\s*\n([\s\S]*?)\n```/i);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}
