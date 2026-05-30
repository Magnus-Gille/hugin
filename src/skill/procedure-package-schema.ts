import { z } from "zod";
import { egressClassSchema } from "./refs.js";

// Runtime-neutral procedure-package format (A3 / issue #80).
// Source-of-truth: skills/<id>/package.yaml (validated by this schema).
// The promoted unit is the *profile* compiled from this package — never the
// raw package itself. See docs/design/skill-distillation-implementation.md §A3.

export const procedurePackageSchema = z.object({
  schemaVersion: z.literal(1),
  skillId: z.string().min(1),
  title: z.string(),
  taskClassId: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  toolAllowlist: z.array(z.string().min(1)),
  steps: z
    .array(
      z.object({
        id: z.string(),
        instruction: z.string(),
        checkpoint: z.string(),
      }),
    )
    .min(1),
  examples: z
    .array(z.object({ input: z.unknown(), output: z.unknown() }))
    .min(1),
  antiExamples: z
    .array(
      z.object({
        input: z.unknown(),
        why: z.string(),
      }),
    )
    .min(1),
  abortConditions: z.array(z.string()).min(1),
  contraindications: z.array(z.string()).default([]),
  egressClass: egressClassSchema,
  evalSuiteId: z.string().min(1),
});

export type ProcedurePackage = z.infer<typeof procedurePackageSchema>;
