import { z } from "zod";
import { contentHash, sha256HexSchema, egressClassSchema } from "./refs.js";
import {
  procedurePackageSchema,
  type ProcedurePackage,
} from "./procedure-package-schema.js";

// pi-local-30b compiled profile (A3 / issue #80).
// Compiled from a ProcedurePackage via compileProfile(); the promoted unit is
// always the *profile*, never the raw package.
// See docs/design/skill-distillation-implementation.md §A3.

export const piLocal30bProfileSchema = z.object({
  schemaVersion: z.literal(1),
  skillId: z.string(),
  profileId: z.string(),
  sourcePackageHash: sha256HexSchema,
  profileHash: sha256HexSchema,
  systemPreamble: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  toolAllowlist: z.array(z.string()),
  stepList: z.array(
    z.object({
      id: z.string(),
      prompt: z.string(),
      checkpointAssertion: z.string(),
    }),
  ),
  examples: z.array(z.unknown()),
  antiExamples: z.array(z.unknown()),
  abortConditions: z.array(z.string()),
  maxContextChars: z.number().int().positive(),
  expectedArtifacts: z.array(z.string()),
  perStepGraderHooks: z
    .array(z.object({ stepId: z.string(), graderRef: z.string() }))
    .default([]),
  // Carry the egress class through so callers can enforce policy without
  // re-reading the package.
  egressClass: egressClassSchema,
});

export type PiLocal30bProfile = z.infer<typeof piLocal30bProfileSchema>;

// ---------------------------------------------------------------------------
// validatePackage — zod parse + structural checks
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw value as a ProcedurePackage.
 * Throws a ZodError on schema violations, or an Error on structural violations
 * (e.g. duplicate step ids, empty toolAllowlist).
 */
export function validatePackage(raw: unknown): ProcedurePackage {
  const pkg = procedurePackageSchema.parse(raw);

  // Structural check: step ids must be unique.
  const stepIds = pkg.steps.map((s) => s.id);
  const uniqueIds = new Set(stepIds);
  if (uniqueIds.size !== stepIds.length) {
    const dups = stepIds.filter((id, i) => stepIds.indexOf(id) !== i);
    throw new Error(
      `ProcedurePackage structural error: duplicate step ids: ${[...new Set(dups)].join(", ")}`,
    );
  }

  // Structural check: toolAllowlist must be non-empty (a package with an
  // empty allowlist cannot safely be compiled into a pi-local-30b profile
  // — the profile would permit no tools at all, making execution impossible).
  if (pkg.toolAllowlist.length === 0) {
    throw new Error(
      "ProcedurePackage structural error: toolAllowlist must be non-empty",
    );
  }

  return pkg;
}

// ---------------------------------------------------------------------------
// compileProfile — pure, deterministic
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONTEXT_CHARS = 32_000;

/**
 * Compile a validated ProcedurePackage into a pi-local-30b profile.
 *
 * PURE + DETERMINISTIC: no Date.now(), no Math.random(), no external I/O.
 * The same pkg always produces the identical profile (and therefore the
 * identical profileHash), which is what makes drift detection in A2 reliable.
 *
 * profileHash stability contract:
 *   1. Build the entire profile object WITHOUT the profileHash field.
 *   2. contentHash() that object → the hash value.
 *   3. Attach profileHash to the returned object.
 *   4. The hash covers everything except itself, so it is self-consistent
 *      and reproducible: profileHash(compileProfile(pkg)) === profile.profileHash.
 */
export function compileProfile(
  pkg: ProcedurePackage,
  target: "pi-local-30b",
): PiLocal30bProfile {
  void target; // only one target today; kept for future additive targets

  const sourcePackageHash = contentHash(pkg);

  // Derive expectedArtifacts from outputSchema keys + any step ids that look
  // like they produce artifacts (step ids ending in "-output" or "-artifact").
  // This is a lightweight heuristic; slice-one authored packages should list
  // explicit outputSchema keys.
  const expectedArtifacts = deriveExpectedArtifacts(pkg);

  // Build the profile body WITHOUT profileHash.
  const profileBody: Omit<PiLocal30bProfile, "profileHash"> = {
    schemaVersion: 1,
    skillId: pkg.skillId,
    profileId: `${pkg.skillId}:pi-local-30b`,
    sourcePackageHash,
    systemPreamble: buildSystemPreamble(pkg),
    inputSchema: pkg.inputSchema,
    outputSchema: pkg.outputSchema,
    toolAllowlist: pkg.toolAllowlist,
    stepList: pkg.steps.map((step) => ({
      id: step.id,
      prompt: step.instruction,
      checkpointAssertion: step.checkpoint,
    })),
    examples: pkg.examples,
    antiExamples: pkg.antiExamples,
    abortConditions: pkg.abortConditions,
    maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
    expectedArtifacts,
    perStepGraderHooks: [],
    egressClass: pkg.egressClass,
  };

  // Hash the body (excludes profileHash) — stable, no external entropy.
  const hash = contentHash(profileBody);

  return { ...profileBody, profileHash: hash };
}

// ---------------------------------------------------------------------------
// profileHash — recompute the content address for verification
// ---------------------------------------------------------------------------

/**
 * Recompute the content address of a profile for drift verification.
 *
 * Strips the profile's own `profileHash` field before hashing so the result
 * agrees with what compileProfile() embedded. This lets callers check:
 *   profileHash(profile) === profile.profileHash
 * to detect any mutation after compilation.
 */
export function profileHash(profile: PiLocal30bProfile): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { profileHash: _excluded, ...body } = profile;
  return contentHash(body);
}

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

function buildSystemPreamble(pkg: ProcedurePackage): string {
  const lines: string[] = [
    `You are a constrained operator executing the "${pkg.title}" skill (id: ${pkg.skillId}).`,
    ``,
    `Your task class is: ${pkg.taskClassId}`,
    `Egress class: ${pkg.egressClass} (you MUST NOT make network calls beyond what this permits).`,
    ``,
    `Allowed tools: ${pkg.toolAllowlist.join(", ")}.`,
    `You MUST NOT call any tool not in this allowlist.`,
    ``,
    `Abort immediately if any of the following conditions are true:`,
    ...pkg.abortConditions.map((c) => `  - ${c}`),
    ``,
    `Do NOT use this skill if any of the following apply (anti-examples exist to guide you):`,
    ...pkg.antiExamples.map((ae) => `  - ${ae.why}`),
    ``,
    `Proceed step by step. After each step, verify the checkpoint before continuing.`,
    `Do not improvise beyond the defined steps.`,
  ];

  if (pkg.contraindications.length > 0) {
    lines.push(``, `Contraindications (do not proceed if any hold):`);
    pkg.contraindications.forEach((c) => lines.push(`  - ${c}`));
  }

  return lines.join("\n");
}

function deriveExpectedArtifacts(pkg: ProcedurePackage): string[] {
  // Prefer explicit outputSchema keys as the primary artifact list.
  const schemaKeys = Object.keys(pkg.outputSchema);
  if (schemaKeys.length > 0) return schemaKeys;

  // Fallback: steps whose id ends with a common artifact suffix.
  const artifactSuffixes = ["-output", "-artifact", "-result", "-patch", "-file"];
  return pkg.steps
    .filter((s) => artifactSuffixes.some((suffix) => s.id.endsWith(suffix)))
    .map((s) => s.id);
}
