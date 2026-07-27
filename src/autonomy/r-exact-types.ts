/** Public adapter boundaries for Hugin's W0.2 R-exact orchestration. */
import {
  W0_CONSTITUTION_DIGEST,
  type HuginRExactDomain,
  type VerifiedW0Binding,
  type W0AuthorityBundle,
} from "./w0-authority.js";

export interface RExactConfigTarget {
  id: string;
  owner: "hugin";
  domain: HuginRExactDomain;
  targetScopeDigest: string;
  read(): Promise<{ revision: string; digest: string }>;
  snapshot(): Promise<{ ref: string; digest: string }>;
  replaceExact(
    expected: { revision: string; digest: string },
    candidateDigest: string,
  ): Promise<void>;
}

export interface FreshAdmission {
  checkedAt: string;
  trustedWatchdogTime: string;
  killSwitchOff: boolean;
  evidenceFresh: boolean;
  journalHealthy: boolean;
  rateWindowEligible: boolean;
  attemptIntervalEligible: boolean;
  attemptWindowEligible: boolean;
  livenessHealthy: boolean;
  watchdogSilenceSeconds: number;
  proposalDigest: string;
  targetScopeDigest: string;
  baseRevision: string;
  baseDigest: string;
  candidateDigest: string;
  evidenceFingerprintsDigest: string;
  evidenceDigest: string;
  policyDigest: string;
  postconditionsDigest: string;
  configDigest: string;
  deadline: string;
}

export interface ProtectedWatchProof {
  proposalId: string;
  attemptId: string;
  targetId: string;
  targetScopeDigest: string;
  candidateDigest: string;
  watchReceiptDigest: string;
  watchdogIdentity: string;
  watchStartedAt: string;
  watchDeadline: string;
  completedAt: string;
  maxObservedSilenceSeconds: number;
  killSwitchStayedOff: boolean;
  evidenceStayedFresh: boolean;
  journalStayedHealthy: boolean;
  livenessStayedHealthy: boolean;
}

export interface RecoveryProtection {
  checkedAt: string;
  trustedWatchdogTime: string;
  killSwitchIdentity: string;
  killSwitchStateDigest: string;
  journalHealthy: boolean;
}

export type JournalRole = "controller" | "watchdog" | "recovery-worker";
export type JournalPhase =
  | "prepare"
  | "apply"
  | "verify"
  | "watch"
  | "commit"
  | "unknown"
  | "revert"
  | "disarm"
  | "terminally-blocked";
export type JournalOutcome =
  | "prepared"
  | "applied"
  | "verified"
  | "watching"
  | "committed"
  | "unknown"
  | "reverted"
  | "disarmed"
  | "terminally-blocked";

export interface JournalEntry {
  entry_id: string;
  sequence: number;
  recorded_at: string;
  phase: JournalPhase;
  outcome: JournalOutcome;
  executor_identity: string;
  binding_digest: string;
  quarantine: { state: "not-applicable" | "active"; reason_digest: string };
  coverage_transition: null | {
    from_state: "armed-canary" | "armed-fleet";
    to_state: "shadow";
    target_scope_digest: string;
    actor_identity: string;
  };
  terminal_reason_digest: null | string;
  previous_receipt_digest: null | string;
  receipt_digest: string;
  content_refs: string[];
}

export interface RExactJournal {
  kind: "autonomous-mutation-journal";
  schema_version: "v2";
  journal_id: string;
  domain: HuginRExactDomain;
  constitution_digest: typeof W0_CONSTITUTION_DIGEST;
  binding: Record<string, any>;
  binding_digest: string;
  entries: JournalEntry[];
  extensions: [];
}

export interface PreparedAttempt {
  kind: "hugin-r-exact-prepared-attempt";
  schema_version: "v1";
  proposal_receipt_digest: string;
  proposal_digest: string;
  target_id: string;
  target_scope_digest: string;
  base_revision: string;
  base_digest: string;
  candidate_digest: string;
  snapshot_ref: string;
  snapshot_digest: string;
  prepared_authority: VerifiedW0Binding;
  prepared_authority_digest: string;
  prepared_owner_key_fingerprint: string;
  role_service_pins: ProtectedRoleServicePins;
  role_service_pins_digest: string;
  admission_digest: string;
}

export interface ProtectedRoleServicePins {
  kind: "hugin-r-exact-role-service-pins";
  schema_version: "v1";
  owner_authorization_digest: string;
  entries: Array<{
    role: JournalRole;
    identity: string;
    public_key_fingerprint: string;
  }>;
  pins_digest: string;
  signature: { algorithm: "Ed25519"; value_base64: string };
}

export interface RoleWriteReceipt {
  kind: "hugin-r-exact-role-write-receipt";
  schema_version: "v1";
  role: JournalRole;
  identity: string;
  action: "create" | "append";
  journal_id: string;
  binding_digest: string;
  prepared_digest: string;
  previous_receipt_digest: null | string;
  resulting_receipt_digest: string;
  recorded_at: string;
  signature: { algorithm: "Ed25519"; value_base64: string };
}

export interface RoleWriteResult {
  journal: RExactJournal;
  prepared: PreparedAttempt;
  receipt: RoleWriteReceipt;
}

export interface RExactJournalReader {
  read(proposalId: string): Promise<RoleWriteResult | null>;
}

