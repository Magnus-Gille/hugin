import {
  buildPhaseTaskDrafts,
} from "./pipeline-compiler.js";
import { buildPipelineResumePlan } from "./pipeline-ops.js";
import { pipelineIRSchema, type PipelineIR } from "./pipeline-ir.js";
import { getPipelinePhaseLifecycle } from "./pipeline-summary.js";
import { buildRoutingMetadataLines } from "./result-format.js";
import { buildPromotedTags } from "./task-graph.js";
import {
  buildPipelineParentCancelledTags,
  buildPipelineParentSuccessTags,
} from "./task-status-tags.js";
import type {
  MuninEntry,
  MuninReadRequest,
  MuninReadResult,
} from "./munin-client.js";
import type {
  TaskExecutionBodyKind,
  TaskExecutionRuntimeMetadata,
} from "./task-result-schema.js";

export interface CancellationRequest {
  reason: string;
  sourceNamespace: string;
  pipelineId?: string;
}

export interface MarkTaskCancelledOptions {
  executor: string;
  resultSource: string;
  startedAt?: string;
  completedAt?: string;
  durationSeconds?: number;
  body?: string;
  bodyKind?: TaskExecutionBodyKind;
  bodyText?: string;
  logFile?: string;
  runtimeMetadata?: TaskExecutionRuntimeMetadata;
}

export interface PipelineControlClient {
  read(namespace: string, key: string): Promise<MuninEntry | null>;
  readBatch(reads: MuninReadRequest[]): Promise<MuninReadResult[]>;
  write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string
  ): Promise<unknown>;
  log(namespace: string, content: string, tags?: string[]): Promise<void>;
}

export interface PipelineControlHooks {
  clearCancellationRequest(
    taskNs: string,
    entry: MuninEntry & { found: true },
    logMessage?: string
  ): Promise<void>;
  clearResumeRequest(
    taskNs: string,
    entry: MuninEntry & { found: true },
    logMessage?: string
  ): Promise<void>;
  markTaskCancelled(
    taskNs: string,
    entry: MuninEntry & { found: true },
    reason: string,
    options: MarkTaskCancelledOptions
  ): Promise<void>;
  requestCancellationForCurrentTask(request: CancellationRequest): void;
  refreshPipelineSummary(pipelineId: string): Promise<void>;
}

