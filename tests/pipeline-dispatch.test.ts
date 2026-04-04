import { describe, expect, it } from "vitest";
import { handlePipelineTask, type PipelineDispatchClient, type PipelineDispatchHooks } from "../src/pipeline-dispatch.js";
import { compilePipelineTask } from "../src/pipeline-compiler.js";
import { pipelineIRSchema } from "../src/pipeline-ir.js";
import {
  buildPipelineExecutionSummary,
  getPipelinePhaseLifecycle,
  parsePipelineExecutionSummary,
} from "../src/pipeline-summary.js";
import { buildTerminalStatusTags } from "../src/task-status-tags.js";
import type { MuninEntry, MuninReadRequest, MuninReadResult } from "../src/munin-client.js";

type StoredEntry = MuninEntry & { found: true };

class FakePipelineDispatchClient implements PipelineDispatchClient {
  private entries = new Map<string, StoredEntry>();
  private tick = 0;
  private writeFailures = new Map<string, string>();

  readonly logs: Array<{ namespace: string; content: string; tags: string[] }> = [];

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

  listByNamespace(namespacePrefix: string): StoredEntry[] {
    return [...this.entries.values()].filter((entry) =>
      entry.namespace.startsWith(namespacePrefix)
    );
  }

  nextTimestamp(): string {
    const timestamp = new Date(Date.UTC(2026, 3, 3, 12, 0, this.tick)).toISOString();
    this.tick += 1;
    return timestamp;
  }

  failNextWrite(namespace: string, key: string, message: string): void {
    this.writeFailures.set(this.entryKey(namespace, key), message);
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
      throw new Error(
        `CAS mismatch for ${namespace}/${key}: expected ${expectedUpdatedAt}, got ${existing.updated_at}`
      );
    }
    const failureKey = this.entryKey(namespace, key);
    const failureMessage = this.writeFailures.get(failureKey);
    if (failureMessage) {
      this.writeFailures.delete(failureKey);
      throw new Error(failureMessage);
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
    return entry;
  }

  async log(namespace: string, content: string, tags: string[] = []): Promise<void> {
    this.logs.push({ namespace, content, tags });
  }

  private entryKey(namespace: string, key: string): string {
    return `${namespace}::${key}`;
  }
}

function createPipelineHooks(client: FakePipelineDispatchClient): {
  hooks: PipelineDispatchHooks;
  promotedTaskIds: string[];
  refreshedPipelineIds: string[];
} {
  const promotedTaskIds: string[] = [];
  const refreshedPipelineIds: string[] = [];

  return {
    hooks: {
      async failTaskWithMessage(taskNs, entry, errorMessage, runtimeTagOverride) {
        await client.write(
          taskNs,
          "status",
          entry.content,
          buildTerminalStatusTags("failed", entry.tags, runtimeTagOverride),
          entry.updated_at
        );
        await client.write(
          taskNs,
          "result",
          `## Result\n\n- **Exit code:** -1\n- **Error:** ${errorMessage}\n`
        );
      },
      async promoteDependents(completedTaskId) {
        promotedTaskIds.push(completedTaskId);
      },
      async refreshPipelineSummary(pipelineId) {
        refreshedPipelineIds.push(pipelineId);
        const pipelineNs = `tasks/${pipelineId}`;
        const specEntry = client.get(pipelineNs, "spec");
        if (!specEntry) {
          throw new Error(`Missing spec for ${pipelineNs}`);
        }

        const pipeline = pipelineIRSchema.parse(JSON.parse(specEntry.content));
        const summary = buildPipelineExecutionSummary(
          pipeline,
          pipeline.phases.map((phase) => {
            const phaseStatus = client.get(phase.taskNamespace, "status");
            return {
              phase,
              lifecycle: getPipelinePhaseLifecycle(phaseStatus?.tags),
            };
          }),
          client.nextTimestamp()
        );
        await client.write(
          pipeline.sourceTaskNamespace,
          "summary",
          JSON.stringify(summary, null, 2),
          ["type:pipeline", "type:pipeline-summary"]
        );
      },
    },
    promotedTaskIds,
    refreshedPipelineIds,
  };
}

function makeValidPipelineContent(): string {
  return `## Task: Research brief

- **Runtime:** pipeline
- **Submitted by:** Codex
- **Submitted at:** 2026-04-03T10:00:00Z
- **Reply-to:** telegram:12345
- **Reply-format:** summary
- **Group:** sprint-step3
- **Sequence:** 2
- **Sensitivity:** internal

### Pipeline
Phase: Explore
  Runtime: claude-sdk
  Prompt: |
    Gather the most relevant notes.

Phase: Synthesize
  Depends-on: Explore
  Runtime: ollama-pi
  On-dep-failure: continue
  Prompt: |
    Summarize the findings into a brief.`;
}

