/**
 * Production candidate-pool assembler (hugin#272) -- fuel for the #266
 * experiment cadence.
 *
 * `experiment-cadence.ts`'s module doc comment names an explicit,
 * intentional gap: assembling the full production `PackagerCandidateInput[]`
 * pool is out of #234/#233's scope, so the cadence tick takes `loadCandidates`
 * as a REQUIRED injected dependency rather than building a bulk evidence scan
 * itself. Before this module, `experiment-cadence-cli.ts` filled that gap
 * with an operator/cron-supplied JSON snapshot file (`--candidates <path>`) --
 * deploy seeded an empty `[]`, so the daily tick only ever observed/concluded
 * already-packaged experiments and never proposed or packaged a new one. This
 * module is the "future ticket" the CLI's doc comment already anticipated: it
 * becomes the tick's DEFAULT candidate source; `--candidates` remains as an
 * explicit override for tests and manual runs.
 *
 * Scope boundary, same discipline as candidate-packager.ts/experiment-
 * proposer.ts: this module is read-only over the #232 registry, the #216
 * quality-receipt ledger, and the durable LearningTaskContract admitted-
 * evidence row. It never mutates anything, never qualifies or floors a
 * candidate itself (that stays entirely `qualifyCandidate`'s job, invoked
 * downstream by BOTH `proposeExperimentsFromRegistry` -- floor "wrong", the
 * full outcome spectrum -- and `packageAndHandOff`/`packageExperimentCandidates`
 * -- floor "pass" -- exactly the deliberate floor difference #269 documents),
 * and never fabricates configuration bytes it cannot honestly attribute.
 *
 * Discovery mechanism: the registry has no "list every task" primitive, only
 * `listTerminalOutcomesForPeriod(occurrencePeriodUtc)` -- a cross-task scan of
 * one UTC calendar month. This module scans a configurable trailing window of
 * months (default: the current month plus the previous one, to cover
 * month-boundary stragglers) and resolves each completed terminal outcome
 * into a candidate, or records why it could not.
 *
 * Per-(taskId, attemptId) resolution -- every step below fails closed by
 * EXCLUDING the candidate, never by defaulting or guessing a value:
 *
 *   1. `payload.outcome !== "completed"` -> excluded ("outcome-not-completed").
 *   2. `payload.delegation?.modelId` absent -> excluded
 *      ("missing-model-identity"). Hugin's native registry producers durably
 *      record real model identity in the shared `delegation` field. The
 *      admitted direct-homeserver bridge (#284) additionally requires its M5
 *      ledger join before it writes that field.
 *   3. `payload.delegation?.taskType` absent or not a valid Broker task type
 *      -> excluded ("missing-or-invalid-task-type").
 *   4. `payload.attemptOutcomeRef` absent, or it does not resolve to an
 *      `m5-admitted`+`evidenceAccepted` `LearningTaskExecutionEvidence` row
 *      (`admitted-attempt-evidence.ts`) -> excluded
 *      ("missing-attempt-outcome-ref" / "attempt-outcome-not-admitted"). This
 *      durable row is the proof that a real, gateway-admitted
 *      LearningTaskContract handshake produced this attempt's prompt/harness
 *      identity (`requestStamp.origin_config`).
 *   5. No effective, binding-matched quality receipt resolves for this
 *      (taskId, attemptId) (`quality-receipt-resolution.ts`) -> excluded
 *      ("missing-quality-receipt").
 *   6. Otherwise, a `PackagerCandidateInput` is built:
 *        - `prompt`/`harness` from `requestStamp.origin_config.prompt`/
 *          `.harness` (id/version + the config document's own sha256 digest;
 *          `harness.toolPolicyVersion` from `origin_config.tool_policy.version`).
 *        - `model` from `delegation.modelId`, with `provider`/`runtime`
 *          naming the dispatch surface the admitted attempt proves (the M5
 *          gateway's `/delegate` lane); `config: {}`
 *          because Hugin does not durably record per-task model-config detail
 *          (quantization/temperature/etc) -- left empty rather than guessed.
 *        - `logging`/`testHarness`/`routing`: Hugin does not yet durably
 *          track per-task variation on these three axes. Each is a FIXED,
 *          versioned, digested sentinel identical for every real candidate
 *          today -- the exact "digest a real, if trivial, constant document"
 *          pattern `learning-task-handshake.ts`'s own `originConfig()` already
 *          uses for prompt/harness/tool-policy identity. This is a documented
 *          simplification, not a fabrication: these axes never register as
 *          "the changed axis" and never masquerade as differentiated
 *          evidence. Today's only real per-candidate axis Hugin's own
 *          registry can observe is `model` (the M5 gateway is free to route a
 *          nominal request to different underlying models -- exactly what the
 *          harness-lane sampler's comparison exists to surface).
 *
 * Dedup: natural key `${taskId}/${attemptId}`. The registry's own natural-key
 * write-time dedup already prevents a duplicate event within one scanned
 * month; this module additionally dedupes across scanned months (in case of
 * an overlapping window) so the returned pool never contains the same
 * candidate twice.
 *
 * Determinism / idempotency: the returned pool is sorted by
 * `${taskId}/${attemptId}` and depends only on durable state (registry,
 * quality-receipt ledger, admitted-evidence rows) -- re-running against
 * unchanged state yields a byte-identical pool.
 *
 * Fail-closed on truncation: if `listTerminalOutcomesForPeriod` reports
 * `truncated: true` for ANY scanned period, this module THROWS rather than
 * silently returning a partial pool as if it were complete. The cadence
 * tick's existing `loadCandidates` error handling
 * (`experiment-cadence.ts`'s `"load-candidates"` stage) already records this
 * as a durable, discoverable failure and continues the tick with zero
 * candidates for that run -- no new error path is needed.
 */

