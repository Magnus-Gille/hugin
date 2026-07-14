import { createHash } from "node:crypto";
import { z } from "zod";
import type { MuninEntry } from "../munin-client.js";
import {
  structuredTaskResultSchema,
  type StructuredTaskResult,
} from "../task-result-schema.js";
import {
  TASK_EXPOSURE_FINGERPRINT_VERSION,
  TASK_EXPOSURE_REQUIRED_LANES,
  type TaskExposureLookupEvidence,
  type TaskExposureLookupFailureKind,
  type TaskExposureLookupResult,
} from "./task-exposure-client.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });

export const dailyExamCandidateSchema = z.object({
  schemaVersion: z.literal(2),
  candidateId: z.string().regex(/^daily-[0-9a-f]{24}$/),
  source: z.object({
    taskNamespace: z.string().startsWith("tasks/"),
    taskId: z.string().min(1),
    taskCreatedAt: isoTimestampSchema.optional(),
    statusUpdatedAt: isoTimestampSchema,
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
    crossClient: z.object({
      fingerprintVersion: z.literal(TASK_EXPOSURE_FINGERPRINT_VERSION),
      fingerprintSha256: sha256Schema,
      seen: z.boolean(),
      firstSeenAt: isoTimestampSchema.nullable(),
      lastSeenAt: isoTimestampSchema.nullable(),
      lanes: z.array(z.enum(TASK_EXPOSURE_REQUIRED_LANES)).max(TASK_EXPOSURE_REQUIRED_LANES.length),
      modelIds: z.array(z.string().min(1).max(160)).max(1_000),
      harnessIds: z.array(z.string().min(1).max(160)).max(1_000),
    }).strict().superRefine((crossClient, ctx) => {
      if (!crossClient.seen && (
        crossClient.firstSeenAt !== null ||
        crossClient.lastSeenAt !== null ||
        crossClient.lanes.length > 0 ||
        crossClient.modelIds.length > 0 ||
        crossClient.harnessIds.length > 0
      )) {
        ctx.addIssue({ code: "custom", path: ["seen"], message: "unseen results cannot carry exposure metadata" });
      }
      if (crossClient.seen && (
        crossClient.firstSeenAt === null ||
        crossClient.lastSeenAt === null ||
        crossClient.lanes.length === 0
      )) {
        ctx.addIssue({ code: "custom", path: ["seen"], message: "seen results require timestamps and lanes" });
      }
    }).optional(),
  }).strict(),
  lane: z.enum(["provisional-holdout", "regression", "quarantine"]),
  readiness: z.enum(["needs-independent-verifier", "quarantined"]),
  reasons: z.array(z.string().min(1)),
  contentPolicy: z.literal("content-blind-references-only"),
}).strict().superRefine((value, ctx) => {
  if (
    value.exposure.crossClient &&
    value.exposure.crossClient.fingerprintSha256 !== value.source.promptSha256
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["exposure", "crossClient", "fingerprintSha256"],
      message: "cross-client result must bind to the candidate prompt fingerprint",
    });
  }
  if (value.exposure.crossClient?.seen && value.exposure.state !== "m5-exposed") {
    ctx.addIssue({
      code: "custom",
      path: ["exposure", "state"],
      message: "a positive cross-client result must classify as M5-exposed",
    });
  }
  if (value.lane === "provisional-holdout" && (
    value.exposure.state !== "no-m5-evidence" ||
    value.exposure.crossClient?.seen !== false
  )) {
    ctx.addIssue({
      code: "custom",
      path: ["lane"],
      message: "provisional holdouts require a bound negative cross-client result",
    });
  }
  if (value.lane === "regression" && value.exposure.state !== "m5-exposed") {
    ctx.addIssue({ code: "custom", path: ["lane"], message: "regressions require M5 exposure" });
  }
  if ((value.lane === "quarantine") !== (value.readiness === "quarantined")) {
    ctx.addIssue({ code: "custom", path: ["readiness"], message: "quarantine lane/readiness must agree" });
  }
});
export type DailyExamCandidate = z.infer<typeof dailyExamCandidateSchema>;

