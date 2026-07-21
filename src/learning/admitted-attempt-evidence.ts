/**
 * Shared read of one Hugin attempt's admitted LearningTaskContract evidence
 * row (`learning-task-handshake.ts`'s `LearningTaskExecutionEvidence`), keyed
 * by the #232 registry's own `RegistryEvidenceRef` (the `attempt-reference`/
 * `terminal-outcome` payload's optional `attemptOutcomeRef`).
 *
 * Used by BOTH the #272 candidate-pool assembler
 * (`candidate-pool-assembler.ts`, to recover the prompt/harness/tool-policy
 * identity a `LearningConfiguration` needs) and the #272 gille outcome-export
 * evidence resolver (`gille-outcome-evidence-resolver.ts`, to recover the
 * same fields for gille-inference#8's nine-field evidence-identity bundle) --
 * one read-only resolution, not two independently drifting copies.
 *
 * Read-only, content-blind at the caller boundary: this returns the FULL
 * durable evidence row, which itself only ever carries digests/labels, never
 * raw prompt bytes (`DurableLearningTaskAttemptStart` deliberately omits
 * `renderedPrompt` -- see learning-task-handshake.ts's own module doc). A row
 * that is not `state: "m5-admitted"` / `evidenceAccepted: true` is treated as
 * unresolved (`null`), never partially trusted: a preflight-failed or
 * join-failed attempt never produced a genuinely admitted identity, and
 * `evidenceAccepted` can only be `true` together with `state ===
 * "m5-admitted"` per that schema's own superRefine. The caller's `taskId`/
 * `attemptId` are additionally cross-checked against the resolved row's own
 * identity -- a misdirected or stale ref (e.g. two registry events
 * accidentally pointing at the same Munin key) must never silently donate
 * one attempt's evidence to a different attempt.
 */

import type { MuninClient } from "../munin-client.js";
import {
  learningTaskExecutionEvidenceSchema,
  type LearningTaskExecutionEvidence,
} from "../learning-task-handshake.js";
import type { RegistryEvidenceRef } from "../learning-registry-schema.js";

export async function resolveAdmittedAttemptOutcomeEvidence(
  munin: Pick<MuninClient, "read">,
  ref: RegistryEvidenceRef,
  identity: { taskId: string; attemptId: string },
): Promise<LearningTaskExecutionEvidence | null> {
  const entry = await munin.read(ref.namespace, ref.key);
  if (!entry) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(entry.content);
  } catch {
    return null;
  }
  const parsed = learningTaskExecutionEvidenceSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.state !== "m5-admitted" || !parsed.data.evidenceAccepted) return null;
  if (parsed.data.taskId !== identity.taskId || parsed.data.attemptId !== identity.attemptId) return null;
  return parsed.data;
}
