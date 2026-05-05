/**
 * Schema for the friction-mcp `report_friction` tool.
 *
 * The friction taxonomy splits into three categories:
 *   - capability:    the model hit its own limits (reasoning, knowledge, context, tools, confidence)
 *   - environment:   something outside the model failed (tool errors, perms, connectivity)
 *   - specification: the task itself was unclear or contradictory
 *
 * `alias_suggested` reuses the broker's alias vocabulary so the field
 * can drive routing without a free-form translation step.
 */

import { z } from "zod";
import { aliasSchema } from "../broker/types.js";

export const frictionTypeSchema = z.enum([
  // capability
  "reasoning_limit",
  "knowledge_gap",
  "context_window_limit",
  "tool_missing",
  "confidence_low",
  // environment
  "tool_failure",
  "permission_denied",
  "connectivity",
  // specification
  "ambiguity",
  "prerequisite_missing",
  "scope_mismatch",
]);
export type FrictionType = z.infer<typeof frictionTypeSchema>;

export type FrictionCategory = "capability" | "environment" | "specification";

export const FRICTION_CATEGORY: Record<FrictionType, FrictionCategory> = {
  reasoning_limit: "capability",
  knowledge_gap: "capability",
  context_window_limit: "capability",
  tool_missing: "capability",
  confidence_low: "capability",
  tool_failure: "environment",
  permission_denied: "environment",
  connectivity: "environment",
  ambiguity: "specification",
  prerequisite_missing: "specification",
  scope_mismatch: "specification",
};

export const severitySchema = z.enum(["low", "medium", "high", "blocking"]);
export type Severity = z.infer<typeof severitySchema>;

export const resourceAssessmentSchema = z.enum([
  "under-resourced",
  "appropriate",
  "over-resourced",
]);
export type ResourceAssessment = z.infer<typeof resourceAssessmentSchema>;

export const reportFrictionInputShape = {
  friction_type: frictionTypeSchema.describe(
    "The category of friction. capability: model limits. environment: external failure. specification: task unclear.",
  ),
  severity: severitySchema.describe(
    "low: noticed but coped; output unaffected. medium: slowed down or had to simplify; output mostly unaffected. high: had to drop or guess part of the task. blocking: could not proceed without external help.",
  ),
  summary: z
    .string()
    .min(1)
    .max(500)
    .describe("One-sentence headline of the friction."),
  detail: z
    .string()
    .min(1)
    .max(8_000)
    .describe("What you tried, what failed, and what would have made this easier."),
  resource_assessment: resourceAssessmentSchema
    .optional()
    .describe(
      "Honest self-assessment: was the model assigned to this task appropriately matched to the difficulty? Skip if unsure.",
    ),
  alias_suggested: aliasSchema
    .optional()
    .describe(
      "If under-resourced, which alias from {tiny, medium, large-reasoning, pi-large-coder} would have helped? Skip if unsure.",
    ),
  tool_name: z
    .string()
    .max(120)
    .optional()
    .describe("Tool that failed or was missing (only for tool_failure/tool_missing)."),
  task_id: z
    .string()
    .max(200)
    .optional()
    .describe("Override for HUGIN_FRICTION_TASK_ID env."),
  tags: z
    .array(z.string().max(80))
    .max(16)
    .optional()
    .describe("Extra free-form tags appended to the Munin entry."),
};

export const reportFrictionInputSchema = z.object(reportFrictionInputShape);
export type ReportFrictionInput = z.infer<typeof reportFrictionInputSchema>;

export const FRICTION_SCHEMA_VERSION = 1 as const;
