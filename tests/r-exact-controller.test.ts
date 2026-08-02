import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeJcs } from "../src/jcs.js";
import {
  canonicalAutonomyProposalDigest,
  createAutonomyProposalReceipt,
  signAutonomyProposalReceipt,
  type AutonomyProposalReceipt,
} from "../src/autonomy/proposal-receipts.js";
import {
  applyRExactProposal,
  buildJournalEntry,
  recoverRExactAttempt,
  validateRExactJournal,
  type FreshAdmission,
  type JournalEntry,
  type JournalRole,
  type PreparedAttempt,
  type RExactAttemptClaims,
  type RExactConfigTarget,
  type RExactControllerService,
  type RExactJournal,
  type RExactJournalReader,
  type RExactRoleService,
  type RoleWriteReceipt,
  type RoleWriteResult,
  type W0RuntimeGate,
} from "../src/autonomy/r-exact-controller.js";
import { roleForPhase } from "../src/autonomy/r-exact-journal.js";
import {
  isExactUtc,
  schemaErrors,
  type JsonValue,
} from "../src/node-substrate.js";
import {
  R_EXACT_CONFORMANCE,
  verifyW0Authority,
  W0_CONSTITUTION_DIGEST,
  W0_JOURNAL_PHASES,
  w0Digest,
  type W0AuthorityBundle,
} from "../src/autonomy/w0-authority.js";
import {
  HUGIN_CONFIG_ADAPTER_VERSION,
  HuginConfigStore,
  createHuginConfigRecoveryWorker,
  createHuginConfigTargets,
} from "../src/autonomy/hugin-config-adapter.js";

const h = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const secret = "d".repeat(64);
const keys = { "hugin-autonomy-proposer": secret };
const scope = h("hugin-macro-scope");
const fixedNow = "2026-07-26T14:00:00Z";
const constitutionFixture = JSON.parse(readFileSync(
  new URL(
    "./fixtures/autonomy-contract/w0.2-constitution.json",
    import.meta.url,
  ),
  "utf8",
));
const legacyConstitutionFixture = JSON.parse(readFileSync(
  new URL(
    "./fixtures/autonomy-contract/w0.1-constitution.json",
    import.meta.url,
  ),
  "utf8",
));
const rolePhaseFixture = JSON.parse(readFileSync(
  new URL(
    "./fixtures/autonomy-contract/w0.2-role-phase-map.json",
    import.meta.url,
  ),
  "utf8",
));
const canonicalJournalSchema = JSON.parse(readFileSync(
  new URL(
    "../docs/vendor/grimnir/autonomy/autonomous-mutation-journal-v2.schema.json",
    import.meta.url,
  ),
  "utf8",
));

function authority(macroTargetScope = scope): W0AuthorityBundle {
  const ownerKeys = generateKeyPairSync("ed25519");
  const recoveryKeys = generateKeyPairSync("ed25519");
  const ownerPem = ownerKeys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const recoveryPem = recoveryKeys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const fingerprint = (key: KeyObject): string =>
    `sha256:${createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex")}`;
  const fixedTargets = [
    ["micro-routing", "gille", "gille-inference", h("micro-scope")],
    ["macro-routing", "hugin-macro", "hugin", macroTargetScope],
    ["served-model-roster", "roster", "gille-inference", h("roster-scope")],
    [
      "no-reboot-security-bugfix-maintenance",
      "maintenance",
      "brokkr",
      h("maintenance-scope"),
    ],
  ] as const;
  const attestationRows = fixedTargets.map(
    ([domain, prefix, configurationOwner, targetScope]) => {
      const row: any = {
        attestation_id: `${prefix}-attestation`,
        domain,
        target_scope_digest: targetScope,
        configuration_owner: configurationOwner,
        issued_at: "2026-07-26T00:00:00Z",
        attestation_digest: h("placeholder"),
      };
      row.attestation_digest = w0Digest(row, "attestation_digest");
      return row;
    },
  );
  const attestations: any = {
    kind: "autonomy-owner-attestation-registry",
    schema_version: "v1",
    registry_id: "owner-attestations",
    issued_at: "2026-07-26T00:00:00Z",
    issuer_identity: "grimnir-owner",
    mutation_policy: "owner-controlled-protected-lane",
    attestations: attestationRows,
    extensions: [],
  };
  attestations.registry_digest = w0Digest(
    attestations,
    "registry_digest",
  );
  const recoveryRegistry: any = {
    kind: "autonomy-recovery-worker-registry",
    schema_version: "v1",
    registry_id: "recovery-registry",
    entries: [
      {
        domain: "macro-routing",
        target_scope_digest: macroTargetScope,
        recovery_worker_identity: "hugin-recovery",
        public_key_pem: recoveryPem,
        public_key_fingerprint: fingerprint(recoveryKeys.publicKey),
      },
    ],
    extensions: [],
  };
  recoveryRegistry.registry_digest = w0Digest(
    recoveryRegistry,
    "registry_digest",
  );
  const fixedRows = fixedTargets.map(
    ([domain, prefix, owner, targetScope]) => {
      const attestation = attestationRows.find(
        (row: any) => row.domain === domain,
      );
      const identities = domain === "macro-routing"
        ? {
          owner: "hugin-owner",
          controller: "hugin-controller",
          watchdog: "hugin-watchdog",
          kill_switch: "hugin-kill-switch",
          recovery_worker: "hugin-recovery",
        }
        : {
          owner: `${prefix}-owner`,
          controller: `${prefix}-controller`,
          watchdog: `${prefix}-watchdog`,
          kill_switch: `${prefix}-kill-switch`,
          recovery_worker: `${prefix}-recovery`,
        };
      return {
        domain,
        required_for_levels: domain === "micro-routing"
          ? ["L4", "L5"]
          : domain === "no-reboot-security-bugfix-maintenance"
            ? ["L4"]
            : ["L5"],
        owner_scope: "fixed-component",
        owner,
        recovery_class: domain === "no-reboot-security-bugfix-maintenance"
          ? "R-forward"
          : "R-exact",
        coverage: domain === "macro-routing" ? "armed-canary" : "shadow",
        target_state: "armed-canary",
        bindings: [{
          writer_owner: owner,
          owner_authority_ref: `ref:${prefix}-owner-authority`,
          owner_authority_digest: h(`${prefix}-owner-authority`),
          configuration_owner: owner,
          configuration_owner_authority_ref:
            `ref:${attestation.attestation_id}`,
          configuration_owner_authority_digest:
            attestation.attestation_digest,
          target_scope_digest: targetScope,
          state: domain === "macro-routing" ? "armed-canary" : "shadow",
          identities,
        }],
      };
    },
  );
  const owningRows = ["prompt", "harness", "tool-policy"].map((domain) => ({
    domain,
    required_for_levels: ["L5"],
    owner_scope: "owning-component",
    owner: "owning-component",
    recovery_class: "R-exact",
    coverage: "shadow",
    target_state: "armed-canary",
    bindings: [],
  }));
  const protectedRows = [
    "credentials-and-auth",
    "owner-policy",
    "constitution-and-safety-gates",
    "deployments-and-code",
    "privacy-retention-and-erasure",
    "firmware",
    "remote-recovery",
    "model-weight-training",
    "irreversible-external-actions",
    "package-downgrade",
  ].map((domain) => ({
    domain,
    required_for_levels: ["permanent"],
    owner_scope: "owner-only",
    owner: "owner",
    recovery_class: "none",
    coverage: "protected",
    target_state: "never-mechanical",
    bindings: [],
  }));
  const coverage: any = {
    kind: "autonomy-coverage-registry",
    schema_version: "v2",
    registry_id: "coverage-registry",
    issued_at: "2026-07-26T00:00:00Z",
    constitution_digest: W0_CONSTITUTION_DIGEST,
    mutation_policy: "owner-widen-recovery-worker-narrow",
    global_state: "armed",
    domains: [...fixedRows, ...owningRows, ...protectedRows],
    extensions: [],
  };
  coverage.registry_digest = w0Digest(coverage, "registry_digest");
  const constitution = structuredClone(constitutionFixture);
  const authorization: any = {
    kind: "autonomy-owner-authorization",
    schema_version: "v1",
    authorization_id: "owner-authorization",
    authorization_sequence: 1,
    previous_authorization_digest: null,
    issued_at: "2026-07-26T00:00:00Z",
    authority: {
      key_id: "owner-key",
      algorithm: "Ed25519",
      public_key_pem: ownerPem,
      public_key_fingerprint: fingerprint(ownerKeys.publicKey),
    },
    bindings: {
      constitution_digest: W0_CONSTITUTION_DIGEST,
      coverage_intent_digest: coverage.registry_digest,
      owner_attestation_registry_digest: attestations.registry_digest,
      recovery_worker_registry_digest: recoveryRegistry.registry_digest,
    },
    signature: { algorithm: "Ed25519", value_base64: "" },
  };
  const unsigned = structuredClone(authorization);
  delete unsigned.signature;
  authorization.signature.value_base64 = sign(
    null,
    Buffer.from(canonicalizeJcs(unsigned)),
    ownerKeys.privateKey,
  ).toString("base64");
  const authorizationDigest = w0Digest(authorization);
  const bundle: any = {
    constitution,
    coverageIntent: coverage,
    ownerAttestations: attestations,
    recoveryWorkerRegistry: recoveryRegistry,
    ownerAuthorization: authorization,
    pinnedOwnerPublicKeyPem: ownerPem,
    authorizationCheckpoint: {
      kind: "autonomy-owner-authorization-checkpoint",
      schema_version: "v1",
      authorization_digest: authorizationDigest,
      minimum_sequence: 1,
    },
    runtimeNarrowing: {
      kind: "autonomy-runtime-narrowing",
      schema_version: "v1",
      ledger_id: "runtime-narrowing",
      owner_authorization_digest: authorizationDigest,
      entries: [],
      extensions: [],
    },
    narrowingCheckpoint: {
      kind: "autonomy-runtime-narrowing-checkpoint",
      schema_version: "v1",
      owner_authorization_digest: authorizationDigest,
      ledger_tail_digest: null,
      minimum_entries: 0,
    },
  };
  Object.defineProperty(bundle, "_recoveryPrivateKey", {
    value: recoveryKeys.privateKey,
  });
  Object.defineProperty(bundle, "_ownerPrivateKey", {
    value: ownerKeys.privateKey,
  });
  return bundle;
}

function resignOwnerBundle(bundle: W0AuthorityBundle): void {
  const authorization = bundle.ownerAuthorization;
  const unsigned = structuredClone(authorization);
  delete unsigned.signature;
  authorization.signature.value_base64 = sign(
    null,
    Buffer.from(canonicalizeJcs(unsigned)),
    (bundle as any)._ownerPrivateKey,
  ).toString("base64");
  const authorizationDigest = w0Digest(authorization);
  bundle.authorizationCheckpoint.authorization_digest = authorizationDigest;
  bundle.runtimeNarrowing.owner_authorization_digest = authorizationDigest;
  bundle.narrowingCheckpoint.owner_authorization_digest =
    authorizationDigest;
}

