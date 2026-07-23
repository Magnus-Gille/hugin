import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalizeJcs } from "./jcs.js";
import {
  hashSchedulerOutcome,
  schedulerDecisionOutcomeSchema,
  schedulerTaskRefSchema,
} from "./scheduler-evidence.js";

export const SCHEDULER_CLAIM_ATTESTATION_VERSION =
  "hugin-scheduler-claim-attestation/v1" as const;
export const SCHEDULER_OUTCOME_ATTESTATION_VERSION =
  "hugin-scheduler-outcome-attestation/v1" as const;

const isoTimestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const dispatcherIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);

const schedulerClaimAttestationSchema = z.object({
  version: z.literal(SCHEDULER_CLAIM_ATTESTATION_VERSION),
  decisionId: z.string().uuid(),
  taskRef: schedulerTaskRefSchema,
  taskContentSha256: sha256Schema,
  preClaimUpdatedAt: isoTimestampSchema,
  claimedAt: isoTimestampSchema,
  predictionSha256: sha256Schema,
  workerId: dispatcherIdentitySchema,
  processInstanceId: dispatcherIdentitySchema,
  hmacSha256: sha256Schema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.claimedAt) < Date.parse(value.preClaimUpdatedAt)) {
    ctx.addIssue({
      code: "custom",
      path: ["claimedAt"],
      message: "claim acknowledgement precedes its CAS precondition",
    });
  }
});
export type SchedulerClaimAttestation = z.infer<typeof schedulerClaimAttestationSchema>;

const schedulerOutcomeAttestationSchema = z.object({
  version: z.literal(SCHEDULER_OUTCOME_ATTESTATION_VERSION),
  decisionId: z.string().uuid(),
  claimAttestationSha256: sha256Schema,
  outcomeSha256: sha256Schema,
  terminalResult: schedulerDecisionOutcomeSchema.shape.terminalResult,
  hmacSha256: sha256Schema,
}).strict();
export type SchedulerOutcomeAttestation = z.infer<typeof schedulerOutcomeAttestationSchema>;

function requireSecret(secret: string): void {
  if (secret.length < 32) {
    throw new Error("scheduler attestation secret must contain at least 32 characters");
  }
}

