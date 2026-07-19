/** Content-blind, append-only post-run quality receipts (issue #216). */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeJcs } from "./jcs.js";
import { structuredTaskResultSchema } from "./task-result-schema.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const commitSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
const learningContractTimestampSchema = z.string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/)
  .datetime();

export const qualityRepositoryBindingSchema = z.object({
  state: z.enum([
    "unknown",
    "not-managed",
    "checkout-failed",
    "not-finalized",
    "no-changes",
    "changes-present",
    "publication-failed",
  ]),
  baseBranch: z.string().min(1).max(255).optional(),
  baseCommit: commitSchema.optional(),
  headCommit: commitSchema.optional(),
  diffSha256: sha256Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.state === "changes-present") {
    for (const field of ["baseBranch", "baseCommit", "headCommit", "diffSha256"] as const) {
      if (value[field] === undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: `${field} is required for changes-present` });
      }
    }
  }
  if (value.state === "no-changes") {
    for (const field of ["baseBranch", "baseCommit"] as const) {
      if (value[field] === undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: `${field} is required for no-changes` });
      }
    }
    if (value.headCommit !== undefined || value.diffSha256 !== undefined) {
      ctx.addIssue({ code: "custom", message: "no-changes cannot carry head or diff evidence" });
    }
  }
});
export type QualityRepositoryBinding = z.infer<typeof qualityRepositoryBindingSchema>;

export const qualityBindingSchema = z.object({
  taskDocumentSha256: sha256Schema,
  structuredResultSha256: sha256Schema,
  repository: qualityRepositoryBindingSchema,
}).strict();
export type QualityBinding = z.infer<typeof qualityBindingSchema>;

const qualityReviewerSchema = z.object({
  principal: z.string().min(1).max(200),
  independence: z.enum(["independent", "self", "unknown"]),
}).strict();

const qualitySourceDocumentDigestSchema = z.object({
  algorithm: z.literal("sha256"),
  canonicalization: z.literal("jcs-rfc8785-utf8-v1"),
  source_ref: z.string().regex(/^source-doc:[a-z0-9][a-z0-9._/-]*$/),
  source_type: z.literal("rubric-config"),
  source_version: z.string().min(1),
  digest: sha256Schema,
}).strict();

const qualityConfigurationIdentitySchema = z.object({
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
  sha256: sha256Schema,
}).strict();

const qualityModelConfigurationSchema = z.object({
  id: z.string().min(1).max(200),
  configurationSha256: sha256Schema,
}).strict();

export const qualityRubricSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
  config_digest: qualitySourceDocumentDigestSchema,
}).strict();
export type QualityRubric = z.infer<typeof qualityRubricSchema>;

export const qualityVerifierIdentitySchema = z.object({
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
}).strict();
export type QualityVerifierIdentity = z.infer<typeof qualityVerifierIdentitySchema>;

export const qualityFailureCodeSchema = z.enum([
  "none",
  "incorrect-answer",
  "incomplete-answer",
  "format-invalid",
  "instruction-noncompliance",
  "unsafe-output",
  "unsupported-claim",
  "tool-failure",
  "harness-failure",
  "infrastructure",
  "verification-failure",
  "other",
]);

export const qualityFailureSchema = z.object({
  taxonomy: z.object({
    id: z.string().min(1).max(200),
    version: z.string().min(1).max(200),
  }).strict(),
  code: qualityFailureCodeSchema,
}).strict();
export type QualityFailure = z.infer<typeof qualityFailureSchema>;

export const qualityProducingConfigurationSchema = z.object({
  prompt: qualityConfigurationIdentitySchema.optional(),
  harness: qualityConfigurationIdentitySchema.optional(),
  model: qualityModelConfigurationSchema.optional(),
  toolPolicy: qualityConfigurationIdentitySchema.optional(),
}).strict().refine(
  (value) => Object.values(value).some((child) => child !== undefined),
  "producing configuration must contain at least one identity",
);
export type QualityProducingConfiguration = z.infer<
  typeof qualityProducingConfigurationSchema
>;