function redigestAndResignAuthorityArtifacts(
  bundle: W0AuthorityBundle,
): void {
  bundle.coverageIntent.registry_digest = w0Digest(
    bundle.coverageIntent,
    "registry_digest",
  );
  bundle.ownerAttestations.registry_digest = w0Digest(
    bundle.ownerAttestations,
    "registry_digest",
  );
  bundle.ownerAuthorization.bindings.coverage_intent_digest =
    bundle.coverageIntent.registry_digest;
  bundle.ownerAuthorization.bindings.owner_attestation_registry_digest =
    bundle.ownerAttestations.registry_digest;
  resignOwnerBundle(bundle);
}

function appendSignedForeignNarrowing(
  bundle: W0AuthorityBundle,
  fromState: "armed-canary" | "armed-fleet" = "armed-canary",
): void {
  const recoveryKeys = generateKeyPairSync("ed25519");
  const publicKeyPem = recoveryKeys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const publicKeyFingerprint =
    `sha256:${createHash("sha256")
      .update(
        recoveryKeys.publicKey.export({ type: "spki", format: "der" }),
      )
      .digest("hex")}`;
  const microRow = bundle.coverageIntent.domains.find(
    (row: any) => row.domain === "micro-routing",
  );
  const microBinding = microRow.bindings[0];
  microRow.coverage = "armed-canary";
  microBinding.state = "armed-canary";
  bundle.coverageIntent.registry_digest = w0Digest(
    bundle.coverageIntent,
    "registry_digest",
  );
  bundle.ownerAuthorization.bindings.coverage_intent_digest =
    bundle.coverageIntent.registry_digest;
  bundle.recoveryWorkerRegistry.entries.push({
    domain: "micro-routing",
    target_scope_digest: microBinding.target_scope_digest,
    recovery_worker_identity: microBinding.identities.recovery_worker,
    public_key_pem: publicKeyPem,
    public_key_fingerprint: publicKeyFingerprint,
  });
  bundle.recoveryWorkerRegistry.registry_digest = w0Digest(
    bundle.recoveryWorkerRegistry,
    "registry_digest",
  );
  bundle.ownerAuthorization.bindings.recovery_worker_registry_digest =
    bundle.recoveryWorkerRegistry.registry_digest;
  resignOwnerBundle(bundle);
  const unsigned: any = {
    sequence: 1,
    recorded_at: fixedNow,
    domain: "micro-routing",
    target_scope_digest: microBinding.target_scope_digest,
    from_state: fromState,
    to_state: "shadow",
    recovery_worker_identity: microBinding.identities.recovery_worker,
    journal_receipt_digest: h("foreign-micro-journal"),
    previous_entry_digest: null,
  };
  const entry: any = {
    ...unsigned,
    entry_digest: w0Digest(unsigned),
    signature: { algorithm: "Ed25519", value_base64: "" },
  };
  const signed = structuredClone(entry);
  delete signed.signature;
  entry.signature.value_base64 = sign(
    null,
    Buffer.from(canonicalizeJcs(signed)),
    recoveryKeys.privateKey,
  ).toString("base64");
  bundle.runtimeNarrowing.entries.push(entry);
  bundle.narrowingCheckpoint.minimum_entries = 1;
  bundle.narrowingCheckpoint.ledger_tail_digest = entry.entry_digest;
}

class Target implements RExactConfigTarget {
  id = "hugin-orin-macro-routing";
  owner = "hugin" as const;
  domain = "macro-routing" as const;
  targetScopeDigest = scope;
  revision = "base-1";
  digest = h("base");
  partial = false;
  beforeReplace?: () => Promise<void>;

  async read() {
    return { revision: this.revision, digest: this.digest };
  }

  async candidateRevision(candidateDigest: string) {
    if (candidateDigest !== h("candidate")) throw new Error("unknown candidate");
    return "candidate-1";
  }

  async snapshot() {
    return { ref: "ref:snapshot-330", digest: h("base") };
  }

  async replaceExact(
    expected: { revision: string; digest: string },
    candidate: string,
  ) {
    await this.beforeReplace?.();
    if (
      expected.revision !== this.revision
      || expected.digest !== this.digest
    ) {
      throw new Error("cas");
    }
    this.digest = this.partial ? h("partial") : candidate;
    this.revision = "candidate-1";
  }
}

class Claims implements RExactAttemptClaims {
  claimCalls = 0;
  rows = new Map<string, {
    attemptId: string;
    proposalDigest: string;
    terminal?: string;
  }>();

  async claim(key: string, attemptId: string, proposalDigest: string) {
    this.claimCalls += 1;
    const row = this.rows.get(key);
    if (!row || row.terminal) {
      this.rows.set(key, { attemptId, proposalDigest });
      return "acquired" as const;
    }
    return row.attemptId === attemptId
      && row.proposalDigest === proposalDigest
      ? "same" as const
      : "busy" as const;
  }

  async assertHeld(
    key: string,
    attemptId: string,
    proposalDigest: string,
  ) {
    const row = this.rows.get(key);
    return row?.attemptId === attemptId
      && row.proposalDigest === proposalDigest;
  }

  async terminalize(
    key: string,
    attemptId: string,
    terminalReceiptDigest: string,
  ) {
    const row = this.rows.get(key);
    if (!row || row.attemptId !== attemptId) throw new Error("claim-lost");
    row.terminal = terminalReceiptDigest;
  }
}

class JournalBackend implements RExactJournalReader {
  rows = new Map<string, RoleWriteResult>();
  history: RoleWriteResult[] = [];
  historical = new Map<string, any>();
  claims = new Claims();
  roleNow: () => string = () => fixedNow;
  beforeAppend?: (entry: JournalEntry) => void;
  checkpointRows = new Map<string, {
    proposalId: string;
    attemptId: string;
    sequence: number;
    tailReceiptDigest: string;
    terminalReceiptDigest: string | null;
  }>();
  checkpoints = {
    read: async (proposalId: string, attemptId: string) => {
      const checkpoint = this.checkpointRows.get(`${proposalId}:${attemptId}`);
      return checkpoint ? structuredClone(checkpoint) : null;
    },
  };
  services: Record<JournalRole, RExactRoleService>
    & { controller: RExactControllerService };

  constructor() {
    this.services = Object.fromEntries(
      ([
        ["controller", "hugin-controller"],
        ["watchdog", "hugin-watchdog"],
        ["recovery-worker", "hugin-recovery"],
      ] as const).map(([role, identity]) => {
        const pair = generateKeyPairSync("ed25519");
        const publicKeyPem = pair.publicKey
          .export({ type: "spki", format: "pem" })
          .toString();
        const service: any = {
          role,
          identity,
          publicKeyPem,
          createAndClaim: async (
            proposalId: string,
            journal: RExactJournal,
            prepared: PreparedAttempt,
            claim: {
              targetKey: string;
              attemptId: string;
              proposalReceiptDigest: string;
            },
            historicalAuthority: any,
          ) => {
            if (role !== "controller") throw new Error("role-create");
            const claimStatus = await this.claims.claim(
              claim.targetKey,
              claim.attemptId,
              claim.proposalReceiptDigest,
            );
            if (claimStatus === "busy") return { status: "busy" as const };
            if (this.rows.has(proposalId)) throw new Error("create-conflict");
            const result = this.result(
              role,
              identity,
              pair.privateKey,
              "create",
              journal,
              prepared,
              null,
            );
            this.rows.set(proposalId, structuredClone(result));
            this.history.push(structuredClone(result));
            this.recordCheckpoint(proposalId, result);
            this.historical.set(
              historicalAuthority.authority.ownerAuthorization
                ? w0Digest(
                    historicalAuthority.authority.ownerAuthorization,
                  )
                : prepared.prepared_authority.authorizationDigest,
              historicalAuthority,
            );
            return {
              status: "prepared" as const,
              write: structuredClone(result),
            };
          },
          append: async (proposalId, expected, entry) => {
            this.beforeAppend?.(entry);
            const stored = this.rows.get(proposalId);
            if (!stored) throw new Error("missing");
            if (
              stored.journal.entries.at(-1)?.receipt_digest !== expected
            ) {
              throw new Error("cas-conflict");
            }
            const expectedRole = entry.phase === "unknown"
              ? "watchdog"
              : ["revert", "disarm", "terminally-blocked"].includes(entry.phase)
                ? "recovery-worker"
                : "controller";
            if (
              role !== expectedRole
              || identity !== entry.executor_identity
            ) {
              throw new Error("role-refused");
            }
            const persistedEntry = structuredClone(entry);
            if (persistedEntry.phase === "watch") {
              persistedEntry.recorded_at = this.roleNow();
              const unsignedEntry: any = structuredClone(persistedEntry);
              delete unsignedEntry.receipt_digest;
              persistedEntry.receipt_digest = w0Digest(unsignedEntry);
            }
            const journal = {
              ...stored.journal,
              entries: [...stored.journal.entries, persistedEntry],
            };
            validateRExactJournal(journal);
            const result = this.result(
              role,
              identity,
              pair.privateKey,
              "append",
              journal,
              stored.prepared,
              expected,
            );
            this.rows.set(proposalId, structuredClone(result));
            this.history.push(structuredClone(result));
            this.recordCheckpoint(proposalId, result);
            return structuredClone(result);
          },
        };
        return [role, service];
      }),
    ) as Record<JournalRole, RExactRoleService>
      & { controller: RExactControllerService };
  }

  async read(proposalId: string) {
    const row = this.rows.get(proposalId);
    return row ? structuredClone(row) : null;
  }

  private recordCheckpoint(
    proposalId: string,
    result: RoleWriteResult,
  ): void {
    const tail = result.journal.entries.at(-1)!;
    const key = `${proposalId}:${result.journal.binding.attempt_id}`;
    const current = this.checkpointRows.get(key);
    if (
      current
      && (
        current.sequence > tail.sequence
        || current.terminalReceiptDigest !== null
      )
    ) {
      return;
    }
    const terminal = ["commit", "disarm", "terminally-blocked"].includes(
      tail.phase,
    );
    this.checkpointRows.set(
      key,
      {
        proposalId,
        attemptId: result.journal.binding.attempt_id,
        sequence: tail.sequence,
        tailReceiptDigest: tail.receipt_digest,
        terminalReceiptDigest: terminal ? tail.receipt_digest : null,
      },
    );
  }

  private result(
    role: JournalRole,
    identity: string,
    privateKey: KeyObject,
    action: "create" | "append",
    journal: RExactJournal,
    prepared: PreparedAttempt,
    previous: string | null,
  ): RoleWriteResult {
    const unsigned = {
      kind: "hugin-r-exact-role-write-receipt" as const,
      schema_version: "v1" as const,
      role,
      identity,
      action,
      journal_id: journal.journal_id,
      binding_digest: journal.binding_digest,
      prepared_digest: w0Digest(prepared),
      previous_receipt_digest: previous,
      resulting_receipt_digest: journal.entries.at(-1)!.receipt_digest,
      recorded_at: journal.entries.at(-1)!.recorded_at,
    };
    const receipt: RoleWriteReceipt = {
      ...unsigned,
      signature: {
        algorithm: "Ed25519",
        value_base64: sign(
          null,
          Buffer.from(canonicalizeJcs(unsigned)),
          privateKey,
        ).toString("base64"),
      },
    };
    return { journal, prepared, receipt };
  }
}

