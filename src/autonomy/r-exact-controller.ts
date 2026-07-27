/** Adapter-neutral, owner-authorized R-exact journal/controller (Hugin #330). */
import { createHash, createPublicKey } from "node:crypto";
import type { KeyStore } from "../task-signing.js";
import { canonicalizeJcs } from "../jcs.js";
import {
  proposalTargetRegistry,
  verifyAutonomyProposalReceipt,
  type AutonomyProposalReceipt,
} from "./proposal-receipts.js";
import {
  verifyW0Authority,
  verifyW0NarrowingApplied,
  verifyW0NarrowingReceipt,
  verifyW0SignedAuthorityEpoch,
  w0Digest,
  W0_CONSTITUTION_DIGEST,
  type VerifiedW0Binding,
} from "./w0-authority.js";
import {
  appendJournalEntry,
  buildJournalEntry,
  latestEntry as latest,
  roleForPhase,
  validateRExactJournal,
} from "./r-exact-journal.js";
import {
  validateHistoricalRoleAuthority,
  validateHistoricalRoleServices,
  verifyRoleWriteReceipt,
  verifyStoredRoleWriteReceipt,
  type VerifiedRoleServiceKey,
} from "./r-exact-role-auth.js";
import type {
  FreshAdmission,
  JournalEntry,
  PreparedAttempt,
  ProtectedWatchProof,
  RExactConfigTarget,
  RExactJournal,
  RExactOptions,
  RExactResult,
  RExactRoleService,
  RoleWriteResult,
  W0RuntimeGate,
} from "./r-exact-types.js";

export {
  buildJournalEntry,
  validateRExactJournal,
} from "./r-exact-journal.js";
export type * from "./r-exact-types.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const refPattern = /^ref:[a-z][a-z0-9-]{2,120}$/;
const proposalIdPattern = /^[a-z][a-z0-9-]{2,120}$/;
const utcPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const APPLY_VERIFY_BUDGET_MS = 300_000;
const MINIMUM_WATCH_MS = 3_600_000;
const COMMIT_GRACE_MS = 300_000;
const TOTAL_DEADLINE_MS = 4_200_000;
const CONSTITUTIONAL_MAX_SILENCE_SECONDS = 900;
const exactKeys = (value: unknown, keys: string[]): boolean =>
  !!value
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const exactUtc = (value: unknown): value is string => {
  if (
    typeof value !== "string"
    || !utcPattern.test(value)
    || Number.isNaN(Date.parse(value))
  ) return false;
  return new Date(value).toISOString().replace(".000Z", "Z") === value;
};
const utcFromMs = (value: number): string =>
  new Date(value).toISOString().replace(".000Z", "Z");
const idDigest = (prefix: string, value: string): string =>
  `${prefix}-${w0Digest({ value }).slice(7, 31)}`;

const targetClaimKey = (target: RExactConfigTarget): string =>
  `${target.domain}:${target.targetScopeDigest}`;

