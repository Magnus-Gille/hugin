/**
 * Shared resolution of the currently-EFFECTIVE, binding-matched quality
 * receipt for one Hugin task/attempt (issue #216's append-only ledger,
 * durable at `tasks/<taskId>` / `feedback`).
 *
 * Mirrors `quality-receipt.ts`'s own `summarizeQualityReceipts`
 * correction-chain-resolution rule (a schemaVersion-2 correction supersedes
 * the receipt it names in `correctsReceiptId`), but returns the NATIVE
 * receipt object. `summarizeQualityReceipts` intentionally strips free-text
 * `ratingReason` into a hash for its own dashboard-facing
 * `QualityReceiptEvidence` view -- the wrong shape for
 * `PackagerCandidateInput.qualityReceipt` (candidate-packager-schema.ts),
 * whose caller is trusted to hold the native receipt transiently in memory
 * (see `candidate-packager.ts`'s `qualifyCandidate` doc comment) even though
 * the package it eventually freezes only ever projects `receiptId`/`rating`
 * out of it -- content-blindness is enforced at the FROZEN PACKAGE boundary,
 * not this transient in-memory candidate.
 *
 * Used by both the #272 candidate-pool assembler and the #272 gille
 * outcome-export evidence resolver (which needs a v2 receipt's `rubric` for
 * gille-inference#8's `verifierRubric` identity field).
 */

import type { MuninClient } from "../munin-client.js";
import {
  buildQualityBinding,
  qualityBindingsEqual,
  qualityReceiptLedgerSchema,
  type NativeQualityReceipt,
} from "../quality-receipt.js";

/**
 * `null` when the task's status/result documents are missing (nothing to
 * bind against), the feedback ledger is missing/unreadable/unparseable, no
 * receipt is bound to the CURRENT task content, or no bound receipt survives
 * as the effective one for this exact attempt. Never fabricates or guesses.
 *
 * A schemaVersion-2 (attempt-bound) effective receipt naming this exact
 * `attemptId` wins. Otherwise a legacy schemaVersion-1 (task-level, no
 * attempt binding) effective receipt applies -- mirroring
 * `qualifyCandidate`'s own permissive rule for v1 receipts (candidate-
 * packager.ts: it only checks `receipt.taskId`, never an attempt id, for
 * schemaVersion 1). Multiple equally-eligible effective receipts (e.g. two
 * independent reviewers, neither superseding the other) are broken by most-
 * recent `ratedAt` -- a documented simplification, not a fabrication: every
 * candidate receipt considered is itself completely real.
 */
export async function resolveEffectiveQualityReceipt(
  munin: Pick<MuninClient, "read">,
  taskId: string,
  attemptId: string,
): Promise<NativeQualityReceipt | null> {
  const namespace = `tasks/${taskId}`;
  const [statusEntry, resultEntry, feedbackEntry] = await Promise.all([
    munin.read(namespace, "status"),
    munin.read(namespace, "result-structured"),
    munin.read(namespace, "feedback"),
  ]);
  if (!statusEntry || !resultEntry || !feedbackEntry) return null;

  let binding: ReturnType<typeof buildQualityBinding>;
  try {
    binding = buildQualityBinding({
      statusContent: statusEntry.content,
      structuredResultContent: resultEntry.content,
    });
  } catch {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(feedbackEntry.content);
  } catch {
    return null;
  }
  const ledger = qualityReceiptLedgerSchema.safeParse(raw);
  if (!ledger.success) return null;

  const bound = ledger.data.receipts.filter((receipt) => qualityBindingsEqual(receipt.binding, binding));
  if (bound.length === 0) return null;
  const superseded = new Set(
    bound.flatMap((receipt) => (receipt.schemaVersion === 2 ? [receipt.correctsReceiptId] : [])),
  );
  const effective = bound.filter((receipt) => !superseded.has(receipt.receiptId));
  if (effective.length === 0) return null;

  const attemptBound = effective
    .filter((receipt) => receipt.schemaVersion === 2 && receipt.attemptId === attemptId)
    .sort((a, b) => b.ratedAt.localeCompare(a.ratedAt));
  if (attemptBound.length > 0) return attemptBound[0]!;

  const taskLevel = effective
    .filter((receipt) => receipt.schemaVersion === 1)
    .sort((a, b) => b.ratedAt.localeCompare(a.ratedAt));
  return taskLevel[0] ?? null;
}