export const qualityCorrectionReferencesSchema = z.object({
  correctedSuccessor: z.object({
    taskId: z.string().min(1).max(200),
    structuredResultSha256: sha256Schema,
  }).strict().optional(),
  followUpTaskId: z.string().min(1).max(200).optional(),
  pullRequestUrl: z.string().url().optional(),
  replacementCommit: commitSchema.optional(),
}).strict().refine(
  (value) => Object.values(value).some((child) => child !== undefined),
  "correction references must contain at least one reference",
);
export type QualityCorrectionReferences = z.infer<
  typeof qualityCorrectionReferencesSchema
>;

const qualityReceiptBaseSchema = z.object({
  schemaVersion: z.literal(1),
  receiptId: z.string().regex(/^qr-[0-9a-f]{24}$/),
  taskId: z.string().min(1).max(200),
  rating: z.enum(["pass", "partial", "redo", "wrong"]),
  ratingReason: z.string().min(1).max(10_000),
  verificationOutcome: z.enum([
    "accepted_unchanged",
    "minor_edit",
    "major_rewrite",
    "discarded",
    "escalated_to_claude",
  ]),
  retriesCount: z.number().int().nonnegative().optional(),
  ratedAt: z.string().datetime(),
  reviewer: qualityReviewerSchema,
  bindingAttestation: z.enum(["server-bound", "reviewer-confirmed"]),
  binding: qualityBindingSchema,
}).strict();
export const qualityReceiptSchema = qualityReceiptBaseSchema.superRefine((value, ctx) => {
  const expected = qualityReceiptId({
    taskId: value.taskId,
    reviewerPrincipal: value.reviewer.principal,
    reviewerIndependence: value.reviewer.independence,
    rating: value.rating,
    ratingReason: value.ratingReason,
    verificationOutcome: value.verificationOutcome,
    retriesCount: value.retriesCount,
    bindingAttestation: value.bindingAttestation,
    binding: value.binding,
  });
  if (value.receiptId !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["receiptId"],
      message: `receipt identity mismatch; expected ${expected}`,
    });
  }
});
export type QualityReceipt = z.infer<typeof qualityReceiptSchema>;

const qualityCorrectionGroupSchema = z.object({
  algorithm: z.literal("sha256"),
  version: z.literal("quality-correction-group-jcs-v1"),
  digest: sha256Schema,
}).strict();

const qualityReceiptV2BaseSchema = z.object({
  schemaVersion: z.literal(2),
  receiptId: z.string().regex(/^qr-[0-9a-f]{24}$/),
  taskId: z.string().min(1).max(200),
  attemptId: z.string().min(1).max(200),
  correctsReceiptId: z.string().regex(/^qr-[0-9a-f]{24}$/),
  correctionGroup: qualityCorrectionGroupSchema,
  rating: z.enum(["pass", "partial", "redo", "wrong"]),
  ratingReason: z.string().min(1).max(10_000),
  verificationOutcome: z.enum([
    "accepted_unchanged",
    "minor_edit",
    "major_rewrite",
    "discarded",
    "escalated_to_claude",
  ]),
  retriesCount: z.number().int().nonnegative().optional(),
  ratedAt: learningContractTimestampSchema,
  reviewer: qualityReviewerSchema,
  rubric: qualityRubricSchema,
  verifier: qualityVerifierIdentitySchema,
  failure: qualityFailureSchema,
  producingConfiguration: qualityProducingConfigurationSchema.optional(),
  references: qualityCorrectionReferencesSchema.optional(),
  bindingAttestation: z.enum(["server-bound", "reviewer-confirmed"]),
  binding: qualityBindingSchema,
}).strict();