const publicKeyFingerprint = (publicKeyPem: string): string => {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("r-exact-owner-key-invalid");
  }
  return `sha256:${createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
};

function trustedNow(gate: W0RuntimeGate): number {
  const value = gate.protectedNow().getTime();
  if (!Number.isFinite(value)) throw new Error("r-exact-protected-clock-invalid");
  return value;
}

function expectedAdmission(
  receipt: AutonomyProposalReceipt,
  binding: VerifiedW0Binding,
): Pick<
  FreshAdmission,
  | "proposalDigest"
  | "targetScopeDigest"
  | "baseRevision"
  | "baseDigest"
  | "candidateDigest"
  | "evidenceFingerprintsDigest"
> {
  return {
    proposalDigest: receipt.canonicalProposalDigest,
    targetScopeDigest: binding.targetScopeDigest,
    baseRevision: receipt.base.revision,
    baseDigest: receipt.base.digest,
    candidateDigest: receipt.candidateContentDigest,
    evidenceFingerprintsDigest: w0Digest(receipt.evidenceFingerprints),
  };
}

type ImmutableAdmission = Pick<
  FreshAdmission,
  | "proposalDigest"
  | "targetScopeDigest"
  | "baseRevision"
  | "baseDigest"
  | "candidateDigest"
  | "evidenceFingerprintsDigest"
  | "evidenceDigest"
  | "policyDigest"
  | "postconditionsDigest"
  | "configDigest"
  | "deadline"
>;

function validateFresh(
  proof: FreshAdmission,
  gate: W0RuntimeGate,
  phase: "apply" | "commit",
  receipt: AutonomyProposalReceipt,
  binding: VerifiedW0Binding,
  immutable?: ImmutableAdmission,
): void {
  const actual = trustedNow(gate);
  const checked = Date.parse(proof.checkedAt);
  const watchdog = Date.parse(proof.trustedWatchdogTime);
  const deadline = Date.parse(proof.deadline);
  if (
    !exactUtc(proof.checkedAt)
    || !exactUtc(proof.trustedWatchdogTime)
    || !exactUtc(proof.deadline)
    || Math.abs(actual - checked) > 5_000
    || Math.abs(actual - watchdog) > 5_000
  ) {
    throw new Error("r-exact-stale-protected-clock");
  }
  if (
    !proof.killSwitchOff
    || !proof.evidenceFresh
    || !proof.journalHealthy
    || !proof.rateWindowEligible
    || !proof.attemptIntervalEligible
    || !proof.attemptWindowEligible
    || !proof.livenessHealthy
    || !Number.isSafeInteger(proof.watchdogSilenceSeconds)
    || proof.watchdogSilenceSeconds < 0
    || proof.watchdogSilenceSeconds
      > CONSTITUTIONAL_MAX_SILENCE_SECONDS
  ) {
    throw new Error(`r-exact-${phase}-gate-refused`);
  }
  if (
    canonicalizeJcs(expectedAdmission(receipt, binding))
    !== canonicalizeJcs({
      proposalDigest: proof.proposalDigest,
      targetScopeDigest: proof.targetScopeDigest,
      baseRevision: proof.baseRevision,
      baseDigest: proof.baseDigest,
      candidateDigest: proof.candidateDigest,
      evidenceFingerprintsDigest: proof.evidenceFingerprintsDigest,
    })
  ) {
    throw new Error("r-exact-admission-subject-mismatch");
  }
  for (const digest of [
    proof.evidenceDigest,
    proof.policyDigest,
    proof.postconditionsDigest,
    proof.configDigest,
  ]) {
    if (!digestPattern.test(digest)) throw new Error("r-exact-admission-digest");
  }
  if (actual > deadline) {
    throw new Error("r-exact-deadline-expired");
  }
  if (
    !immutable
    && deadline - checked !== TOTAL_DEADLINE_MS
  ) {
    throw new Error("r-exact-admission-window-bound");
  }
  if (immutable) {
    const immutableFields = [
      "proposalDigest",
      "targetScopeDigest",
      "baseRevision",
      "baseDigest",
      "candidateDigest",
      "evidenceFingerprintsDigest",
      "evidenceDigest",
      "policyDigest",
      "postconditionsDigest",
      "configDigest",
      "deadline",
    ] as const;
    for (const field of immutableFields) {
      if (proof[field] !== immutable[field]) {
        throw new Error(`r-exact-admission-drift:${field}`);
      }
    }
  }
}

function immutableAdmissionFromJournal(
  receipt: AutonomyProposalReceipt,
  binding: VerifiedW0Binding,
  journal: RExactJournal,
): ImmutableAdmission {
  return {
    ...expectedAdmission(receipt, binding),
    evidenceDigest: journal.binding.evidence_digest,
    policyDigest: journal.binding.policy_digest,
    postconditionsDigest: journal.binding.postconditions_digest,
    configDigest: journal.binding.config_digest,
    deadline: journal.binding.deadline,
  };
}

function protectedWatchInput(
  receipt: AutonomyProposalReceipt,
  target: RExactConfigTarget,
  journal: RExactJournal,
  prepared: PreparedAttempt,
): Parameters<W0RuntimeGate["awaitProtectedWatch"]>[0] {
  const watch = latest(journal);
  if (watch.phase !== "watch") {
    throw new Error("r-exact-watch-not-durable");
  }
  return {
    proposalId: receipt.proposalId,
    attemptId: journal.binding.attempt_id,
    targetId: target.id,
    targetScopeDigest: target.targetScopeDigest,
    candidateDigest: prepared.candidate_digest,
    watchReceiptDigest: watch.receipt_digest,
    watchStartedAt: watch.recorded_at,
    watchDeadline: utcFromMs(
      Date.parse(watch.recorded_at) + MINIMUM_WATCH_MS,
    ),
    watchdogIdentity: journal.binding.watchdog_identity,
  };
}

function validateProtectedWatch(
  proof: ProtectedWatchProof,
  expected: Parameters<W0RuntimeGate["awaitProtectedWatch"]>[0],
  gate: W0RuntimeGate,
): void {
  const completed = Date.parse(proof.completedAt);
  const deadline = Date.parse(expected.watchDeadline);
  const started = Date.parse(expected.watchStartedAt);
  if (
    !exactKeys(proof, [
      "proposalId",
      "attemptId",
      "targetId",
      "targetScopeDigest",
      "candidateDigest",
      "watchReceiptDigest",
      "watchdogIdentity",
      "watchStartedAt",
      "watchDeadline",
      "completedAt",
      "maxObservedSilenceSeconds",
      "killSwitchStayedOff",
      "evidenceStayedFresh",
      "journalStayedHealthy",
      "livenessStayedHealthy",
    ])
    || !exactUtc(proof.watchStartedAt)
    || !exactUtc(proof.watchDeadline)
    || !exactUtc(proof.completedAt)
    || proof.proposalId !== expected.proposalId
    || proof.attemptId !== expected.attemptId
    || proof.targetId !== expected.targetId
    || proof.targetScopeDigest !== expected.targetScopeDigest
    || proof.candidateDigest !== expected.candidateDigest
    || proof.watchReceiptDigest !== expected.watchReceiptDigest
    || proof.watchdogIdentity !== expected.watchdogIdentity
    || proof.watchStartedAt !== expected.watchStartedAt
    || proof.watchDeadline !== expected.watchDeadline
    || deadline - started !== MINIMUM_WATCH_MS
    || completed < deadline
    || completed > deadline + COMMIT_GRACE_MS
    || Math.abs(trustedNow(gate) - completed) > 5_000
    || !Number.isSafeInteger(proof.maxObservedSilenceSeconds)
    || proof.maxObservedSilenceSeconds < 0
    || proof.maxObservedSilenceSeconds
      > CONSTITUTIONAL_MAX_SILENCE_SECONDS
    || !proof.killSwitchStayedOff
    || !proof.evidenceStayedFresh
    || !proof.journalStayedHealthy
    || !proof.livenessStayedHealthy
  ) {
    throw new Error("r-exact-watch-incomplete");
  }
}

async function resumeDurableWatch(
  receipt: AutonomyProposalReceipt,
  target: RExactConfigTarget,
  gate: W0RuntimeGate,
  journal: RExactJournal,
  prepared: PreparedAttempt,
  owner: VerifiedW0Binding,
  controllerService: RExactRoleService,
  controllerRoleKey: VerifiedRoleServiceKey,
  options: RExactOptions,
): Promise<RExactResult> {
  const watchInput = protectedWatchInput(
    receipt,
    target,
    journal,
    prepared,
  );
  const watchProof = await gate.awaitProtectedWatch(watchInput);
  validateProtectedWatch(watchProof, watchInput, gate);
  const commitOwner = verifyOwner(
    receipt,
    target,
    await gate.readAuthority(),
  );
  if (!sameAuthority(owner, commitOwner)) {
    throw new Error("r-exact-authority-drift");
  }
  const commitAdmission = await gate.verifyFresh("commit", commitOwner);
  validateFresh(
    commitAdmission,
    gate,
    "commit",
    receipt,
    commitOwner,
    immutableAdmissionFromJournal(receipt, owner, journal),
  );
  await assertClaim(
    gate,
    target,
    prepared,
    journal.binding.attempt_id,
  );
  if ((await target.read()).digest !== prepared.candidate_digest) {
    throw new Error("r-exact-commit-readback");
  }
  options.onPhase?.("terminalization");
  const state = await appendThroughRole(
    controllerService,
    controllerRoleKey,
    gate.journalCheckpoints,
    receipt.proposalId,
    journal,
    buildJournalEntry(
      journal,
      "commit",
      commitAdmission.checkedAt,
      owner.identities.controller,
    ),
    prepared,
  );
  validateRExactJournal(state.journal, false);
  await terminalizeClaim(gate, target, state.journal);
  return { status: "committed", journal: state.journal };
}

function validatePrepared(
  prepared: PreparedAttempt,
  receipt: AutonomyProposalReceipt,
  target: RExactConfigTarget,
): void {
  if (
    !exactKeys(prepared, [
      "kind",
      "schema_version",
      "proposal_receipt_digest",
      "proposal_digest",
      "target_id",
      "target_scope_digest",
      "base_revision",
      "base_digest",
      "candidate_digest",
      "snapshot_ref",
      "snapshot_digest",
      "prepared_authority",
      "prepared_authority_digest",
      "prepared_owner_key_fingerprint",
      "role_service_pins",
      "role_service_pins_digest",
      "admission_digest",
    ])
    || prepared.kind !== "hugin-r-exact-prepared-attempt"
    || prepared.schema_version !== "v1"
    || prepared.proposal_receipt_digest !== w0Digest(receipt)
    || prepared.proposal_digest !== receipt.canonicalProposalDigest
    || prepared.target_id !== target.id
    || prepared.target_scope_digest !== target.targetScopeDigest
    || prepared.base_revision !== receipt.base.revision
    || prepared.base_digest !== receipt.base.digest
    || prepared.candidate_digest !== receipt.candidateContentDigest
    || prepared.snapshot_digest !== receipt.base.digest
    || !refPattern.test(prepared.snapshot_ref)
    || prepared.prepared_authority_digest !== w0Digest(prepared.prepared_authority)
    || !digestPattern.test(prepared.prepared_owner_key_fingerprint)
    || prepared.role_service_pins_digest !== w0Digest(prepared.role_service_pins)
    || !digestPattern.test(prepared.admission_digest)
  ) {
    throw new Error("r-exact-prepared-attempt-invalid");
  }
}

function recoveryDescriptorDigest(prepared: PreparedAttempt): string {
  return w0Digest({
    snapshot_ref: prepared.snapshot_ref,
    snapshot_digest: prepared.snapshot_digest,
    target_id: prepared.target_id,
    base_revision: prepared.base_revision,
    base_digest: prepared.base_digest,
    prepared_digest: w0Digest(prepared),
  });
}

function verifyReceiptIdentityOnly(
  raw: unknown,
  keys: KeyStore,
  now: () => Date,
): AutonomyProposalReceipt {
  const receipt = raw as AutonomyProposalReceipt;
  const verified = verifyAutonomyProposalReceipt(receipt, keys, {
    now,
    currentBase: receipt?.base,
  });
  if (verified.status !== "valid") {
    throw new Error(`proposal-${verified.reason}`);
  }
  return receipt;
}

function verifyReceiptForCurrentBase(
  receipt: AutonomyProposalReceipt,
  keys: KeyStore,
  gate: W0RuntimeGate,
  current: { revision: string; digest: string },
): void {
  const verified = verifyAutonomyProposalReceipt(receipt, keys, {
    now: () => gate.protectedNow(),
    currentBase: current,
  });
  if (verified.status !== "valid") {
    throw new Error(`proposal-${verified.reason}`);
  }
}

function verifyOwner(
  receipt: AutonomyProposalReceipt,
  target: RExactConfigTarget,
  authority: W0RuntimeGate["authority"],
): VerifiedW0Binding {
  const registry = proposalTargetRegistry.find(
    (entry) => entry.id === receipt.targetId,
  );
  if (
    !registry?.huginOwned
    || target.owner !== "hugin"
    || receipt.targetId !== target.id
    || receipt.axis !== target.domain
  ) {
    throw new Error("r-exact-cross-owner-refused");
  }
  return verifyW0Authority(
    authority,
    target.domain,
    target.targetScopeDigest,
  );
}

function deriveSignedRecoveryPosture(
  authority: W0RuntimeGate["authority"],
  target: RExactConfigTarget,
  prepared: VerifiedW0Binding,
):
  | { state: "broader"; binding: VerifiedW0Binding }
  | { state: "already-safe"; killSwitchIdentity: string } {
  const coverage = authority.coverageIntent;
  const row = coverage.domains.find(
    (candidate: any) => candidate.domain === target.domain,
  );
  const matchingBindings = row?.bindings?.filter(
    (candidate: any) =>
      candidate.target_scope_digest === target.targetScopeDigest,
  ) ?? [];
  if (
    coverage.global_state !== "armed"
    || matchingBindings.length === 0
    || row?.coverage === "shadow"
    || matchingBindings[0]?.state === "shadow"
  ) {
    return {
      state: "already-safe",
      killSwitchIdentity:
        matchingBindings[0]?.identities?.kill_switch
          ?? prepared.identities.kill_switch,
    };
  }
  const binding = verifyW0Authority(
    authority,
    target.domain,
    target.targetScopeDigest,
    true,
  );
  return binding.effectiveState === "shadow"
    ? {
        state: "already-safe",
        killSwitchIdentity: binding.identities.kill_switch,
      }
    : { state: "broader", binding };
}

async function appendThroughRole(
  service: RExactRoleService,
  pinned: VerifiedRoleServiceKey,
  checkpoints: W0RuntimeGate["journalCheckpoints"],
  proposalId: string,
  journal: RExactJournal,
  entry: JournalEntry,
  prepared: PreparedAttempt,
): Promise<RoleWriteResult> {
  const expectedRole = roleForPhase(entry.phase);
  if (
    service.role !== expectedRole
    || service.identity !== entry.executor_identity
  ) {
    throw new Error("r-exact-role-service-refused");
  }
  const result = await service.append(
    proposalId,
    latest(journal).receipt_digest,
    entry,
  );
  const returnedEntry = latest(result.journal);
  const expectedEntryShape = structuredClone(entry);
  const returnedEntryShape = structuredClone(returnedEntry);
  if (entry.phase === "watch") {
    delete (expectedEntryShape as Partial<JournalEntry>).recorded_at;
    delete (expectedEntryShape as Partial<JournalEntry>).receipt_digest;
    delete (returnedEntryShape as Partial<JournalEntry>).recorded_at;
    delete (returnedEntryShape as Partial<JournalEntry>).receipt_digest;
  }
  if (
    canonicalizeJcs(result.prepared) !== canonicalizeJcs(prepared)
    || result.journal.entries.length !== journal.entries.length + 1
    || canonicalizeJcs(result.journal.entries.slice(0, -1))
      !== canonicalizeJcs(journal.entries)
    || canonicalizeJcs(returnedEntryShape)
      !== canonicalizeJcs(expectedEntryShape)
    || (
      entry.phase === "watch"
      && (
        !exactUtc(returnedEntry.recorded_at)
        || Date.parse(returnedEntry.recorded_at)
          < Date.parse(entry.recorded_at)
      )
    )
  ) {
    throw new Error("r-exact-role-service-result");
  }
  verifyRoleWriteReceipt(
    result,
    service,
    pinned,
    "append",
    latest(journal).receipt_digest,
  );
  validateRExactJournal(result.journal);
  await assertJournalCheckpoint(
    checkpoints,
    proposalId,
    result.journal,
  );
  return result;
}

async function assertJournalCheckpoint(
  checkpoints: W0RuntimeGate["journalCheckpoints"],
  proposalId: string,
  journal: RExactJournal,
): Promise<void> {
  const checkpoint = await checkpoints.read(
    proposalId,
    journal.binding.attempt_id,
  );
  if (!checkpoint) throw new Error("r-exact-journal-checkpoint-missing");
  if (
    !exactKeys(checkpoint, [
      "proposalId",
      "attemptId",
      "sequence",
      "tailReceiptDigest",
      "terminalReceiptDigest",
    ])
    || checkpoint.proposalId !== proposalId
    || checkpoint.attemptId !== journal.binding.attempt_id
    || !Number.isSafeInteger(checkpoint.sequence)
    || checkpoint.sequence < 1
    || !digestPattern.test(checkpoint.tailReceiptDigest)
    || (
      checkpoint.terminalReceiptDigest !== null
      && !digestPattern.test(checkpoint.terminalReceiptDigest)
    )
  ) {
    throw new Error("r-exact-journal-checkpoint-invalid");
  }
  const tail = latest(journal);
  const terminal = ["commit", "disarm", "terminally-blocked"].includes(
    tail.phase,
  )
    ? tail.receipt_digest
    : null;
  if (
    checkpoint.sequence !== tail.sequence
    || checkpoint.tailReceiptDigest !== tail.receipt_digest
    || checkpoint.terminalReceiptDigest !== terminal
  ) {
    throw new Error("r-exact-journal-checkpoint-stale");
  }
}

function sameAuthority(
  left: VerifiedW0Binding,
  right: VerifiedW0Binding,
): boolean {
  return canonicalizeJcs(left) === canonicalizeJcs(right);
}

async function assertClaim(
  gate: W0RuntimeGate,
  target: RExactConfigTarget,
  prepared: PreparedAttempt,
  attemptId: string,
): Promise<void> {
  if (
    !await gate.claims.assertHeld(
      targetClaimKey(target),
      attemptId,
      prepared.proposal_receipt_digest,
    )
  ) {
    throw new Error("r-exact-attempt-claim-lost");
  }
}

async function terminalizeClaim(
  gate: W0RuntimeGate,
  target: RExactConfigTarget,
  journal: RExactJournal,
): Promise<void> {
  await gate.claims.terminalize(
    targetClaimKey(target),
    journal.binding.attempt_id,
    latest(journal).receipt_digest,
  );
}

export async function applyRExactProposal(
  raw: unknown,
  keys: KeyStore,
  target: RExactConfigTarget,
  gate: W0RuntimeGate,
  options: RExactOptions = {},
): Promise<RExactResult> {
  const rolePinsSnapshot = structuredClone(gate.roleServicePins);
  const roleServicesSnapshot = {
    controller: gate.controller,
    watchdog: gate.watchdog,
    "recovery-worker": gate.recoveryJournal,
  };
  const rolePublicKeysSnapshot = Object.values(roleServicesSnapshot).map(
    (service) => ({
      role: service.role,
      identity: service.identity,
      publicKeyPem: service.publicKeyPem,
    }),
  );
  const recoveryProposalId = raw
    && typeof raw === "object"
    && !Array.isArray(raw)
    && typeof (raw as { proposalId?: unknown }).proposalId === "string"
    && proposalIdPattern.test((raw as { proposalId: string }).proposalId)
    ? (raw as { proposalId: string }).proposalId
    : null;
  if (recoveryProposalId) {
    const existing = await gate.reader.read(recoveryProposalId);
    if (existing) {
      return recoverRExactAttempt(raw, keys, target, gate, options);
    }
  }
  const authoritySnapshot = structuredClone(await gate.readAuthority());
  const receipt = verifyReceiptIdentityOnly(
    raw,
    keys,
    () => gate.protectedNow(),
  );
  const current = await target.read();
  verifyReceiptForCurrentBase(receipt, keys, gate, current);
  const owner = verifyOwner(receipt, target, authoritySnapshot);
  const historicalSnapshot = {
    authority: authoritySnapshot,
    roleServicePins: rolePinsSnapshot,
    rolePublicKeys: rolePublicKeysSnapshot,
    roleServices: roleServicesSnapshot,
  };
  const roleKeys = validateHistoricalRoleAuthority(
    historicalSnapshot,
    owner,
  );
  const initialAdmission = await gate.verifyFresh("apply", owner);
  validateFresh(
    initialAdmission,
    gate,
    "apply",
    receipt,
    owner,
  );
  const attemptId = idDigest("attempt", receipt.canonicalProposalDigest);
  const snapshot = await target.snapshot();
  if (
    snapshot.digest !== receipt.base.digest
    || !refPattern.test(snapshot.ref)
  ) {
    throw new Error("r-exact-snapshot-base-mismatch");
  }
  const prepared: PreparedAttempt = {
    kind: "hugin-r-exact-prepared-attempt",
    schema_version: "v1",
    proposal_receipt_digest: w0Digest(receipt),
    proposal_digest: receipt.canonicalProposalDigest,
    target_id: target.id,
    target_scope_digest: target.targetScopeDigest,
    base_revision: receipt.base.revision,
    base_digest: receipt.base.digest,
    candidate_digest: receipt.candidateContentDigest,
    snapshot_ref: snapshot.ref,
    snapshot_digest: snapshot.digest,
    prepared_authority: structuredClone(owner),
    prepared_authority_digest: w0Digest(owner),
    prepared_owner_key_fingerprint: publicKeyFingerprint(
      authoritySnapshot.pinnedOwnerPublicKeyPem,
    ),
    role_service_pins: structuredClone(rolePinsSnapshot),
    role_service_pins_digest: w0Digest(rolePinsSnapshot),
    admission_digest: w0Digest(initialAdmission),
  };
  validatePrepared(prepared, receipt, target);
  const binding = {
    mutation_id: idDigest("mutation", receipt.canonicalProposalDigest),
    attempt_id: attemptId,
    recovery_disarm_id: idDigest(
      "disarm",
      receipt.canonicalProposalDigest,
    ),
    idempotency_key: idDigest("idem", receipt.canonicalProposalDigest),
    writer_owner: "hugin",
    owner_authority_ref: owner.ownerAuthorityRef,
    owner_authority_digest: owner.ownerAuthorityDigest,
    configuration_owner: "hugin",
    configuration_owner_authority_ref:
      owner.configurationOwnerAuthorityRef,
    configuration_owner_authority_digest:
      owner.configurationOwnerAuthorityDigest,
    target_scope_digest: owner.targetScopeDigest,
    admission_coverage_digest: owner.coverageDigest,
    admission_binding_state: owner.state,
    owner_identity: owner.identities.owner,
    controller_identity: owner.identities.controller,
    watchdog_identity: owner.identities.watchdog,
    kill_switch_identity: owner.identities.kill_switch,
    recovery_worker_identity: owner.identities.recovery_worker,
    risk_scope: target.domain,
    candidate_digest: receipt.candidateContentDigest,
    config_digest: initialAdmission.configDigest,
    evidence_digest: initialAdmission.evidenceDigest,
    policy_digest: initialAdmission.policyDigest,
    baseline_digest: snapshot.digest,
    postconditions_digest: initialAdmission.postconditionsDigest,
    deadline: initialAdmission.deadline,
    canary: {
      scope_digest: owner.targetScopeDigest,
      target_count: 1,
    },
    recovery: {
      class: "R-exact",
      worker_identity: owner.identities.recovery_worker,
      descriptor_digest: recoveryDescriptorDigest(prepared),
      disarms_after_action: true,
    },
  };
  let journal: RExactJournal = {
    kind: "autonomous-mutation-journal",
    schema_version: "v2",
    journal_id: idDigest("journal", receipt.canonicalProposalDigest),
    domain: target.domain,
    constitution_digest: W0_CONSTITUTION_DIGEST,
    binding,
    binding_digest: w0Digest(binding),
    entries: [],
    extensions: [],
  };
  journal = appendJournalEntry(
    journal,
    buildJournalEntry(
      journal,
      "prepare",
      initialAdmission.checkedAt,
      owner.identities.controller,
    ),
  );
  validateRExactJournal(journal);
  const preparedWrite = await roleServicesSnapshot.controller.createAndClaim(
    receipt.proposalId,
    journal,
    prepared,
    {
      targetKey: targetClaimKey(target),
      attemptId,
      proposalReceiptDigest: prepared.proposal_receipt_digest,
    },
    historicalSnapshot,
  );
  if (preparedWrite.status === "busy") {
    throw new Error("r-exact-target-busy");
  }
  const created = preparedWrite.write;
  verifyRoleWriteReceipt(
    created,
    roleServicesSnapshot.controller,
    roleKeys.controller,
    "create",
    null,
  );
  if (
    canonicalizeJcs(created.journal) !== canonicalizeJcs(journal)
    || canonicalizeJcs(created.prepared) !== canonicalizeJcs(prepared)
  ) {
    throw new Error("r-exact-role-service-result");
  }
  const durablePrepared = await gate.reader.read(receipt.proposalId);
  if (
    !durablePrepared
    || canonicalizeJcs(durablePrepared)
      !== canonicalizeJcs(created)
  ) {
    throw new Error("r-exact-atomic-prepare-not-durable");
  }
  await assertJournalCheckpoint(
    gate.journalCheckpoints,
    receipt.proposalId,
    durablePrepared.journal,
  );
  const retainedHistorical = await gate.resolveHistoricalAuthority(
    owner.authorizationDigest,
  );
  if (
    !retainedHistorical
    || canonicalizeJcs(retainedHistorical.authority)
      !== canonicalizeJcs(historicalSnapshot.authority)
    || canonicalizeJcs(retainedHistorical.roleServicePins)
      !== canonicalizeJcs(historicalSnapshot.roleServicePins)
    || canonicalizeJcs(retainedHistorical.rolePublicKeys)
      !== canonicalizeJcs(historicalSnapshot.rolePublicKeys)
  ) {
    throw new Error("r-exact-historical-snapshot-not-durable");
  }
  validateHistoricalRoleServices(retainedHistorical, owner);
  options.onPhase?.("snapshot");
  try {
    await assertClaim(gate, target, prepared, attemptId);
    const preApplyOwner = verifyOwner(
      receipt,
      target,
      await gate.readAuthority(),
    );
    if (!sameAuthority(owner, preApplyOwner)) {
      throw new Error("r-exact-authority-drift");
    }
    const preApply = await gate.verifyFresh("apply", preApplyOwner);
    validateFresh(
      preApply,
      gate,
      "apply",
      receipt,
      preApplyOwner,
      initialAdmission,
    );
    await target.replaceExact(receipt.base, receipt.candidateContentDigest);
    options.onPhase?.("mutation");
    let state = await appendThroughRole(
      roleServicesSnapshot.controller,
      roleKeys.controller,
      gate.journalCheckpoints,
      receipt.proposalId,
      journal,
      buildJournalEntry(
        journal,
        "apply",
        preApply.checkedAt,
        owner.identities.controller,
      ),
      prepared,
    );
    journal = state.journal;
    const readback = await target.read();
    if (readback.digest !== receipt.candidateContentDigest) {
      throw new Error("r-exact-readback-mismatch");
    }
    options.onPhase?.("readback");
    const verifiedAt = utcFromMs(trustedNow(gate));
    if (
      Date.parse(verifiedAt) - Date.parse(initialAdmission.checkedAt)
        > APPLY_VERIFY_BUDGET_MS
    ) {
      throw new Error("r-exact-apply-verify-budget");
    }
    state = await appendThroughRole(
      roleServicesSnapshot.controller,
      roleKeys.controller,
      gate.journalCheckpoints,
      receipt.proposalId,
      journal,
      buildJournalEntry(
        journal,
        "verify",
        verifiedAt,
        owner.identities.controller,
      ),
      prepared,
    );
    journal = state.journal;
    state = await appendThroughRole(
      roleServicesSnapshot.controller,
      roleKeys.controller,
      gate.journalCheckpoints,
      receipt.proposalId,
      journal,
      buildJournalEntry(
        journal,
        "watch",
        verifiedAt,
        owner.identities.controller,
      ),
      prepared,
    );
    journal = state.journal;
    const durableWatchAt = Date.parse(latest(journal).recorded_at);
    if (
      Math.abs(trustedNow(gate) - durableWatchAt) > 5_000
      || durableWatchAt - Date.parse(initialAdmission.checkedAt)
        > APPLY_VERIFY_BUDGET_MS
    ) {
      throw new Error("r-exact-watch-receipt-time");
    }
    return await resumeDurableWatch(
      receipt,
      target,
      gate,
      journal,
      prepared,
      owner,
      roleServicesSnapshot.controller,
      roleKeys.controller,
      options,
    );
  } catch (error) {
    options.onRecoveryCause?.(error);
    return recoverRExactAttempt(receipt, keys, target, gate, options);
  }
}

async function narrowCurrentAuthority(
  gate: W0RuntimeGate,
  current:
    | { state: "broader"; binding: VerifiedW0Binding }
    | {
        state: "already-safe";
        killSwitchIdentity: string;
        safetyDigest: string;
      },
  journalReceiptDigest: string,
  options: RExactOptions,
): Promise<void> {
  if (current.state === "already-safe") return;
  const binding = current.binding;
  const narrowed = await gate.recovery.narrowAndVerify({
    binding,
    journalReceiptDigest,
  });
  options.onPhase?.("narrowing");
  verifyW0NarrowingApplied(narrowed, binding, journalReceiptDigest);
}

function terminalBlockedReasonDigest(recoveryReasonDigest: string): string {
  return w0Digest({
    kind: "r-exact-terminal-blocked",
    recovery_reason_digest: recoveryReasonDigest,
  });
}

async function reconcilePendingNarrowing(
  receipt: AutonomyProposalReceipt,
  target: RExactConfigTarget,
  gate: W0RuntimeGate,
  journal: RExactJournal,
  prepared: PreparedAttempt,
  recoveryService: RExactRoleService,
  recoveryRoleKey: VerifiedRoleServiceKey,
  recoveryReasonDigest: string,
): Promise<RExactResult | null> {
  if (!["unknown", "revert"].includes(latest(journal).phase)) {
    return null;
  }
  const transition = {
    from_state: prepared.prepared_authority.state,
    to_state: "shadow" as const,
    target_scope_digest: prepared.target_scope_digest,
    actor_identity: prepared.prepared_authority.identities.recovery_worker,
  };
  const candidates: Array<{
    status: "disarmed" | "terminally-blocked";
    entry: JournalEntry;
  }> = [
    {
      status: "terminally-blocked",
      entry: buildJournalEntry(
        journal,
        "terminally-blocked",
        latest(journal).recorded_at,
        prepared.prepared_authority.identities.recovery_worker,
        terminalBlockedReasonDigest(recoveryReasonDigest),
        transition,
      ),
    },
  ];
  if (latest(journal).phase === "revert") {
    candidates.unshift({
      status: "disarmed",
      entry: buildJournalEntry(
        journal,
        "disarm",
        latest(journal).recorded_at,
        prepared.prepared_authority.identities.recovery_worker,
        recoveryReasonDigest,
        transition,
      ),
    });
  }
  let pending: typeof candidates[number] | undefined;
  for (const candidate of candidates) {
    const authority = await gate.resolveNarrowingAuthority({
      domain: target.domain,
      targetScopeDigest: target.targetScopeDigest,
      terminalReceiptDigest: candidate.entry.receipt_digest,
      ownerAuthorizationDigest:
        prepared.prepared_authority.authorizationDigest,
      recoveryWorkerIdentity:
        prepared.prepared_authority.identities.recovery_worker,
      fromState: prepared.prepared_authority.state,
    });
    if (authority) {
      const resolved = verifyW0NarrowingReceipt(
        authority,
        target.domain,
        target.targetScopeDigest,
        candidate.entry.receipt_digest,
      );
      const {
        effectiveState: _preparedEffective,
        ...preparedAuthority
      } = prepared.prepared_authority;
      const {
        effectiveState: _resolvedEffective,
        ...resolvedAuthority
      } = resolved;
      if (
        resolved.effectiveState !== "shadow"
        || canonicalizeJcs(resolvedAuthority)
          !== canonicalizeJcs(preparedAuthority)
      ) {
        throw new Error("r-exact-pending-narrowing-authority-mismatch");
      }
      if (pending) throw new Error("r-exact-pending-narrowing-ambiguous");
      pending = candidate;
    }
  }
  if (!pending) {
    return null;
  }
  const state = await appendThroughRole(
    recoveryService,
    recoveryRoleKey,
    gate.journalCheckpoints,
    receipt.proposalId,
    journal,
    pending.entry,
    prepared,
  );
  validateRExactJournal(state.journal, false);
  await terminalizeClaim(gate, target, state.journal);
  return { status: pending.status, journal: state.journal };
}

async function appendTerminalBlocked(
  receipt: AutonomyProposalReceipt,
  target: RExactConfigTarget,
  gate: W0RuntimeGate,
  journal: RExactJournal,
  prepared: PreparedAttempt,
  currentPosture:
    | { state: "broader"; binding: VerifiedW0Binding }
    | {
        state: "already-safe";
        killSwitchIdentity: string;
        safetyDigest: string;
      },
  recoveryService: RExactRoleService,
  recoveryRoleKey: VerifiedRoleServiceKey,
  reasonDigest: string,
  options: RExactOptions,
): Promise<RExactResult> {
  const transition = {
    from_state: prepared.prepared_authority.state,
    to_state: "shadow" as const,
    target_scope_digest: prepared.target_scope_digest,
    actor_identity: prepared.prepared_authority.identities.recovery_worker,
  };
  const terminalEntry = buildJournalEntry(
    journal,
    "terminally-blocked",
    latest(journal).recorded_at,
    prepared.prepared_authority.identities.recovery_worker,
    reasonDigest,
    transition,
  );
  await narrowCurrentAuthority(
    gate,
    currentPosture,
    terminalEntry.receipt_digest,
    options,
  );
  const state = await appendThroughRole(
    recoveryService,
    recoveryRoleKey,
    gate.journalCheckpoints,
    receipt.proposalId,
    journal,
    terminalEntry,
    prepared,
  );
  validateRExactJournal(state.journal, false);
  await terminalizeClaim(gate, target, state.journal);
  return { status: "terminally-blocked", journal: state.journal };
}

export async function recoverRExactAttempt(
  raw: unknown,
  keys: KeyStore,
  target: RExactConfigTarget,
  gate: W0RuntimeGate,
  options: RExactOptions = {},
): Promise<RExactResult> {
  void keys;
  if (
    !raw
    || typeof raw !== "object"
    || Array.isArray(raw)
    || typeof (raw as { proposalId?: unknown }).proposalId !== "string"
    || !proposalIdPattern.test(
      (raw as { proposalId: string }).proposalId,
    )
  ) {
    throw new Error("r-exact-recovery-receipt-shape");
  }
  const receipt = raw as AutonomyProposalReceipt;
  const stored = await gate.reader.read(receipt.proposalId);
  if (!stored) throw new Error("r-exact-journal-missing");
  let { journal } = stored;
  const { prepared } = stored;
  validatePrepared(prepared, receipt, target);
  validateRExactJournal(journal);
  const historical = await gate.resolveHistoricalAuthority(
    prepared.prepared_authority.authorizationDigest,
  );
  if (!historical) {
    throw new Error("r-exact-historical-authority-missing");
  }
  const historicalBinding = verifyW0Authority(
    historical.authority,
    target.domain,
    target.targetScopeDigest,
    true,
  );
  if (
    historicalBinding.authorizationDigest
      !== prepared.prepared_authority.authorizationDigest
    || canonicalizeJcs(prepared.prepared_authority)
      !== canonicalizeJcs(historicalBinding)
    || prepared.prepared_owner_key_fingerprint
      !== publicKeyFingerprint(
        historical.authority.pinnedOwnerPublicKeyPem,
      )
    || canonicalizeJcs(prepared.role_service_pins)
      !== canonicalizeJcs(historical.roleServicePins)
  ) {
    throw new Error("r-exact-historical-authority-mismatch");
  }
  const historicalRoleKeys = validateHistoricalRoleAuthority(
    historical,
    historicalBinding,
  );
  const storedRole = roleForPhase(latest(journal).phase);
  const storedAction = journal.entries.length === 1 ? "create" : "append";
  const storedPrevious = journal.entries.length === 1
    ? null
    : journal.entries.at(-2)!.receipt_digest;
  verifyStoredRoleWriteReceipt(
    stored,
    historicalRoleKeys[storedRole],
    storedAction,
    storedPrevious,
  );
  await assertJournalCheckpoint(
    gate.journalCheckpoints,
    receipt.proposalId,
    journal,
  );
  const roleKeys = validateHistoricalRoleServices(
    historical,
    historicalBinding,
  );
  const claim = await gate.claims.claim(
    targetClaimKey(target),
    journal.binding.attempt_id,
    prepared.proposal_receipt_digest,
  );
  if (claim === "busy") throw new Error("r-exact-target-busy");
  if (
    journal.binding_digest !== w0Digest(journal.binding)
    || journal.binding.recovery.descriptor_digest
      !== recoveryDescriptorDigest(prepared)
    || journal.binding.target_scope_digest
      !== historicalBinding.targetScopeDigest
    || journal.binding.admission_coverage_digest
      !== historicalBinding.coverageDigest
    || journal.binding.owner_authority_ref
      !== historicalBinding.ownerAuthorityRef
    || journal.binding.owner_authority_digest
      !== historicalBinding.ownerAuthorityDigest
    || journal.binding.configuration_owner_authority_ref
      !== historicalBinding.configurationOwnerAuthorityRef
    || journal.binding.configuration_owner_authority_digest
      !== historicalBinding.configurationOwnerAuthorityDigest
  ) {
    throw new Error("r-exact-journal-binding-invalid");
  }
  if (latest(journal).phase === "commit") {
    await terminalizeClaim(gate, target, journal);
    return { status: "already-committed", journal };
  }
  if (latest(journal).phase === "disarm") {
    await terminalizeClaim(gate, target, journal);
    return { status: "disarmed", journal };
  }
  if (latest(journal).phase === "terminally-blocked") {
    await terminalizeClaim(gate, target, journal);
    return { status: "terminally-blocked", journal };
  }
  if (latest(journal).phase === "watch") {
    try {
      return await resumeDurableWatch(
        receipt,
        target,
        gate,
        journal,
        prepared,
        historicalBinding,
        historical.roleServices.controller,
        roleKeys.controller,
        options,
      );
    } catch (error) {
      options.onRecoveryCause?.(error);
      const afterResume = await gate.reader.read(receipt.proposalId);
      if (!afterResume) throw new Error("r-exact-watch-resume-lost");
      if (latest(afterResume.journal).phase === "commit") {
        return recoverRExactAttempt(raw, keys, target, gate, options);
      }
      if (
        canonicalizeJcs(afterResume.journal) !== canonicalizeJcs(journal)
        || canonicalizeJcs(afterResume.prepared)
          !== canonicalizeJcs(prepared)
      ) {
        throw new Error("r-exact-watch-resume-ambiguous");
      }
    }
  }
  let protectedRecoveryAuthority: W0RuntimeGate["authority"] | null = null;
  try {
    protectedRecoveryAuthority = structuredClone(
      await gate.readAuthority(),
    );
  } catch {
    // Durable historical recovery must remain available after loss of the
    // current live authority reader. The protected posture service remains
    // the authority in that degraded case.
  }
  if (protectedRecoveryAuthority) {
    verifyW0SignedAuthorityEpoch(protectedRecoveryAuthority);
  }
  const currentPosture = await gate.currentRecoveryPosture(
    historicalBinding,
    protectedRecoveryAuthority,
  );
  if (protectedRecoveryAuthority) {
    const signedPosture = deriveSignedRecoveryPosture(
      protectedRecoveryAuthority,
      target,
      historicalBinding,
    );
    if (
      (
        currentPosture.state === "already-safe"
        && (
          signedPosture.state !== "already-safe"
          || currentPosture.authorityDigest
            !== w0Digest(protectedRecoveryAuthority)
          || currentPosture.killSwitchIdentity
            !== signedPosture.killSwitchIdentity
        )
      )
      || (
        currentPosture.state === "broader"
        && (
          signedPosture.state !== "broader"
          || canonicalizeJcs(signedPosture.binding)
            !== canonicalizeJcs(currentPosture.binding)
        )
      )
    ) {
      throw new Error("r-exact-recovery-posture-authority-mismatch");
    }
  }
  const protection = await gate.verifyRecovery(
    prepared.prepared_authority,
    currentPosture,
  );
  const currentKillSwitchIdentity = currentPosture.state === "broader"
    ? currentPosture.binding.identities.kill_switch
    : currentPosture.killSwitchIdentity;
  if (
    !exactUtc(protection.checkedAt)
    || !exactUtc(protection.trustedWatchdogTime)
    || protection.killSwitchIdentity
      !== currentKillSwitchIdentity
    || !digestPattern.test(protection.killSwitchStateDigest)
    || (
      currentPosture.state === "already-safe"
      && !digestPattern.test(currentPosture.safetyDigest)
    )
    || !protection.journalHealthy
    || Math.abs(
      trustedNow(gate) - Date.parse(protection.checkedAt)
    ) > 5_000
    || Math.abs(
      trustedNow(gate) - Date.parse(protection.trustedWatchdogTime)
    ) > 5_000
  ) {
    throw new Error("r-exact-recovery-protection-invalid");
  }
  await assertClaim(
    gate,
    target,
    prepared,
    journal.binding.attempt_id,
  );
  const observedReasonDigest = w0Digest({
    kind: "r-exact-recovery",
    proposal_digest: prepared.proposal_digest,
    kill_switch_state_digest: protection.killSwitchStateDigest,
  });
  const durableUnknown = [...journal.entries]
    .reverse()
    .find((entry) => entry.phase === "unknown");
  const reasonDigest = durableUnknown?.terminal_reason_digest
    ?? observedReasonDigest;
  const reconciledNarrowing = await reconcilePendingNarrowing(
    receipt,
    target,
    gate,
    journal,
    prepared,
    historical.roleServices["recovery-worker"],
    roleKeys["recovery-worker"],
    reasonDigest,
  );
  if (reconciledNarrowing) return reconciledNarrowing;
  if (latest(journal).phase !== "unknown" && latest(journal).phase !== "revert") {
    const state = await appendThroughRole(
      historical.roleServices.watchdog,
      roleKeys.watchdog,
      gate.journalCheckpoints,
      receipt.proposalId,
      journal,
      buildJournalEntry(
        journal,
        "unknown",
        protection.checkedAt,
        prepared.prepared_authority.identities.watchdog,
        reasonDigest,
      ),
      prepared,
    );
    journal = state.journal;
  }
  let narrowedDisarmReceipt: string | null = null;
  try {
    const currentTarget = await target.read();
    if (
      currentTarget.digest !== prepared.snapshot_digest
      || currentTarget.revision !== prepared.base_revision
    ) {
      const restored = await gate.recovery.restoreAndVerify({
        snapshotRef: prepared.snapshot_ref,
        snapshotDigest: prepared.snapshot_digest,
        targetId: prepared.target_id,
        baseRevision: prepared.base_revision,
        baseDigest: prepared.base_digest,
      });
      options.onPhase?.("restore");
      const readback = await target.read();
      if (
        restored.restoredDigest !== prepared.snapshot_digest
        || restored.restoredRevision !== prepared.base_revision
        || readback.digest !== prepared.snapshot_digest
        || readback.revision !== prepared.base_revision
      ) {
        throw new Error("r-exact-restore-readback");
      }
    }
    if (latest(journal).phase === "unknown") {
      const state = await appendThroughRole(
        historical.roleServices["recovery-worker"],
        roleKeys["recovery-worker"],
        gate.journalCheckpoints,
        receipt.proposalId,
        journal,
        buildJournalEntry(
          journal,
          "revert",
          protection.checkedAt,
          prepared.prepared_authority.identities.recovery_worker,
        ),
        prepared,
      );
      journal = state.journal;
    }
    const transition = {
      from_state: prepared.prepared_authority.state,
      to_state: "shadow" as const,
      target_scope_digest: prepared.target_scope_digest,
      actor_identity: prepared.prepared_authority.identities.recovery_worker,
    };
    const disarmEntry = buildJournalEntry(
      journal,
      "disarm",
      latest(journal).recorded_at,
      prepared.prepared_authority.identities.recovery_worker,
      reasonDigest,
      transition,
    );
    await narrowCurrentAuthority(
      gate,
      currentPosture,
      disarmEntry.receipt_digest,
      options,
    );
    narrowedDisarmReceipt = disarmEntry.receipt_digest;
    const state = await appendThroughRole(
      historical.roleServices["recovery-worker"],
      roleKeys["recovery-worker"],
      gate.journalCheckpoints,
      receipt.proposalId,
      journal,
      disarmEntry,
      prepared,
    );
    journal = state.journal;
    validateRExactJournal(journal, false);
    await terminalizeClaim(gate, target, journal);
    return { status: "disarmed", journal };
  } catch (error) {
    options.onRecoveryCause?.(error);
    if (
      error instanceof Error
      && (
        error.message.startsWith("r-exact-role-")
        || error.message.startsWith("w0-authority-rejected:")
      )
    ) {
      throw error;
    }
    if (narrowedDisarmReceipt !== null) {
      throw new Error("r-exact-disarm-append-pending");
    }
    return appendTerminalBlocked(
      receipt,
      target,
      gate,
      journal,
      prepared,
      currentPosture,
      historical.roleServices["recovery-worker"],
      roleKeys["recovery-worker"],
      terminalBlockedReasonDigest(reasonDigest),
      options,
    );
  }
}
