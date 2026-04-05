import type {
  MuninEntry,
  MuninReadRequest,
  MuninReadResult,
} from "./munin-client.js";
import { getFoundBatchEntry } from "./task-helpers.js";
import { pipelineIRSchema, type PipelineIR } from "./pipeline-ir.js";
import {
  buildPipelineExecutionSummary,
  getPipelineExecutionSummaryFingerprint,
  getPipelinePhaseLifecycle,
  type PipelineExecutionSummary,
  type PipelinePhaseSnapshot,
} from "./pipeline-summary.js";
import {
  structuredTaskResultSchema,
  type StructuredTaskResult,
} from "./task-result-schema.js";
import { sensitivityToMuninClassification } from "./sensitivity.js";

interface LoggerLike {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface PipelineSummaryClient {
  read(namespace: string, key: string): Promise<MuninEntry | null>;
  readBatch(reads: MuninReadRequest[]): Promise<MuninReadResult[]>;
  write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string
  ): Promise<unknown>;
}

function getPipelineIdFromContent(content: string): string | undefined {
  return content.match(/\*\*Pipeline:\*\*\s*(.+)/i)?.[1]?.trim();
}

function getBatchResultKey(namespace: string, key: string): string {
  return `${namespace}::${key}`;
}


function parseErrorMessageFromResult(content: string | undefined): string | undefined {
  if (!content) return undefined;
  return content.match(/\*\*Error:\*\*\s*(.+)/)?.[1]?.trim();
}

function parseStructuredTaskResultContent(
  taskNs: string,
  content: string,
  logger: LoggerLike
): StructuredTaskResult | null {
  try {
    return structuredTaskResultSchema.parse(JSON.parse(content));
  } catch (err) {
    logger.error(`Failed to parse structured result for ${taskNs}:`, err);
    return null;
  }
}

export class PipelineSummaryManager {
  private trackedPipelineSummaryIds = new Set<string>();
  private pipelineSummaryFingerprints = new Map<string, string>();

  track(pipelineId: string): void {
    this.trackedPipelineSummaryIds.add(pipelineId);
  }

  untrack(pipelineId: string): void {
    this.trackedPipelineSummaryIds.delete(pipelineId);
    this.pipelineSummaryFingerprints.delete(pipelineId);
  }

  cacheSummaryFingerprint(summary: PipelineExecutionSummary): string {
    const fingerprint = getPipelineExecutionSummaryFingerprint(summary);
    this.pipelineSummaryFingerprints.set(summary.pipelineId, fingerprint);
    return fingerprint;
  }

  listTrackedIds(): string[] {
    return Array.from(this.trackedPipelineSummaryIds);
  }

  trackedCount(): number {
    return this.trackedPipelineSummaryIds.size;
  }

  async refresh(
    client: PipelineSummaryClient,
    pipelineId: string,
    logger: LoggerLike = console
  ): Promise<void> {
    this.track(pipelineId);
    try {
      const pipelineNs = `tasks/${pipelineId}`;
      const specEntry = await client.read(pipelineNs, "spec");
      if (!specEntry) {
        this.untrack(pipelineId);
        return;
      }

      let pipeline: PipelineIR;
      try {
        pipeline = pipelineIRSchema.parse(JSON.parse(specEntry.content));
      } catch (err) {
        logger.error(`Failed to parse pipeline spec for ${pipelineNs}:`, err);
        return;
      }

      const statusEntries = await client.readBatch(
        pipeline.phases.map((phase) => ({
          namespace: phase.taskNamespace,
          key: "status",
        }))
      );
      const terminalPhases: Array<{
        phase: PipelineIR["phases"][number];
        lifecycle: PipelinePhaseSnapshot["lifecycle"];
      }> = [];
      const snapshots: PipelinePhaseSnapshot[] = pipeline.phases.map(
        (phase, index) => {
          const statusEntry = getFoundBatchEntry(statusEntries[index]);
          const lifecycle = getPipelinePhaseLifecycle(statusEntry?.tags);
          if (
            lifecycle === "completed" ||
            lifecycle === "failed" ||
            lifecycle === "cancelled"
          ) {
            terminalPhases.push({ phase, lifecycle });
          }
          return {
            phase,
            lifecycle,
          };
        }
      );

      const terminalResultEntries = terminalPhases.length
        ? await client.readBatch(
            terminalPhases.flatMap(({ phase }) => [
              { namespace: phase.taskNamespace, key: "result-structured" },
              { namespace: phase.taskNamespace, key: "result" },
            ])
          )
        : [];
      const terminalEntryMap = new Map<string, MuninReadResult>();
      for (const entry of terminalResultEntries) {
        terminalEntryMap.set(getBatchResultKey(entry.namespace, entry.key), entry);
      }

      snapshots.forEach((snapshot) => {
        const isTerminal =
          snapshot.lifecycle === "completed" ||
          snapshot.lifecycle === "failed" ||
          snapshot.lifecycle === "cancelled";
        if (!isTerminal) return;

        const structuredEntry = getFoundBatchEntry(
          terminalEntryMap.get(
            getBatchResultKey(snapshot.phase.taskNamespace, "result-structured")
          )
        );
        const resultEntry = getFoundBatchEntry(
          terminalEntryMap.get(
            getBatchResultKey(snapshot.phase.taskNamespace, "result")
          )
        );
        const structuredResult = structuredEntry
          ? parseStructuredTaskResultContent(
              snapshot.phase.taskNamespace,
              structuredEntry.content,
              logger
            )
          : null;

        snapshot.structuredResult = structuredResult || undefined;
        snapshot.errorMessage =
          structuredResult?.errorMessage ||
          parseErrorMessageFromResult(resultEntry?.content);
      });

      const summary = buildPipelineExecutionSummary(pipeline, snapshots);
      const nextFingerprint = getPipelineExecutionSummaryFingerprint(summary);
      if (this.pipelineSummaryFingerprints.get(pipelineId) !== nextFingerprint) {
        await client.write(
          pipelineNs,
          "summary",
          JSON.stringify(summary, null, 2),
          ["type:pipeline", "type:pipeline-summary"],
          undefined,
          sensitivityToMuninClassification(pipeline.sensitivity)
        );
      }
      this.pipelineSummaryFingerprints.set(pipelineId, nextFingerprint);
      if (summary.terminal) {
        this.untrack(pipelineId);
      }
    } catch (err) {
      logger.error(`Pipeline summary refresh failed for ${pipelineId}:`, err);
    }
  }

  async refreshFromContent(
    client: PipelineSummaryClient,
    content: string,
    logger: LoggerLike = console
  ): Promise<void> {
    const pipelineId = getPipelineIdFromContent(content);
    if (!pipelineId) return;
    await this.refresh(client, pipelineId, logger);
  }

  async reconcile(
    client: PipelineSummaryClient,
    logger: LoggerLike = console
  ): Promise<void> {
    if (this.trackedPipelineSummaryIds.size === 0) return;

    const pipelineIds = Array.from(this.trackedPipelineSummaryIds);
    let reconciled = 0;
    for (const pipelineId of pipelineIds) {
      await this.refresh(client, pipelineId, logger);
      reconciled++;
    }

    if (reconciled > 0) {
      logger.log(
        `Pipeline summary reconciliation: refreshed=${reconciled}, still_tracked=${this.trackedPipelineSummaryIds.size}`
      );
    }
  }
}