export const qualityReceiptV2Schema = qualityReceiptV2BaseSchema.superRefine(
  (value, ctx) => {
    const expectedGroup = qualityCorrectionGroupKey({
      taskId: value.taskId,
      attemptId: value.attemptId,
      reviewerPrincipal: value.reviewer.principal,
      reviewerIndependence: value.reviewer.independence,
      rubric: value.rubric,
      binding: value.binding,
    });
    if (value.correctionGroup.digest !== expectedGroup) {
      ctx.addIssue({
        code: "custom",
        path: ["correctionGroup", "digest"],
        message: `correction group mismatch; expected ${expectedGroup}`,
      });
    }
    if (value.receiptId === value.correctsReceiptId) {
      ctx.addIssue({
        code: "custom",
        path: ["correctsReceiptId"],
        message: "quality correction cannot name itself as predecessor",
      });
    }
    const expectedId = qualityCorrectionReceiptId({
      taskId: value.taskId,
      attemptId: value.attemptId,
      rating: value.rating,
      ratingReason: value.ratingReason,
      verificationOutcome: value.verificationOutcome,
      retriesCount: value.retriesCount,
      ratedAt: value.ratedAt,
      reviewer: value.reviewer,
      rubric: value.rubric,
      bindingAttestation: value.bindingAttestation,
      binding: value.binding,
      correctsReceiptId: value.correctsReceiptId,
    });
    if (value.receiptId !== expectedId) {
      ctx.addIssue({
        code: "custom",
        path: ["receiptId"],
        message: `receipt identity mismatch; expected ${expectedId}`,
      });
    }
    const fullyAccepted = value.rating === "pass" &&
      value.verificationOutcome === "accepted_unchanged";
    if (!fullyAccepted && value.failure.code === "none") {
      ctx.addIssue({
        code: "custom",
        path: ["failure", "code"],
        message: "a non-accepted correction requires a structured failure code",
      });
    }
    if (fullyAccepted && value.failure.code !== "none") {
      ctx.addIssue({
        code: "custom",
        path: ["failure", "code"],
        message: "an accepted unchanged correction must use failure code none",
      });
    }
  },
);
export type QualityReceiptV2 = z.infer<typeof qualityReceiptV2Schema>;
export type NativeQualityReceipt = QualityReceipt | QualityReceiptV2;

const qualityReceiptLedgerV1Schema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1).max(200),
  receipts: z.array(qualityReceiptSchema).max(1_000),
  legacyFeedback: z.record(z.string(), z.unknown()).optional(),
}).strict();

const qualityReceiptLedgerV2Schema = z.object({
  schemaVersion: z.literal(2),
  taskId: z.string().min(1).max(200),
  receipts: z.array(z.union([qualityReceiptSchema, qualityReceiptV2Schema])).max(1_000),
  legacyFeedback: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const qualityReceiptLedgerSchema = z.union([
  qualityReceiptLedgerV1Schema,
  qualityReceiptLedgerV2Schema,
]).superRefine((value, ctx) => {
  const ids = new Set<string>();
  const successors = new Set<string>();
  value.receipts.forEach((receipt, index) => {
    if (receipt.taskId !== value.taskId) {
      ctx.addIssue({
        code: "custom",
        path: ["receipts", index, "taskId"],
        message: "receipt task does not match ledger task",
      });
    }
    if (ids.has(receipt.receiptId)) {
      ctx.addIssue({
        code: "custom",
        path: ["receipts", index, "receiptId"],
        message: "duplicate receipt identity",
      });
    }
    ids.add(receipt.receiptId);
    if (receipt.schemaVersion === 2) {
      if (successors.has(receipt.correctsReceiptId)) {
        ctx.addIssue({
          code: "custom",
          path: ["receipts", index, "correctsReceiptId"],
          message: "quality correction lineage cannot fork",
        });
      }
      successors.add(receipt.correctsReceiptId);
    }
  });
  value.receipts.forEach((receipt, index) => {
    if (receipt.schemaVersion !== 2) return;
    const predecessorIndex = value.receipts.findIndex(
      (candidate) => candidate.receiptId === receipt.correctsReceiptId,
    );
    const predecessor = predecessorIndex >= 0 ? value.receipts[predecessorIndex] : undefined;
    if (!predecessor) {
      ctx.addIssue({
        code: "custom",
        path: ["receipts", index, "correctsReceiptId"],
        message: "quality correction predecessor is missing",
      });
      return;
    }
    if (predecessorIndex >= index) {
      ctx.addIssue({
        code: "custom",
        path: ["receipts", index, "correctsReceiptId"],
        message: "quality correction predecessor must appear earlier in the immutable ledger",
      });
    }
    if (
      predecessor.taskId !== receipt.taskId ||
      predecessor.reviewer.principal !== receipt.reviewer.principal ||
      predecessor.reviewer.independence !== receipt.reviewer.independence ||
      !qualityBindingsEqual(predecessor.binding, receipt.binding)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["receipts", index, "correctsReceiptId"],
        message: "quality correction predecessor must retain task, reviewer, and binding",
      });
    }
    if (
      predecessor.schemaVersion === 2 &&
      (
        predecessor.attemptId !== receipt.attemptId ||
        stable(predecessor.rubric) !== stable(receipt.rubric) ||
        predecessor.correctionGroup.digest !== receipt.correctionGroup.digest
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["receipts", index, "correctionGroup"],
        message: "quality correction chain cannot change attempt, rubric, or correction group",
      });
    }
    if (Date.parse(receipt.ratedAt) <= Date.parse(predecessor.ratedAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["receipts", index, "ratedAt"],
        message: "quality correction clock must advance beyond its predecessor",
      });
    }
  });
});
export type QualityReceiptLedger = z.infer<typeof qualityReceiptLedgerSchema>;

