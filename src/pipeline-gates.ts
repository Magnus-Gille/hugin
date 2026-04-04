import { z } from "zod";
import {
  pipelineAuthoritySchema,
  pipelineSideEffectIdSchema,
} from "./pipeline-ir.js";

export const phaseApprovalRequestSchema = z.object({
  schemaVersion: z.literal(1),
  pipelineId: z.string().min(1),
  phaseName: z.string().min(1),
  phaseTaskId: z.string().min(1),
  authority: pipelineAuthoritySchema,
  sideEffects: z.array(pipelineSideEffectIdSchema).default([]),
  status: z.literal("pending"),
  requestedAt: z.string().min(1),
  requestedByWorker: z.string().min(1),
  replyTo: z.string().min(1).optional(),
  replyFormat: z.string().min(1).optional(),
  operationKey: z.string().min(1),
  summary: z.object({
    runtime: z.string().min(1),
    context: z.string().min(1).optional(),
    promptPreview: z.string().min(1),
    dependencyTaskIds: z.array(z.string().min(1)).default([]),
  }),
});
export type PhaseApprovalRequest = z.infer<typeof phaseApprovalRequestSchema>;

export const phaseApprovalDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  pipelineId: z.string().min(1),
  phaseTaskId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  decidedAt: z.string().min(1),
  decidedBy: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  comment: z.string().min(1).optional(),
});
export type PhaseApprovalDecision = z.infer<typeof phaseApprovalDecisionSchema>;

export function parsePhaseApprovalDecision(
  content: string
): PhaseApprovalDecision | null {
  try {
    return phaseApprovalDecisionSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

export function parsePhaseApprovalRequest(
  content: string
): PhaseApprovalRequest | null {
  try {
    return phaseApprovalRequestSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

export function buildPhaseOperationKey(
  pipelineId: string,
  phaseTaskId: string
): string {
  return `${pipelineId}:${phaseTaskId}`;
}

export function buildPromptPreview(prompt: string, maxLength = 160): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

export function buildPhaseApprovalRequestContent(
  input: Omit<PhaseApprovalRequest, "schemaVersion">
): string {
  return JSON.stringify(
    phaseApprovalRequestSchema.parse({
      schemaVersion: 1,
      ...input,
    }),
    null,
    2
  );
}
