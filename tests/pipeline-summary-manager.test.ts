import { describe, expect, it } from "vitest";
import { compilePipelineTask } from "../src/pipeline-compiler.js";
import { PipelineSummaryManager } from "../src/pipeline-summary-manager.js";
import { parsePipelineExecutionSummary } from "../src/pipeline-summary.js";
import { buildStructuredTaskResult } from "../src/task-result-schema.js";
import type { MuninEntry, MuninReadRequest, MuninReadResult } from "../src/munin-client.js";

type StoredEntry = MuninEntry & { found: true };

class FakeSummaryClient {
  private entries = new Map<string, StoredEntry>();
  private tick = 0;
  private writeCounts = new Map<string, number>();

  seed(entry: Omit<StoredEntry, "id" | "created_at" | "updated_at" | "found">): StoredEntry {
    const now = this.nextTimestamp();
    const stored: StoredEntry = {
      ...entry,
      id: `${entry.namespace}/${entry.key}`,
      created_at: now,
      updated_at: now,
      found: true,
    };
    this.entries.set(this.entryKey(entry.namespace, entry.key), stored);
    return stored;
  }

  get(namespace: string, key: string): StoredEntry | null {
    return this.entries.get(this.entryKey(namespace, key)) || null;
  }

  writeCount(namespace: string, key: string): number {
    return this.writeCounts.get(this.entryKey(namespace, key)) || 0;
  }

  async read(namespace: string, key: string): Promise<MuninEntry | null> {
    return this.get(namespace, key);
  }

  async readBatch(reads: MuninReadRequest[]): Promise<MuninReadResult[]> {
    return reads.map(({ namespace, key }) => {
      const entry = this.get(namespace, key);
      return entry || { namespace, key, found: false };
    });
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string
  ): Promise<StoredEntry> {
    const existing = this.get(namespace, key);
    if (expectedUpdatedAt && existing && existing.updated_at !== expectedUpdatedAt) {
      throw new Error(`CAS mismatch for ${namespace}/${key}`);
    }

    const timestamp = this.nextTimestamp();
    const entry: StoredEntry = {
      id: existing?.id || `${namespace}/${key}`,
      namespace,
      key,
      content,
      tags: tags ? [...tags] : [...(existing?.tags || [])],
      created_at: existing?.created_at || timestamp,
      updated_at: timestamp,
      found: true,
    };
    this.entries.set(this.entryKey(namespace, key), entry);
    this.writeCounts.set(
      this.entryKey(namespace, key),
      this.writeCount(namespace, key) + 1
    );
    return entry;
  }

  private nextTimestamp(): string {
    const timestamp = new Date(Date.UTC(2026, 3, 3, 18, 30, this.tick)).toISOString();
    this.tick += 1;
    return timestamp;
  }

  private entryKey(namespace: string, key: string): string {
    return `${namespace}::${key}`;
  }
}

function silentLogger() {
  return {
    log: () => {},
    error: () => {},
  };
}

function makePipeline() {
  return compilePipelineTask(
    "20260403-summary-manager",
    "tasks/20260403-summary-manager",
    `## Task: Summary manager pipeline

- **Runtime:** pipeline
- **Submitted by:** Codex
- **Submitted at:** 2026-04-03T18:00:00Z
- **Reply-format:** summary

### Pipeline
Phase: Gather
  Runtime: claude-sdk
  Prompt: |
    Gather.

Phase: Report
  Depends-on: Gather
  Runtime: claude-sdk
  Prompt: |
    Report.`
  );
}

describe("PipelineSummaryManager", () => {
  it("writes a non-terminal summary once and skips unchanged rewrites", async () => {
    const pipeline = makePipeline();
    const client = new FakeSummaryClient();
    const manager = new PipelineSummaryManager();

    client.seed({
      namespace: pipeline.sourceTaskNamespace,
      key: "spec",
      content: JSON.stringify(pipeline, null, 2),
      tags: ["type:pipeline", "type:pipeline-spec"],
    });
    client.seed({
      namespace: pipeline.phases[0]!.taskNamespace,
      key: "status",
      content: "gather",
      tags: ["pending", "runtime:claude", "type:pipeline", "type:pipeline-phase"],
    });
    client.seed({
      namespace: pipeline.phases[1]!.taskNamespace,
      key: "status",
      content: "report",
      tags: ["blocked", "runtime:claude", "type:pipeline", "type:pipeline-phase"],
    });

    await manager.refresh(client, pipeline.id, silentLogger());
    const firstSummary = client.get(pipeline.sourceTaskNamespace, "summary");
    expect(firstSummary).not.toBeNull();
    expect(parsePipelineExecutionSummary(firstSummary!.content)?.executionState).toBe(
      "decomposed"
    );
    expect(manager.listTrackedIds()).toContain(pipeline.id);
    expect(client.writeCount(pipeline.sourceTaskNamespace, "summary")).toBe(1);

    const firstUpdatedAt = firstSummary!.updated_at;
    await manager.refresh(client, pipeline.id, silentLogger());
    const secondSummary = client.get(pipeline.sourceTaskNamespace, "summary");
    expect(secondSummary?.updated_at).toBe(firstUpdatedAt);
    expect(client.writeCount(pipeline.sourceTaskNamespace, "summary")).toBe(1);
  });

  it("reconciles tracked pipelines and untracks once the summary becomes terminal", async () => {
    const pipeline = makePipeline();
    const client = new FakeSummaryClient();
    const manager = new PipelineSummaryManager();

    client.seed({
      namespace: pipeline.sourceTaskNamespace,
      key: "spec",
      content: JSON.stringify(pipeline, null, 2),
      tags: ["type:pipeline", "type:pipeline-spec"],
    });
    for (const phase of pipeline.phases) {
      client.seed({
        namespace: phase.taskNamespace,
        key: "status",
        content: phase.name,
        tags: ["completed", "runtime:claude", "type:pipeline", "type:pipeline-phase"],
      });
      client.seed({
        namespace: phase.taskNamespace,
        key: "result-structured",
        content: JSON.stringify(
          buildStructuredTaskResult({
            schemaVersion: 1,
            taskId: phase.taskId,
            taskNamespace: phase.taskNamespace,
            lifecycle: "completed",
            outcome: "completed",
            runtime: "claude",
            executor: "agent-sdk",
            resultSource: "agent-sdk",
            exitCode: 0,
            startedAt: "2026-04-03T18:00:01Z",
            completedAt: "2026-04-03T18:00:02Z",
            durationSeconds: 1,
            bodyKind: "response",
            bodyText: phase.name.toUpperCase(),
          }),
          null,
          2
        ),
        tags: ["type:task-result", "type:task-result-structured"],
      });
    }

    manager.track(pipeline.id);
    await manager.reconcile(client, silentLogger());

    const summary = parsePipelineExecutionSummary(
      client.get(pipeline.sourceTaskNamespace, "summary")?.content || ""
    );
    expect(summary?.executionState).toBe("completed");
    expect(summary?.terminal).toBe(true);
    expect(manager.trackedCount()).toBe(0);
  });
});
