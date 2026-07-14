import { createHash } from "node:crypto";
import { z } from "zod";
import type { MuninEntry } from "../munin-client.js";
import {
  structuredTaskResultSchema,
  type StructuredTaskResult,
} from "../task-result-schema.js";
import {
  REQUIRED_TASK_EXPOSURE_LANES,
  TASK_EXPOSURE_FINGERPRINT_VERSION,
  taskTextFingerprint,
  type TaskExposureCoverage,
  type TaskExposureLookupResult,
  type TaskExposureSnapshot,
} from "./m5-task-exposure.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });

export const dailyExamCandidateSchema = z.object({
  schemaVersion: z.literal(2),
  candidateId: z.string().regex(/^daily-[0-9a-f]{24}$/),
  source: z.object({
    taskNamespace: z.string().startsWith("tasks/"),
    taskId: z.string().min(1),
    taskCreatedAt: z.string(),
    statusUpdatedAt: z.string().min(1),
    taskDocumentSha256: sha256Schema,
    promptSha256: sha256Schema.optional(),
    structuredResultSha256: sha256Schema.optional(),
    runtime: z.string().min(1).optional(),
    taskType: z.string().min(1).optional(),
    sensitivity: z.enum(["public", "internal", "private"]).optional(),
  }).strict(),
  repository: z.object({
    githubRepository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    contextAlias: z.string().regex(/^repo:[A-Za-z0-9._-]+$/).optional(),
    pullRequestUrl: z.string().url(),
    baseCommit: gitCommitSchema,
    headCommit: gitCommitSchema,
    changedFiles: z.array(z.string().min(1)).min(1).max(10_000),
    diffSha256: sha256Schema,
  }).strict().optional(),
  exposure: z.object({
    state: z.enum(["no-m5-evidence", "m5-exposed", "unknown"]),
    models: z.array(z.string().min(1)),
    evidence: z.array(z.string().min(1)),
  }).strict(),
  crossClientExposure: z.object({
    fingerprintVersion: z.literal(TASK_EXPOSURE_FINGERPRINT_VERSION),
    fingerprintSha256: sha256Schema.optional(),
    state: z.enum(["not-checked", "seen", "unseen-covered", "incomplete", "error"]),
    checkedAt: z.string().datetime({ offset: true }).optional(),
    lookupSchemaVersion: z.literal(1).optional(),
    coverage: z.object({
      coverageComplete: z.boolean(),
      from: z.string().datetime({ offset: true }),
      through: z.string().datetime({ offset: true }),
      lanes: z.array(z.string().min(1)),
      historicalBackfillComplete: z.boolean(),
      historicalBackfillFrom: z.string().datetime({ offset: true }).nullable(),
      historicalBackfillThrough: z.string().datetime({ offset: true }).nullable(),
      historicalEventsImported: z.number().int().nonnegative(),
      historicalRowsSkippedInexact: z.number().int().nonnegative(),
      incompleteBefore: z.string().datetime({ offset: true }),
      incompleteReasons: z.array(z.string().min(1)),
    }).strict().optional(),
    match: z.object({
      seen: z.boolean(),
      firstSeenAt: z.string().datetime({ offset: true }).nullable(),
      lastSeenAt: z.string().datetime({ offset: true }).nullable(),
      lanes: z.array(z.string().min(1)),
      modelIds: z.array(z.string().min(1)),
      harnessIds: z.array(z.string().min(1)),
    }).strict().optional(),
    evidence: z.array(z.string().min(1)),
  }).strict().superRefine((value, ctx) => {
    const checked = value.state === "seen" || value.state === "unseen-covered" || value.state === "incomplete";
    if (checked && (!value.checkedAt || value.lookupSchemaVersion !== 1 || !value.coverage || !value.match)) {
      ctx.addIssue({ code: "custom", message: `${value.state} requires a complete lookup snapshot` });
      return;
    }
    if (value.state === "seen" && value.match?.seen !== true) {
      ctx.addIssue({ code: "custom", message: "seen requires a positive match" });
    }
    if ((value.state === "unseen-covered" || value.state === "incomplete") && value.match?.seen !== false) {
      ctx.addIssue({ code: "custom", message: `${value.state} requires a negative match` });
    }
    if (value.state === "unseen-covered") {
      if (value.coverage?.coverageComplete !== true) {
        ctx.addIssue({ code: "custom", message: "unseen-covered requires complete coverage" });
      }
      for (const lane of REQUIRED_TASK_EXPOSURE_LANES) {
        if (!value.coverage?.lanes.includes(lane)) {
          ctx.addIssue({ code: "custom", message: `unseen-covered is missing lane ${lane}` });
        }
      }
    }
    if (value.state === "error" && !value.checkedAt) {
      ctx.addIssue({ code: "custom", message: "error requires an attempted-at timestamp" });
    }
  }),
  lane: z.enum(["provisional-holdout", "regression", "quarantine"]),
  readiness: z.enum(["needs-independent-verifier", "quarantined"]),
  reasons: z.array(z.string().min(1)),
  contentPolicy: z.literal("content-blind-references-only"),
}).strict();
export type DailyExamCandidate = z.infer<typeof dailyExamCandidateSchema>;