import type { MuninClient } from "../munin-client.js";
import type { LearningRegistryStore } from "../learning-registry-store.js";
import {
  jcsDigestHex,
  occurrencePeriodUtcFromInstant,
  type TerminalOutcomeEvent,
} from "../learning-registry-schema.js";
import { taskTypeSchema } from "../broker/task-type-metadata.js";
import {
  computeConfigurationFingerprint,
  learningConfigurationSchema,
  type LearningConfiguration,
} from "./experiment-schema.js";
import {
  packagerCandidateInputSchema,
  type PackagerCandidateInput,
} from "./candidate-packager-schema.js";
import { resolveAdmittedAttemptOutcomeEvidence } from "./admitted-attempt-evidence.js";
import { resolveEffectiveQualityReceipt } from "./quality-receipt-resolution.js";
import type { LearningTaskExecutionEvidence } from "../learning-task-handshake.js";

const DEFAULT_LOOKBACK_MONTHS = 2;

/** The dispatch surface an admitted candidate can honestly attribute today --
 * the M5 gateway's `/delegate` endpoint (see
 * `m5-provenance.ts` and `learning-task-handshake.ts`'s
 * `HARNESS_CONFIG_DOCUMENT.settings.adapter`). Never a guess at the
 * underlying model's own real provider/runtime, which Hugin does not own
 * (AGENTS.md: "the M5 gateway owns model selection ... Hugin ... must not
 * build a competing capability truth"). */
const HUGIN_MODEL_PROVIDER = "m5-gateway";
const HUGIN_MODEL_RUNTIME = "m5-gateway-delegate";

/**
 * Fixed, versioned, digested sentinel documents for the three axes Hugin
 * does not yet durably differentiate per candidate -- mirroring
 * `learning-task-handshake.ts`'s own `originConfig()` pattern (digest a real,
 * declared constant document, never a fabricated per-task value).
 */
const HUGIN_CANDIDATE_LOGGING_DOCUMENT = {
  schema_version: "hugin-candidate-pool-sentinel/v1",
  axis: "logging",
  note: "Hugin does not yet durably record per-task logging-schema variation; every assembled candidate shares this fixed identity.",
};
const HUGIN_CANDIDATE_TEST_HARNESS_DOCUMENT = {
  schema_version: "hugin-candidate-pool-sentinel/v1",
  axis: "test-harness",
  note: "Hugin does not yet durably record a per-task test-harness/corpus identity for ad-hoc coding tasks; every assembled candidate shares this fixed identity.",
};
const HUGIN_CANDIDATE_ROUTING_DOCUMENT = {
  schema_version: "hugin-candidate-pool-sentinel/v1",
  axis: "routing",
  note: "Hugin does not yet durably record a per-task routing-policy identity distinct from the M5 gateway's own delegate lane; every assembled candidate shares this fixed identity.",
};