const dailyExamExposureCoverageSchema = z.object({
  coverageComplete: z.boolean(),
  from: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  through: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  lanes: z.array(z.enum(TASK_EXPOSURE_REQUIRED_LANES)).max(TASK_EXPOSURE_REQUIRED_LANES.length),
  historicalBackfillComplete: z.literal(false),
  incompleteBefore: z.string().min(1),
  incompleteReasonCount: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.from) > Date.parse(value.through)) {
    ctx.addIssue({ code: "custom", path: ["through"], message: "coverage window is inverted" });
  }
  if (new Set(value.lanes).size !== value.lanes.length) {
    ctx.addIssue({ code: "custom", path: ["lanes"], message: "coverage lanes must be unique" });
  }
  if (Date.parse(value.incompleteBefore) !== Date.parse(value.from)) {
    ctx.addIssue({
      code: "custom",
      path: ["incompleteBefore"],
      message: "incomplete-before boundary must match live coverage start",
    });
  }
});

const dailyExamExposureLookupSchema = z.object({
  status: z.enum(["queried", "unavailable", "not-needed"]),
  fingerprintVersion: z.literal(TASK_EXPOSURE_FINGERPRINT_VERSION),
  queriedFingerprints: z.number().int().nonnegative(),
  coverage: dailyExamExposureCoverageSchema.optional(),
  failureKind: z.enum([
    "configuration",
    "authentication",
    "transport",
    "server",
    "contract",
  ]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "queried" && (!value.coverage || value.queriedFingerprints < 1)) {
    ctx.addIssue({ code: "custom", path: ["coverage"], message: "queried lookups require coverage" });
  }
  if (value.status === "unavailable" && !value.failureKind) {
    ctx.addIssue({ code: "custom", path: ["failureKind"], message: "unavailable lookups require a failure kind" });
  }
  if (value.status === "not-needed" && value.queriedFingerprints !== 0) {
    ctx.addIssue({ code: "custom", path: ["queriedFingerprints"], message: "not-needed lookups query nothing" });
  }
  if (value.status === "queried" && value.failureKind) {
    ctx.addIssue({ code: "custom", path: ["failureKind"], message: "queried lookups cannot carry a failure" });
  }
  if (value.status !== "queried" && value.coverage) {
    ctx.addIssue({ code: "custom", path: ["coverage"], message: "only queried lookups carry coverage" });
  }
});

export const dailyExamManifestSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: isoTimestampSchema,
  source: z.literal("hugin-munin-daily-tasks"),
  contentPolicy: z.literal("content-blind-references-only"),
  exposureLookup: dailyExamExposureLookupSchema,
  historyComplete: z.boolean(),
  inspectedTasks: z.number().int().nonnegative(),
  counts: z.object({
    provisionalHoldout: z.number().int().nonnegative(),
    regression: z.number().int().nonnegative(),
    quarantine: z.number().int().nonnegative(),
  }).strict(),
  candidates: z.array(dailyExamCandidateSchema),
}).strict().superRefine((value, ctx) => {
  if (value.inspectedTasks !== value.candidates.length) {
    ctx.addIssue({ code: "custom", path: ["inspectedTasks"], message: "candidate count disagrees with inspected tasks" });
  }
  const actualCounts = {
    provisionalHoldout: value.candidates.filter((candidate) => candidate.lane === "provisional-holdout").length,
    regression: value.candidates.filter((candidate) => candidate.lane === "regression").length,
    quarantine: value.candidates.filter((candidate) => candidate.lane === "quarantine").length,
  };
  for (const key of ["provisionalHoldout", "regression", "quarantine"] as const) {
    if (value.counts[key] !== actualCounts[key]) {
      ctx.addIssue({ code: "custom", path: ["counts", key], message: "manifest lane count is dishonest" });
    }
  }
  if (new Set(value.candidates.map((candidate) => candidate.candidateId)).size !== value.candidates.length) {
    ctx.addIssue({ code: "custom", path: ["candidates"], message: "candidate IDs must be unique" });
  }
  for (let index = 0; index < value.candidates.length; index += 1) {
    const candidate = value.candidates[index]!;
    if (candidate.lane !== "provisional-holdout") continue;
    const coverage = value.exposureLookup.coverage;
    const safeNegative =
      value.exposureLookup.status === "queried" &&
      coverage?.coverageComplete === true &&
      TASK_EXPOSURE_REQUIRED_LANES.every((lane) => coverage.lanes.includes(lane)) &&
      candidate.source.taskCreatedAt !== undefined &&
      candidate.source.taskCreatedAt >= coverage.from &&
      candidate.source.taskCreatedAt <= coverage.through;
    if (!safeNegative) {
      ctx.addIssue({
        code: "custom",
        path: ["candidates", index, "lane"],
        message: "provisional holdout is not bound to complete live cross-client coverage",
      });
    }
  }
});
export type DailyExamManifest = z.infer<typeof dailyExamManifestSchema>;