const qualityReceiptEvidenceV1Schema = z.object({
  nativeSchemaVersion: z.literal(1),
  receiptId: z.string().regex(/^qr-[0-9a-f]{24}$/),
  rating: z.enum(["pass", "partial", "redo", "wrong"]),
  verificationOutcome: z.enum([
    "accepted_unchanged",
    "minor_edit",
    "major_rewrite",
    "discarded",
    "escalated_to_claude",
  ]),
  ratingReasonSha256: sha256Schema,
  ratedAt: z.string().datetime(),
  reviewer: qualityReviewerSchema,
}).strict();

const qualityReceiptEvidenceV2Schema = qualityReceiptEvidenceV1Schema.omit({
  nativeSchemaVersion: true,
}).extend({
  nativeSchemaVersion: z.literal(2),
  attemptId: z.string().min(1).max(200),
  correctsReceiptId: z.string().regex(/^qr-[0-9a-f]{24}$/),
  correctionGroup: qualityCorrectionGroupSchema,
  rubric: qualityRubricSchema,
  verifier: qualityVerifierIdentitySchema,
  failure: qualityFailureSchema,
  producingConfiguration: qualityProducingConfigurationSchema.optional(),
  references: qualityCorrectionReferencesSchema.optional(),
}).strict();

export const qualityReceiptEvidenceSchema = z.union([
  qualityReceiptEvidenceV1Schema,
  qualityReceiptEvidenceV2Schema,
]);
export type QualityReceiptEvidence = z.infer<typeof qualityReceiptEvidenceSchema>;

export const qualitySummarySchema = z.object({
  state: z.enum([
    "unrated",
    "legacy-unbound",
    "accepted",
    "partial",
    "rejected",
    "conflicted",
    "invalid",
  ]),
  receiptIds: z.array(z.string()).default([]),
  reviewers: z.array(z.string()).default([]),
  independentAccepted: z.boolean().default(false),
  effectiveReceipts: z.array(qualityReceiptEvidenceSchema).default([]),
}).strict();
export type QualitySummary = z.infer<typeof qualitySummarySchema>;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function qualityBindingsEqual(left: QualityBinding, right: QualityBinding): boolean {
  return stable(left) === stable(right);
}

function normalizedMissingRepositoryField(
  state: QualityRepositoryBinding["state"],
  field: "baseBranch" | "baseCommit" | "headCommit" | "diffSha256",
): { value: null; unknown_reason: "not-applicable" | "not-observed" } {
  const notApplicable = state === "not-managed" ||
    (state === "no-changes" && (field === "headCommit" || field === "diffSha256"));
  return {
    value: null,
    unknown_reason: notApplicable ? "not-applicable" : "not-observed",
  };
}