export const dailyExamManifestSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: isoTimestampSchema,
  source: z.literal("hugin-munin-daily-tasks"),
  contentPolicy: z.literal("content-blind-references-only"),
  historyComplete: z.boolean(),
  inspectedTasks: z.number().int().nonnegative(),
  counts: z.object({
    provisionalHoldout: z.number().int().nonnegative(),
    regression: z.number().int().nonnegative(),
    quarantine: z.number().int().nonnegative(),
  }).strict(),
  candidates: z.array(dailyExamCandidateSchema),
}).strict();
export type DailyExamManifest = z.infer<typeof dailyExamManifestSchema>;

export interface DailyTaskHarvestSource {
  status: MuninEntry;
  resultStructured?: MuninEntry | null;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function field(content: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)`, "i"))?.[1]?.trim();
}

function promptFromTask(content: string): string | undefined {
  const prompt = content.match(/###\s*Prompt\s*\n([\s\S]+)$/i)?.[1]?.trim();
  return prompt || undefined;
}

function contextAliasFromTask(content: string): string | undefined {
  const context = field(content, "Context");
  return context && /^repo:[A-Za-z0-9._-]+$/.test(context) ? context : undefined;
}

function githubRepositoryFromPr(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/);
    return match ? `${match[1]}/${match[2]}` : undefined;
  } catch {
    return undefined;
  }
}

function parseStructuredResult(content: string | undefined): StructuredTaskResult | undefined {
  if (!content) return undefined;
  try {
    const parsed = structuredTaskResultSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function exposureFor(result: StructuredTaskResult | undefined): DailyExamCandidate["exposure"] {
  if (!result) return { state: "unknown", models: [], evidence: ["structured-result-unavailable"] };
  const models = new Set<string>();
  const evidence = new Set<string>();
  const delegation = result.runtimeMetadata?.delegation;
  if (result.runtimeMetadata?.effectiveModel) models.add(result.runtimeMetadata.effectiveModel);
  if (delegation?.modelId) models.add(delegation.modelId);
  if (delegation) evidence.add("runtime-m5-delegation-provenance");
  if (result.runtimeMetadata?.effectiveHost?.toLowerCase() === "m5") {
    evidence.add("runtime-effective-host-m5");
  }
  if (result.runtime === "homeserver") evidence.add("runtime-homeserver");
  if (result.runtime === "opencode") evidence.add("runtime-opencode-m5");

  for (const outcome of result.orchestratorOutcomes ?? []) {
    if (outcome.delegation?.modelId) models.add(outcome.delegation.modelId);
    if (outcome.delegation || outcome.provider.toLowerCase() === "homeserver") {
      evidence.add(`orchestrator-m5-leaf:${outcome.subtaskId}`);
    }
  }

  if (evidence.size > 0) {
    return { state: "m5-exposed", models: [...models].sort(), evidence: [...evidence].sort() };
  }
  if (["claude", "codex", "ollama"].includes(result.runtime)) {
    return {
      state: "no-m5-evidence",
      models: [...models].sort(),
      evidence: [`completed-via-${result.runtime}`],
    };
  }
  if (result.runtime === "orchestrator" && (result.orchestratorOutcomes?.length ?? 0) > 0) {
    return {
      state: "no-m5-evidence",
      models: [...models].sort(),
      evidence: ["orchestrator-outcomes-have-no-m5-leaf"],
    };
  }
  return { state: "unknown", models: [...models].sort(), evidence: ["runtime-exposure-ambiguous"] };
}

function taskTypeFromTags(tags: readonly string[]): string | undefined {
  return tags
    .find((tag) => tag.startsWith("type:") && !tag.startsWith("type:task-result"))
    ?.slice("type:".length);
}

/**
 * Convert one completed daily task into content-blind exam-candidate metadata.
 * "No M5 evidence" is intentionally only provisional: Hugin cannot prove the
 * same prompt was not shown through another client, so a later exposure-ledger
 * check remains mandatory before a candidate is sealed as a holdout.
 */
export function buildDailyExamCandidate(source: DailyTaskHarvestSource): DailyExamCandidate {
  const taskDocument = source.status.content;
  const prompt = promptFromTask(taskDocument);
  const promptFingerprint = prompt ? taskTextFingerprint(prompt) : undefined;
  const resultContent = source.resultStructured?.content;
  const result = parseStructuredResult(resultContent);
  const exposure = exposureFor(result);
  const contextAlias = contextAliasFromTask(taskDocument);
  const githubRepository = githubRepositoryFromPr(result?.prUrl);
  const change = result?.repositoryChange;
  const sensitivity = result?.sensitivity?.effective;
  const sourceClassification = source.status.classification?.trim().toLowerCase();
  const sourceClassificationIsPrivate = Boolean(
    sourceClassification && !["public", "internal"].includes(sourceClassification),
  );
  const reasons: string[] = [];

  if (!source.status.tags.includes("completed")) reasons.push("source-task-not-completed");
  if (!prompt) reasons.push("task-prompt-missing");
  if (!result) reasons.push("valid-result-structured-missing");
  if (result && (result.lifecycle !== "completed" || result.outcome !== "completed")) {
    reasons.push("structured-result-not-completed");
  }
  if (!change) reasons.push("repository-change-evidence-missing");
  if (!result?.prUrl || !githubRepository) reasons.push("github-pull-request-binding-missing");
  if (!contextAlias) reasons.push("portable-repo-context-missing");
  if (!sensitivity) reasons.push("task-sensitivity-evidence-missing");
  if (sensitivity === "private") reasons.push("private-task-not-eligible-for-automatic-packaging");
  if (sourceClassificationIsPrivate) reasons.push("source-classification-not-eligible-for-automatic-packaging");
  if (exposure.state === "unknown") reasons.push("m5-exposure-unknown");

  const repository = sensitivity !== "private" && !sourceClassificationIsPrivate && change && result?.prUrl && githubRepository
    ? {
        githubRepository,
        ...(contextAlias ? { contextAlias } : {}),
        pullRequestUrl: result.prUrl,
        ...change,
      }
    : undefined;

  const quarantine = reasons.length > 0;
  const lane: DailyExamCandidate["lane"] = quarantine
    ? "quarantine"
    : exposure.state === "m5-exposed"
      ? "regression"
      : "provisional-holdout";
  if (!quarantine) reasons.push(
    lane === "regression"
      ? "already-exposed-to-m5-use-only-as-regression"
      : "requires-cross-client-exposure-check-before-holdout-seal",
    "independent-verifier-required",
  );

  const identity = JSON.stringify({
    taskNamespace: source.status.namespace,
    taskDocumentSha256: sha256(taskDocument),
    promptSha256: promptFingerprint ?? null,
    baseCommit: change?.baseCommit ?? null,
    headCommit: change?.headCommit ?? null,
    diffSha256: change?.diffSha256 ?? null,
  });
  const candidate: DailyExamCandidate = {
    schemaVersion: 2,
    candidateId: `daily-${sha256(identity).slice(0, 24)}`,
    source: {
      taskNamespace: source.status.namespace,
      taskId: result?.taskId ?? source.status.namespace.replace(/^tasks\//, ""),
      taskCreatedAt: typeof source.status.created_at === "string"
        ? source.status.created_at
        : "",
      statusUpdatedAt: source.status.updated_at,
      taskDocumentSha256: sha256(taskDocument),
      ...(promptFingerprint ? { promptSha256: promptFingerprint } : {}),
      ...(resultContent ? { structuredResultSha256: sha256(resultContent) } : {}),
      ...(result?.runtime ? { runtime: result.runtime } : {}),
      ...(taskTypeFromTags(source.status.tags)
        ? { taskType: taskTypeFromTags(source.status.tags) }
        : {}),
      ...(sensitivity ? { sensitivity } : {}),
    },
    repository,
    exposure,
    crossClientExposure: {
      fingerprintVersion: TASK_EXPOSURE_FINGERPRINT_VERSION,
      ...(promptFingerprint ? { fingerprintSha256: promptFingerprint } : {}),
      state: "not-checked",
      evidence: [
        lane === "provisional-holdout"
          ? "cross-client-exposure-lookup-pending"
          : lane === "regression"
            ? "lookup-not-required-local-m5-exposure"
            : "lookup-not-required-ineligible",
      ],
    },
    lane,
    readiness: quarantine ? "quarantined" : "needs-independent-verifier",
    reasons,
    contentPolicy: "content-blind-references-only",
  };
  return dailyExamCandidateSchema.parse(candidate);
}

export function buildDailyExamManifest(input: {
  generatedAt: string;
  historyComplete: boolean;
  sources: DailyTaskHarvestSource[];
}): DailyExamManifest {
  const candidates = input.sources
    .map(buildDailyExamCandidate)
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  return dailyExamManifestSchema.parse({
    schemaVersion: 2,
    generatedAt: input.generatedAt,
    source: "hugin-munin-daily-tasks",
    contentPolicy: "content-blind-references-only",
    historyComplete: input.historyComplete,
    inspectedTasks: input.sources.length,
    counts: {
      provisionalHoldout: candidates.filter((candidate) => candidate.lane === "provisional-holdout").length,
      regression: candidates.filter((candidate) => candidate.lane === "regression").length,
      quarantine: candidates.filter((candidate) => candidate.lane === "quarantine").length,
    },
    candidates,
  });
}

function manifestCoverage(coverage: TaskExposureCoverage): NonNullable<DailyExamCandidate["crossClientExposure"]["coverage"]> {
  return {
    coverageComplete: coverage.coverage_complete,
    from: coverage.from,
    through: coverage.through,
    lanes: coverage.lanes,
    historicalBackfillComplete: coverage.historical_backfill_complete,
    historicalBackfillFrom: coverage.historical_backfill_from,
    historicalBackfillThrough: coverage.historical_backfill_through,
    historicalEventsImported: coverage.historical_events_imported,
    historicalRowsSkippedInexact: coverage.historical_rows_skipped_inexact,
    incompleteBefore: coverage.incomplete_before,
    incompleteReasons: coverage.incomplete_reasons,
  };
}

function manifestMatch(result: TaskExposureLookupResult): NonNullable<DailyExamCandidate["crossClientExposure"]["match"]> {
  return {
    seen: result.seen,
    firstSeenAt: result.first_seen_at,
    lastSeenAt: result.last_seen_at,
    lanes: result.lanes,
    modelIds: result.model_ids,
    harnessIds: result.harness_ids,
  };
}

function removeReasons(candidate: DailyExamCandidate, ...reasons: string[]): void {
  const remove = new Set(reasons);
  candidate.reasons = candidate.reasons.filter((reason) => !remove.has(reason));
}

function addReason(candidate: DailyExamCandidate, reason: string): void {
  if (!candidate.reasons.includes(reason)) candidate.reasons.push(reason);
}

function quarantine(candidate: DailyExamCandidate, reason: string): void {
  if (candidate.lane === "provisional-holdout") {
    candidate.lane = "quarantine";
    candidate.readiness = "quarantined";
    removeReasons(candidate, "independent-verifier-required");
  }
  addReason(candidate, reason);
}

function applySnapshot(candidate: DailyExamCandidate, snapshot: TaskExposureSnapshot): void {
  const fingerprintSha256 = candidate.crossClientExposure.fingerprintSha256;
  candidate.crossClientExposure = {
    fingerprintVersion: TASK_EXPOSURE_FINGERPRINT_VERSION,
    ...(fingerprintSha256 ? { fingerprintSha256 } : {}),
    checkedAt: snapshot.checkedAt,
    lookupSchemaVersion: 1,
    coverage: manifestCoverage(snapshot.coverage),
    match: manifestMatch(snapshot.result),
    state: snapshot.result.seen ? "seen" : "incomplete",
    evidence: [],
  };
  removeReasons(candidate, "requires-cross-client-exposure-check-before-holdout-seal");

  // Positive evidence is useful regardless of negative-coverage completeness.
  if (snapshot.result.seen) {
    candidate.crossClientExposure.evidence = ["m5-lookup-seen"];
    if (candidate.lane === "provisional-holdout") {
      candidate.lane = "regression";
      addReason(candidate, "cross-client-exposure-seen-use-only-as-regression");
    }
    return;
  }

  const createdAtIsIso = isoTimestampSchema.safeParse(candidate.source.taskCreatedAt).success;
  const createdMs = Date.parse(candidate.source.taskCreatedAt);
  const fromMs = Date.parse(snapshot.coverage.from);
  const throughMs = Date.parse(snapshot.coverage.through);
  const missingLanes = REQUIRED_TASK_EXPOSURE_LANES.filter(
    (lane) => !snapshot.coverage.lanes.includes(lane),
  );
  if (!createdAtIsIso || !Number.isFinite(createdMs)) {
    candidate.crossClientExposure.evidence = ["task-created-at-invalid"];
    quarantine(candidate, "task-created-at-invalid");
  } else if (!Number.isFinite(fromMs) || !Number.isFinite(throughMs) || fromMs > throughMs) {
    candidate.crossClientExposure.evidence = ["cross-client-coverage-invalid"];
    quarantine(candidate, "cross-client-coverage-invalid");
  } else if (!snapshot.coverage.coverage_complete) {
    candidate.crossClientExposure.evidence = ["cross-client-coverage-incomplete"];
    quarantine(candidate, "cross-client-coverage-incomplete");
  } else if (createdMs < fromMs) {
    candidate.crossClientExposure.evidence = ["task-created-before-cross-client-coverage"];
    quarantine(candidate, "task-created-before-cross-client-coverage");
  } else if (createdMs > throughMs) {
    candidate.crossClientExposure.evidence = ["task-created-after-cross-client-coverage"];
    quarantine(candidate, "task-created-after-cross-client-coverage");
  } else if (missingLanes.length > 0) {
    candidate.crossClientExposure.evidence = [
      "cross-client-coverage-lanes-missing",
      ...missingLanes.map((lane) => `missing-lane:${lane}`),
    ];
    quarantine(candidate, "cross-client-coverage-lanes-missing");
  } else {
    candidate.crossClientExposure.state = "unseen-covered";
    candidate.crossClientExposure.evidence = [
      "m5-lookup-unseen",
      "coverage-complete",
      "task-created-within-coverage-window",
      "required-lanes-covered",
      "snapshot-requires-recheck-before-harbor",
    ];
  }
}

function recalculateCounts(manifest: DailyExamManifest): void {
  manifest.counts = {
    provisionalHoldout: manifest.candidates.filter((candidate) => candidate.lane === "provisional-holdout").length,
    regression: manifest.candidates.filter((candidate) => candidate.lane === "regression").length,
    quarantine: manifest.candidates.filter((candidate) => candidate.lane === "quarantine").length,
  };
}

/**
 * Join the owner-only M5 lookup into the content-blind manifest. This only
 * clears cross-client freshness at one point in time; it never seals or runs a
 * holdout. A future packager must repeat the lookup immediately before use.
 */
export function applyCrossClientExposure(
  sourceManifest: DailyExamManifest,
  lookup: {
    snapshots?: ReadonlyMap<string, TaskExposureSnapshot>;
    error?: { code: string; checkedAt: string };
  },
): DailyExamManifest {
  const manifest = dailyExamManifestSchema.parse(structuredClone(sourceManifest));
  for (const candidate of manifest.candidates) {
    if (candidate.lane !== "provisional-holdout") continue;
    const fingerprint = candidate.crossClientExposure.fingerprintSha256;
    if (!fingerprint) continue;
    if (lookup.error) {
      candidate.crossClientExposure = {
        fingerprintVersion: TASK_EXPOSURE_FINGERPRINT_VERSION,
        fingerprintSha256: fingerprint,
        state: "error",
        checkedAt: lookup.error.checkedAt,
        evidence: [`lookup-error:${lookup.error.code}`],
      };
      quarantine(candidate, "cross-client-exposure-lookup-error");
      continue;
    }
    const snapshot = lookup.snapshots?.get(fingerprint);
    if (!snapshot || snapshot.result.fingerprint_sha256 !== fingerprint) {
      candidate.crossClientExposure = {
        fingerprintVersion: TASK_EXPOSURE_FINGERPRINT_VERSION,
        fingerprintSha256: fingerprint,
        state: "error",
        checkedAt: manifest.generatedAt,
        evidence: [snapshot ? "lookup-result-fingerprint-mismatch" : "lookup-result-missing"],
      };
      quarantine(candidate, "cross-client-exposure-lookup-error");
      continue;
    }
    applySnapshot(candidate, snapshot);
  }

  const candidatesByFingerprint = new Map<string, DailyExamCandidate[]>();
  for (const candidate of manifest.candidates) {
    const fingerprint = candidate.crossClientExposure.fingerprintSha256;
    if (fingerprint) {
      const group = candidatesByFingerprint.get(fingerprint) ?? [];
      group.push(candidate);
      candidatesByFingerprint.set(fingerprint, group);
    }
  }
  for (const group of candidatesByFingerprint.values()) {
    if (group.length < 2) continue;
    for (const duplicate of group) {
      quarantine(duplicate, "duplicate-prompt-in-daily-manifest");
      if (!duplicate.crossClientExposure.evidence.includes("duplicate-prompt-in-daily-manifest")) {
        duplicate.crossClientExposure.evidence.push("duplicate-prompt-in-daily-manifest");
      }
    }
  }
  recalculateCounts(manifest);
  return dailyExamManifestSchema.parse(manifest);
}