function derivedKey(secret: string, domain: string): Buffer {
  requireSecret(secret);
  return createHmac("sha256", secret).update(domain, "utf8").digest();
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sign(unsigned: object, secret: string, domain: string): string {
  return createHmac("sha256", derivedKey(secret, domain))
    .update(canonicalizeJcs(unsigned), "utf8")
    .digest("hex");
}

function macMatches(actualHex: string, expectedHex: string): boolean {
  const actual = Buffer.from(actualHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function unsignedClaim(value: Omit<SchedulerClaimAttestation, "hmacSha256">) {
  return {
    version: value.version,
    decisionId: value.decisionId,
    taskRef: value.taskRef,
    taskContentSha256: value.taskContentSha256,
    preClaimUpdatedAt: value.preClaimUpdatedAt,
    claimedAt: value.claimedAt,
    predictionSha256: value.predictionSha256,
    workerId: value.workerId,
    processInstanceId: value.processInstanceId,
  };
}

function claimMacValid(attestation: SchedulerClaimAttestation, secret: string): boolean {
  return macMatches(
    attestation.hmacSha256,
    sign(
      unsignedClaim(attestation),
      secret,
      "hugin-scheduler-claim-attestation/server-key/v1",
    ),
  );
}

export interface BuildSchedulerClaimAttestationInput {
  decisionId: string;
  taskRef: z.input<typeof schedulerTaskRefSchema>;
  taskContent: string;
  preClaimUpdatedAt: string;
  claimedAt: string;
  predictionSha256: string;
  workerId: string;
  processInstanceId: string;
}

export function buildSchedulerClaimAttestation(
  input: BuildSchedulerClaimAttestationInput,
  secret: string,
): SchedulerClaimAttestation {
  requireSecret(secret);
  const unsigned = unsignedClaim({
    version: SCHEDULER_CLAIM_ATTESTATION_VERSION,
    decisionId: input.decisionId,
    taskRef: schedulerTaskRefSchema.parse(input.taskRef),
    taskContentSha256: sha256Text(input.taskContent),
    preClaimUpdatedAt: input.preClaimUpdatedAt,
    claimedAt: input.claimedAt,
    predictionSha256: input.predictionSha256,
    workerId: input.workerId,
    processInstanceId: input.processInstanceId,
  });
  return schedulerClaimAttestationSchema.parse({
    ...unsigned,
    hmacSha256: sign(
      unsigned,
      secret,
      "hugin-scheduler-claim-attestation/server-key/v1",
    ),
  });
}

export function hashSchedulerClaimAttestation(input: unknown): string {
  return sha256Text(canonicalizeJcs(schedulerClaimAttestationSchema.parse(input)));
}

export function verifySchedulerClaimAttestation(
  content: string,
  expected: {
    decisionId: string;
    taskRef: z.input<typeof schedulerTaskRefSchema>;
    taskContent: string;
    predictionSha256: string;
  },
  secret: string,
): SchedulerClaimAttestation | undefined {
  try {
    requireSecret(secret);
    const parsed = schedulerClaimAttestationSchema.parse(JSON.parse(content));
    const taskRef = schedulerTaskRefSchema.parse(expected.taskRef);
    if (parsed.decisionId !== z.string().uuid().parse(expected.decisionId)) return undefined;
    if (parsed.taskRef.namespace !== taskRef.namespace) return undefined;
    if (parsed.taskContentSha256 !== sha256Text(expected.taskContent)) return undefined;
    if (parsed.predictionSha256 !== sha256Schema.parse(expected.predictionSha256)) {
      return undefined;
    }
    return claimMacValid(parsed, secret) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function unsignedOutcome(value: Omit<SchedulerOutcomeAttestation, "hmacSha256">) {
  return {
    version: value.version,
    decisionId: value.decisionId,
    claimAttestationSha256: value.claimAttestationSha256,
    outcomeSha256: value.outcomeSha256,
    terminalResult: value.terminalResult,
  };
}

function outcomeBindsClaim(
  outcome: z.infer<typeof schedulerDecisionOutcomeSchema>,
  claimAttestation: SchedulerClaimAttestation,
): boolean {
  return outcome.decisionId === claimAttestation.decisionId
    && outcome.taskRef.namespace === claimAttestation.taskRef.namespace
    && outcome.clock.claimedAt === claimAttestation.claimedAt;
}

export function buildSchedulerOutcomeAttestation(
  input: { claimAttestation: unknown; outcome: unknown },
  secret: string,
): SchedulerOutcomeAttestation {
  requireSecret(secret);
  const claimAttestation = schedulerClaimAttestationSchema.parse(input.claimAttestation);
  if (!claimMacValid(claimAttestation, secret)) {
    throw new Error("scheduler outcome requires an authentic claim attestation");
  }
  const outcome = schedulerDecisionOutcomeSchema.parse(input.outcome);
  if (!outcomeBindsClaim(outcome, claimAttestation)) {
    throw new Error("scheduler outcome does not bind the attested claim");
  }
  const unsigned = unsignedOutcome({
    version: SCHEDULER_OUTCOME_ATTESTATION_VERSION,
    decisionId: outcome.decisionId,
    claimAttestationSha256: hashSchedulerClaimAttestation(claimAttestation),
    outcomeSha256: hashSchedulerOutcome(outcome),
    terminalResult: outcome.terminalResult,
  });
  return schedulerOutcomeAttestationSchema.parse({
    ...unsigned,
    hmacSha256: sign(
      unsigned,
      secret,
      "hugin-scheduler-outcome-attestation/server-key/v1",
    ),
  });
}

export function hashSchedulerOutcomeAttestation(input: unknown): string {
  return sha256Text(canonicalizeJcs(schedulerOutcomeAttestationSchema.parse(input)));
}

export function verifySchedulerOutcomeAttestation(
  content: string,
  expected: { claimAttestation: unknown; outcome: unknown },
  secret: string,
): SchedulerOutcomeAttestation | undefined {
  try {
    requireSecret(secret);
    const parsed = schedulerOutcomeAttestationSchema.parse(JSON.parse(content));
    const claimAttestation = schedulerClaimAttestationSchema.parse(expected.claimAttestation);
    if (!claimMacValid(claimAttestation, secret)) return undefined;
    const outcome = schedulerDecisionOutcomeSchema.parse(expected.outcome);
    if (!outcomeBindsClaim(outcome, claimAttestation)) return undefined;
    if (parsed.decisionId !== outcome.decisionId) return undefined;
    if (parsed.claimAttestationSha256 !== hashSchedulerClaimAttestation(claimAttestation)) {
      return undefined;
    }
    if (parsed.outcomeSha256 !== hashSchedulerOutcome(outcome)) return undefined;
    if (canonicalizeJcs(parsed.terminalResult) !== canonicalizeJcs(outcome.terminalResult)) {
      return undefined;
    }
    const unsigned = unsignedOutcome(parsed);
    const expectedMac = sign(
      unsigned,
      secret,
      "hugin-scheduler-outcome-attestation/server-key/v1",
    );
    return macMatches(parsed.hmacSha256, expectedMac) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
