import {
  buildPhaseTaskDrafts,
  buildPipelineDecompositionResult,
  compilePipelineTask,
} from "./pipeline-compiler.js";
import type { PipelineIR } from "./pipeline-ir.js";
import type { MuninEntry, MuninReadRequest, MuninReadResult } from "./munin-client.js";
import { buildPipelineParentSuccessTags } from "./task-status-tags.js";

export interface PipelineDispatchClient {
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

export interface PipelineDispatchHooks {
  failTaskWithMessage(
    taskNs: string,
    entry: MuninEntry & { found: true },
    errorMessage: string,
    runtimeTagOverride?: string
  ): Promise<void>;
  promoteDependents(completedTaskId: string): Promise<void>;
  refreshPipelineSummary(pipelineId: string): Promise<void>;
}

function extractTaskId(namespace: string): string {
  return namespace.replace(/^tasks\//, "");
}

function getFoundBatchEntry(
  entry: MuninReadResult | undefined
): (MuninEntry & { found: true }) | null {
  return entry && entry.found ? entry : null;
}

export async function handlePipelineTask(
  client: PipelineDispatchClient,
  hooks: PipelineDispatchHooks,
  taskNs: string,
  entry: MuninEntry & { found: true },
  queueDepth: number
): Promise<{ hadTask: boolean; queueDepth: number }> {
  const pipelineId = extractTaskId(taskNs);
  let pipeline: PipelineIR;

  try {
    pipeline = compilePipelineTask(pipelineId, taskNs, entry.content);
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
      ["type:pipeline", "type:pipeline-spec"]
    );

    for (const draft of phaseDrafts) {
      await client.write(draft.namespace, "status", draft.content, draft.tags);
    }

    await client.write(
      taskNs,
      "status",
      entry.content,
      buildPipelineParentSuccessTags(entry.tags),
      entry.updated_at
    );
    await client.write(taskNs, "result", buildPipelineDecompositionResult(pipeline));
    await hooks.refreshPipelineSummary(pipelineId);
    await client.log(
      taskNs,
      `Pipeline compiled and decomposed into ${phaseDrafts.length} phase task(s)`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await hooks.failTaskWithMessage(
      taskNs,
      entry,
      `Pipeline decomposition failed: ${message}`,
      "runtime:pipeline"
    );
    await client.log(taskNs, `Pipeline decomposition failed: ${message}`);
  }

  await hooks.promoteDependents(pipelineId);

  return { hadTask: true, queueDepth };
}
