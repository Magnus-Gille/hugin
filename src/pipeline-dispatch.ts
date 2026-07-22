import {
  buildPhaseTaskDrafts,
  buildPipelineDecompositionResult,
  compilePipelineTask,
} from "./pipeline-compiler.js";
import type { PipelineIR, PipelinePhaseTaskDraft } from "./pipeline-ir.js";
import type { MuninEntry, MuninReadRequest, MuninReadResult } from "./munin-client.js";
import type { OllamaHost } from "./ollama-hosts.js";
import { getFoundBatchEntry, extractTaskId } from "./task-helpers.js";
import { sensitivityToMuninClassification } from "./sensitivity.js";
import {
  buildPipelineParentSuccessTags,
  buildTerminalStatusTags,
} from "./task-status-tags.js";
import {
  buildTaskSensitivitySnapshot,
  buildStructuredTaskResult,
  type StructuredTaskResult,
} from "./task-result-schema.js";
import {
  buildSensitivityCheckpoint,
  SENSITIVITY_CHECKPOINT_KEY,
  SENSITIVITY_CHECKPOINT_TAGS,
} from "./sensitivity-checkpoint.js";

export interface PipelineDispatchClient {
  readBatch(reads: MuninReadRequest[]): Promise<MuninReadResult[]>;
  write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string
  ): Promise<unknown>;
  log(namespace: string, content: string, tags?: string[]): Promise<void>;
}

export interface PipelineDispatchHooks {
  failTaskWithMessage(
    taskNs: string,
    entry: MuninEntry & { found: true },
    errorMessage: string,
    runtimeTagOverride?: string
  ): Promise<void>;
  promoteDependents(completedTaskId: string): Promise<void>;
  refreshPipelineSummary(pipelineId: string): Promise<void>;
  writeStructuredResult(
    taskNs: string,
    result: StructuredTaskResult,
    classification?: string,
  ): Promise<void>;
}


async function cancelCreatedChildren(
  client: PipelineDispatchClient,
  hooks: PipelineDispatchHooks,
  createdDrafts: PipelinePhaseTaskDraft[],
): Promise<void> {
  for (const draft of createdDrafts) {
    try {
      await client.write(
        draft.namespace,
        "status",
        draft.content,
        buildTerminalStatusTags("cancelled", draft.tags),
        undefined,
        sensitivityToMuninClassification(draft.classification)
      );
      await client.write(
        draft.namespace,
        "result",
        "## Result\n\n- **Exit code:** CANCELLED\n- **Error:** Pipeline decomposition aborted before parent commit\n",
        undefined,
        undefined,
        sensitivityToMuninClassification(draft.classification)
      );
      const runtime = (draft.tags.find((tag) => tag.startsWith("runtime:")) ?? "runtime:claude")
        .replace(/^runtime:/, "") as StructuredTaskResult["runtime"];
      await hooks.writeStructuredResult(
        draft.namespace,
        buildStructuredTaskResult({
          schemaVersion: 1,
          taskId: extractTaskId(draft.namespace),
          taskNamespace: draft.namespace,
          lifecycle: "cancelled",
          outcome: "cancelled",
          runtime,
          executor: "dispatcher",
          resultSource: "pipeline-decomposition-cleanup",
          exitCode: "CANCELLED",
          completedAt: new Date().toISOString(),
          bodyKind: "error",
          bodyText: "Pipeline decomposition aborted before parent commit",
          errorMessage: "Pipeline decomposition aborted before parent commit",
          sensitivity: buildTaskSensitivitySnapshot(draft.sensitivityAssessment),
        }),
        sensitivityToMuninClassification(draft.classification),
      );
      await client.log(
        draft.namespace,
        "Pipeline phase cancelled because parent decomposition failed before commit"
      );
    } catch {
      // Best-effort cleanup: the parent failure will still surface the original error.
    }
  }
}

