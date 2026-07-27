/** Exact W0.1 journal construction and semantic validation. */
import { canonicalizeJcs } from "../jcs.js";
import { canonicalJournalSchemaErrors } from "./grimnir-w0-schemas.js";
import { W0_CONSTITUTION_DIGEST, w0Digest } from "./w0-authority.js";
import type {
  JournalEntry,
  JournalRole,
  RExactJournal,
} from "./r-exact-types.js";

type Phase = JournalEntry["phase"];
type Outcome = JournalEntry["outcome"];

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const idPattern = /^[a-z][a-z0-9-]{2,62}$/;
const refPattern = /^ref:[a-z][a-z0-9-]{2,120}$/;
const utcPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const CONSTITUTIONAL_WINDOW_MS = 3_600_000;
const exactKeys = (value: unknown, keys: string[]): boolean =>
  !!value
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const exactUtc = (value: unknown): value is string =>
  typeof value === "string"
  && utcPattern.test(value)
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString().replace(".000Z", "Z") === value;
const idDigest = (prefix: string, value: string): string =>
  `${prefix}-${w0Digest({ value }).slice(7, 31)}`;

const phaseOutcome: Record<Phase, Outcome> = {
  prepare: "prepared",
  apply: "applied",
  verify: "verified",
  watch: "watching",
  commit: "committed",
  unknown: "unknown",
  revert: "reverted",
  disarm: "disarmed",
  "terminally-blocked": "terminally-blocked",
};
const transitions: Record<Phase, readonly Phase[]> = {
  prepare: ["apply", "unknown"],
  apply: ["verify", "unknown"],
  verify: ["watch", "unknown"],
  watch: ["commit", "unknown"],
  commit: [],
  unknown: ["revert", "terminally-blocked"],
  revert: ["disarm", "terminally-blocked"],
  disarm: [],
  "terminally-blocked": [],
};

export const roleForPhase = (phase: Phase): JournalRole =>
  phase === "unknown"
    ? "watchdog"
    : ["revert", "disarm", "terminally-blocked"].includes(phase)
      ? "recovery-worker"
      : "controller";

const identityForRole = (
  role: JournalRole,
  binding: Record<string, any>,
): string =>
  role === "controller"
    ? binding.controller_identity
    : role === "watchdog"
      ? binding.watchdog_identity
      : binding.recovery_worker_identity;

export const latestEntry = (journal: RExactJournal): JournalEntry =>
  journal.entries.at(-1)!;

function assertContentBlind(value: unknown): void {
  if (
    /(raw.prompt|payload|secret|command|private.locator|candidate.content)/i
      .test(canonicalizeJcs(value))
  ) {
    throw new Error("r-exact-journal-not-content-blind");
  }
}

export function buildJournalEntry(
  journal: RExactJournal,
  phase: Phase,
  at: string,
  executor: string,
  terminalReasonDigest: string | null = null,
  coverageTransition: JournalEntry["coverage_transition"] = null,
): JournalEntry {
  const prior = journal.entries.at(-1);
  if (prior && !transitions[prior.phase].includes(phase)) {
    throw new Error(`r-exact-invalid-transition:${prior.phase}:${phase}`);
  }
  const unsigned = {
    entry_id: idDigest(
      phase === "terminally-blocked" ? "terminal" : phase,
      `${journal.journal_id}:${journal.entries.length + 1}`,
    ),
    sequence: journal.entries.length + 1,
    recorded_at: at,
    phase,
    outcome: phaseOutcome[phase],
    executor_identity: executor,
    binding_digest: journal.binding_digest,
    quarantine: {
      state: phase === "terminally-blocked"
        ? "active" as const
        : "not-applicable" as const,
      reason_digest: w0Digest({
        state: phase === "terminally-blocked"
          ? "active"
          : "not-applicable",
      }),
    },
    coverage_transition: coverageTransition,
    terminal_reason_digest: terminalReasonDigest,
    previous_receipt_digest: prior?.receipt_digest ?? null,
    content_refs: [
      `ref:${idDigest("candidate", journal.binding.candidate_digest)}`,
    ],
  };
  return { ...unsigned, receipt_digest: w0Digest(unsigned) };
}

export function appendJournalEntry(
  journal: RExactJournal,
  entry: JournalEntry,
): RExactJournal {
  return { ...journal, entries: [...journal.entries, entry] };
}

/**
 * Validate a strict one-entry in-flight prefix or canonical W0.1 journal.
 * Passing `allowInflight=false` additionally requires a terminal export.
 */
