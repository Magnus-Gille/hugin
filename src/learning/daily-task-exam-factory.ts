import { createHash } from "node:crypto";
import { z } from "zod";
import type { MuninEntry } from "../munin-client.js";
import {
  structuredTaskResultSchema,
  type StructuredTaskResult,
} from "../task-result-schema.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitCommitSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const dailyExamCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  candidateId: z.string().regex(/^daily-[0-9a-f]{24}$/),
  source: z.object({
    taskNamespace: z.string().startsWith("tasks/"),
    taskId: z.string().min(1),
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
  lane: z.enum(["provisional-holdout", "regression", "quarantine"]),
  readiness: z.enum(["needs-independent-verifier", "quarantined"]),
  reasons: z.array(z.string().min(1)),
  contentPolicy: z.literal("content-blind-references-only"),
}).strict();
export type DailyExamCandidate = z.infer<typeof dailyExamCandidateSchema>;

export const dailyExamManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().min(1),
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
    promptSha256: prompt ? sha256(prompt) : null,
    baseCommit: change?.baseCommit ?? null,
    headCommit: change?.headCommit ?? null,
    diffSha256: change?.diffSha256 ?? null,
  });
  const candidate: DailyExamCandidate = {
    schemaVersion: 1,
    candidateId: `daily-${sha256(identity).slice(0, 24)}`,
    source: {
      taskNamespace: source.status.namespace,
      taskId: result?.taskId ?? source.status.namespace.replace(/^tasks\//, ""),
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
}): DailyExamManifest {
  const candidates = input.sources
    .map(buildDailyExamCandidate)
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  return dailyExamManifestSchema.parse({
    schemaVersion: 1,
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