/** Exact snake-case binding used by Grimnir's learning-quality-normalized/v2 projection. */
export function normalizedQualityBinding(binding: QualityBinding) {
  const repository = binding.repository;
  return {
    task_document_sha256: binding.taskDocumentSha256,
    structured_result_sha256: binding.structuredResultSha256,
    repository: {
      state: repository.state,
      base_branch: repository.baseBranch ??
        normalizedMissingRepositoryField(repository.state, "baseBranch"),
      base_commit: repository.baseCommit ??
        normalizedMissingRepositoryField(repository.state, "baseCommit"),
      head_commit: repository.headCommit ??
        normalizedMissingRepositoryField(repository.state, "headCommit"),
      diff_sha256: repository.diffSha256
        ? {
            algorithm: "sha256" as const,
            version: "git-binary-diff-sha256-v1" as const,
            digest: repository.diffSha256,
          }
        : normalizedMissingRepositoryField(repository.state, "diffSha256"),
    },
  };
}

export function buildQualityBinding(input: {
  statusContent: string;
  structuredResultContent: string;
}): QualityBinding {
  const raw = JSON.parse(input.structuredResultContent) as unknown;
  const current = structuredTaskResultSchema.safeParse(raw);
  if (!current.success) {
    z.object({
      task_id: z.string().min(1),
      result_schema_version: z.literal(1),
    }).passthrough().parse(raw);
  }
  const change = current.success ? current.data.repositoryChange : undefined;
  const outcome = current.success ? current.data.repositoryOutcome : undefined;
  const repository: QualityRepositoryBinding = qualityRepositoryBindingSchema.parse({
    state: outcome?.state ?? (change ? "changes-present" : "unknown"),
    baseBranch: change?.baseBranch ?? outcome?.baseBranch,
    baseCommit: change?.baseCommit ?? outcome?.baseCommit,
    headCommit: change?.headCommit,
    diffSha256: change?.diffSha256,
  });
  return qualityBindingSchema.parse({
    taskDocumentSha256: sha256(input.statusContent),
    structuredResultSha256: sha256(input.structuredResultContent),
    repository,
  });
}

export interface BuildQualityReceiptInput {
  taskId: string;
  reviewerPrincipal: string;
  reviewerIndependence: "independent" | "self" | "unknown";
  rating: "pass" | "partial" | "redo" | "wrong";
  ratingReason: string;
  verificationOutcome:
    | "accepted_unchanged"
    | "minor_edit"
    | "major_rewrite"
    | "discarded"
    | "escalated_to_claude";
  retriesCount?: number;
  ratedAt: string;
  bindingAttestation: "server-bound" | "reviewer-confirmed";
  binding: QualityBinding;
}

function qualityReceiptId(input: Omit<BuildQualityReceiptInput, "ratedAt">): string {
  return `qr-${sha256(stable(input)).slice(0, 24)}`;
}

export function buildQualityReceipt(input: BuildQualityReceiptInput): QualityReceipt {
  const semanticPayload: Omit<BuildQualityReceiptInput, "ratedAt"> = {
    taskId: input.taskId,
    reviewerPrincipal: input.reviewerPrincipal,
    reviewerIndependence: input.reviewerIndependence,
    rating: input.rating,
    ratingReason: input.ratingReason,
    verificationOutcome: input.verificationOutcome,
    retriesCount: input.retriesCount,
    bindingAttestation: input.bindingAttestation,
    binding: input.binding,
  };
  return qualityReceiptSchema.parse({
    schemaVersion: 1,
    receiptId: qualityReceiptId(semanticPayload),
    taskId: input.taskId,
    rating: input.rating,
    ratingReason: input.ratingReason,
    verificationOutcome: input.verificationOutcome,
    ...(input.retriesCount !== undefined ? { retriesCount: input.retriesCount } : {}),
    ratedAt: input.ratedAt,
    reviewer: {
      principal: input.reviewerPrincipal,
      independence: input.reviewerIndependence,
    },
    bindingAttestation: input.bindingAttestation,
    binding: input.binding,
  });
}

