/** Content-blind, append-only post-run quality receipts (issue #216). */

import { createHash } from "node:crypto";
import { z } from "zod";
import { structuredTaskResultSchema } from "./task-result-schema.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const commitSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

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
  reviewer: z.object({
    principal: z.string().min(1).max(200),
    independence: z.enum(["independent", "self", "unknown"]),
  }).strict(),
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

export const qualityReceiptLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1).max(200),
  receipts: z.array(qualityReceiptSchema).max(1_000),
  legacyFeedback: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
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
  });
});
export type QualityReceiptLedger = z.infer<typeof qualityReceiptLedgerSchema>;

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
  next: QualityReceipt,
): { ledger: QualityReceiptLedger; changed: boolean } {
  let ledger: QualityReceiptLedger;
  const parsed = qualityReceiptLedgerSchema.safeParse(current);
  if (parsed.success) {
    ledger = parsed.data;
  } else if (current && typeof current === "object" && !Array.isArray(current)) {
    if (
      current.schemaVersion === 1 ||
      Object.hasOwn(current, "taskId") ||
      Object.hasOwn(current, "receipts")
    ) {
      throw new QualityReceiptInvalidLedgerError(
        "stored schema-v1 quality receipt ledger is invalid",
      );
    }
    ledger = qualityReceiptLedgerSchema.parse({
      schemaVersion: 1,
      taskId: next.taskId,
      receipts: [],
      legacyFeedback: current,
    });
  } else {
    ledger = qualityReceiptLedgerSchema.parse({
      schemaVersion: 1,
      taskId: next.taskId,
      receipts: [],
    });
  }
  if (ledger.taskId !== next.taskId) {
    throw new QualityReceiptConflictError("quality receipt task does not match the ledger");
  }
  if (ledger.receipts.some((receipt) => receipt.receiptId === next.receiptId)) {
    return { ledger, changed: false };
  }
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
  return {
    ledger: qualityReceiptLedgerSchema.parse({
      ...ledger,
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
  const verdicts = receipts.map((receipt) => {
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
  const distinct = new Set(verdicts);
  const state = distinct.size === 1 ? verdicts[0]! : "conflicted";
  return qualitySummarySchema.parse({
    state,
    receiptIds: receipts.map((receipt) => receipt.receiptId),
    reviewers: [...new Set(receipts.map((receipt) => receipt.reviewer.principal))].sort(),
    independentAccepted:
      state === "accepted" && receipts.some(
        (receipt) => receipt.reviewer.independence === "independent",
      ),
  });
}