export interface HistoricalRoleAuthority {
  authority: W0AuthorityBundle;
  roleServicePins: ProtectedRoleServicePins;
  rolePublicKeys: Array<{
    role: JournalRole;
    identity: string;
    publicKeyPem: string;
  }>;
  roleServices: {
    controller: RExactRoleService;
    watchdog: RExactRoleService;
    "recovery-worker": RExactRoleService;
  };
}

export interface RExactRoleService {
  role: JournalRole;
  identity: string;
  publicKeyPem: string;
  /**
   * The service must replace a watch entry's recorded_at and receipt_digest
   * with its protected persistence time before signing the returned write.
   */
  append(
    proposalId: string,
    expectedReceiptDigest: string,
    entry: JournalEntry,
  ): Promise<RoleWriteResult>;
}

export interface RExactJournalCheckpoint {
  proposalId: string;
  attemptId: string;
  sequence: number;
  tailReceiptDigest: string;
  terminalReceiptDigest: string | null;
}

export interface RExactJournalCheckpoints {
  read(
    proposalId: string,
    attemptId: string,
  ): Promise<RExactJournalCheckpoint | null>;
}

export interface PreparedClaim {
  targetKey: string;
  attemptId: string;
  proposalReceiptDigest: string;
}

export interface RExactControllerService extends RExactRoleService {
  createAndClaim(
    proposalId: string,
    journal: RExactJournal,
    prepared: PreparedAttempt,
    claim: PreparedClaim,
    historicalAuthority: HistoricalRoleAuthority,
  ): Promise<
    | { status: "prepared"; write: RoleWriteResult }
    | { status: "busy" }
  >;
}

export interface RExactAttemptClaims {
  claim(
    targetKey: string,
    attemptId: string,
    proposalReceiptDigest: string,
  ): Promise<"acquired" | "same" | "busy">;
  assertHeld(
    targetKey: string,
    attemptId: string,
    proposalReceiptDigest: string,
  ): Promise<boolean>;
  terminalize(
    targetKey: string,
    attemptId: string,
    terminalReceiptDigest: string,
  ): Promise<void>;
}

export interface RExactRecoveryWorker {
  restoreAndVerify(input: {
    snapshotRef: string;
    snapshotDigest: string;
    targetId: string;
    baseRevision: string;
    baseDigest: string;
    /** Fence recovery to the exact post-apply state recorded by this attempt. */
    expectedCurrent: { revision: string; digest: string };
    recoveryWorkerIdentity: string;
  }): Promise<{ restoredRevision: string; restoredDigest: string }>;
  narrowAndVerify(input: {
    binding: VerifiedW0Binding;
    journalReceiptDigest: string;
  }): Promise<W0AuthorityBundle>;
}

export interface W0RuntimeGate {
  /** Compatibility view only; controller decisions use readAuthority(). */
  authority: W0AuthorityBundle;
  readAuthority(): Promise<W0AuthorityBundle>;
  roleServicePins: ProtectedRoleServicePins;
  reader: RExactJournalReader;
  controller: RExactControllerService;
  watchdog: RExactRoleService;
  recoveryJournal: RExactRoleService;
  recovery: RExactRecoveryWorker;
  claims: RExactAttemptClaims;
  journalCheckpoints: RExactJournalCheckpoints;
  resolveHistoricalAuthority(
    ownerAuthorizationDigest: string,
  ): Promise<HistoricalRoleAuthority | null>;
  currentRecoveryPosture(
    prepared: VerifiedW0Binding,
    authority: W0AuthorityBundle | null,
  ): Promise<
    | { state: "broader"; binding: VerifiedW0Binding }
    | {
        state: "already-safe";
        killSwitchIdentity: string;
        safetyDigest: string;
        authorityDigest: string | null;
      }
  >;
  resolveNarrowingAuthority(input: {
    domain: HuginRExactDomain;
    targetScopeDigest: string;
    terminalReceiptDigest: string;
    ownerAuthorizationDigest: string;
    recoveryWorkerIdentity: string;
    fromState: "armed-canary" | "armed-fleet";
  }): Promise<W0AuthorityBundle | null>;
  protectedNow(): Date;
  /**
   * Durable, idempotent protected-watch seam. The service, rather than this
   * process, owns the elapsed watch and may be rejoined after restart.
   */
  awaitProtectedWatch(input: {
    proposalId: string;
    attemptId: string;
    targetId: string;
    targetScopeDigest: string;
    candidateDigest: string;
    watchReceiptDigest: string;
    watchStartedAt: string;
    watchDeadline: string;
    watchdogIdentity: string;
  }): Promise<ProtectedWatchProof>;
  verifyFresh(
    phase: "apply" | "commit",
    binding: VerifiedW0Binding,
  ): Promise<FreshAdmission>;
  verifyRecovery(
    prepared: VerifiedW0Binding,
    current:
      | { state: "broader"; binding: VerifiedW0Binding }
      | {
          state: "already-safe";
          killSwitchIdentity: string;
          safetyDigest: string;
          authorityDigest: string | null;
        },
  ): Promise<RecoveryProtection>;
}

export type RExactResult = {
  status:
    | "committed"
    | "disarmed"
    | "terminally-blocked"
    | "already-committed";
  journal: RExactJournal;
};

export interface RExactOptions {
  onRecoveryCause?: (error: unknown) => void;
  onPhase?: (
    phase:
      | "snapshot"
      | "mutation"
      | "readback"
      | "terminalization"
      | "restore"
      | "narrowing",
  ) => void;
}