export interface BuildQualityCorrectionReceiptInput {
  taskId: string;
  attemptId: string;
  correctsReceiptId: string;
  reviewerPrincipal: string;
  reviewerIndependence: "independent" | "self" | "unknown";
  rating: "pass" | "partial" | "redo" | "wrong";
  ratingReason: string;
  verificationOutcome:
    | "accepted_unchanged"
    | "minor_edit"
    | "major_rewrite"
    | "discarded"
    | "escalated_to_claude";
  retriesCount?: number;
  ratedAt: string;
  rubric: QualityRubric;
  verifier: QualityVerifierIdentity;
  failure: QualityFailure;
  producingConfiguration?: QualityProducingConfiguration;
  references?: QualityCorrectionReferences;
  bindingAttestation: "server-bound" | "reviewer-confirmed";
  binding: QualityBinding;
}

function qualityCorrectionGroupKey(input: {
  taskId: string;
  attemptId: string;
  reviewerPrincipal: string;
  reviewerIndependence: "independent" | "self" | "unknown";
  rubric: QualityRubric;
  binding: QualityBinding;
}): string {
  return sha256(canonicalizeJcs({
    task_id: input.taskId,
    attempt_id: input.attemptId,
    reviewer: {
      principal: input.reviewerPrincipal,
      independence: input.reviewerIndependence,
    },
    rubric: input.rubric,
    binding: normalizedQualityBinding(input.binding),
  }));
}

interface QualityCorrectionReceiptIdentityPayload {
  taskId: string;
  attemptId: string;
  rating: BuildQualityCorrectionReceiptInput["rating"];
  ratingReason: string;
  verificationOutcome: BuildQualityCorrectionReceiptInput["verificationOutcome"];
  retriesCount?: number;
  ratedAt: string;
  reviewer: {
    principal: string;
    independence: BuildQualityCorrectionReceiptInput["reviewerIndependence"];
  };
  rubric: QualityRubric;
  bindingAttestation: BuildQualityCorrectionReceiptInput["bindingAttestation"];
  binding: QualityBinding;
  correctsReceiptId: string;
}

/** Exact future-native-v2 identity body accepted by Grimnir #86. */
function qualityCorrectionReceiptId(
  input: QualityCorrectionReceiptIdentityPayload,
): string {
  return `qr-${sha256(canonicalizeJcs(input)).slice(0, 24)}`;
}

export function buildQualityCorrectionReceipt(
  input: BuildQualityCorrectionReceiptInput,
): QualityReceiptV2 {
  const identityPayload: QualityCorrectionReceiptIdentityPayload = {
    taskId: input.taskId,
    attemptId: input.attemptId,
    rating: input.rating,
    ratingReason: input.ratingReason,
    verificationOutcome: input.verificationOutcome,
    retriesCount: input.retriesCount,
    ratedAt: input.ratedAt,
    reviewer: {
      principal: input.reviewerPrincipal,
      independence: input.reviewerIndependence,
    },
    rubric: input.rubric,
    bindingAttestation: input.bindingAttestation,
    binding: input.binding,
    correctsReceiptId: input.correctsReceiptId,
  };
  return qualityReceiptV2Schema.parse({
    schemaVersion: 2,
    receiptId: qualityCorrectionReceiptId(identityPayload),
    taskId: input.taskId,
    attemptId: input.attemptId,
    correctsReceiptId: input.correctsReceiptId,
    correctionGroup: {
      algorithm: "sha256",
      version: "quality-correction-group-jcs-v1",
      digest: qualityCorrectionGroupKey({
        taskId: input.taskId,
        attemptId: input.attemptId,
        reviewerPrincipal: input.reviewerPrincipal,
        reviewerIndependence: input.reviewerIndependence,
        rubric: input.rubric,
        binding: input.binding,
      }),
    },
    rating: input.rating,
    ratingReason: input.ratingReason,
    verificationOutcome: input.verificationOutcome,
    ...(input.retriesCount !== undefined ? { retriesCount: input.retriesCount } : {}),
    ratedAt: input.ratedAt,
    reviewer: {
      principal: input.reviewerPrincipal,
      independence: input.reviewerIndependence,
    },
    rubric: input.rubric,
    verifier: input.verifier,
    failure: input.failure,
    ...(input.producingConfiguration
      ? { producingConfiguration: input.producingConfiguration }
      : {}),
    ...(input.references ? { references: input.references } : {}),
    bindingAttestation: input.bindingAttestation,
    binding: input.binding,
  });
}