export async function handlePipelineTask(
  client: PipelineDispatchClient,
  hooks: PipelineDispatchHooks,
  taskNs: string,
  entry: MuninEntry & { found: true },
  queueDepth: number,
  ollamaHosts?: OllamaHost[],
  options?: {
    allowOwnerOverride?: boolean;
    sensitivityCheckpointSecret?: string;
  },
): Promise<{ hadTask: boolean; queueDepth: number }> {
  const pipelineId = extractTaskId(taskNs);
  let pipeline: PipelineIR;

  try {
    pipeline = compilePipelineTask(pipelineId, taskNs, entry.content, ollamaHosts, {
      allowOwnerOverride: options?.allowOwnerOverride,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await hooks.failTaskWithMessage(
      taskNs,
      entry,
      `Pipeline compile failed: ${message}`,
      "runtime:pipeline"
    );
    await client.log(taskNs, `Pipeline compile failed: ${message}`);
    await hooks.promoteDependents(pipelineId);
    return { hadTask: true, queueDepth };
  }

  const phaseDrafts = buildPhaseTaskDrafts(pipeline);
  const createdDrafts: typeof phaseDrafts = [];
  let decompositionCommitted = false;

  try {
    const existingChildren = await client.readBatch(
      phaseDrafts.map((draft) => ({
        namespace: draft.namespace,
        key: "status",
      }))
    );
    const existingChild = existingChildren
      .map((batchEntry) => getFoundBatchEntry(batchEntry))
      .find((child) => child !== null);
    if (existingChild) {
      throw new Error(`Child task namespace already exists: ${existingChild.namespace}`);
    }

    await client.write(
      taskNs,
      "spec",
      JSON.stringify(pipeline, null, 2),
      ["type:pipeline", "type:pipeline-spec"],
      undefined,
      sensitivityToMuninClassification(pipeline.sensitivity)
    );

    for (const draft of phaseDrafts) {
      const sensitivity = buildTaskSensitivitySnapshot(
        draft.sensitivityAssessment,
      );
      if (sensitivity) {
        await client.write(
          draft.namespace,
          SENSITIVITY_CHECKPOINT_KEY,
          buildSensitivityCheckpoint(
            draft.namespace,
            draft.content,
            sensitivity,
            options?.sensitivityCheckpointSecret ?? "",
          ),
          [...SENSITIVITY_CHECKPOINT_TAGS],
          undefined,
          sensitivityToMuninClassification(draft.classification),
        );
      }
      await client.write(
        draft.namespace,
        "status",
        draft.content,
        draft.tags,
        undefined,
        sensitivityToMuninClassification(draft.classification)
      );
      createdDrafts.push(draft);
    }

    await client.write(
      taskNs,
      "status",
      entry.content,
      buildPipelineParentSuccessTags(entry.tags),
      entry.updated_at,
      sensitivityToMuninClassification(pipeline.sensitivity)
    );
    await client.write(
      taskNs,
      "result",
      buildPipelineDecompositionResult(pipeline),
      undefined,
      undefined,
      sensitivityToMuninClassification(pipeline.sensitivity)
    );
    decompositionCommitted = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (createdDrafts.length > 0) {
      await cancelCreatedChildren(client, hooks, createdDrafts);
    }
    await hooks.failTaskWithMessage(
      taskNs,
      entry,
      `Pipeline decomposition failed: ${message}`,
      "runtime:pipeline"
    );
    await client.log(taskNs, `Pipeline decomposition failed: ${message}`);
  }

  if (decompositionCommitted) {
    try {
      const bodyText = buildPipelineDecompositionResult(pipeline);
      await hooks.writeStructuredResult(
        taskNs,
        buildStructuredTaskResult({
          schemaVersion: 1,
          taskId: pipelineId,
          taskNamespace: taskNs,
          lifecycle: "completed",
          outcome: "completed",
          runtime: "pipeline",
          executor: "dispatcher",
          resultSource: "pipeline-decomposition",
          exitCode: 0,
          completedAt: new Date().toISOString(),
          bodyKind: "response",
          bodyText,
          sensitivity: {
            declared: pipeline.declaredSensitivity,
            effective: pipeline.sensitivity,
            mismatch:
              pipeline.declaredSensitivity !== undefined &&
              pipeline.declaredSensitivity !== pipeline.sensitivity,
          },
        }),
        sensitivityToMuninClassification(pipeline.sensitivity),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await client.log(
        taskNs,
        `Pipeline decomposition committed, but structured result write failed: ${message}`,
      );
    }

    try {
      await hooks.refreshPipelineSummary(pipelineId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await client.log(
        taskNs,
        `Pipeline decomposition committed, but summary refresh failed: ${message}`
      );
    }

    try {
      await client.log(
        taskNs,
        `Pipeline compiled and decomposed into ${phaseDrafts.length} phase task(s)`
      );
    } catch {
      // Best-effort observability only: decomposition is already committed.
    }
  }

  await hooks.promoteDependents(pipelineId);

  return { hadTask: true, queueDepth };
}