function extractTaskId(namespace: string): string {
  return namespace.replace(/^tasks\//, "");
}

function extractRoutingMetadataFromContent(content: string): {
  replyTo?: string;
  replyFormat?: string;
  group?: string;
  sequence?: number;
} {
  const sequenceRaw = content.match(/\*\*Sequence:\*\*\s*(\d+)/i)?.[1];
  return {
    replyTo: content.match(/\*\*Reply-to:\*\*\s*(.+)/i)?.[1]?.trim(),
    replyFormat: content.match(/\*\*Reply-format:\*\*\s*(.+)/i)?.[1]?.trim(),
    group: content.match(/\*\*Group:\*\*\s*(.+)/i)?.[1]?.trim(),
    sequence: sequenceRaw ? parseInt(sequenceRaw, 10) : undefined,
  };
}

function getFoundBatchEntry(
  entry: MuninReadResult | undefined
): (MuninEntry & { found: true }) | null {
  return entry && entry.found ? entry : null;
}

function isTerminalTaskStatus(tags: string[]): boolean {
  return (
    tags.includes("completed") ||
    tags.includes("failed") ||
    tags.includes("cancelled")
  );
}

function buildPipelineCancelledResultDocument(input: {
  pipelineId: string;
  reason: string;
  replyTo?: string;
  replyFormat?: string;
  group?: string;
  sequence?: number;
}): string {
  return [
    "## Result",
    "",
    "- **Exit code:** CANCELLED",
    "- **Pipeline action:** cancelled",
    `- **Pipeline id:** ${input.pipelineId}`,
    `- **Spec key:** tasks/${input.pipelineId}/spec`,
    `- **Summary key:** tasks/${input.pipelineId}/summary`,
    `- **Reason:** ${input.reason}`,
    ...buildRoutingMetadataLines({
      replyTo: input.replyTo,
      replyFormat: input.replyFormat,
      group: input.group,
      sequence: input.sequence,
    }),
  ].join("\n");
}

function buildPhaseResumeResultDocument(input: {
  pipelineId: string;
  phaseName: string;
  previousLifecycle: string;
  nextLifecycle: "pending" | "blocked";
}): string {
  return [
    "## Result",
    "",
    "- **Pipeline action:** resumed",
    `- **Pipeline id:** ${input.pipelineId}`,
    `- **Pipeline phase:** ${input.phaseName}`,
    `- **Previous state:** ${input.previousLifecycle}`,
    `- **Next state:** ${input.nextLifecycle}`,
  ].join("\n");
}

function buildPipelineResumedResultDocument(input: {
  pipelineId: string;
  resumedPhaseNames: string[];
  keptCompletedPhaseNames: string[];
  replyTo?: string;
  replyFormat?: string;
  group?: string;
  sequence?: number;
}): string {
  return [
    "## Result",
    "",
    "- **Exit code:** 0",
    "- **Pipeline action:** resumed",
    `- **Pipeline id:** ${input.pipelineId}`,
    `- **Resumed phases:** ${input.resumedPhaseNames.length}`,
    `- **Completed phases kept:** ${input.keptCompletedPhaseNames.length}`,
    `- **Summary key:** tasks/${input.pipelineId}/summary`,
    ...buildRoutingMetadataLines({
      replyTo: input.replyTo,
      replyFormat: input.replyFormat,
      group: input.group,
      sequence: input.sequence,
    }),
    "",
    "### Resumed phases",
    ...(input.resumedPhaseNames.length > 0
      ? input.resumedPhaseNames.map((name) => `- ${name}`)
      : ["- (none)"]),
    "",
    "### Kept completed phases",
    ...(input.keptCompletedPhaseNames.length > 0
      ? input.keptCompletedPhaseNames.map((name) => `- ${name}`)
      : ["- (none)"]),
  ].join("\n");
}

async function finalizePipelineCancellationIfReady(
  client: PipelineControlClient,
  hooks: PipelineControlHooks,
  pipelineId: string,
  reason: string
): Promise<boolean> {
  const pipelineNs = `tasks/${pipelineId}`;
  const [pipelineEntryResult, specEntryResult] = await client.readBatch([
    { namespace: pipelineNs, key: "status" },
    { namespace: pipelineNs, key: "spec" },
  ]);
  const pipelineEntry = getFoundBatchEntry(pipelineEntryResult);
  const specEntry = getFoundBatchEntry(specEntryResult);
  if (
    !pipelineEntry ||
    !specEntry ||
    !pipelineEntry.tags.includes("cancel-requested")
  ) {
    return false;
  }

  let pipeline: PipelineIR;
  try {
    pipeline = pipelineIRSchema.parse(JSON.parse(specEntry.content));
  } catch (err) {
    console.error(
      `Failed to parse pipeline spec while finalizing cancellation for ${pipelineNs}:`,
      err
    );
    return false;
  }

  const phaseEntries = await client.readBatch(
    pipeline.phases.map((phase) => ({
      namespace: phase.taskNamespace,
      key: "status",
    }))
  );
  for (const phaseEntryResult of phaseEntries) {
    const phaseEntry = getFoundBatchEntry(phaseEntryResult);
    if (phaseEntry && !isTerminalTaskStatus(phaseEntry.tags)) {
      return false;
    }
  }

  const refreshedEntry = await client.read(pipelineNs, "status");
  if (!refreshedEntry || !refreshedEntry.tags.includes("cancel-requested")) {
    return false;
  }

  await client.write(
    pipelineNs,
    "result",
    buildPipelineCancelledResultDocument({
      pipelineId,
      reason,
      replyTo: pipeline.replyTo,
      replyFormat: pipeline.replyFormat,
      group: pipeline.group,
      sequence: pipeline.sequence,
    })
  );
  await client.write(
    pipelineNs,
    "status",
    refreshedEntry.content,
    buildPipelineParentCancelledTags(refreshedEntry.tags),
    refreshedEntry.updated_at
  );
  await client.log(pipelineNs, `Pipeline cancelled: ${reason}`);
  await hooks.refreshPipelineSummary(pipelineId);
  return true;
}

export async function processPipelineCancellationRequest(
  client: PipelineControlClient,
  hooks: PipelineControlHooks,
  entry: MuninEntry & { found: true },
  currentTask: string | null
): Promise<boolean> {
  const pipelineId = extractTaskId(entry.namespace);
  const specEntry = await client.read(entry.namespace, "spec");
  const reason = `Pipeline ${pipelineId} cancelled by operator`;

  if (!specEntry) {
    const routing = extractRoutingMetadataFromContent(entry.content);
    await client.write(
      entry.namespace,
      "result",
      buildPipelineCancelledResultDocument({
        pipelineId,
        reason,
        ...routing,
      })
    );
    await client.write(
      entry.namespace,
      "status",
      entry.content,
      buildPipelineParentCancelledTags(entry.tags),
      entry.updated_at
    );
    await client.log(
      entry.namespace,
      `Pipeline cancelled before decomposition: ${reason}`
    );
    return true;
  }

  let pipeline: PipelineIR;
  try {
    pipeline = pipelineIRSchema.parse(JSON.parse(specEntry.content));
  } catch (err) {
    console.error(
      `Failed to parse pipeline spec for cancellation request ${entry.namespace}:`,
      err
    );
    return false;
  }

  let activeRunningPhase = false;
  let cancelledAny = false;

  const phaseEntries = await client.readBatch(
    pipeline.phases.map((phase) => ({
      namespace: phase.taskNamespace,
      key: "status",
    }))
  );

  for (const [index, phase] of pipeline.phases.entries()) {
    const phaseEntry = getFoundBatchEntry(phaseEntries[index]);
    if (!phaseEntry || isTerminalTaskStatus(phaseEntry.tags)) {
      if (phaseEntry?.tags.includes("cancelled")) cancelledAny = true;
      continue;
    }

    if (phaseEntry.tags.includes("running")) {
      activeRunningPhase = true;
      if (phase.taskNamespace === currentTask) {
        hooks.requestCancellationForCurrentTask({
          reason,
          sourceNamespace: entry.namespace,
          pipelineId,
        });
      }
      continue;
    }

    cancelledAny = true;
    await hooks.markTaskCancelled(phase.taskNamespace, phaseEntry, reason, {
      executor: "dispatcher",
      resultSource: "cancellation",
    });
  }

  if (!activeRunningPhase && !cancelledAny) {
    await hooks.clearCancellationRequest(
      entry.namespace,
      entry,
      "Pipeline cancellation ignored; pipeline already terminal"
    );
    return false;
  }

  try {
    await hooks.refreshPipelineSummary(pipelineId);
  } catch (err) {
    console.error(
      `Pipeline summary refresh failed during cancellation for ${pipelineId}:`,
      err
    );
  }

  if (activeRunningPhase) {
    return true;
  }

  try {
    return await finalizePipelineCancellationIfReady(client, hooks, pipelineId, reason);
  } catch (err) {
    console.error(
      `Pipeline cancellation finalization failed for ${pipelineId}:`,
      err
    );
    return true;
  }
}

export async function processPipelineResumeRequest(
  client: PipelineControlClient,
  hooks: PipelineControlHooks,
  entry: MuninEntry & { found: true }
): Promise<boolean> {
  const specEntry = await client.read(entry.namespace, "spec");
  if (!specEntry) {
    await hooks.clearResumeRequest(
      entry.namespace,
      entry,
      "Resume ignored; pipeline spec is missing"
    );
    return false;
  }

  let pipeline: PipelineIR;
  try {
    pipeline = pipelineIRSchema.parse(JSON.parse(specEntry.content));
  } catch (err) {
    console.error(
      `Failed to parse pipeline spec for resume request ${entry.namespace}:`,
      err
    );
    return false;
  }

  const phaseEntries = new Map<string, (MuninEntry & { found: true }) | null>();
  const currentLifecycles: Record<string, ReturnType<typeof getPipelinePhaseLifecycle>> = {};
  const phaseStatusEntries = await client.readBatch(
    pipeline.phases.map((phase) => ({
      namespace: phase.taskNamespace,
      key: "status",
    }))
  );
  for (const [index, phase] of pipeline.phases.entries()) {
    const phaseEntry = getFoundBatchEntry(phaseStatusEntries[index]);
    phaseEntries.set(phase.taskNamespace, phaseEntry);
    currentLifecycles[phase.taskNamespace] = getPipelinePhaseLifecycle(
      phaseEntry?.tags
    );
  }

  const plan = buildPipelineResumePlan(pipeline, currentLifecycles);
  if (entry.tags.includes("cancel-requested") && plan.hasActivePhases) {
    await hooks.clearResumeRequest(
      entry.namespace,
      entry,
      "Resume ignored; cancellation is still pending"
    );
    return false;
  }

  if (!plan.resumable) {
    if (
      plan.hasActivePhases &&
      (entry.tags.includes("cancelled") || entry.tags.includes("failed"))
    ) {
      const resumedPhaseNames = plan.phases
        .filter((phasePlan) => phasePlan.currentLifecycle !== "completed")
        .map((phasePlan) => phasePlan.phase.name);
      const keptCompletedPhaseNames = plan.phases
        .filter((phasePlan) => phasePlan.currentLifecycle === "completed")
        .map((phasePlan) => phasePlan.phase.name);

      await client.write(
        entry.namespace,
        "result",
        buildPipelineResumedResultDocument({
          pipelineId: pipeline.id,
          resumedPhaseNames,
          keptCompletedPhaseNames,
          replyTo: pipeline.replyTo,
          replyFormat: pipeline.replyFormat,
          group: pipeline.group,
          sequence: pipeline.sequence,
        })
      );
      await client.write(
        entry.namespace,
        "status",
        entry.content,
        buildPipelineParentSuccessTags(
          entry.tags.filter(
            (tag) => tag !== "resume-requested" && tag !== "cancel-requested"
          )
        ),
        entry.updated_at
      );
      await client.log(
        entry.namespace,
        `Pipeline resume finalized after partial update; ${resumedPhaseNames.length} phase(s) already active`
      );
      await hooks.refreshPipelineSummary(pipeline.id);
      return true;
    }

    await hooks.clearResumeRequest(
      entry.namespace,
      entry,
      `Resume ignored; ${plan.reason || "pipeline is not resumable"}`
    );
    return false;
  }

  const draftByNamespace = new Map(
    buildPhaseTaskDrafts(pipeline).map((draft) => [draft.namespace, draft])
  );
  const resumedPhaseNames: string[] = [];
  const keptCompletedPhaseNames: string[] = [];

  for (const phasePlan of plan.phases) {
    if (!phasePlan.shouldReset) {
      if (phasePlan.currentLifecycle === "completed") {
        keptCompletedPhaseNames.push(phasePlan.phase.name);
      }
      continue;
    }

    const draft = draftByNamespace.get(phasePlan.phase.taskNamespace);
    if (!draft) {
      throw new Error(
        `Missing pipeline task draft for ${phasePlan.phase.taskNamespace}`
      );
    }

    const nextTags =
      phasePlan.nextLifecycle === "pending"
        ? buildPromotedTags(draft.tags)
        : draft.tags;

    await client.write(
      phasePlan.phase.taskNamespace,
      "result",
      buildPhaseResumeResultDocument({
        pipelineId: pipeline.id,
        phaseName: phasePlan.phase.name,
        previousLifecycle: phasePlan.currentLifecycle,
        nextLifecycle:
          phasePlan.nextLifecycle === "pending" ? "pending" : "blocked",
      })
    );

    const phaseEntry = phaseEntries.get(phasePlan.phase.taskNamespace);
    if (phaseEntry) {
      await client.write(
        phasePlan.phase.taskNamespace,
        "status",
        draft.content,
        nextTags,
        phaseEntry.updated_at
      );
    } else {
      await client.write(
        phasePlan.phase.taskNamespace,
        "status",
        draft.content,
        nextTags
      );
    }

    await client.log(
      phasePlan.phase.taskNamespace,
      `Phase resumed from ${phasePlan.currentLifecycle} -> ${phasePlan.nextLifecycle} (pipeline ${pipeline.id})`
    );
    resumedPhaseNames.push(phasePlan.phase.name);
  }

  await client.write(
    entry.namespace,
    "result",
    buildPipelineResumedResultDocument({
      pipelineId: pipeline.id,
      resumedPhaseNames,
      keptCompletedPhaseNames,
      replyTo: pipeline.replyTo,
      replyFormat: pipeline.replyFormat,
      group: pipeline.group,
      sequence: pipeline.sequence,
    })
  );

  await client.write(
    entry.namespace,
    "status",
    entry.content,
    buildPipelineParentSuccessTags(
      entry.tags.filter(
        (tag) => tag !== "resume-requested" && tag !== "cancel-requested"
      )
    ),
    entry.updated_at
  );
  await client.log(
    entry.namespace,
    `Pipeline resumed: reset ${resumedPhaseNames.length} phase(s), kept ${keptCompletedPhaseNames.length} completed phase(s)`
  );
  await hooks.refreshPipelineSummary(pipeline.id);
  return true;
}