export class QualityReceiptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityReceiptConflictError";
  }
}

export class QualityReceiptInvalidLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityReceiptInvalidLedgerError";
  }
}

export function foldQualityReceipt(
  current: QualityReceiptLedger | Record<string, unknown> | null,
  next: NativeQualityReceipt,
): { ledger: QualityReceiptLedger; changed: boolean } {
  let ledger: QualityReceiptLedger;
  const parsed = qualityReceiptLedgerSchema.safeParse(current);
  if (parsed.success) {
    ledger = parsed.data;
  } else if (current && typeof current === "object" && !Array.isArray(current)) {
    if (
      current.schemaVersion === 1 ||
      current.schemaVersion === 2 ||
      Object.hasOwn(current, "taskId") ||
      Object.hasOwn(current, "receipts")
    ) {
      throw new QualityReceiptInvalidLedgerError(
        "stored quality receipt ledger is invalid",
      );
    }
    if (next.schemaVersion === 2) {
      throw new QualityReceiptConflictError(
        "quality correction predecessor is missing",
      );
    }
    ledger = qualityReceiptLedgerSchema.parse({
      schemaVersion: 1,
      taskId: next.taskId,
      receipts: [],
      legacyFeedback: current,
    });
  } else {
    if (next.schemaVersion === 2) {
      throw new QualityReceiptConflictError(
        "quality correction predecessor is missing",
      );
    }
    ledger = qualityReceiptLedgerSchema.parse({
      schemaVersion: 1,
      taskId: next.taskId,
      receipts: [],
    });
  }
  if (ledger.taskId !== next.taskId) {
    throw new QualityReceiptConflictError("quality receipt task does not match the ledger");
  }
  const replayedReceipt = ledger.receipts.find(
    (receipt) => receipt.receiptId === next.receiptId,
  );
  if (replayedReceipt) {
    if (
      (replayedReceipt.schemaVersion === 2 || next.schemaVersion === 2) &&
      canonicalizeJcs(replayedReceipt) !== canonicalizeJcs(next)
    ) {
      throw new QualityReceiptConflictError(
        `quality receipt identity collision for ${next.receiptId}: canonical artifacts differ`,
      );
    }
    return { ledger, changed: false };
  }
  if (next.schemaVersion === 1) {
    const priorVerdict = ledger.receipts.find(
      (receipt) =>
        receipt.reviewer.principal === next.reviewer.principal &&
        qualityBindingsEqual(receipt.binding, next.binding),
    );
    if (priorVerdict) {
      throw new QualityReceiptConflictError(
        `reviewer ${next.reviewer.principal} already rated this exact result`,
      );
    }
  } else {
    const predecessor = ledger.receipts.find(
      (receipt) => receipt.receiptId === next.correctsReceiptId,
    );
    if (!predecessor) {
      throw new QualityReceiptConflictError(
        `quality correction predecessor ${next.correctsReceiptId} is missing`,
      );
    }
    if (
      predecessor.taskId !== next.taskId ||
      predecessor.reviewer.principal !== next.reviewer.principal ||
      predecessor.reviewer.independence !== next.reviewer.independence ||
      !qualityBindingsEqual(predecessor.binding, next.binding)
    ) {
      throw new QualityReceiptConflictError(
        "quality correction predecessor must retain task, reviewer, and binding",
      );
    }
    if (ledger.receipts.some(
      (receipt) =>
        receipt.schemaVersion === 2 &&
        receipt.correctsReceiptId === next.correctsReceiptId,
    )) {
      throw new QualityReceiptConflictError(
        `quality correction predecessor ${next.correctsReceiptId} already has a successor`,
      );
    }
    if (
      predecessor.schemaVersion === 2 &&
      (
        predecessor.attemptId !== next.attemptId ||
        stable(predecessor.rubric) !== stable(next.rubric) ||
        predecessor.correctionGroup.digest !== next.correctionGroup.digest
      )
    ) {
      throw new QualityReceiptConflictError(
        "quality correction chain cannot change attempt, rubric, or correction group",
      );
    }
    if (Date.parse(next.ratedAt) <= Date.parse(predecessor.ratedAt)) {
      throw new QualityReceiptConflictError(
        "quality correction clock must advance beyond its predecessor",
      );
    }
  }
  const schemaVersion = ledger.schemaVersion === 2 || next.schemaVersion === 2 ? 2 : 1;
  return {
    ledger: qualityReceiptLedgerSchema.parse({
      ...ledger,
      schemaVersion,
      receipts: [...ledger.receipts, next],
    }),
    changed: true,
  };
}