describe("handlePipelineTask", () => {
  it("writes parent spec/result, child tasks, and decomposed summary for a valid pipeline", async () => {
    const client = new FakePipelineDispatchClient();
    const { hooks, promotedTaskIds, refreshedPipelineIds } = createPipelineHooks(client);
    const taskNs = "tasks/20260403-valid-pipeline";
    const parentEntry = client.seed({
      namespace: taskNs,
      key: "status",
      content: makeValidPipelineContent(),
      tags: ["running", "runtime:pipeline", "type:research", "type:evaluation"],
    });

    const result = await handlePipelineTask(client, hooks, taskNs, parentEntry, 4);

    expect(result).toEqual({ hadTask: true, queueDepth: 4 });

    const specEntry = client.get(taskNs, "spec");
    expect(specEntry).not.toBeNull();
    const pipeline = pipelineIRSchema.parse(JSON.parse(specEntry!.content));
    expect(pipeline.id).toBe("20260403-valid-pipeline");
    expect(pipeline.replyTo).toBe("telegram:12345");
    expect(pipeline.group).toBe("sprint-step3");

    const parentStatus = client.get(taskNs, "status");
    expect(parentStatus?.tags).toEqual([
      "completed",
      "runtime:pipeline",
      "type:research",
      "type:evaluation",
      "type:pipeline",
    ]);

    const parentResult = client.get(taskNs, "result");
    expect(parentResult?.content).toContain("- **Pipeline action:** compiled and decomposed");
    expect(parentResult?.content).toContain("- **Reply-to:** telegram:12345");
    expect(parentResult?.content).toContain("- **Reply-format:** summary");
    expect(parentResult?.content).toContain("- **Group:** sprint-step3");
    expect(parentResult?.content).toContain("- **Sequence:** 2");

    const exploreStatus = client.get("tasks/20260403-valid-pipeline-explore", "status");
    expect(exploreStatus?.tags).toEqual([
      "pending",
      "runtime:claude",
      "type:pipeline",
      "type:pipeline-phase",
      "authority:autonomous",
      "sensitivity:internal",
    ]);
    expect(exploreStatus?.content).toContain("- **Pipeline:** 20260403-valid-pipeline");

    const synthesizeStatus = client.get(
      "tasks/20260403-valid-pipeline-synthesize",
      "status"
    );
    expect(synthesizeStatus?.tags).toEqual([
      "blocked",
      "runtime:ollama",
      "type:pipeline",
      "type:pipeline-phase",
      "authority:autonomous",
      "sensitivity:internal",
      "on-dep-failure:continue",
      "depends-on:20260403-valid-pipeline-explore",
    ]);
    expect(synthesizeStatus?.content).toContain(
      "- **Depends on task ids:** 20260403-valid-pipeline-explore"
    );

    const summaryEntry = client.get(taskNs, "summary");
    const summary = parsePipelineExecutionSummary(summaryEntry?.content || "");
    expect(summary).not.toBeNull();
    expect(summary?.executionState).toBe("decomposed");
    expect(summary?.phaseCounts).toMatchObject({
      total: 2,
      pending: 1,
      blocked: 1,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });

    expect(refreshedPipelineIds).toEqual(["20260403-valid-pipeline"]);
    expect(promotedTaskIds).toEqual(["20260403-valid-pipeline"]);
    expect(client.logs).toContainEqual({
      namespace: taskNs,
      content: "Pipeline compiled and decomposed into 2 phase task(s)",
      tags: [],
    });
  });

  it("fails the parent task cleanly when pipeline compile validation fails", async () => {
    const client = new FakePipelineDispatchClient();
    const { hooks, promotedTaskIds, refreshedPipelineIds } = createPipelineHooks(client);
    const taskNs = "tasks/20260403-invalid-pipeline";
    const invalidPipelineContent = `## Task: Broken pipeline

- **Runtime:** pipeline
- **Submitted by:** Codex

### Pipeline
Phase: Explore
  Prompt: |
    Gather notes.`;
    const parentEntry = client.seed({
      namespace: taskNs,
      key: "status",
      content: invalidPipelineContent,
      tags: ["running", "runtime:pipeline", "type:research"],
    });

    await handlePipelineTask(client, hooks, taskNs, parentEntry, 1);

    expect(client.get(taskNs, "spec")).toBeNull();
    expect(client.listByNamespace(`${taskNs}-`)).toHaveLength(0);

    const parentStatus = client.get(taskNs, "status");
    expect(parentStatus?.tags).toEqual([
      "failed",
      "runtime:pipeline",
      "type:research",
    ]);

    const parentResult = client.get(taskNs, "result");
    expect(parentResult?.content).toContain(
      'Pipeline compile failed: Phase "Explore" is missing a Runtime field'
    );
    expect(refreshedPipelineIds).toEqual([]);
    expect(promotedTaskIds).toEqual(["20260403-invalid-pipeline"]);
    expect(client.logs).toContainEqual({
      namespace: taskNs,
      content:
        'Pipeline compile failed: Phase "Explore" is missing a Runtime field',
      tags: [],
    });
  });

  it("fails closed when a child task namespace already exists before decomposition", async () => {
    const client = new FakePipelineDispatchClient();
    const { hooks, promotedTaskIds, refreshedPipelineIds } = createPipelineHooks(client);
    const taskNs = "tasks/20260403-collision-pipeline";
    const parentEntry = client.seed({
      namespace: taskNs,
      key: "status",
      content: makeValidPipelineContent(),
      tags: ["running", "runtime:pipeline", "type:research"],
    });
    const compiled = compilePipelineTask(
      "20260403-collision-pipeline",
      taskNs,
      parentEntry.content
    );
    client.seed({
      namespace: compiled.phases[0]!.taskNamespace,
      key: "status",
      content: "existing child",
      tags: ["pending", "runtime:claude"],
    });

    await handlePipelineTask(client, hooks, taskNs, parentEntry, 2);

    expect(client.get(taskNs, "spec")).toBeNull();
    expect(client.get(compiled.phases[1]!.taskNamespace, "status")).toBeNull();

    const parentStatus = client.get(taskNs, "status");
    expect(parentStatus?.tags).toEqual([
      "failed",
      "runtime:pipeline",
      "type:research",
    ]);

    const parentResult = client.get(taskNs, "result");
    expect(parentResult?.content).toContain(
      `Pipeline decomposition failed: Child task namespace already exists: ${compiled.phases[0]!.taskNamespace}`
    );
    expect(refreshedPipelineIds).toEqual([]);
    expect(promotedTaskIds).toEqual(["20260403-collision-pipeline"]);
    expect(client.logs).toContainEqual({
      namespace: taskNs,
      content: `Pipeline decomposition failed: Child task namespace already exists: ${compiled.phases[0]!.taskNamespace}`,
      tags: [],
    });
  });

  it("cancels already-created children if decomposition fails mid-write", async () => {
    const client = new FakePipelineDispatchClient();
    const { hooks, promotedTaskIds, refreshedPipelineIds } = createPipelineHooks(client);
    const taskNs = "tasks/20260403-partial-write-pipeline";
    const parentEntry = client.seed({
      namespace: taskNs,
      key: "status",
      content: makeValidPipelineContent(),
      tags: ["running", "runtime:pipeline", "type:research"],
    });
    const compiled = compilePipelineTask(
      "20260403-partial-write-pipeline",
      taskNs,
      parentEntry.content
    );
    client.failNextWrite(
      compiled.phases[1]!.taskNamespace,
      "status",
      "simulated child write failure"
    );

    await handlePipelineTask(client, hooks, taskNs, parentEntry, 3);

    const rolledBackChild = client.get(compiled.phases[0]!.taskNamespace, "status");
    expect(rolledBackChild?.tags).toEqual([
      "cancelled",
      "runtime:claude",
      "type:pipeline",
      "type:pipeline-phase",
      "authority:autonomous",
      "sensitivity:internal",
    ]);
    expect(
      client.get(compiled.phases[0]!.taskNamespace, "result")?.content
    ).toContain("Pipeline decomposition aborted before parent commit");
    expect(client.get(compiled.phases[1]!.taskNamespace, "status")).toBeNull();

    const parentStatus = client.get(taskNs, "status");
    expect(parentStatus?.tags).toEqual([
      "failed",
      "runtime:pipeline",
      "type:research",
    ]);
    expect(client.get(taskNs, "result")?.content).toContain(
      "Pipeline decomposition failed: simulated child write failure"
    );
    expect(refreshedPipelineIds).toEqual([]);
    expect(promotedTaskIds).toEqual(["20260403-partial-write-pipeline"]);
  });
});
