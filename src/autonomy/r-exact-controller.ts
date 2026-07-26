/** Crash-safe, adapter-neutral R-exact controller (hugin#330). */
import { z } from "zod";
import { canonicalizeJcs } from "../jcs.js";
import { MuninWriteRejectedError, type MuninClient } from "../munin-client.js";
import { proposalTargetRegistry, verifyAutonomyProposalReceipt, type AutonomyProposalReceipt } from "./proposal-receipts.js";
import type { KeyStore } from "../task-signing.js";

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ref = z.string().regex(/^ref:[a-z][a-z0-9-]{2,120}$/);
const stateSchema = z.enum(["prepared", "applied", "verified", "committed", "reverting", "reverted", "blocked"]);
export type RExactState = z.infer<typeof stateSchema>;

export interface RExactConfigTarget {
  id: string; owner: "hugin"; axis: string;
  read(): Promise<{ revision: string; digest: string }>;
  snapshot(): Promise<{ ref: string; digest: string }>;
  /** Must atomically replace only when the target still equals expectedBase. */
  replaceExact(expectedBase: { revision: string; digest: string }, candidateDigest: string): Promise<void>;
  /** Must restore exactly the snapshot captured in this journal. */
  restoreExact(snapshot: { ref: string; digest: string }): Promise<void>;
}
export interface MechanicalPromotionPredicate {
  eligible: boolean; globalState: "disarmed" | "armed";
  classCoverage: "shadow" | "armed-canary" | "armed-fleet";
  killSwitchOff: boolean; watchdogHealthy: boolean; evidenceFresh: boolean; uniqueIdentity: boolean;
}
export const disarmedPromotionPredicate: MechanicalPromotionPredicate = Object.freeze({
  eligible: false, globalState: "disarmed", classCoverage: "shadow", killSwitchOff: true, watchdogHealthy: false, evidenceFresh: false, uniqueIdentity: false,
});
const journalSchema = z.object({
  schemaVersion: z.literal("v1"), proposalDigest: sha, proposalSignature: z.string(), targetId: z.string(), axis: z.string(),
  base: z.object({ revision: z.string(), digest: sha }).strict(), snapshot: z.object({ ref, digest: sha }).strict(), postimageDigest: sha,
  reversal: z.literal("restore-exact-preimage"), state: stateSchema, createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type RExactJournal = z.infer<typeof journalSchema>;
export type RExactResult = { status: "committed" | "reverted" | "blocked" | "already-committed"; journal: RExactJournal };
export interface RExactOptions { now?: () => Date; onPhase?: (phase: "snapshot" | "mutation" | "readback" | "terminalization") => void; }

function namespace(id: string) { return `autonomy/hugin/r-exact/${id}`; }
function eligible(p: MechanicalPromotionPredicate) { return p.eligible && p.globalState === "armed" && p.classCoverage !== "shadow" && p.killSwitchOff && p.watchdogHealthy && p.evidenceFresh && p.uniqueIdentity; }
function same(state: { digest: string }, expected: string) { return state.digest === expected; }

async function writeJournal(munin: MuninClient, proposalId: string, journal: RExactJournal, expected?: string): Promise<void> {
  await munin.write(namespace(proposalId), "journal", canonicalizeJcs(journal), ["autonomy:r-exact", `state:${journal.state}`], expected, "internal", expected === undefined);
}
async function readJournal(munin: MuninClient, proposalId: string): Promise<{ journal: RExactJournal; updatedAt: string } | null> {
  const entry = await munin.read(namespace(proposalId), "journal");
  if (!entry) return null;
  return { journal: journalSchema.parse(JSON.parse(entry.content)), updatedAt: entry.updated_at };
}

export async function recoverRExactAttempt(munin: MuninClient, proposalId: string, target: RExactConfigTarget, options: RExactOptions = {}): Promise<RExactResult> {
  const now = options.now ?? (() => new Date());
  const stored = await readJournal(munin, proposalId);
  if (!stored) throw new Error("missing-r-exact-journal");
  let { journal, updatedAt } = stored;
  if (journal.targetId !== target.id || journal.axis !== target.axis || target.owner !== "hugin") throw new Error("journal-target-mismatch");
  if (journal.state === "committed") return { status: "already-committed", journal };
  const transition = async (state: RExactState) => {
    journal = journalSchema.parse({ ...journal, state, updatedAt: now().toISOString() });
    await writeJournal(munin, proposalId, journal, updatedAt);
    const reread = await readJournal(munin, proposalId); if (!reread) throw new Error("journal-lost"); updatedAt = reread.updatedAt;
  };
  const current = await target.read();
  if (same(current, journal.postimageDigest)) {
    if (journal.state === "prepared") await transition("applied");
    if (journal.state === "applied") await transition("verified");
    options.onPhase?.("terminalization");
    await transition("committed");
    return { status: "committed", journal };
  }
  if (same(current, journal.snapshot.digest)) {
    if (journal.state === "prepared") { await transition("blocked"); return { status: "blocked", journal }; }
  }
  await transition("reverting");
  await target.restoreExact(journal.snapshot);
  const restored = await target.read();
  if (!same(restored, journal.snapshot.digest)) { await transition("blocked"); return { status: "blocked", journal }; }
  await transition("reverted");
  return { status: "reverted", journal };
}

export async function applyRExactProposal(munin: MuninClient, rawReceipt: unknown, keys: KeyStore, target: RExactConfigTarget, predicate: MechanicalPromotionPredicate = disarmedPromotionPredicate, options: RExactOptions = {}): Promise<RExactResult> {
  const now = options.now ?? (() => new Date());
  const current = await target.read();
  const verified = verifyAutonomyProposalReceipt(rawReceipt, keys, { now, currentBase: current });
  if (verified.status !== "valid") throw new Error(`proposal-${verified.reason}`);
  const receipt = rawReceipt as AutonomyProposalReceipt;
  const registry = proposalTargetRegistry.find((candidate) => candidate.id === receipt.targetId);
  if (!registry?.huginOwned || receipt.targetId !== target.id || receipt.axis !== target.axis || !eligible(predicate)) throw new Error("r-exact-admission-refused");
  const existing = await readJournal(munin, receipt.proposalId);
  if (existing) return recoverRExactAttempt(munin, receipt.proposalId, target, options);
  const snapshot = await target.snapshot();
  const journal = journalSchema.parse({ schemaVersion: "v1", proposalDigest: receipt.canonicalProposalDigest, proposalSignature: receipt.signature, targetId: receipt.targetId, axis: receipt.axis, base: receipt.base, snapshot, postimageDigest: receipt.candidateContentDigest, reversal: "restore-exact-preimage", state: "prepared", createdAt: now().toISOString(), updatedAt: now().toISOString() });
  try { await writeJournal(munin, receipt.proposalId, journal); } catch (error) { if (error instanceof MuninWriteRejectedError && error.conflictReason === "already_exists") return recoverRExactAttempt(munin, receipt.proposalId, target, options); throw error; }
  options.onPhase?.("snapshot");
  await target.replaceExact(receipt.base, receipt.candidateContentDigest);
  options.onPhase?.("mutation");
  const after = await target.read(); options.onPhase?.("readback");
  if (!same(after, receipt.candidateContentDigest)) return recoverRExactAttempt(munin, receipt.proposalId, target, options);
  return recoverRExactAttempt(munin, receipt.proposalId, target, options);
}