const HUGIN_CANDIDATE_LOGGING_REF = {
  schemaVersion: "hugin-candidate-pool-sentinel-v1",
  requiredFieldsSha256: jcsDigestHex(HUGIN_CANDIDATE_LOGGING_DOCUMENT),
};
const HUGIN_CANDIDATE_TEST_HARNESS_REF = {
  id: "hugin-candidate-pool-sentinel",
  version: "v1",
  corpusSha256: jcsDigestHex(HUGIN_CANDIDATE_TEST_HARNESS_DOCUMENT),
  oracleVersion: "hugin-candidate-pool-sentinel-v1",
  holdoutRevision: "hugin-candidate-pool-sentinel-v1",
};
const HUGIN_CANDIDATE_ROUTING_REF = {
  policyId: "hugin-candidate-pool-sentinel",
  version: "v1",
  configSha256: jcsDigestHex(HUGIN_CANDIDATE_ROUTING_DOCUMENT),
};

export interface CandidatePoolAssemblerDeps {
  registry: Pick<LearningRegistryStore, "listTerminalOutcomesForPeriod">;
  munin: Pick<MuninClient, "read">;
  now?: () => string;
}

export interface AssembleCandidatePoolOptions {
  /** Trailing UTC calendar months to scan, most-recent first. Default 2 (current + previous). */
  lookbackMonths?: number;
  /** Explicit period override for tests/manual runs (bypasses `lookbackMonths`/`now`). */
  periods?: string[];
}

export type SkippedCandidateReason =
  | "outcome-not-completed"
  | "missing-model-identity"
  | "missing-evidence-identity"
  | "missing-or-invalid-task-type"
  | "missing-attempt-outcome-ref"
  | "attempt-outcome-not-admitted"
  | "missing-quality-receipt"
  | "candidate-schema-invalid";

export interface SkippedCandidate {
  taskId: string;
  attemptId: string;
  reason: SkippedCandidateReason;
}

export interface CandidatePoolAssemblyResult {
  candidates: PackagerCandidateInput[];
  scannedPeriods: string[];
  scannedTerminalOutcomes: number;
  skipped: SkippedCandidate[];
}