export function summarizeQualityReceipts(
  feedbackContent: string | null | undefined,
  binding: QualityBinding,
): QualitySummary {
  if (!feedbackContent) return qualitySummarySchema.parse({ state: "unrated" });
  let raw: unknown;
  try {
    raw = JSON.parse(feedbackContent);
  } catch {
    return qualitySummarySchema.parse({ state: "invalid" });
  }
  const ledger = qualityReceiptLedgerSchema.safeParse(raw);
  if (!ledger.success) {
    const legacy = z.object({ rating: z.string() }).passthrough().safeParse(raw);
    return qualitySummarySchema.parse({
      state: legacy.success ? "legacy-unbound" : "invalid",
    });
  }
  const receipts = ledger.data.receipts.filter((receipt) => qualityBindingsEqual(receipt.binding, binding));
  if (receipts.length === 0) {
    return qualitySummarySchema.parse({
      state: ledger.data.legacyFeedback ? "legacy-unbound" : "invalid",
    });
  }
  const superseded = new Set(
    receipts.flatMap((receipt) =>
      receipt.schemaVersion === 2 ? [receipt.correctsReceiptId] : []),
  );
  const effective = receipts.filter((receipt) => !superseded.has(receipt.receiptId));
  const verdicts = effective.map((receipt) => {
    if (
      receipt.rating === "wrong" ||
      receipt.rating === "redo" ||
      receipt.verificationOutcome === "discarded"
    ) return "rejected" as const;
    if (
      receipt.rating === "pass" &&
      receipt.verificationOutcome === "accepted_unchanged"
    ) return "accepted" as const;
    return "partial" as const;
  });
  const fullVerdicts = new Set(
    effective.map((receipt) => `${receipt.rating}\0${receipt.verificationOutcome}`),
  );
  const rubricCohorts = new Set(
    effective.map((receipt) => receipt.schemaVersion === 1
      ? "native-v1-unversioned"
      : stable(receipt.rubric)),
  );
  // Multiple rubric cohorts are incomparable under LearningTaskContract v1.
  // Fail closed even when their verdicts agree; this is not evidence that the
  // reviewers themselves disagreed.
  const state = fullVerdicts.size === 1 && rubricCohorts.size === 1
    ? verdicts[0]!
    : "conflicted";
  return qualitySummarySchema.parse({
    state,
    receiptIds: effective.map((receipt) => receipt.receiptId),
    reviewers: [...new Set(effective.map((receipt) => receipt.reviewer.principal))].sort(),
    independentAccepted:
      state === "accepted" && effective.some(
        (receipt) => receipt.reviewer.independence === "independent",
      ),
    effectiveReceipts: effective.map((receipt): QualityReceiptEvidence => {
      const common = {
        nativeSchemaVersion: receipt.schemaVersion,
        receiptId: receipt.receiptId,
        rating: receipt.rating,
        verificationOutcome: receipt.verificationOutcome,
        ratingReasonSha256: sha256(receipt.ratingReason),
        ratedAt: receipt.ratedAt,
        reviewer: receipt.reviewer,
      };
      if (receipt.schemaVersion === 1) {
        return qualityReceiptEvidenceSchema.parse(common);
      }
      return qualityReceiptEvidenceSchema.parse({
        ...common,
        attemptId: receipt.attemptId,
        correctsReceiptId: receipt.correctsReceiptId,
        correctionGroup: receipt.correctionGroup,
        rubric: receipt.rubric,
        verifier: receipt.verifier,
        failure: receipt.failure,
        ...(receipt.producingConfiguration
          ? { producingConfiguration: receipt.producingConfiguration }
          : {}),
        ...(receipt.references ? { references: receipt.references } : {}),
      });
    }),
  });
}