export interface DailyTaskHarvestSource {
  status: MuninEntry;
  resultStructured?: MuninEntry | null;
}

export type DailyExamExposureLookupInput =
  | { status: "queried"; evidence: TaskExposureLookupEvidence }
  | { status: "unavailable"; failureKind: TaskExposureLookupFailureKind }
  | { status: "not-needed" };

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

export function dailyTaskExposureFingerprint(source: DailyTaskHarvestSource): string | undefined {
  const prompt = promptFromTask(source.status.content);
  return prompt ? sha256(prompt) : undefined;
}

function normalizedIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function taskCreatedAt(source: DailyTaskHarvestSource): string | undefined {
  const candidates = [
    normalizedIso(field(source.status.content, "Submitted at")),
    normalizedIso(source.status.created_at),
  ].filter((value): value is string => value !== undefined);
  return candidates.sort()[0];
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

function crossClientRecord(result: TaskExposureLookupResult) {
  return {
    fingerprintVersion: TASK_EXPOSURE_FINGERPRINT_VERSION,
    fingerprintSha256: result.fingerprintSha256,
    seen: result.seen,
    firstSeenAt: result.firstSeenAt,
    lastSeenAt: result.lastSeenAt,
    lanes: result.lanes,
    modelIds: result.modelIds,
    harnessIds: result.harnessIds,
  };
}

function resolveExposure(input: {
  local: DailyExamCandidate["exposure"];
  fingerprint?: string;
  createdAt?: string;
  lookup: DailyExamExposureLookupInput;
  results: Map<string, TaskExposureLookupResult>;
}): { exposure: DailyExamCandidate["exposure"]; reason?: string } {
  const { local, fingerprint, createdAt, lookup, results } = input;
  if (local.state === "m5-exposed") {
    const result = fingerprint ? results.get(fingerprint) : undefined;
    return {
      exposure: result ? { ...local, crossClient: crossClientRecord(result) } : local,
    };
  }
  if (local.state === "unknown") {
    const result = fingerprint ? results.get(fingerprint) : undefined;
    if (result?.seen) {
      return {
        exposure: {
          state: "m5-exposed",
          models: [...new Set([...local.models, ...result.modelIds])].sort(),
          evidence: [...new Set([...local.evidence, "cross-client-registry-seen"])].sort(),
          crossClient: crossClientRecord(result),
        },
      };
    }
    return {
      exposure: result ? { ...local, crossClient: crossClientRecord(result) } : local,
    };
  }
  if (!fingerprint) {
    return {
      exposure: { ...local, state: "unknown", evidence: [...local.evidence, "cross-client-fingerprint-unavailable"] },
      reason: "cross-client-fingerprint-unavailable",
    };
  }
  if (lookup.status !== "queried") {
    return {
      exposure: { ...local, state: "unknown", evidence: [...local.evidence, "cross-client-lookup-unavailable"] },
      reason: "cross-client-exposure-lookup-unavailable",
    };
  }
  const result = results.get(fingerprint);
  if (!result) {
    return {
      exposure: { ...local, state: "unknown", evidence: [...local.evidence, "cross-client-result-missing"] },
      reason: "cross-client-exposure-result-missing",
    };
  }
  const crossClient = crossClientRecord(result);
  if (result.seen) {
    return {
      exposure: {
        state: "m5-exposed",
        models: [...new Set([...local.models, ...result.modelIds])].sort(),
        evidence: [...new Set([...local.evidence, "cross-client-registry-seen"])].sort(),
        crossClient,
      },
    };
  }
  const coverage = lookup.evidence.coverage;
  if (!coverage.coverageComplete) {
    return {
      exposure: { ...local, state: "unknown", evidence: [...local.evidence, "cross-client-coverage-incomplete"], crossClient },
      reason: "cross-client-coverage-incomplete",
    };
  }
  if (!TASK_EXPOSURE_REQUIRED_LANES.every((lane) => coverage.lanes.includes(lane))) {
    return {
      exposure: { ...local, state: "unknown", evidence: [...local.evidence, "cross-client-coverage-lanes-incomplete"], crossClient },
      reason: "cross-client-coverage-lanes-incomplete",
    };
  }
  if (!createdAt) {
    return {
      exposure: { ...local, state: "unknown", evidence: [...local.evidence, "task-created-at-unavailable"], crossClient },
      reason: "task-created-at-unavailable",
    };
  }
  if (createdAt < coverage.from) {
    return {
      exposure: { ...local, state: "unknown", evidence: [...local.evidence, "candidate-before-cross-client-coverage"], crossClient },
      reason: "candidate-before-cross-client-coverage-window",
    };
  }
  if (createdAt > coverage.through) {
    return {
      exposure: { ...local, state: "unknown", evidence: [...local.evidence, "candidate-after-cross-client-coverage"], crossClient },
      reason: "candidate-after-cross-client-coverage-window",
    };
  }
  return {
    exposure: {
      ...local,
      evidence: [...new Set([...local.evidence, "cross-client-registry-unseen-complete"])].sort(),
      crossClient,
    },
  };
}

function taskTypeFromTags(tags: readonly string[]): string | undefined {
  return tags
    .find((tag) => tag.startsWith("type:") && !tag.startsWith("type:task-result"))
    ?.slice("type:".length);
}

/**
 * Convert one completed daily task into content-blind exam-candidate metadata.
 * "No M5 evidence" becomes provisional only after a bound negative lookup in
 * the complete live cross-client coverage window. Missing or incomplete lookup
 * evidence fails closed to quarantine.
 */
export function buildDailyExamCandidate(
  source: DailyTaskHarvestSource,
  exposureLookup: DailyExamExposureLookupInput = { status: "unavailable", failureKind: "configuration" },
): DailyExamCandidate {
  const taskDocument = source.status.content;
  const prompt = promptFromTask(taskDocument);
  const resultContent = source.resultStructured?.content;
  const result = parseStructuredResult(resultContent);
  const localExposure = exposureFor(result);
  const promptFingerprint = prompt ? sha256(prompt) : undefined;
  const createdAt = taskCreatedAt(source);
  const lookupResults = exposureLookup.status === "queried"
    ? new Map(exposureLookup.evidence.results.map((row) => [row.fingerprintSha256, row]))
    : new Map<string, TaskExposureLookupResult>();
  const resolvedExposure = resolveExposure({
    local: localExposure,
    fingerprint: promptFingerprint,
    createdAt,
    lookup: exposureLookup,
    results: lookupResults,
  });
  const exposure = resolvedExposure.exposure;
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
  if (resolvedExposure.reason) reasons.push(resolvedExposure.reason);

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
      : "cross-client-exposure-check-passed",
    "independent-verifier-required",
  );

  const identity = JSON.stringify({
    taskNamespace: source.status.namespace,
    taskDocumentSha256: sha256(taskDocument),
    promptSha256: prompt ? sha256(prompt) : null,
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
      ...(createdAt ? { taskCreatedAt: createdAt } : {}),
      statusUpdatedAt: source.status.updated_at,
      taskDocumentSha256: sha256(taskDocument),
      ...(prompt ? { promptSha256: sha256(prompt) } : {}),
      ...(resultContent ? { structuredResultSha256: sha256(resultContent) } : {}),
      ...(result?.runtime ? { runtime: result.runtime } : {}),
      ...(taskTypeFromTags(source.status.tags)
        ? { taskType: taskTypeFromTags(source.status.tags) }
        : {}),
      ...(sensitivity ? { sensitivity } : {}),
    },
    repository,
    exposure,
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
  exposureLookup?: DailyExamExposureLookupInput;
}): DailyExamManifest {
  const exposureLookup = input.exposureLookup ?? { status: "unavailable", failureKind: "configuration" };
  const candidates = input.sources
    .map((source) => buildDailyExamCandidate(source, exposureLookup))
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  const lookupManifest = exposureLookup.status === "queried"
    ? {
        status: exposureLookup.status,
        fingerprintVersion: TASK_EXPOSURE_FINGERPRINT_VERSION,
        queriedFingerprints: exposureLookup.evidence.results.length,
        coverage: exposureLookup.evidence.coverage,
      }
    : exposureLookup.status === "unavailable"
      ? {
          status: exposureLookup.status,
          fingerprintVersion: TASK_EXPOSURE_FINGERPRINT_VERSION,
          queriedFingerprints: 0,
          failureKind: exposureLookup.failureKind,
        }
      : {
          status: exposureLookup.status,
          fingerprintVersion: TASK_EXPOSURE_FINGERPRINT_VERSION,
          queriedFingerprints: 0,
        };
  return dailyExamManifestSchema.parse({
    schemaVersion: 2,
    generatedAt: input.generatedAt,
    source: "hugin-munin-daily-tasks",
    contentPolicy: "content-blind-references-only",
    exposureLookup: lookupManifest,
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