/** Trailing `count` UTC calendar months ending at (and including) `period`, most-recent first. */
function monthsBack(period: string, count: number): string[] {
  const [yearStr, monthStr] = period.split("-");
  let year = Number(yearStr);
  let month = Number(monthStr);
  const periods: string[] = [];
  for (let i = 0; i < Math.max(count, 1); i += 1) {
    periods.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return periods;
}

function buildConfiguration(
  evidence: LearningTaskExecutionEvidence,
  modelId: string,
): LearningConfiguration {
  const stamp = evidence.requestStamp;
  if (!stamp) {
    throw new Error("m5-admitted evidence is missing its request stamp");
  }
  const payload = {
    prompt: {
      id: stamp.origin_config.prompt.id,
      version: stamp.origin_config.prompt.version,
      sha256: stamp.origin_config.prompt.config_digest.digest,
    },
    harness: {
      id: stamp.origin_config.harness.id,
      version: stamp.origin_config.harness.version,
      configSha256: stamp.origin_config.harness.config_digest.digest,
      toolPolicyVersion: stamp.origin_config.tool_policy.version,
    },
    model: {
      id: modelId,
      provider: HUGIN_MODEL_PROVIDER,
      runtime: HUGIN_MODEL_RUNTIME,
      config: {},
    },
    logging: HUGIN_CANDIDATE_LOGGING_REF,
    testHarness: HUGIN_CANDIDATE_TEST_HARNESS_REF,
    routing: HUGIN_CANDIDATE_ROUTING_REF,
  };
  const fingerprint = computeConfigurationFingerprint(payload);
  return learningConfigurationSchema.parse({ ...payload, fingerprint });
}

async function resolveCandidate(
  munin: Pick<MuninClient, "read">,
  event: TerminalOutcomeEvent,
): Promise<{ candidate: PackagerCandidateInput } | { skip: SkippedCandidate }> {
  const taskId = event.taskId;
  const attemptId = event.attemptId;

  if (event.payload.outcome !== "completed") {
    return { skip: { taskId, attemptId, reason: "outcome-not-completed" } };
  }

  const modelId = event.payload.delegation?.modelId;
  if (!modelId) {
    return { skip: { taskId, attemptId, reason: "missing-model-identity" } };
  }
  const evidenceIdentityHash = event.payload.delegation?.evidenceIdentityHash;
  if (!evidenceIdentityHash) {
    return { skip: { taskId, attemptId, reason: "missing-evidence-identity" } };
  }
  // Presence proves the registry writer completed the authoritative Gille
  // ledger join. Do not use the full hash as a configuration axis: Gille's
  // evidence identity intentionally includes logical-task/prompt identity, so
  // it differs across matched samples even when their configuration is equal.

  const rawTaskType = event.payload.delegation?.taskType;
  const taskTypeParsed = rawTaskType ? taskTypeSchema.safeParse(rawTaskType) : undefined;
  if (!taskTypeParsed || !taskTypeParsed.success) {
    return { skip: { taskId, attemptId, reason: "missing-or-invalid-task-type" } };
  }

  const attemptOutcomeRef = event.payload.attemptOutcomeRef;
  if (!attemptOutcomeRef) {
    return { skip: { taskId, attemptId, reason: "missing-attempt-outcome-ref" } };
  }

  const evidence = await resolveAdmittedAttemptOutcomeEvidence(munin, attemptOutcomeRef, { taskId, attemptId });
  if (!evidence) {
    return { skip: { taskId, attemptId, reason: "attempt-outcome-not-admitted" } };
  }

  const qualityReceipt = await resolveEffectiveQualityReceipt(munin, taskId, attemptId);
  if (!qualityReceipt) {
    return { skip: { taskId, attemptId, reason: "missing-quality-receipt" } };
  }

  try {
    const configuration = buildConfiguration(evidence, modelId);
    const candidate = packagerCandidateInputSchema.parse({
      taskId,
      attemptId,
      taskType: taskTypeParsed.data,
      configuration,
      qualityReceipt,
    });
    return { candidate };
  } catch {
    return { skip: { taskId, attemptId, reason: "candidate-schema-invalid" } };
  }
}

/**
 * Scan the trailing window of UTC months and resolve every honestly
 * resolvable `PackagerCandidateInput`. Never throws for an individual
 * unresolvable candidate (recorded in `skipped` instead); throws only when a
 * scanned period's registry query cannot prove completeness (see the module
 * doc comment's fail-closed-on-truncation note).
 */
export async function assembleCandidatePool(
  deps: CandidatePoolAssemblerDeps,
  options: AssembleCandidatePoolOptions = {},
): Promise<CandidatePoolAssemblyResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const periods = options.periods
    ?? monthsBack(occurrencePeriodUtcFromInstant(now()), options.lookbackMonths ?? DEFAULT_LOOKBACK_MONTHS);

  const byKey = new Map<string, PackagerCandidateInput>();
  const skipped: SkippedCandidate[] = [];
  let scannedTerminalOutcomes = 0;

  for (const period of periods) {
    const { events, truncated } = await deps.registry.listTerminalOutcomesForPeriod(period);
    if (truncated) {
      throw new Error(
        `candidate-pool assembler: terminal-outcome scan for ${period} was truncated; refusing a partial pool`,
      );
    }
    scannedTerminalOutcomes += events.length;
    for (const event of events) {
      const key = `${event.taskId}/${event.attemptId}`;
      if (byKey.has(key)) continue; // already resolved from an earlier-scanned, overlapping period
      const resolved = await resolveCandidate(deps.munin, event);
      if ("candidate" in resolved) {
        byKey.set(key, resolved.candidate);
      } else {
        skipped.push(resolved.skip);
      }
    }
  }

  const candidates = [...byKey.values()].sort((a, b) =>
    `${a.taskId}/${a.attemptId}`.localeCompare(`${b.taskId}/${b.attemptId}`));

  return { candidates, scannedPeriods: periods, scannedTerminalOutcomes, skipped };
}

/**
 * Thin adapter matching `ExperimentCadenceDeps["loadCandidates"]`'s exact
 * shape, for direct injection as the cadence tick's DEFAULT candidate source.
 */
export function createCandidatePoolAssembler(
  deps: CandidatePoolAssemblerDeps,
  options: AssembleCandidatePoolOptions = {},
): () => Promise<PackagerCandidateInput[]> {
  return async () => (await assembleCandidatePool(deps, options)).candidates;
}