function proposal(
  proposalId = "proposal-330-a",
  base = { revision: "base-1", digest: h("base") },
  candidateDigest = h("candidate"),
) {
  return createAutonomyProposalReceipt({
    proposalId,
    experimentRef: "ref:experiment-330",
    evidenceFingerprints: [h("e")],
    targetId: "hugin-orin-macro-routing",
    base,
    candidateContentDigest: candidateDigest,
    expiresAt: "2026-07-26T15:00:00Z",
    signerKeyId: "hugin-autonomy-proposer",
  }, secret);
}

function proofFor(
  receipt: AutonomyProposalReceipt,
  override: Partial<FreshAdmission> = {},
  targetScopeDigest = scope,
): FreshAdmission {
  return {
    checkedAt: fixedNow,
    trustedWatchdogTime: fixedNow,
    killSwitchOff: true,
    evidenceFresh: true,
    journalHealthy: true,
    rateWindowEligible: true,
    attemptIntervalEligible: true,
    attemptWindowEligible: true,
    livenessHealthy: true,
    watchdogSilenceSeconds: 0,
    proposalDigest: receipt.canonicalProposalDigest,
    targetScopeDigest,
    baseRevision: receipt.base.revision,
    baseDigest: receipt.base.digest,
    candidateDigest: receipt.candidateContentDigest,
    evidenceFingerprintsDigest: w0Digest(receipt.evidenceFingerprints),
    evidenceDigest: h("evidence"),
    policyDigest: h("policy"),
    postconditionsDigest: h("post"),
    configDigest: h("config"),
    deadline: "2026-07-26T15:10:00Z",
    ...override,
  };
}

function gate(
  backend: JournalBackend,
  target: RExactConfigTarget,
  receipt = proposal(),
  bundle = authority(),
  override: Partial<FreshAdmission> = {},
  restoreAndVerify?: W0RuntimeGate["recovery"]["restoreAndVerify"],
): W0RuntimeGate {
  const narrowingHistory: W0AuthorityBundle[] = [];
  let protectedNow = fixedNow;
  const recoveryPrivateKey = (bundle as any)._recoveryPrivateKey;
  const rolePinEntries = Object.values(backend.services).map((service) => {
    const publicKey = createHash("sha256")
      .update(
        createPublicKey(service.publicKeyPem)
          .export({ type: "spki", format: "der" }),
      )
      .digest("hex");
    return {
      role: service.role,
      identity: service.identity,
      public_key_fingerprint: `sha256:${publicKey}`,
    };
  });
  const pinsBase = {
    kind: "hugin-r-exact-role-service-pins" as const,
    schema_version: "v1" as const,
    owner_authorization_digest: w0Digest(bundle.ownerAuthorization),
    entries: rolePinEntries,
  };
  const roleServicePins: any = {
    ...pinsBase,
    pins_digest: w0Digest(pinsBase),
    signature: { algorithm: "Ed25519", value_base64: "" },
  };
  roleServicePins.signature.value_base64 = sign(
    null,
    Buffer.from(canonicalizeJcs({
      ...pinsBase,
      pins_digest: roleServicePins.pins_digest,
    })),
    (bundle as any)._ownerPrivateKey,
  ).toString("base64");
  const runtime: W0RuntimeGate = {
    authority: bundle,
    readAuthority: async () => structuredClone(runtime.authority),
    roleServicePins,
    reader: backend,
    controller: backend.services.controller,
    watchdog: backend.services.watchdog,
    recoveryJournal: backend.services["recovery-worker"],
    claims: backend.claims,
    journalCheckpoints: backend.checkpoints,
    resolveHistoricalAuthority: async (authorizationDigest) =>
      backend.historical.get(authorizationDigest) ?? null,
    currentRecoveryPosture: async (prepared, currentAuthority) => {
      const authorityForPosture = currentAuthority ?? runtime.authority;
      const row = authorityForPosture.coverageIntent.domains.find(
        (item: any) => item.domain === prepared.domain,
      );
      const binding = row?.bindings?.find(
        (item: any) =>
          item.target_scope_digest === prepared.targetScopeDigest,
      );
      if (
        authorityForPosture.coverageIntent.global_state !== "armed"
        || !binding
        || binding.state === "shadow"
      ) {
        return {
          state: "already-safe" as const,
          killSwitchIdentity: prepared.identities.kill_switch,
          safetyDigest: h("protected-already-safe"),
          authorityDigest: currentAuthority
            ? w0Digest(currentAuthority)
            : null,
        };
      }
      const verified = verifyW0Authority(
        authorityForPosture,
        prepared.domain,
        prepared.targetScopeDigest,
        true,
      );
      if (verified.effectiveState === "shadow") {
        return {
          state: "already-safe" as const,
          killSwitchIdentity: verified.identities.kill_switch,
          safetyDigest: h("protected-narrowed"),
          authorityDigest: currentAuthority
            ? w0Digest(currentAuthority)
            : null,
        };
      }
      return {
        state: "broader" as const,
        binding: verified,
      };
    },
    resolveNarrowingAuthority: async (input) => {
      const matches = [...narrowingHistory, runtime.authority].filter(
        (candidate) =>
          w0Digest(candidate.ownerAuthorization)
            === input.ownerAuthorizationDigest
          && candidate.runtimeNarrowing.entries.some(
            (entry: any) =>
              entry.domain === input.domain
              && entry.target_scope_digest === input.targetScopeDigest
              && entry.journal_receipt_digest
                === input.terminalReceiptDigest
              && entry.recovery_worker_identity
                === input.recoveryWorkerIdentity
              && entry.from_state === input.fromState,
          ),
      );
      const matchingEntryDigests = new Set(matches.flatMap(
        (candidate) => candidate.runtimeNarrowing.entries
          .filter((entry: any) =>
            entry.domain === input.domain
            && entry.target_scope_digest === input.targetScopeDigest
            && entry.journal_receipt_digest
              === input.terminalReceiptDigest)
          .map((entry: any) => entry.entry_digest),
      ));
      if (matchingEntryDigests.size > 1) {
        throw new Error("ambiguous-protected-narrowing");
      }
      return matches[0] ?? null;
    },
    protectedNow: () => new Date(protectedNow),
    awaitProtectedWatch: async (input) => {
      protectedNow = input.watchDeadline;
      return {
        proposalId: input.proposalId,
        attemptId: input.attemptId,
        targetId: input.targetId,
        targetScopeDigest: input.targetScopeDigest,
        candidateDigest: input.candidateDigest,
        watchReceiptDigest: input.watchReceiptDigest,
        watchdogIdentity: input.watchdogIdentity,
        watchStartedAt: input.watchStartedAt,
        watchDeadline: input.watchDeadline,
        completedAt: protectedNow,
        maxObservedSilenceSeconds: 60,
        killSwitchStayedOff: true,
        evidenceStayedFresh: true,
        journalStayedHealthy: true,
        livenessStayedHealthy: true,
      };
    },
    verifyFresh: async () => proofFor(receipt, {
      checkedAt: protectedNow,
      trustedWatchdogTime: protectedNow,
      ...override,
    }, target.targetScopeDigest),
    verifyRecovery: async (_prepared, current) => ({
      checkedAt: protectedNow,
      trustedWatchdogTime: protectedNow,
      killSwitchIdentity: current.state === "broader"
        ? current.binding.identities.kill_switch
        : current.killSwitchIdentity,
      killSwitchStateDigest: h("kill-switch-off"),
      journalHealthy: true,
    }),
    recovery: {
      restoreAndVerify: restoreAndVerify ?? (async (input) => {
        target.digest = input.snapshotDigest;
        target.revision = input.baseRevision;
        return {
          restoredRevision: target.revision,
          restoredDigest: target.digest,
        };
      }),
      narrowAndVerify: async ({ binding, journalReceiptDigest }) => {
        const next = structuredClone(runtime.authority);
        const previous =
          next.runtimeNarrowing.entries.at(-1)?.entry_digest ?? null;
        const digestInput: any = {
          sequence: next.runtimeNarrowing.entries.length + 1,
          recorded_at: fixedNow,
          domain: binding.domain,
          target_scope_digest: binding.targetScopeDigest,
          from_state: binding.state,
          to_state: "shadow",
          recovery_worker_identity: binding.identities.recovery_worker,
          journal_receipt_digest: journalReceiptDigest,
          previous_entry_digest: previous,
        };
        const entry: any = {
          ...digestInput,
          entry_digest: w0Digest(digestInput),
          signature: { algorithm: "Ed25519", value_base64: "" },
        };
        const unsigned = structuredClone(entry);
        delete unsigned.signature;
        entry.signature.value_base64 = sign(
          null,
          Buffer.from(canonicalizeJcs(unsigned)),
          (runtime.authority as any)._recoveryPrivateKey
            ?? recoveryPrivateKey,
        ).toString("base64");
        next.runtimeNarrowing.entries.push(entry);
        next.narrowingCheckpoint.minimum_entries =
          next.runtimeNarrowing.entries.length;
        next.narrowingCheckpoint.ledger_tail_digest = entry.entry_digest;
        narrowingHistory.push(structuredClone(next));
        runtime.authority = next;
        return next;
      },
    },
  };
  backend.roleNow = () =>
    runtime.protectedNow().toISOString().replace(".000Z", "Z");
  return runtime;
}