export function validateRExactJournal(
  journal: RExactJournal,
  allowInflight = true,
): void {
  const bindingKeys = [
    "mutation_id",
    "attempt_id",
    "recovery_disarm_id",
    "idempotency_key",
    "writer_owner",
    "owner_authority_ref",
    "owner_authority_digest",
    "configuration_owner",
    "configuration_owner_authority_ref",
    "configuration_owner_authority_digest",
    "target_scope_digest",
    "admission_coverage_digest",
    "admission_binding_state",
    "owner_identity",
    "controller_identity",
    "watchdog_identity",
    "kill_switch_identity",
    "recovery_worker_identity",
    "risk_scope",
    "candidate_digest",
    "config_digest",
    "evidence_digest",
    "policy_digest",
    "baseline_digest",
    "postconditions_digest",
    "deadline",
    "canary",
    "recovery",
  ];
  if (
    !exactKeys(journal, [
      "kind",
      "schema_version",
      "journal_id",
      "domain",
      "constitution_digest",
      "binding",
      "binding_digest",
      "entries",
      "extensions",
    ])
    || !exactKeys(journal.binding, bindingKeys)
    || journal.kind !== "autonomous-mutation-journal"
    || journal.schema_version !== "v1"
    || !idPattern.test(journal.journal_id)
    || journal.constitution_digest !== W0_CONSTITUTION_DIGEST
    || journal.extensions.length !== 0
    || journal.binding_digest !== w0Digest(journal.binding)
    || journal.domain !== journal.binding.risk_scope
    || journal.binding.writer_owner !== "hugin"
    || journal.binding.configuration_owner !== "hugin"
    || !Array.isArray(journal.entries)
    || journal.entries.length < 1
    || (
      journal.entries.length >= 2
      && canonicalJournalSchemaErrors(journal).length > 0
    )
  ) {
    throw new Error("r-exact-journal-schema");
  }
  if (
    !exactKeys(journal.binding.canary, [
      "scope_digest",
      "target_count",
      "watch_deadline",
    ])
    || !exactKeys(journal.binding.recovery, [
      "class",
      "worker_identity",
      "descriptor_digest",
      "disarms_after_action",
    ])
    || journal.binding.canary.scope_digest
      !== journal.binding.target_scope_digest
    || journal.binding.canary.target_count !== 1
    || journal.binding.recovery.class !== "R-exact"
    || journal.binding.recovery.worker_identity
      !== journal.binding.recovery_worker_identity
    || !digestPattern.test(journal.binding.recovery.descriptor_digest)
    || journal.binding.recovery.disarms_after_action !== true
    || !exactUtc(journal.binding.deadline)
    || !exactUtc(journal.binding.canary.watch_deadline)
    || Date.parse(journal.binding.canary.watch_deadline)
      > Date.parse(journal.binding.deadline)
  ) {
    throw new Error("r-exact-journal-binding-schema");
  }
  const identities = [
    journal.binding.owner_identity,
    journal.binding.controller_identity,
    journal.binding.watchdog_identity,
    journal.binding.kill_switch_identity,
    journal.binding.recovery_worker_identity,
  ];
  if (
    new Set(identities).size !== 5
    || !identities.every((identity) => idPattern.test(identity))
  ) {
    throw new Error("r-exact-journal-identities");
  }
  for (const field of [
    "owner_authority_digest",
    "configuration_owner_authority_digest",
    "target_scope_digest",
    "admission_coverage_digest",
    "candidate_digest",
    "config_digest",
    "evidence_digest",
    "policy_digest",
    "baseline_digest",
    "postconditions_digest",
  ]) {
    if (!digestPattern.test(journal.binding[field])) {
      throw new Error("r-exact-journal-binding-digest");
    }
  }
  if (
    !digestPattern.test(journal.binding.recovery.descriptor_digest)
    || !refPattern.test(journal.binding.owner_authority_ref)
    || !refPattern.test(journal.binding.configuration_owner_authority_ref)
    || !idPattern.test(journal.binding.mutation_id)
    || !idPattern.test(journal.binding.attempt_id)
    || !idPattern.test(journal.binding.recovery_disarm_id)
    || !idPattern.test(journal.binding.idempotency_key)
    || journal.binding.attempt_id === journal.binding.recovery_disarm_id
  ) {
    throw new Error("r-exact-journal-binding-format");
  }
  let previous: JournalEntry | undefined;
  const entryIds = new Set<string>();
  for (const entry of journal.entries) {
    if (
      !exactKeys(entry, [
        "entry_id",
        "sequence",
        "recorded_at",
        "phase",
        "outcome",
        "executor_identity",
        "binding_digest",
        "quarantine",
        "coverage_transition",
        "terminal_reason_digest",
        "previous_receipt_digest",
        "receipt_digest",
        "content_refs",
      ])
      || !exactKeys(entry.quarantine, ["state", "reason_digest"])
      || !idPattern.test(entry.entry_id)
      || entryIds.has(entry.entry_id)
      || !exactUtc(entry.recorded_at)
      || entry.outcome !== phaseOutcome[entry.phase]
      || entry.sequence !== (previous?.sequence ?? 0) + 1
      || entry.previous_receipt_digest !== (previous?.receipt_digest ?? null)
      || entry.binding_digest !== journal.binding_digest
      || entry.executor_identity
        !== identityForRole(roleForPhase(entry.phase), journal.binding)
      || !digestPattern.test(entry.quarantine.reason_digest)
      || !Array.isArray(entry.content_refs)
      || entry.content_refs.length < 1
      || new Set(entry.content_refs).size !== entry.content_refs.length
      || !entry.content_refs.every((ref) => refPattern.test(ref))
    ) {
      throw new Error("r-exact-journal-entry-schema");
    }
    entryIds.add(entry.entry_id);
    const unsigned = structuredClone(entry);
    delete (unsigned as Partial<JournalEntry>).receipt_digest;
    if (entry.receipt_digest !== w0Digest(unsigned)) {
      throw new Error("r-exact-journal-receipt-digest");
    }
    if (
      previous
      && (
        Date.parse(entry.recorded_at) < Date.parse(previous.recorded_at)
        || !transitions[previous.phase].includes(entry.phase)
      )
    ) {
      throw new Error("r-exact-journal-transition");
    }
    if (
      ["prepare", "apply", "verify", "watch", "commit"].includes(entry.phase)
      && Date.parse(entry.recorded_at) > Date.parse(journal.binding.deadline)
    ) {
      throw new Error("r-exact-journal-deadline");
    }
    if (
      entry.phase === "watch"
      && Date.parse(entry.recorded_at)
        > Date.parse(journal.binding.canary.watch_deadline)
    ) {
      throw new Error("r-exact-journal-watch-late");
    }
    if (
      entry.phase === "commit"
      && Date.parse(entry.recorded_at)
        < Date.parse(journal.binding.canary.watch_deadline)
    ) {
      throw new Error("r-exact-journal-commit-early");
    }
    const terminalReasonRequired = [
      "unknown",
      "disarm",
      "terminally-blocked",
    ].includes(entry.phase);
    if (
      terminalReasonRequired !== (entry.terminal_reason_digest !== null)
      || (
        entry.terminal_reason_digest !== null
        && !digestPattern.test(entry.terminal_reason_digest)
      )
    ) {
      throw new Error("r-exact-journal-terminal-reason");
    }
    const coverageRequired = ["disarm", "terminally-blocked"].includes(
      entry.phase,
    );
    if (coverageRequired !== (entry.coverage_transition !== null)) {
      throw new Error("r-exact-journal-coverage");
    }
    if (
      entry.coverage_transition
      && (
        !exactKeys(entry.coverage_transition, [
          "from_state",
          "to_state",
          "target_scope_digest",
          "actor_identity",
        ])
        || entry.coverage_transition.from_state
          !== journal.binding.admission_binding_state
        || entry.coverage_transition.to_state !== "shadow"
        || entry.coverage_transition.target_scope_digest
          !== journal.binding.target_scope_digest
        || entry.coverage_transition.actor_identity
          !== journal.binding.recovery_worker_identity
        || entry.executor_identity !== entry.coverage_transition.actor_identity
      )
    ) {
      throw new Error("r-exact-journal-coverage");
    }
    if (
      (entry.phase === "terminally-blocked")
      !== (entry.quarantine.state === "active")
    ) {
      throw new Error("r-exact-journal-quarantine");
    }
    previous = entry;
  }
  if (
    Date.parse(journal.binding.deadline)
      - Date.parse(journal.entries[0].recorded_at)
      > CONSTITUTIONAL_WINDOW_MS
  ) {
    throw new Error("r-exact-journal-deadline-bound");
  }
  const watchEntry = journal.entries.find((entry) => entry.phase === "watch");
  if (
    watchEntry
    && Date.parse(journal.binding.canary.watch_deadline)
      - Date.parse(watchEntry.recorded_at)
      > CONSTITUTIONAL_WINDOW_MS
  ) {
    throw new Error("r-exact-journal-watch-bound");
  }
  if (journal.entries[0]!.phase !== "prepare") {
    throw new Error("r-exact-journal-start");
  }
  const terminal = ["commit", "disarm", "terminally-blocked"].includes(
    latestEntry(journal).phase,
  );
  if (!allowInflight && (!terminal || journal.entries.length < 2)) {
    throw new Error("r-exact-journal-not-terminal");
  }
  if (
    latestEntry(journal).phase === "disarm"
    && !journal.entries.some((entry) => entry.phase === "revert")
  ) {
    throw new Error("r-exact-journal-disarm-without-revert");
  }
  assertContentBlind(journal);
}
