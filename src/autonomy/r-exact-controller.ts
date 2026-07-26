/** Adapter-neutral, owner-authorized R-exact journal/controller (Hugin #330). */
import type { MuninClient } from "../munin-client.js";
import type { KeyStore } from "../task-signing.js";
import { canonicalizeJcs } from "../jcs.js";
import { proposalTargetRegistry, verifyAutonomyProposalReceipt, type AutonomyProposalReceipt } from "./proposal-receipts.js";
import { verifyW0Authority, verifyW0NarrowingApplied, w0Digest, W0_CONSTITUTION_DIGEST, type HuginRExactDomain, type VerifiedW0Binding, type W0AuthorityBundle } from "./w0-authority.js";

export interface RExactConfigTarget {
  id: string; owner: "hugin"; domain: HuginRExactDomain; targetScopeDigest: string;
  read(): Promise<{ revision: string; digest: string }>;
  snapshot(): Promise<{ ref: string; digest: string }>;
  replaceExact(expected: { revision: string; digest: string }, candidateDigest: string): Promise<void>;
}
export interface FreshAdmission {
  checkedAt: string; trustedWatchdogTime: string; killSwitchOff: boolean; evidenceFresh: boolean;
  journalHealthy: boolean; rateWindowEligible: boolean; livenessHealthy: boolean;
  evidenceDigest: string; policyDigest: string; postconditionsDigest: string; configDigest: string;
  deadline: string; watchDeadline: string;
}
export interface RExactRecoveryWorker {
  identity: string;
  journal: MuninClient;
  restoreAndVerify(snapshot: { ref: string; digest: string }): Promise<{ restoredDigest: string }>;
  narrowAndVerify(input: { binding: VerifiedW0Binding; journalReceiptDigest: string }): Promise<W0AuthorityBundle>;
}
export interface W0RuntimeGate {
  authority: W0AuthorityBundle;
  watchdogJournal: MuninClient;
  recovery: RExactRecoveryWorker;
  protectedNow(): Date;
  verifyFresh(phase: "apply" | "commit", binding: VerifiedW0Binding): Promise<FreshAdmission>;
}
type Phase = "prepare" | "apply" | "verify" | "watch" | "commit" | "unknown" | "revert" | "disarm" | "terminally-blocked";
type Outcome = "prepared" | "applied" | "verified" | "watching" | "committed" | "unknown" | "reverted" | "disarmed" | "terminally-blocked";
export interface JournalEntry {
  entry_id: string; sequence: number; recorded_at: string; phase: Phase; outcome: Outcome;
  executor_identity: string; binding_digest: string;
  quarantine: { state: "not-applicable"; reason_digest: string };
  coverage_transition: null | { from_state: "armed-canary" | "armed-fleet"; to_state: "shadow"; target_scope_digest: string; actor_identity: string };
  terminal_reason_digest: null | string; previous_receipt_digest: null | string; receipt_digest: string; content_refs: string[];
}
export interface RExactJournal {
  kind: "autonomous-mutation-journal"; schema_version: "v1"; journal_id: string;
  domain: HuginRExactDomain; constitution_digest: typeof W0_CONSTITUTION_DIGEST;
  binding: any; binding_digest: string; entries: JournalEntry[]; extensions: [];
}
export type RExactResult = { status: "committed" | "disarmed" | "terminally-blocked" | "already-committed"; journal: RExactJournal };
export interface RExactOptions { onPhase?: (phase: "snapshot" | "mutation" | "readback" | "terminalization" | "restore") => void; }