function strictMacroCandidate(base: { revision: string; digest: string }) {
  const body = {
    schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION,
    targetId: "hugin-orin-macro-routing" as const,
    revision: "orin-macro-route-v2",
    base,
    config: {
      routes: [
        { workerProvider: "homeserver", taskType: "classify", sensitivity: "internal", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
        { workerProvider: "homeserver", taskType: "classify", sensitivity: "public", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
        { workerProvider: "homeserver", taskType: "extract", sensitivity: "internal", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
        { workerProvider: "homeserver", taskType: "extract", sensitivity: "public", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
      ],
    },
  };
  return { ...body, candidateDigest: h(canonicalizeJcs(body)) };
}

describe("W0.2 R-exact controller", () => {
  it("exports the exact shared phase vocabulary and proposal epoch", () => {
    expect(R_EXACT_CONFORMANCE.phases).toEqual(W0_JOURNAL_PHASES);
    expect(proposal().policyEpoch.constitutionDigest)
      .toBe(W0_CONSTITUTION_DIGEST);
    expect(rolePhaseFixture.constitution_digest)
      .toBe(W0_CONSTITUTION_DIGEST);
    for (const [role, phases] of Object.entries(rolePhaseFixture)) {
      if (role === "constitution_digest") continue;
      for (const phase of phases as any[]) {
        expect(roleForPhase(phase)).toBe(role);
      }
    }
  });

  it("rejects a newly submitted, correctly re-signed v1 proposal epoch", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const current = proposal();
    const legacy: any = structuredClone(current);
    legacy.policyEpoch.id = "grimnir-adr-008-v1";
    legacy.policyEpoch.constitutionId = "grimnir-autonomy-v1";
    legacy.policyEpoch.constitutionDigest =
      "sha256:51efdb78c4524780919649f285862543db8b38a6a3a07894f0fad8bdab40fc6c";
    delete legacy.signature;
    delete legacy.canonicalProposalDigest;
    legacy.canonicalProposalDigest = canonicalAutonomyProposalDigest(legacy);
    legacy.signature = signAutonomyProposalReceipt(legacy, secret);
    await expect(
      applyRExactProposal(legacy, keys, target, gate(backend, target)),
    ).rejects.toThrow("proposal-invalid-receipt");
  });

  it("rejects mixed v1 constitution and v2 coverage authority", () => {
    const mixed = authority();
    mixed.constitution = structuredClone(legacyConstitutionFixture);
    expect(
      () => verifyW0Authority(mixed, "macro-routing", scope),
    ).toThrow("w0-authority-rejected:schema");
  });

  it("commits through independently authenticated role services", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      gate(backend, target, receipt),
    );
    expect(result.status).toBe("committed");
    expect(result.journal.entries.map((entry) => entry.phase)).toEqual([
      "prepare",
      "apply",
      "verify",
      "watch",
      "commit",
    ]);
    expect(result.journal.entries.at(-1)?.recorded_at)
      .toBe("2026-07-26T15:00:00Z");
    expect(result.journal.schema_version).toBe("v2");
    validateRExactJournal(result.journal, false);
  });

  it("recovers a real durable strict-config attempt across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-r-exact-composition-"));
    const store = new HuginConfigStore(root);
    const target = createHuginConfigTargets(store)["hugin-orin-macro-routing"];
    const base = await target.read();
    const candidate = store.stage(strictMacroCandidate(base));
    const receipt = proposal("proposal-338-strict-config", base, candidate.candidateDigest);
    const backend = new JournalBackend();
    const bundle = authority(target.targetScopeDigest);
    const recovery = createHuginConfigRecoveryWorker(store);
    let unknownWasDurableBeforeRestore = false;
    const runtime = gate(
      backend,
      target,
      receipt,
      bundle,
      {},
      async (input) => {
        unknownWasDurableBeforeRestore = (await backend.read(receipt.proposalId))
          ?.journal.entries.at(-1)?.phase === "unknown";
        return recovery.restoreAndVerify(input);
      },
    );

    await expect(applyRExactProposal(receipt, keys, target, runtime, {
      onPhase: (phase) => {
        if (phase === "readback") throw new Error("simulated-process-crash");
      },
      onRecoveryCause: () => { throw new Error("simulated-process-crash"); },
    })).rejects.toThrow("simulated-process-crash");
    expect(await target.read()).toEqual({
      revision: candidate.revision,
      digest: candidate.candidateDigest,
    });
    expect((await backend.read(receipt.proposalId))?.journal.entries.at(-1)?.phase)
      .toBe("apply");

    const restartedStore = new HuginConfigStore(root);
    const restartedTarget = createHuginConfigTargets(restartedStore)["hugin-orin-macro-routing"];
    const restartedRecovery = createHuginConfigRecoveryWorker(restartedStore);
    const restartedRuntime = gate(
      backend,
      restartedTarget,
      receipt,
      bundle,
      {},
      async (input) => {
        unknownWasDurableBeforeRestore = (await backend.read(receipt.proposalId))
          ?.journal.entries.at(-1)?.phase === "unknown";
        return restartedRecovery.restoreAndVerify(input);
      },
    );
    const result = await applyRExactProposal(
      receipt,
      keys,
      restartedTarget,
      restartedRuntime,
    );

    expect(result.status).toBe("disarmed");
    expect(unknownWasDurableBeforeRestore).toBe(true);
    expect(result.journal.entries.map((entry) => entry.phase)).toEqual([
      "prepare", "apply", "unknown", "revert", "disarm",
    ]);
    expect(await restartedTarget.read()).toEqual(base);
    expect(await createHuginConfigTargets(new HuginConfigStore(root))[
      "hugin-orin-macro-routing"
    ].read()).toEqual(base);
  });


  it("starts the full watch at the service-authored durable append time", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    let roleTime = fixedNow;
    backend.beforeAppend = (entry) => {
      if (entry.phase === "watch") {
        roleTime = "2026-07-26T14:02:00Z";
      }
    };
    backend.roleNow = () => roleTime;
    runtime.protectedNow = () => new Date(roleTime);
    runtime.verifyFresh = async () => proofFor(receipt, {
      checkedAt: roleTime,
      trustedWatchdogTime: roleTime,
    });
    let protectedWatchStartedAt: string | null = null;
    runtime.awaitProtectedWatch = async (input) => {
      protectedWatchStartedAt = input.watchStartedAt;
      roleTime = input.watchDeadline;
      return {
        ...input,
        completedAt: roleTime,
        maxObservedSilenceSeconds: 0,
        killSwitchStayedOff: true,
        evidenceStayedFresh: true,
        journalStayedHealthy: true,
        livenessStayedHealthy: true,
      };
    };

    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
    );

    expect(result.status).toBe("committed");
    expect(result.journal.entries.find((entry) => entry.phase === "watch")
      ?.recorded_at).toBe("2026-07-26T14:02:00Z");
    expect(protectedWatchStartedAt).toBe("2026-07-26T14:02:00Z");
    expect(result.journal.entries.at(-1)?.recorded_at)
      .toBe("2026-07-26T15:02:00Z");
  });

  it("refuses commit when the protected watch returns before one hour", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    let recoveryCause: unknown;
    (runtime as any).awaitProtectedWatch = async (input: any) => ({
      proposalId: input.proposalId,
      attemptId: input.attemptId,
      targetId: input.targetId,
      targetScopeDigest: input.targetScopeDigest,
      candidateDigest: input.candidateDigest,
      watchReceiptDigest: input.watchReceiptDigest,
      watchdogIdentity: input.watchdogIdentity,
      watchStartedAt: input.watchStartedAt,
      watchDeadline: input.watchDeadline,
      completedAt: fixedNow,
      maxObservedSilenceSeconds: 0,
      killSwitchStayedOff: true,
      evidenceStayedFresh: true,
      journalStayedHealthy: true,
      livenessStayedHealthy: true,
    });
    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
      { onRecoveryCause: (error) => { recoveryCause = error; } },
    );
    expect(result.status).toBe("disarmed");
    expect(recoveryCause).toEqual(
      expect.objectContaining({ message: "r-exact-watch-incomplete" }),
    );
    expect(result.journal.entries.some((entry) => entry.phase === "commit"))
      .toBe(false);
  });

  it("rejects a protected watch with a silence gap above 900 seconds", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const awaitWatch = runtime.awaitProtectedWatch;
    runtime.awaitProtectedWatch = async (input) => ({
      ...await awaitWatch(input),
      maxObservedSilenceSeconds: 901,
    });
    let recoveryCause: unknown;
    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
      { onRecoveryCause: (error) => { recoveryCause = error; } },
    );
    expect(result.status).toBe("disarmed");
    expect(recoveryCause).toEqual(
      expect.objectContaining({ message: "r-exact-watch-incomplete" }),
    );
  });

  it.each([
    ["proposalId", "proposal-attacker"],
    ["attemptId", "attempt-attacker"],
    ["targetId", "hugin-agent-prompt"],
    ["targetScopeDigest", h("other-scope")],
    ["candidateDigest", h("other-candidate")],
    ["watchReceiptDigest", h("other-watch-receipt")],
    ["watchdogIdentity", "attacker-watchdog"],
  ] as const)(
    "rejects a protected watch proof replayed across %s",
    async (field, value) => {
      const backend = new JournalBackend();
      const target = new Target();
      const receipt = proposal();
      const runtime = gate(backend, target, receipt);
      const awaitWatch = runtime.awaitProtectedWatch;
      runtime.awaitProtectedWatch = async (input) => ({
        ...await awaitWatch(input),
        [field]: value,
      });
      let recoveryCause: unknown;
      const result = await applyRExactProposal(
        receipt,
        keys,
        target,
        runtime,
        { onRecoveryCause: (error) => { recoveryCause = error; } },
      );
      expect(result.status).toBe("disarmed");
      expect(recoveryCause).toEqual(
        expect.objectContaining({ message: "r-exact-watch-incomplete" }),
      );
    },
  );

  it.each([
    {
      elapsed: 300_000,
      expected: "committed",
      watchAt: "2026-07-26T14:05:00Z",
    },
    {
      elapsed: 300_001,
      expected: "disarmed",
      watchAt: null,
    },
  ] as const)(
    "enforces the apply/readback/verify-to-durable-watch bound at $elapsed ms",
    async ({ elapsed, expected, watchAt }) => {
      const backend = new JournalBackend();
      const target = new Target();
      const receipt = proposal();
      const runtime = gate(backend, target, receipt);
      let now = fixedNow;
      runtime.protectedNow = () => new Date(now);
      runtime.verifyFresh = async () => proofFor(receipt, {
        checkedAt: now,
        trustedWatchdogTime: now,
      });
      runtime.verifyRecovery = async (_prepared, current) => ({
        checkedAt: now,
        trustedWatchdogTime: now,
        killSwitchIdentity: current.state === "broader"
          ? current.binding.identities.kill_switch
          : current.killSwitchIdentity,
        killSwitchStateDigest: h("kill-switch-off"),
        journalHealthy: true,
      });
      target.beforeReplace = async () => {
        now = new Date(Date.parse(fixedNow) + elapsed).toISOString()
          .replace(".000Z", "Z");
      };
      runtime.awaitProtectedWatch = async (input) => {
        now = input.watchDeadline;
        return {
          ...input,
          completedAt: now,
          maxObservedSilenceSeconds: 0,
          killSwitchStayedOff: true,
          evidenceStayedFresh: true,
          journalStayedHealthy: true,
          livenessStayedHealthy: true,
        };
      };
      const result = await applyRExactProposal(
        receipt,
        keys,
        target,
        runtime,
      );
      expect(result.status).toBe(expected);
      expect(
        result.journal.entries.find((entry) => entry.phase === "watch")
          ?.recorded_at ?? null,
      ).toBe(watchAt);
    },
  );

  it.each([
    { elapsed: 3_900_000, expected: "committed" },
    { elapsed: 3_900_001, expected: "disarmed" },
  ] as const)(
    "enforces the 300 second commit grace at $elapsed ms after watch receipt",
    async ({ elapsed, expected }) => {
      const backend = new JournalBackend();
      const target = new Target();
      const receipt = proposal();
      const runtime = gate(backend, target, receipt);
      let now = fixedNow;
      runtime.protectedNow = () => new Date(now);
      runtime.verifyFresh = async () => proofFor(receipt, {
        checkedAt: now,
        trustedWatchdogTime: now,
      });
      runtime.verifyRecovery = async (_prepared, current) => ({
        checkedAt: now,
        trustedWatchdogTime: now,
        killSwitchIdentity: current.state === "broader"
          ? current.binding.identities.kill_switch
          : current.killSwitchIdentity,
        killSwitchStateDigest: h("kill-switch-off"),
        journalHealthy: true,
      });
      runtime.awaitProtectedWatch = async (input) => {
        now = new Date(Date.parse(input.watchStartedAt) + elapsed)
          .toISOString()
          .replace(".000Z", "Z");
        return {
          ...input,
          completedAt: now,
          maxObservedSilenceSeconds: 0,
          killSwitchStayedOff: true,
          evidenceStayedFresh: true,
          journalStayedHealthy: true,
          livenessStayedHealthy: true,
        };
      };
      const result = await applyRExactProposal(
        receipt,
        keys,
        target,
        runtime,
      );
      expect(result.status).toBe(expected);
    },
  );

  it("resumes a durable watch after process loss instead of reverting it", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    let now = fixedNow;
    let watchCalls = 0;
    runtime.protectedNow = () => new Date(now);
    runtime.verifyFresh = async () => proofFor(receipt, {
      checkedAt: now,
      trustedWatchdogTime: now,
    });
    (runtime as any).awaitProtectedWatch = async (input: any) => {
      watchCalls += 1;
      if (watchCalls === 1) {
        await new Promise<never>(() => {});
      }
      now = input.watchDeadline;
      return {
        proposalId: input.proposalId,
        attemptId: input.attemptId,
        targetId: input.targetId,
        targetScopeDigest: input.targetScopeDigest,
        candidateDigest: input.candidateDigest,
        watchReceiptDigest: input.watchReceiptDigest,
        watchdogIdentity: input.watchdogIdentity,
        watchStartedAt: input.watchStartedAt,
        watchDeadline: input.watchDeadline,
        completedAt: now,
        maxObservedSilenceSeconds: 60,
        killSwitchStayedOff: true,
        evidenceStayedFresh: true,
        journalStayedHealthy: true,
        livenessStayedHealthy: true,
      };
    };
    void applyRExactProposal(receipt, keys, target, runtime);
    for (let tries = 0; tries < 20; tries += 1) {
      const stored = await backend.read(receipt.proposalId);
      if (stored?.journal.entries.at(-1)?.phase === "watch") break;
      await Promise.resolve();
    }
    expect((await backend.read(receipt.proposalId))
      ?.journal.entries.at(-1)?.phase).toBe("watch");

    const resumed = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
    );
    expect(resumed.status).toBe("committed");
    expect(resumed.journal.entries.at(-1)?.recorded_at)
      .toBe("2026-07-26T15:00:00Z");
    expect(target.digest).toBe(h("candidate"));
  });

  it("emits a journal accepted by the exact canonical Grimnir schema", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      gate(backend, target, receipt),
    );
    expect(
      schemaErrors(
        canonicalJournalSchema,
        canonicalJournalSchema,
        result.journal as unknown as JsonValue,
      ),
    ).toEqual([]);
  });

  it("binds fresh admission exactly to proposal, base, candidate, and evidence", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    await expect(
      applyRExactProposal(
        receipt,
        keys,
        target,
        gate(backend, target, receipt, authority(), {
          candidateDigest: h("other"),
        }),
      ),
    ).rejects.toThrow("admission-subject-mismatch");
    expect(target.digest).toBe(h("base"));
  });

  it.each([
    {
      name: "deadline above 4200 seconds",
      override: { deadline: "2026-07-26T15:10:00.001Z" },
    },
    {
      name: "deadline below 4200 seconds",
      override: { deadline: "2026-07-26T15:09:59.999Z" },
    },
  ])("rejects a noncanonical constitutional $name window before mutation", async ({
    override,
  }) => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    target.beforeReplace = async () => {
      throw new Error("mutation-ran");
    };
    await expect(
      applyRExactProposal(
        receipt,
        keys,
        target,
        gate(backend, target, receipt, authority(), override),
      ),
    ).rejects.toThrow("admission-window-bound");
    expect(await backend.read(receipt.proposalId)).toBeNull();
  });

  it.each([
    { attemptIntervalEligible: false },
    { attemptWindowEligible: false },
    { watchdogSilenceSeconds: 901 },
  ])("rejects incomplete protected frequency/liveness proof %#", async (
    override,
  ) => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    await expect(
      applyRExactProposal(
        receipt,
        keys,
        target,
        gate(backend, target, receipt, authority(), override),
      ),
    ).rejects.toThrow("r-exact-apply-gate-refused");
    expect(await backend.read(receipt.proposalId)).toBeNull();
  });

  it("rejects later admission drift before apply", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    let calls = 0;
    runtime.verifyFresh = async () =>
      proofFor(receipt, calls++ ? { policyDigest: h("changed") } : {});
    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
    );
    expect(result.status).toBe("disarmed");
    expect(target.digest).toBe(h("base"));
  });

  it("restores from immutable prepared authority after owner rotation", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const rotated = authority();
    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
      {
        onPhase: (phase) => {
          if (phase === "snapshot") runtime.authority = rotated;
        },
      },
    );
    expect(result.status).toBe("disarmed");
    expect(target.digest).toBe(h("base"));
  });

  it.each([
    { phase: "pre-apply", disarmRead: 2, expectedReplaces: 0 },
    { phase: "pre-commit", disarmRead: 3, expectedReplaces: 1 },
  ])("observes protected global disarm at $phase", async ({
    disarmRead,
    expectedReplaces,
  }) => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    let reads = 0;
    let replaces = 0;
    target.beforeReplace = async () => {
      replaces += 1;
    };
    runtime.readAuthority = async () => {
      reads += 1;
      if (reads === disarmRead) {
        runtime.authority.coverageIntent.global_state = "disarmed";
        runtime.authority.coverageIntent.registry_digest = w0Digest(
          runtime.authority.coverageIntent,
          "registry_digest",
        );
        runtime.authority.ownerAuthorization.bindings
          .coverage_intent_digest =
            runtime.authority.coverageIntent.registry_digest;
        resignOwnerBundle(runtime.authority);
      }
      return structuredClone(runtime.authority);
    };
    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
    );
    expect(result.status).toBe("disarmed");
    expect(replaces).toBe(expectedReplaces);
    expect(target.digest).toBe(h("base"));
  });

  it("recovers after proposal expiry and signer-key retirement", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    await expect(
      applyRExactProposal(receipt, keys, target, runtime, {
        onPhase: (phase) => {
          if (phase === "snapshot") throw new Error("pause-after-prepare");
        },
      }),
    ).rejects.toThrow("pause-after-prepare");
    runtime.protectedNow = () => new Date("2026-07-26T16:00:00Z");
    runtime.verifyRecovery = async (_prepared, current) => ({
      checkedAt: "2026-07-26T16:00:00Z",
      trustedWatchdogTime: "2026-07-26T16:00:00Z",
      killSwitchIdentity: current.state === "broader"
        ? current.binding.identities.kill_switch
        : current.killSwitchIdentity,
      killSwitchStateDigest: h("kill-switch-off"),
      journalHealthy: true,
    });
    runtime.readAuthority = async () => {
      throw new Error("live-authority-unavailable");
    };
    const recovered = await applyRExactProposal(
      receipt,
      {},
      target,
      runtime,
    );
    expect(recovered.status).toBe("disarmed");
  });

  it("closed-parses the direct recovery proposal identifier", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    await expect(
      recoverRExactAttempt(
        { proposalId: "../../unbounded" },
        {},
        target,
        gate(backend, target),
      ),
    ).rejects.toThrow("recovery-receipt-shape");
  });

  it.each(["global-disarm", "binding-removed"] as const)(
    "recovers against historical authority when current posture is %s",
    async (mode) => {
      const backend = new JournalBackend();
      const target = new Target();
      target.partial = true;
      const receipt = proposal();
      const runtime = gate(backend, target, receipt);
      await expect(
        applyRExactProposal(receipt, keys, target, runtime, {
          onPhase: (phase) => {
            if (phase === "readback") throw new Error("pause-for-safety");
          },
        }),
      ).resolves.toMatchObject({ status: "disarmed" });

      // Start a fresh nonterminal attempt against a separate backend.
      const retryBackend = new JournalBackend();
      const retryTarget = new Target();
      const retryReceipt = proposal(`proposal-330-${mode}`);
      const retryRuntime = gate(retryBackend, retryTarget, retryReceipt);
      await expect(
        applyRExactProposal(
          retryReceipt,
          keys,
          retryTarget,
          retryRuntime,
          {
            onPhase: (phase) => {
              if (phase === "snapshot") throw new Error("pause-after-prepare");
            },
          },
        ),
      ).rejects.toThrow("pause-after-prepare");
      if (mode === "global-disarm") {
        retryRuntime.authority.coverageIntent.global_state = "disarmed";
      } else {
        const row = retryRuntime.authority.coverageIntent.domains.find(
          (item: any) => item.domain === "macro-routing",
        );
        row.bindings = [];
      }
      redigestAndResignAuthorityArtifacts(retryRuntime.authority);
      const recovered = await applyRExactProposal(
        retryReceipt,
        keys,
        retryTarget,
        retryRuntime,
      );
      expect(recovered.status).toBe("disarmed");
      expect(retryRuntime.authority.runtimeNarrowing.entries)
        .toHaveLength(0);
    },
  );

  it("rejects an already-safe posture not bound to the protected authority read", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    target.partial = true;
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    runtime.currentRecoveryPosture = async (prepared) => ({
      state: "already-safe",
      killSwitchIdentity: prepared.identities.kill_switch,
      safetyDigest: h("claimed-safe"),
      authorityDigest: h("different-authority"),
    });
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("r-exact-recovery-posture-authority-mismatch");
  });

  it("refuses an already-safe claim when signed authority is still armed", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    target.partial = true;
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    runtime.currentRecoveryPosture = async (prepared, currentAuthority) => ({
      state: "already-safe",
      killSwitchIdentity: prepared.identities.kill_switch,
      safetyDigest: h("claimed-safe"),
      authorityDigest: w0Digest(currentAuthority),
    });

    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("r-exact-recovery-posture-authority-mismatch");
    expect(runtime.authority.runtimeNarrowing.entries).toHaveLength(0);
  });

  it("cryptographically validates current authority on an already-safe recovery path", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    target.partial = true;
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    runtime.authority.ownerAuthorization.signature.value_base64 =
      Buffer.alloc(64).toString("base64");
    runtime.currentRecoveryPosture = async (prepared, currentAuthority) => ({
      state: "already-safe",
      killSwitchIdentity: prepared.identities.kill_switch,
      safetyDigest: h("claimed-safe"),
      authorityDigest: w0Digest(currentAuthority),
    });
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("w0-authority-rejected:owner-signature");
  });

  it("freezes owner pins and role services before asynchronous admission", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const rotatedBackend = new JournalBackend();
    const frozenPins = structuredClone(runtime.roleServicePins);
    const originalVerify = runtime.verifyFresh;
    let mutated = false;
    runtime.verifyFresh = async (...args) => {
      if (!mutated) {
        mutated = true;
        runtime.roleServicePins = structuredClone(frozenPins);
        runtime.roleServicePins.entries[0].public_key_fingerprint =
          h("rotated-after-snapshot");
        runtime.controller = rotatedBackend.services.controller;
        runtime.watchdog = rotatedBackend.services.watchdog;
        runtime.recoveryJournal =
          rotatedBackend.services["recovery-worker"];
      }
      return originalVerify(...args);
    };
    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
    );
    expect(result.status).toBe("committed");
    const stored = (await backend.read(receipt.proposalId))!;
    expect(stored.prepared.role_service_pins).toEqual(frozenPins);
    expect(await rotatedBackend.read(receipt.proposalId)).toBeNull();
  });

  it("recovers through retained historical services after live rotation", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const rotatedBackend = new JournalBackend();
    await expect(
      applyRExactProposal(receipt, keys, target, runtime, {
        onPhase: (phase) => {
          if (phase === "snapshot") {
            runtime.controller = rotatedBackend.services.controller;
            runtime.watchdog = rotatedBackend.services.watchdog;
            runtime.recoveryJournal =
              rotatedBackend.services["recovery-worker"];
            throw new Error("rotate-live-services");
          }
        },
      }),
    ).rejects.toThrow("rotate-live-services");
    const recovered = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
    );
    expect(recovered.status).toBe("disarmed");
    expect((await backend.read(receipt.proposalId))?.journal.entries.at(-1)
      ?.phase).toBe("disarm");
  });

  it("rejects key reuse across role services", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    runtime.watchdog.publicKeyPem = runtime.controller.publicKeyPem;
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("role-service-key-reuse");
  });

  it("rejects controller-side substitution of owner-pinned role keys", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    runtime.roleServicePins.entries[0].public_key_fingerprint = h("forged");
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("role-service-pins-signature");
    expect(Object.keys(runtime.recovery)).not.toContain("privateKey");
    expect(Object.keys(runtime.recoveryJournal)).not.toContain("privateKey");
  });

  it("rejects a role key swapped while an authenticated write is in flight", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const attacker = generateKeyPairSync("ed25519");
    const originalCreate = runtime.controller.createAndClaim
      .bind(runtime.controller);
    runtime.controller.createAndClaim = async (...args) => {
      const result = await originalCreate(...args);
      if (result.status === "busy") return result;
      runtime.controller.publicKeyPem = attacker.publicKey
        .export({ type: "spki", format: "pem" })
        .toString();
      const unsigned = structuredClone(result.write.receipt);
      delete (unsigned as Partial<RoleWriteReceipt>).signature;
      result.write.receipt.signature.value_base64 = sign(
        null,
        Buffer.from(canonicalizeJcs(unsigned)),
        attacker.privateKey,
      ).toString("base64");
      return result;
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("role-service");
    expect(target.digest).toBe(h("base"));
  });

  it("rejects a role identity swapped while an authenticated write is in flight", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const originalCreate = runtime.controller.createAndClaim
      .bind(runtime.controller);
    runtime.controller.createAndClaim = async (...args) => {
      const result = await originalCreate(...args);
      if (result.status === "busy") return result;
      runtime.controller.identity = "substituted-controller";
      return result;
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("role-service");
    expect(target.digest).toBe(h("base"));
  });

  it("leaves no claim or journal on snapshot or atomic prepare failure", async () => {
    const snapshotBackend = new JournalBackend();
    const snapshotTarget = new Target();
    const snapshotReceipt = proposal();
    const snapshotRuntime = gate(
      snapshotBackend,
      snapshotTarget,
      snapshotReceipt,
    );
    const snapshotClaims = snapshotRuntime.claims as Claims;
    snapshotTarget.snapshot = async () => {
      throw new Error("snapshot-offline");
    };
    await expect(
      applyRExactProposal(
        snapshotReceipt,
        keys,
        snapshotTarget,
        snapshotRuntime,
      ),
    ).rejects.toThrow("snapshot-offline");
    expect(snapshotClaims.claimCalls).toBe(0);
    expect(await snapshotBackend.read(snapshotReceipt.proposalId)).toBeNull();

    const createBackend = new JournalBackend();
    const createTarget = new Target();
    const createReceipt = proposal();
    const createRuntime = gate(createBackend, createTarget, createReceipt);
    const createClaims = createRuntime.claims as Claims;
    createRuntime.controller.createAndClaim = async () => {
      throw new Error("prepare-create-offline");
    };
    await expect(
      applyRExactProposal(createReceipt, keys, createTarget, createRuntime),
    ).rejects.toThrow("prepare-create-offline");
    expect(createClaims.claimCalls).toBe(0);
    expect(await createBackend.read(createReceipt.proposalId)).toBeNull();
  });

  it("leaves neither claim nor prepare when atomic acquisition crashes", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    runtime.claims.claim = async () => {
      throw new Error("claim-service-crash");
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("claim-service-crash");
    expect(await backend.read(receipt.proposalId)).toBeNull();
    expect(target.digest).toBe(h("base"));

    backend.claims = new Claims();
    runtime.claims = backend.claims;
    const recovered = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
    );
    expect(recovered.status).toBe("committed");
    expect(recovered.journal.entries.at(-1)?.phase).toBe("commit");
  });

  it("refuses mutation unless atomic prepare is durably readable", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const original = runtime.controller.createAndClaim
      .bind(runtime.controller);
    runtime.controller.createAndClaim = async (...args) => {
      const result = await original(...args);
      backend.rows.delete(receipt.proposalId);
      return result;
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("atomic-prepare-not-durable");
    expect(target.digest).toBe(h("base"));
  });

  it("refuses mutation unless the atomic historical snapshot is readable", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const original = runtime.controller.createAndClaim
      .bind(runtime.controller);
    runtime.controller.createAndClaim = async (...args) => {
      const result = await original(...args);
      backend.historical.clear();
      return result;
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("historical-snapshot-not-durable");
    expect(target.digest).toBe(h("base"));
  });

  it("atomically excludes a concurrent proposal for the same target", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const firstReceipt = proposal("proposal-330-a");
    const secondReceipt = proposal("proposal-330-b");
    const claims = new Claims();
    backend.claims = claims;
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    target.beforeReplace = async () => {
      entered();
      await releasePromise;
    };
    const firstGate = gate(backend, target, firstReceipt);
    firstGate.claims = claims;
    const first = applyRExactProposal(
      firstReceipt,
      keys,
      target,
      firstGate,
    );
    await enteredPromise;
    const secondGate = gate(backend, target, secondReceipt);
    secondGate.claims = claims;
    await expect(
      applyRExactProposal(secondReceipt, keys, target, secondGate),
    ).rejects.toThrow("target-busy");
    expect(await backend.read(secondReceipt.proposalId)).toBeNull();
    expect(target.digest).toBe(h("base"));
    release();
    expect((await first).status).toBe("committed");
    expect(target.digest).toBe(h("candidate"));
  });

  it("rejects a stale role-service CAS append", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    await expect(
      applyRExactProposal(receipt, keys, target, runtime, {
        onPhase: (phase) => {
          if (phase === "snapshot") throw new Error("pause-after-create");
        },
      }),
    ).rejects.toThrow("pause-after-create");
    const stored = (await backend.read(receipt.proposalId))!;
    const prepareDigest = stored.journal.entries[0].receipt_digest;
    const entry = buildJournalEntry(
      stored.journal,
      "apply",
      fixedNow,
      "hugin-controller",
    );
    await backend.services.controller.append(
      receipt.proposalId,
      prepareDigest,
      entry,
    );
    await expect(
      backend.services.controller.append(
        receipt.proposalId,
        prepareDigest,
        entry,
      ),
    ).rejects.toThrow("cas-conflict");
  });

  it.each(["mutation", "readback", "terminalization"] as const)(
    "recovers and demotes after a crash at %s",
    async (crashPhase) => {
      const backend = new JournalBackend();
      const target = new Target();
      const receipt = proposal();
      const runtime = gate(backend, target, receipt);
      let recoveryCause: unknown;
      const result = await applyRExactProposal(
        receipt,
        keys,
        target,
        runtime,
        {
          onPhase: (phase) => {
            if (phase === crashPhase) throw new Error(`crash-${phase}`);
          },
          onRecoveryCause: (error) => {
            recoveryCause = error;
          },
        },
      );
      expect(result.status).toBe("disarmed");
      expect(recoveryCause).toBeInstanceOf(Error);
      expect((recoveryCause as Error).message).toBe(`crash-${crashPhase}`);
      expect(target.digest).toBe(h("base"));
      expect(result.journal.entries.at(-1)?.coverage_transition?.to_state)
        .toBe("shadow");
      expect(
        runtime.authority.runtimeNarrowing.entries[0].journal_receipt_digest,
      ).toBe(result.journal.entries.at(-1)?.receipt_digest);
    },
  );

  it("demotes before terminally-blocked when recovery throws", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    target.partial = true;
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const recoveryCauses: string[] = [];
    runtime.recovery.restoreAndVerify = async () => {
      throw new Error("restore-offline");
    };
    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
      {
        onRecoveryCause: (error) => {
          recoveryCauses.push(
            error instanceof Error ? error.message : String(error),
          );
        },
      },
    );
    expect(result.status).toBe("terminally-blocked");
    expect(result.journal.entries.at(-1)?.phase)
      .toBe("terminally-blocked");
    expect(result.journal.entries.at(-1)?.coverage_transition?.to_state)
      .toBe("shadow");
    expect(runtime.authority.runtimeNarrowing.entries).toHaveLength(1);
    expect(
      runtime.authority.runtimeNarrowing.entries[0].journal_receipt_digest,
    ).toBe(result.journal.entries.at(-1)?.receipt_digest);
    expect(recoveryCauses).toContain("r-exact-readback-mismatch");
    expect(recoveryCauses).toContain("restore-offline");
  });

  it("never terminalizes a recovery worker's wrong target/receipt narrowing", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    target.partial = true;
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const recoveryPrivateKey =
      (runtime.authority as any)._recoveryPrivateKey;
    const original = runtime.recovery.narrowAndVerify;
    runtime.recovery.narrowAndVerify = async (input) => {
      const next = await original(input);
      const entry = next.runtimeNarrowing.entries.at(-1);
      entry.journal_receipt_digest = h("wrong-terminal");
      const digestInput = structuredClone(entry);
      delete digestInput.entry_digest;
      delete digestInput.signature;
      entry.entry_digest = w0Digest(digestInput);
      const unsigned = structuredClone(entry);
      delete unsigned.signature;
      entry.signature.value_base64 = sign(
        null,
        Buffer.from(canonicalizeJcs(unsigned)),
        recoveryPrivateKey,
      ).toString("base64");
      next.narrowingCheckpoint.ledger_tail_digest = entry.entry_digest;
      return next;
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("narrowing-receipt-binding");
    const stored = (await backend.read(receipt.proposalId))!;
    expect(["disarm", "terminally-blocked"]).not.toContain(
      stored.journal.entries.at(-1)?.phase,
    );
  });

  it("uses prepared pins to reject a recovery key swap during append", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    target.partial = true;
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const attacker = generateKeyPairSync("ed25519");
    const originalAppend = runtime.recoveryJournal.append
      .bind(runtime.recoveryJournal);
    runtime.recoveryJournal.append = async (...args) => {
      const result = await originalAppend(...args);
      runtime.recoveryJournal.publicKeyPem = attacker.publicKey
        .export({ type: "spki", format: "pem" })
        .toString();
      const unsigned = structuredClone(result.receipt);
      delete (unsigned as Partial<RoleWriteReceipt>).signature;
      result.receipt.signature.value_base64 = sign(
        null,
        Buffer.from(canonicalizeJcs(unsigned)),
        attacker.privateKey,
      ).toString("base64");
      return result;
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("role-service");
    const stored = (await backend.read(receipt.proposalId))!;
    expect(["disarm", "terminally-blocked"]).not.toContain(
      stored.journal.entries.at(-1)?.phase,
    );
  });

  it("rejects a store-recomputed journal, prepared sidecar, and receipt", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    await expect(
      applyRExactProposal(receipt, keys, target, runtime, {
        onPhase: (phase) => {
          if (phase === "snapshot") throw new Error("pause-after-prepare");
        },
      }),
    ).rejects.toThrow("pause-after-prepare");
    const tampered = (await backend.read(receipt.proposalId))!;
    tampered.prepared.snapshot_ref = "ref:tampered-snapshot";
    tampered.journal.binding.config_digest = h("tampered-config");
    tampered.journal.binding_digest = w0Digest(tampered.journal.binding);
    const entry = tampered.journal.entries[0];
    entry.binding_digest = tampered.journal.binding_digest;
    const unsignedEntry: any = structuredClone(entry);
    delete unsignedEntry.receipt_digest;
    entry.receipt_digest = w0Digest(unsignedEntry);
    tampered.receipt.binding_digest = tampered.journal.binding_digest;
    tampered.receipt.prepared_digest = w0Digest(tampered.prepared);
    tampered.receipt.resulting_receipt_digest = entry.receipt_digest;
    backend.rows.set(receipt.proposalId, structuredClone(tampered));

    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("role-receipt-signature");
    expect(target.digest).toBe(h("base"));
  });

  it("rejects self-replaced owner fingerprint and role pins", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    await expect(
      applyRExactProposal(receipt, keys, target, runtime, {
        onPhase: (phase) => {
          if (phase === "snapshot") throw new Error("pause-after-prepare");
        },
      }),
    ).rejects.toThrow("pause-after-prepare");
    const tampered = (await backend.read(receipt.proposalId))!;
    tampered.prepared.prepared_owner_key_fingerprint = h("attacker-owner");
    tampered.prepared.role_service_pins.entries[0]
      .public_key_fingerprint = h("attacker-controller");
    const pinsBase = {
      kind: tampered.prepared.role_service_pins.kind,
      schema_version: tampered.prepared.role_service_pins.schema_version,
      owner_authorization_digest:
        tampered.prepared.role_service_pins.owner_authorization_digest,
      entries: tampered.prepared.role_service_pins.entries,
    };
    tampered.prepared.role_service_pins.pins_digest = w0Digest(pinsBase);
    tampered.prepared.role_service_pins_digest = w0Digest(
      tampered.prepared.role_service_pins,
    );
    tampered.receipt.prepared_digest = w0Digest(tampered.prepared);
    backend.rows.set(receipt.proposalId, structuredClone(tampered));

    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("historical-authority-mismatch");
    expect(target.digest).toBe(h("base"));
  });

  it("reconciles the exact precomputed disarm after its append fails", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    target.partial = true;
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const originalAppend = runtime.recoveryJournal.append
      .bind(runtime.recoveryJournal);
    let failed = false;
    runtime.recoveryJournal.append = async (...args) => {
      if (!failed && args[2].phase === "disarm") {
        failed = true;
        throw new Error("disarm-journal-offline");
      }
      return originalAppend(...args);
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("disarm-append-pending");
    const pending = (await backend.read(receipt.proposalId))!;
    expect(pending.journal.entries.at(-1)?.phase).toBe("revert");
    const narrowedReceipt = runtime.authority.runtimeNarrowing.entries.at(-1)
      ?.journal_receipt_digest;
    expect(narrowedReceipt).toMatch(/^sha256:/);

    runtime.verifyRecovery = async (_prepared, current) => ({
      checkedAt: fixedNow,
      trustedWatchdogTime: fixedNow,
      killSwitchIdentity: current.state === "broader"
        ? current.binding.identities.kill_switch
        : current.killSwitchIdentity,
      killSwitchStateDigest: h("changed-kill-switch-observation"),
      journalHealthy: true,
    });
    const recovered = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
    );
    expect(recovered.status).toBe("disarmed");
    expect(recovered.journal.entries.at(-1)?.receipt_digest)
      .toBe(narrowedReceipt);
    expect(runtime.authority.runtimeNarrowing.entries).toHaveLength(1);
  });

  it.each([
    "later-unrelated-narrowing",
    "owner-epoch-rotation",
    "global-disarm",
    "binding-removed",
  ] as const)(
    "replays pending terminal-blocked across %s before restore",
    async (mode) => {
    const backend = new JournalBackend();
    const target = new Target();
    target.partial = true;
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const successfulRestore = runtime.recovery.restoreAndVerify;
    runtime.recovery.restoreAndVerify = async () => {
      throw new Error("restore-offline");
    };
    const originalAppend = runtime.recoveryJournal.append
      .bind(runtime.recoveryJournal);
    let failedTerminalAppend = false;
    runtime.recoveryJournal.append = async (...args) => {
      if (
        !failedTerminalAppend
        && args[2].phase === "terminally-blocked"
      ) {
        failedTerminalAppend = true;
        throw new Error("terminal-journal-offline");
      }
      return originalAppend(...args);
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("terminal-journal-offline");
    const narrowedReceipt = runtime.authority.runtimeNarrowing.entries.at(-1)
      ?.journal_receipt_digest;
    expect((await backend.read(receipt.proposalId))?.journal.entries.at(-1)
      ?.phase).toBe("unknown");
    if (mode === "later-unrelated-narrowing") {
      runtime.authority = authority();
      const unrelatedBinding = verifyW0Authority(
        runtime.authority,
        "macro-routing",
        scope,
        true,
      );
      runtime.authority = await runtime.recovery.narrowAndVerify({
        binding: unrelatedBinding,
        journalReceiptDigest: h("later-unrelated-terminal"),
      });
    } else if (mode === "owner-epoch-rotation") {
      runtime.authority = authority();
    } else if (mode === "global-disarm") {
      runtime.authority = authority();
      runtime.authority.coverageIntent.global_state = "disarmed";
    } else {
      runtime.authority = authority();
      const row = runtime.authority.coverageIntent.domains.find(
        (item: any) => item.domain === "macro-routing",
      );
      row.bindings = [];
    }
    if (mode === "global-disarm" || mode === "binding-removed") {
      redigestAndResignAuthorityArtifacts(runtime.authority);
    }

    let laterRestoreCalls = 0;
    runtime.recovery.restoreAndVerify = async (input) => {
      laterRestoreCalls += 1;
      return successfulRestore(input);
    };
    const recovered = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
    );
    expect(recovered.status).toBe("terminally-blocked");
    expect(recovered.journal.entries.at(-1)?.receipt_digest)
      .toBe(narrowedReceipt);
    expect(laterRestoreCalls).toBe(0);
    },
  );

  it("refuses pending narrowing from a different owner epoch", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    target.partial = true;
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const originalAppend = runtime.recoveryJournal.append
      .bind(runtime.recoveryJournal);
    let failed = false;
    runtime.recoveryJournal.append = async (...args) => {
      if (!failed && args[2].phase === "disarm") {
        failed = true;
        throw new Error("disarm-journal-offline");
      }
      return originalAppend(...args);
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("disarm-append-pending");
    const historicalNarrowing = structuredClone(runtime.authority);

    const wrongEpoch = authority();
    wrongEpoch.recoveryWorkerRegistry = structuredClone(
      historicalNarrowing.recoveryWorkerRegistry,
    );
    wrongEpoch.ownerAuthorization.bindings.recovery_worker_registry_digest =
      wrongEpoch.recoveryWorkerRegistry.registry_digest;
    wrongEpoch.runtimeNarrowing.entries = structuredClone(
      historicalNarrowing.runtimeNarrowing.entries,
    );
    wrongEpoch.narrowingCheckpoint.minimum_entries =
      wrongEpoch.runtimeNarrowing.entries.length;
    wrongEpoch.narrowingCheckpoint.ledger_tail_digest =
      wrongEpoch.runtimeNarrowing.entries.at(-1)?.entry_digest ?? null;
    resignOwnerBundle(wrongEpoch);

    let resolvedInput:
      | Parameters<W0RuntimeGate["resolveNarrowingAuthority"]>[0]
      | undefined;
    runtime.resolveNarrowingAuthority = async (input) => {
      resolvedInput = input;
      return wrongEpoch;
    };
    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("pending-narrowing-authority-mismatch");
    const stored = (await backend.read(receipt.proposalId))!;
    expect(stored.journal.entries.at(-1)?.phase).toBe("revert");
    expect(resolvedInput).toMatchObject({
      ownerAuthorizationDigest:
        stored.prepared.prepared_authority.authorizationDigest,
      recoveryWorkerIdentity:
        stored.prepared.prepared_authority.identities.recovery_worker,
      fromState: stored.prepared.prepared_authority.state,
    });
  });

  it("rejects an altered receipt retry before recovery", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    await expect(
      applyRExactProposal(receipt, keys, target, runtime, {
        onPhase: (phase) => {
          if (phase === "snapshot") throw new Error("crash-after-prepare");
        },
      }),
    ).rejects.toThrow("crash-after-prepare");
    const altered: any = structuredClone(receipt);
    altered.candidateContentDigest = h("altered");
    delete altered.signature;
    delete altered.canonicalProposalDigest;
    altered.canonicalProposalDigest = canonicalAutonomyProposalDigest(altered);
    altered.signature = signAutonomyProposalReceipt(altered, secret);
    await expect(
      applyRExactProposal(altered, keys, target, runtime),
    ).rejects.toThrow("prepared-attempt-invalid");
    expect(target.digest).toBe(h("base"));
  });

  it("returns exact idempotent status for an identical committed retry", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    expect(
      (await applyRExactProposal(receipt, keys, target, runtime)).status,
    ).toBe("committed");
    expect(
      (await applyRExactProposal(receipt, keys, target, runtime)).status,
    ).toBe("already-committed");
    expect(target.digest).toBe(h("candidate"));
  });

  it("rejects an old authentic signed prefix after terminal commit", async () => {
    const backend = new JournalBackend();
    const target = new Target();
    const receipt = proposal();
    const runtime = gate(backend, target, receipt);
    const committed = await applyRExactProposal(
      receipt,
      keys,
      target,
      runtime,
    );
    expect(committed.status).toBe("committed");
    const staleApply = backend.history.find(
      (result) => result.journal.entries.at(-1)?.phase === "apply",
    );
    expect(staleApply).toBeDefined();
    backend.rows.set(receipt.proposalId, structuredClone(staleApply!));

    await expect(
      applyRExactProposal(receipt, keys, target, runtime),
    ).rejects.toThrow("r-exact-journal-checkpoint-stale");
    expect(target.digest).toBe(h("candidate"));
    expect(runtime.authority.runtimeNarrowing.entries).toHaveLength(0);
  });

  it("rejects stale base, bad signature, and partial writes", async () => {
    const staleBackend = new JournalBackend();
    const staleTarget = new Target();
    staleTarget.revision = "base-2";
    await expect(
      applyRExactProposal(
        proposal(),
        keys,
        staleTarget,
        gate(staleBackend, staleTarget),
      ),
    ).rejects.toThrow("stale-or-mismatched-base");

    const bad = proposal() as any;
    bad.signature = `${bad.signature.slice(0, -1)}${
      bad.signature.endsWith("0") ? "1" : "0"
    }`;
    const badBackend = new JournalBackend();
    const badTarget = new Target();
    await expect(
      applyRExactProposal(bad, keys, badTarget, gate(badBackend, badTarget)),
    ).rejects.toThrow("invalid-signature");

    const partialBackend = new JournalBackend();
    const partialTarget = new Target();
    partialTarget.partial = true;
    const partialReceipt = proposal();
    const partial = await applyRExactProposal(
      partialReceipt,
      keys,
      partialTarget,
      gate(partialBackend, partialTarget, partialReceipt),
    );
    expect(partial.status).toBe("disarmed");
    expect(partialTarget.digest).toBe(h("base"));
  });

  it("rejects re-digested coverage and forged narrowing", () => {
    const altered = authority();
    altered.coverageIntent.domains[0].bindings[0].writer_owner = "hugin";
    altered.coverageIntent.registry_digest = w0Digest(
      altered.coverageIntent,
      "registry_digest",
    );
    altered.ownerAuthorization.bindings.coverage_intent_digest =
      altered.coverageIntent.registry_digest;
    resignOwnerBundle(altered);
    expect(
      () => verifyW0Authority(altered, "macro-routing", scope),
    ).toThrow("coverage");

    const truncated = authority();
    truncated.coverageIntent.domains.pop();
    truncated.coverageIntent.registry_digest = w0Digest(
      truncated.coverageIntent,
      "registry_digest",
    );
    truncated.ownerAuthorization.bindings.coverage_intent_digest =
      truncated.coverageIntent.registry_digest;
    resignOwnerBundle(truncated);
    expect(
      () => verifyW0Authority(truncated, "macro-routing", scope),
    ).toThrow("w0-authority-rejected:schema");

    const forged = authority();
    const unsigned: any = {
      sequence: 1,
      recorded_at: fixedNow,
      domain: "macro-routing",
      target_scope_digest: scope,
      from_state: "armed-canary",
      to_state: "shadow",
      recovery_worker_identity: "hugin-recovery",
      journal_receipt_digest: h("journal"),
      previous_entry_digest: null,
    };
    forged.runtimeNarrowing.entries = [{
      ...unsigned,
      entry_digest: w0Digest(unsigned),
      signature: { algorithm: "Ed25519", value_base64: "AA==" },
    }];
    forged.narrowingCheckpoint.minimum_entries = 1;
    forged.narrowingCheckpoint.ledger_tail_digest =
      forged.runtimeNarrowing.entries[0].entry_digest;
    expect(
      () => verifyW0Authority(forged, "macro-routing", scope),
    ).toThrow("narrowing-signature");
  });

  it("validates and ignores signed foreign-domain narrowing during Hugin recovery", async () => {
    const bundle = authority();
    appendSignedForeignNarrowing(bundle);
    expect(
      () => verifyW0Authority(bundle, "macro-routing", scope),
    ).not.toThrow();

    const backend = new JournalBackend();
    const target = new Target();
    target.partial = true;
    const receipt = proposal();
    const result = await applyRExactProposal(
      receipt,
      keys,
      target,
      gate(backend, target, receipt, bundle),
    );
    expect(result.status).toBe("disarmed");
    expect(target.digest).toBe(h("base"));
    expect(bundle.runtimeNarrowing.entries[0].domain).toBe("micro-routing");

    const wrongForeignBinding = authority();
    appendSignedForeignNarrowing(wrongForeignBinding, "armed-fleet");
    expect(
      () => verifyW0Authority(
        wrongForeignBinding,
        "macro-routing",
        scope,
      ),
    ).toThrow("narrowing-authority-binding");
  });

  it("rejects re-signed cross-row coverage semantic substitution", () => {
    const substitutedClassPolicy = authority();
    const macroRow = substitutedClassPolicy.coverageIntent.domains.find(
      (row: any) => row.domain === "macro-routing",
    );
    macroRow.required_for_levels = ["permanent"];
    macroRow.owner_scope = "owning-component";
    redigestAndResignAuthorityArtifacts(substitutedClassPolicy);

    const substitutedRecoveryClass = authority();
    substitutedRecoveryClass.coverageIntent.domains.find(
      (row: any) => row.domain === "macro-routing",
    ).recovery_class = "R-forward";
    redigestAndResignAuthorityArtifacts(substitutedRecoveryClass);

    const substitutedTargetState = authority();
    substitutedTargetState.coverageIntent.domains.find(
      (row: any) => row.domain === "macro-routing",
    ).target_state = "armed-fleet";
    redigestAndResignAuthorityArtifacts(substitutedTargetState);

    const substitutedFixedOwner = authority();
    const microRow = substitutedFixedOwner.coverageIntent.domains.find(
      (row: any) => row.domain === "micro-routing",
    );
    const microAttestation =
      substitutedFixedOwner.ownerAttestations.attestations.find(
        (row: any) => row.domain === "micro-routing",
      );
    microRow.bindings[0].writer_owner = "hugin";
    microRow.bindings[0].configuration_owner = "hugin";
    microAttestation.configuration_owner = "hugin";
    microAttestation.attestation_digest = w0Digest(
      microAttestation,
      "attestation_digest",
    );
    microRow.bindings[0].configuration_owner_authority_digest =
      microAttestation.attestation_digest;
    redigestAndResignAuthorityArtifacts(substitutedFixedOwner);

    const implicitOwningWriter = authority();
    const promptRow = implicitOwningWriter.coverageIntent.domains.find(
      (row: any) => row.domain === "prompt",
    );
    const promptTarget = h("prompt-scope");
    const promptAttestation: any = {
      attestation_id: "prompt-attestation",
      domain: "prompt",
      target_scope_digest: promptTarget,
      configuration_owner: "owning-component",
      issued_at: fixedNow,
      attestation_digest: h("placeholder"),
    };
    promptAttestation.attestation_digest = w0Digest(
      promptAttestation,
      "attestation_digest",
    );
    implicitOwningWriter.ownerAttestations.attestations.push(
      promptAttestation,
    );
    promptRow.bindings.push({
      writer_owner: "owning-component",
      owner_authority_ref: "ref:prompt-owner-authority",
      owner_authority_digest: h("prompt-owner-authority"),
      configuration_owner: "owning-component",
      configuration_owner_authority_ref: "ref:prompt-attestation",
      configuration_owner_authority_digest:
        promptAttestation.attestation_digest,
      target_scope_digest: promptTarget,
      state: "shadow",
      identities: {
        owner: "prompt-owner",
        controller: "prompt-controller",
        watchdog: "prompt-watchdog",
        kill_switch: "prompt-kill-switch",
        recovery_worker: "prompt-recovery",
      },
    });
    redigestAndResignAuthorityArtifacts(implicitOwningWriter);

    const misalignedState = authority();
    misalignedState.coverageIntent.domains.find(
      (row: any) => row.domain === "micro-routing",
    ).bindings[0].state = "armed-canary";
    redigestAndResignAuthorityArtifacts(misalignedState);

    const reusedFleetIdentity = authority();
    reusedFleetIdentity.coverageIntent.domains.find(
      (row: any) => row.domain === "micro-routing",
    ).bindings[0].identities.owner = "hugin-owner";
    redigestAndResignAuthorityArtifacts(reusedFleetIdentity);

    const unboundAttestation = authority();
    unboundAttestation.coverageIntent.domains.find(
      (row: any) => row.domain === "micro-routing",
    ).bindings[0].configuration_owner_authority_digest = h(
      "not-the-attestation",
    );
    redigestAndResignAuthorityArtifacts(unboundAttestation);

    for (const [name, bundle] of [
      ["class policy", substitutedClassPolicy],
      ["recovery class", substitutedRecoveryClass],
      ["target state", substitutedTargetState],
      ["fixed owner", substitutedFixedOwner],
      ["concrete owning-component writer", implicitOwningWriter],
      ["binding state", misalignedState],
      ["fleet identity", reusedFleetIdentity],
      ["owner attestation", unboundAttestation],
    ] as const) {
      expect(
        () => verifyW0Authority(bundle, "macro-routing", scope),
        name,
      ).toThrow("w0-authority-rejected:coverage");
    }
  });

  it("rejects schema-invalid W0 artifacts even after valid re-digesting", () => {
    const impossibleDate = authority();
    impossibleDate.coverageIntent.issued_at = "2026-02-31T00:00:00Z";
    impossibleDate.coverageIntent.registry_digest = w0Digest(
      impossibleDate.coverageIntent,
      "registry_digest",
    );
    impossibleDate.ownerAuthorization.bindings.coverage_intent_digest =
      impossibleDate.coverageIntent.registry_digest;
    resignOwnerBundle(impossibleDate);

    const malformedPrevious = authority();
    malformedPrevious.ownerAuthorization.authorization_sequence = 2;
    malformedPrevious.ownerAuthorization.previous_authorization_digest =
      "not-a-digest";
    resignOwnerBundle(malformedPrevious);

    const invalidRegistryId = authority();
    invalidRegistryId.ownerAttestations.registry_id = "Owner Attestations";
    invalidRegistryId.ownerAttestations.registry_digest = w0Digest(
      invalidRegistryId.ownerAttestations,
      "registry_digest",
    );
    invalidRegistryId.ownerAuthorization.bindings
      .owner_attestation_registry_digest =
        invalidRegistryId.ownerAttestations.registry_digest;
    resignOwnerBundle(invalidRegistryId);

    const impossibleEntryDate = authority();
    impossibleEntryDate.ownerAttestations.attestations[0].issued_at =
      "2026-02-31T00:00:00Z";
    impossibleEntryDate.ownerAttestations.attestations[0]
      .attestation_digest = w0Digest(
        impossibleEntryDate.ownerAttestations.attestations[0],
        "attestation_digest",
      );
    impossibleEntryDate.ownerAttestations.registry_digest = w0Digest(
      impossibleEntryDate.ownerAttestations,
      "registry_digest",
    );
    impossibleEntryDate.ownerAuthorization.bindings
      .owner_attestation_registry_digest =
        impossibleEntryDate.ownerAttestations.registry_digest;
    resignOwnerBundle(impossibleEntryDate);

    for (const bundle of [
      impossibleDate,
      malformedPrevious,
      invalidRegistryId,
      impossibleEntryDate,
    ]) {
      expect(
        () => verifyW0Authority(bundle, "macro-routing", scope),
      ).toThrow("w0-authority-rejected:schema");
    }
  });

  it("uses Grimnir's exact canonical UTC spelling", () => {
    expect(isExactUtc("2026-07-27T00:00:00Z")).toBe(true);
    expect(isExactUtc("2026-07-27T00:00:00.001Z")).toBe(true);
    expect(isExactUtc("2026-07-27T00:00:00.999Z")).toBe(true);
    expect(isExactUtc("2026-07-27T00:00:00.000Z")).toBe(false);
  });
});