const namespace = (id: string) => `autonomy/hugin/r-exact/${id}`;
const latest = (journal: RExactJournal) => journal.entries.at(-1)!;
const idDigest = (prefix: string, value: string) => `${prefix}-${w0Digest({ value }).slice(7, 31)}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const transition: Record<Phase, readonly Phase[]> = {
  prepare: ["apply", "unknown"], apply: ["verify", "unknown"], verify: ["watch", "unknown"],
  watch: ["commit", "unknown"], commit: [], unknown: ["revert", "terminally-blocked"],
  revert: ["disarm", "terminally-blocked"], disarm: [], "terminally-blocked": [],
};
const phaseOutcome: Record<Phase, Outcome> = {
  prepare: "prepared", apply: "applied", verify: "verified", watch: "watching", commit: "committed",
  unknown: "unknown", revert: "reverted", disarm: "disarmed", "terminally-blocked": "terminally-blocked",
};

function trustedNow(gate: W0RuntimeGate): number {
  const value = gate.protectedNow().getTime();
  if (!Number.isFinite(value)) throw new Error("r-exact-protected-clock-invalid");
  return value;
}
function validateFresh(snapshot: FreshAdmission, gate: W0RuntimeGate, phase: "apply" | "commit"): void {
  const actual = trustedNow(gate);
  const checked = Date.parse(snapshot.checkedAt), watchdog = Date.parse(snapshot.trustedWatchdogTime);
  const deadline = Date.parse(snapshot.deadline), watchDeadline = Date.parse(snapshot.watchDeadline);
  if (![checked, watchdog, deadline, watchDeadline].every(Number.isFinite) || Math.abs(actual - checked) > 5_000 || Math.abs(actual - watchdog) > 5_000) throw new Error("r-exact-stale-protected-clock");
  if (!snapshot.killSwitchOff || !snapshot.evidenceFresh || !snapshot.journalHealthy || !snapshot.rateWindowEligible || !snapshot.livenessHealthy) throw new Error(`r-exact-${phase}-gate-refused`);
  if (actual > deadline) throw new Error("r-exact-deadline-expired");
  if (phase === "commit" && actual < watchDeadline) throw new Error("r-exact-watch-incomplete");
}
function assertContentBlind(value: unknown): void {
  if (/(raw.prompt|payload|secret|command|private.locator|candidate.content)/i.test(canonicalizeJcs(value))) throw new Error("r-exact-journal-not-content-blind");
}
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join(",") === [...keys].sort().join(",");
export function validateRExactJournal(journal: RExactJournal): void {
  const bindingKeys = ["mutation_id","attempt_id","recovery_disarm_id","idempotency_key","writer_owner","owner_authority_ref","owner_authority_digest","configuration_owner","configuration_owner_authority_ref","configuration_owner_authority_digest","target_scope_digest","admission_coverage_digest","admission_binding_state","owner_identity","controller_identity","watchdog_identity","kill_switch_identity","recovery_worker_identity","risk_scope","candidate_digest","config_digest","evidence_digest","policy_digest","baseline_digest","postconditions_digest","deadline","canary","recovery"];
  if (!exactKeys(journal, ["kind","schema_version","journal_id","domain","constitution_digest","binding","binding_digest","entries","extensions"]) || !exactKeys(journal.binding, bindingKeys) || journal.kind !== "autonomous-mutation-journal" || journal.schema_version !== "v1" || journal.constitution_digest !== W0_CONSTITUTION_DIGEST || journal.extensions.length !== 0 || journal.domain !== journal.binding.risk_scope || journal.binding.writer_owner !== "hugin" || journal.binding.configuration_owner !== "hugin" || journal.binding_digest !== w0Digest(journal.binding) || !digestPattern.test(journal.binding_digest) || !Array.isArray(journal.entries) || journal.entries.length === 0) throw new Error("r-exact-journal-schema");
  if (!exactKeys(journal.binding.canary, ["scope_digest","target_count","watch_deadline"]) || !exactKeys(journal.binding.recovery, ["class","worker_identity","descriptor_digest","disarms_after_action"]) || journal.binding.canary.scope_digest !== journal.binding.target_scope_digest || journal.binding.canary.target_count !== 1 || journal.binding.recovery.class !== "R-exact" || journal.binding.recovery.worker_identity !== journal.binding.recovery_worker_identity || journal.binding.recovery.disarms_after_action !== true) throw new Error("r-exact-journal-binding-schema");
  if (new Set([journal.binding.owner_identity, journal.binding.controller_identity, journal.binding.watchdog_identity, journal.binding.kill_switch_identity, journal.binding.recovery_worker_identity]).size !== 5) throw new Error("r-exact-journal-identities");
  const requiredDigests = ["owner_authority_digest","configuration_owner_authority_digest","target_scope_digest","admission_coverage_digest","candidate_digest","config_digest","evidence_digest","policy_digest","baseline_digest","postconditions_digest"] as const;
  if (!requiredDigests.every((field) => digestPattern.test(journal.binding[field])) || !digestPattern.test(journal.binding.recovery.descriptor_digest)) throw new Error("r-exact-journal-binding-digest");
  const executorFor = (phase: Phase): string => phase === "watch" ? journal.binding.watchdog_identity : ["revert","disarm","terminally-blocked"].includes(phase) ? journal.binding.recovery_worker_identity : journal.binding.controller_identity;
  let prior: JournalEntry | undefined;
  for (const entry of journal.entries) {
    if (!exactKeys(entry,["entry_id","sequence","recorded_at","phase","outcome","executor_identity","binding_digest","quarantine","coverage_transition","terminal_reason_digest","previous_receipt_digest","receipt_digest","content_refs"]) || !exactKeys(entry.quarantine, ["state","reason_digest"]) || entry.quarantine.state !== "not-applicable" || !digestPattern.test(entry.quarantine.reason_digest) || !Number.isFinite(Date.parse(entry.recorded_at)) || entry.outcome !== phaseOutcome[entry.phase] || entry.executor_identity !== executorFor(entry.phase) || entry.sequence !== (prior?.sequence ?? 0)+1 || entry.previous_receipt_digest !== (prior?.receipt_digest ?? null) || entry.binding_digest !== journal.binding_digest || !Array.isArray(entry.content_refs) || !entry.content_refs.every((ref) => typeof ref === "string" && ref.startsWith("ref:"))) throw new Error("r-exact-journal-entry-schema");
    const unsigned:any=structuredClone(entry);delete unsigned.receipt_digest;if(entry.receipt_digest!==w0Digest(unsigned))throw new Error("r-exact-journal-receipt-digest");
    if (prior && !transition[prior.phase].includes(entry.phase)) throw new Error("r-exact-journal-transition");
    if ((entry.phase === "disarm") !== (entry.coverage_transition !== null)) throw new Error("r-exact-journal-coverage");
    if (entry.coverage_transition && (!exactKeys(entry.coverage_transition, ["from_state","to_state","target_scope_digest","actor_identity"]) || entry.coverage_transition.from_state !== journal.binding.admission_binding_state || entry.coverage_transition.to_state !== "shadow" || entry.coverage_transition.target_scope_digest !== journal.binding.target_scope_digest || entry.coverage_transition.actor_identity !== journal.binding.recovery_worker_identity)) throw new Error("r-exact-journal-coverage");
    if ((entry.phase === "terminally-blocked") !== (entry.terminal_reason_digest !== null) || (entry.terminal_reason_digest !== null && !digestPattern.test(entry.terminal_reason_digest))) throw new Error("r-exact-journal-terminal");
    prior=entry;
  }
}
async function readJournal(client: MuninClient, id: string): Promise<{ journal: RExactJournal; version: string } | null> {
  const entry = await client.read(namespace(id), "journal");
  return entry ? { journal: JSON.parse(entry.content) as RExactJournal, version: entry.updated_at } : null;
}
async function writeJournal(client: MuninClient, id: string, journal: RExactJournal, version?: string): Promise<void> {
  assertContentBlind(journal); validateRExactJournal(journal);
  await client.write(namespace(id), "journal", canonicalizeJcs(journal), ["autonomy:r-exact", `phase:${latest(journal).phase}`], version, "internal", version === undefined);
}
function append(journal: RExactJournal, phase: Phase, at: string, executor: string, coverage: JournalEntry["coverage_transition"] = null): RExactJournal {
  const prior = journal.entries.at(-1);
  if (prior && !transition[prior.phase].includes(phase)) throw new Error(`r-exact-invalid-transition:${prior.phase}:${phase}`);
  if ((phase === "disarm") !== (coverage !== null)) throw new Error("r-exact-invalid-coverage-transition");
  const unsigned = {
    entry_id: `${journal.journal_id}-${phase}-${journal.entries.length + 1}`,
    sequence: journal.entries.length + 1, recorded_at: at, phase, outcome: phaseOutcome[phase],
    executor_identity: executor, binding_digest: journal.binding_digest, coverage_transition: coverage,
    quarantine: { state: "not-applicable" as const, reason_digest: w0Digest({ state: "not-applicable" }) },
    terminal_reason_digest: phase === "terminally-blocked" ? w0Digest({ reason: "recovery-readback-failed" }) : null,
    previous_receipt_digest: prior?.receipt_digest ?? null,
    content_refs: prior?.content_refs ?? [`ref:${journal.binding.mutation_id}-candidate`],
  };
  return { ...journal, entries: [...journal.entries, { ...unsigned, receipt_digest: w0Digest(unsigned) }] };
}
async function appendCAS(client: MuninClient, id: string, journal: RExactJournal, phase: Phase, at: string, executor: string, coverage: JournalEntry["coverage_transition"] = null): Promise<RExactJournal> {
  const stored = await readJournal(client, id);
  if (!stored || latest(stored.journal).receipt_digest !== latest(journal).receipt_digest) throw new Error("r-exact-concurrent-journal");
  const next = append(journal, phase, at, executor, coverage);
  await writeJournal(client, id, next, stored.version);
  return next;
}
function verifyOwner(receipt: AutonomyProposalReceipt, keys: KeyStore, target: RExactConfigTarget, gate: W0RuntimeGate, current: { revision: string; digest: string }): VerifiedW0Binding {
  const proposal = verifyAutonomyProposalReceipt(receipt, keys, { now: () => gate.protectedNow(), currentBase: current });
  if (proposal.status !== "valid") throw new Error(`proposal-${proposal.reason}`);
  const registry = proposalTargetRegistry.find((entry) => entry.id === receipt.targetId);
  if (!registry?.huginOwned || target.owner !== "hugin" || receipt.targetId !== target.id || receipt.axis !== target.domain) throw new Error("r-exact-cross-owner-refused");
  const binding = verifyW0Authority(gate.authority, target.domain, target.targetScopeDigest);
  if (gate.recovery.identity !== binding.identities.recovery_worker) throw new Error("r-exact-recovery-worker-identity");
  if (gate.recovery.journal === gate.watchdogJournal) throw new Error("r-exact-writer-separation");
  return binding;
}

export async function applyRExactProposal(controllerJournal: MuninClient, raw: unknown, keys: KeyStore, target: RExactConfigTarget, gate: W0RuntimeGate, options: RExactOptions = {}): Promise<RExactResult> {
  const receipt = raw as AutonomyProposalReceipt;
  if (controllerJournal === gate.watchdogJournal || controllerJournal === gate.recovery.journal) throw new Error("r-exact-writer-separation");
  // Recovery is keyed by the already-bound durable journal. Do not require the
  // target to still match the proposal base after an interrupted mutation.
  const existing = await readJournal(controllerJournal, receipt.proposalId);
  if (existing) return recoverRExactAttempt(controllerJournal, receipt.proposalId, target, gate, options);
  const owner = verifyOwner(receipt, keys, target, gate, await target.read());
  const first = await gate.verifyFresh("apply", owner); validateFresh(first, gate, "apply");
  const snapshot = await target.snapshot();
  const binding = {
    mutation_id: idDigest("mutation", receipt.proposalId), attempt_id: idDigest("attempt", receipt.proposalId), recovery_disarm_id: idDigest("disarm", receipt.proposalId), idempotency_key: idDigest("idem", receipt.proposalId),
    writer_owner: "hugin", owner_authority_ref: owner.ownerAuthorityRef, owner_authority_digest: owner.ownerAuthorityDigest,
    configuration_owner: "hugin", configuration_owner_authority_ref: owner.configurationOwnerAuthorityRef, configuration_owner_authority_digest: owner.configurationOwnerAuthorityDigest,
    target_scope_digest: owner.targetScopeDigest, admission_coverage_digest: owner.coverageDigest, admission_binding_state: owner.state,
    owner_identity: owner.identities.owner, controller_identity: owner.identities.controller, watchdog_identity: owner.identities.watchdog, kill_switch_identity: owner.identities.kill_switch, recovery_worker_identity: owner.identities.recovery_worker,
    risk_scope: target.domain, candidate_digest: receipt.candidateContentDigest, config_digest: first.configDigest, evidence_digest: first.evidenceDigest, policy_digest: first.policyDigest,
    baseline_digest: snapshot.digest, postconditions_digest: first.postconditionsDigest, deadline: first.deadline,
    canary: { scope_digest: owner.targetScopeDigest, target_count: 1, watch_deadline: first.watchDeadline },
    recovery: { class: "R-exact", worker_identity: owner.identities.recovery_worker, descriptor_digest: w0Digest({ snapshot: snapshot.ref, digest: snapshot.digest, proposal_digest: receipt.canonicalProposalDigest, signature_digest: w0Digest({ signature: receipt.signature }) }), disarms_after_action: true },
  };
  let journal: RExactJournal = { kind: "autonomous-mutation-journal", schema_version: "v1", journal_id: idDigest("journal", receipt.proposalId), domain: target.domain, constitution_digest: W0_CONSTITUTION_DIGEST, binding, binding_digest: w0Digest(binding), entries: [], extensions: [] };
  journal = append(journal, "prepare", first.checkedAt, owner.identities.controller);
  journal.entries[0]!.content_refs.push(snapshot.ref, `ref:${idDigest("proposal", receipt.canonicalProposalDigest)}`);
  const firstEntry:any=journal.entries[0];const firstUnsigned=structuredClone(firstEntry);delete firstUnsigned.receipt_digest;firstEntry.receipt_digest=w0Digest(firstUnsigned);
  await writeJournal(controllerJournal, receipt.proposalId, journal); options.onPhase?.("snapshot");
  try {
    const before = verifyOwner(receipt, keys, target, gate, await target.read());
    const fresh = await gate.verifyFresh("apply", before); validateFresh(fresh, gate, "apply");
    await target.replaceExact(receipt.base, receipt.candidateContentDigest); options.onPhase?.("mutation");
    journal = await appendCAS(controllerJournal, receipt.proposalId, journal, "apply", fresh.checkedAt, owner.identities.controller);
    if ((await target.read()).digest !== receipt.candidateContentDigest) throw new Error("r-exact-readback-mismatch"); options.onPhase?.("readback");
    journal = await appendCAS(controllerJournal, receipt.proposalId, journal, "verify", fresh.checkedAt, owner.identities.controller);
    journal = await appendCAS(gate.watchdogJournal, receipt.proposalId, journal, "watch", fresh.checkedAt, owner.identities.watchdog);
    return await finishCommit(controllerJournal, receipt, target, gate, owner, journal, options);
  } catch {
    return recoverRExactAttempt(controllerJournal, receipt.proposalId, target, gate, options);
  }
}

async function finishCommit(controllerJournal: MuninClient, receipt: AutonomyProposalReceipt, target: RExactConfigTarget, gate: W0RuntimeGate, owner: VerifiedW0Binding, journal: RExactJournal, options: RExactOptions): Promise<RExactResult> {
  try {
    const currentOwner = verifyW0Authority(gate.authority, target.domain, target.targetScopeDigest);
    if (canonicalizeJcs(currentOwner) !== canonicalizeJcs(owner)) throw new Error("r-exact-authority-drift");
    const fresh = await gate.verifyFresh("commit", currentOwner); validateFresh(fresh, gate, "commit");
    if ((await target.read()).digest !== receipt.candidateContentDigest) throw new Error("r-exact-commit-readback");
    options.onPhase?.("terminalization");
    journal = await appendCAS(controllerJournal, receipt.proposalId, journal, "commit", fresh.checkedAt, owner.identities.controller);
    return { status: "committed", journal };
  } catch {
    return recoverRExactAttempt(controllerJournal, receipt.proposalId, target, gate, options);
  }
}

export async function recoverRExactAttempt(controllerJournal: MuninClient, id: string, target: RExactConfigTarget, gate: W0RuntimeGate, options: RExactOptions = {}): Promise<RExactResult> {
  if (controllerJournal === gate.watchdogJournal || controllerJournal === gate.recovery.journal || gate.watchdogJournal === gate.recovery.journal) throw new Error("r-exact-writer-separation");
  const stored = await readJournal(controllerJournal, id); if (!stored) throw new Error("r-exact-journal-missing");
  let journal = stored.journal; const owner = verifyW0Authority(gate.authority, target.domain, target.targetScopeDigest, true);
  validateRExactJournal(journal);
  if (journal.binding_digest !== w0Digest(journal.binding) || journal.binding.target_scope_digest !== owner.targetScopeDigest || journal.binding.owner_authority_ref !== owner.ownerAuthorityRef || journal.binding.owner_authority_digest !== owner.ownerAuthorityDigest || journal.binding.configuration_owner_authority_ref !== owner.configurationOwnerAuthorityRef || journal.binding.configuration_owner_authority_digest !== owner.configurationOwnerAuthorityDigest || journal.binding.owner_identity !== owner.identities.owner || journal.binding.controller_identity !== owner.identities.controller || journal.binding.watchdog_identity !== owner.identities.watchdog || journal.binding.kill_switch_identity !== owner.identities.kill_switch || journal.binding.recovery_worker_identity !== owner.identities.recovery_worker) throw new Error("r-exact-journal-binding-invalid");
  if (latest(journal).phase === "commit") return { status: "already-committed", journal };
  if (latest(journal).phase === "disarm") return { status: "disarmed", journal };
  if (latest(journal).phase === "terminally-blocked") return { status: "terminally-blocked", journal };
  const at = gate.protectedNow().toISOString();
  if (latest(journal).phase !== "unknown" && latest(journal).phase !== "revert") journal = await appendCAS(controllerJournal, id, journal, "unknown", at, owner.identities.controller);
  const current = await target.read();
  if (current.digest !== journal.binding.baseline_digest) {
    const snapshotRef = journal.entries[0]?.content_refs.find((entry) => entry !== `ref:${journal.binding.mutation_id}-candidate` && !entry.includes("proposal"));
    if (!snapshotRef) throw new Error("r-exact-snapshot-ref-missing");
    const restored = await gate.recovery.restoreAndVerify({ ref: snapshotRef, digest: journal.binding.baseline_digest }); options.onPhase?.("restore");
    if (restored.restoredDigest !== journal.binding.baseline_digest || (await target.read()).digest !== journal.binding.baseline_digest) {
      journal = await appendCAS(gate.recovery.journal, id, journal, "terminally-blocked", at, owner.identities.recovery_worker);
      return { status: "terminally-blocked", journal };
    }
  }
  // Restore may have succeeded before a crash; exact readback lets the worker append the missing receipt without restoring again.
  if (latest(journal).phase === "unknown") journal = await appendCAS(gate.recovery.journal, id, journal, "revert", at, owner.identities.recovery_worker);
  if (owner.effectiveState === "shadow") {
    verifyW0NarrowingApplied(gate.authority, owner, latest(journal).receipt_digest);
  } else {
    const narrowedAuthority = await gate.recovery.narrowAndVerify({ binding: owner, journalReceiptDigest: latest(journal).receipt_digest });
    verifyW0NarrowingApplied(narrowedAuthority, owner, latest(journal).receipt_digest);
  }
  journal = await appendCAS(gate.recovery.journal, id, journal, "disarm", at, owner.identities.recovery_worker, { from_state: owner.state, to_state: "shadow", target_scope_digest: owner.targetScopeDigest, actor_identity: owner.identities.recovery_worker });
  return { status: "disarmed", journal };
}
