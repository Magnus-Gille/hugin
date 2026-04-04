import { describe, expect, it } from "vitest";
import {
  processPipelineCancellationRequest,
  processPipelineResumeRequest,
  type CancellationRequest,
  type MarkTaskCancelledOptions,
  type PipelineControlClient,
  type PipelineControlHooks,
} from "../src/pipeline-control.js";
import {
  buildPhaseTaskDrafts,
  compilePipelineTask,
} from "../src/pipeline-compiler.js";
import { buildTerminalStatusTags } from "../src/task-status-tags.js";
import type {
  MuninEntry,
  MuninReadRequest,
  MuninReadResult,
} from "../src/munin-client.js";

type StoredEntry = MuninEntry & { found: true };

class FakeControlClient implements PipelineControlClient {
  private entries = new Map<string, StoredEntry>();
  private tick = 0;

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
    return entry;
  }

  async log(namespace: string, content: string, tags: string[] = []): Promise<void> {
    this.logs.push({ namespace, content, tags });
  }

  private nextTimestamp(): string {
    const timestamp = new Date(Date.UTC(2026, 3, 3, 18, 45, this.tick)).toISOString();
    this.tick += 1;
    return timestamp;
  }

  private entryKey(namespace: string, key: string): string {
    return `${namespace}::${key}`;
  }
}

function removeTag(tags: string[], tagToRemove: string): string[] {
  return tags.filter((tag) => tag !== tagToRemove);
}

function makePipelineContent(): string {
  return `## Task: Control pipeline

- **Runtime:** pipeline
- **Submitted by:** Codex
- **Submitted at:** 2026-04-03T18:40:00Z
- **Reply-format:** summary
- **Sensitivity:** internal

### Pipeline
Phase: Gather
  Runtime: claude-sdk
  Prompt: |
    Gather.

Phase: Report
  Depends-on: Gather
  Runtime: claude-sdk
  Prompt: |
    Report.`;
}

function createHooks(client: FakeControlClient): {
  hooks: PipelineControlHooks;
  refreshedPipelineIds: string[];
  clearedCancellation: string[];
  clearedResume: string[];
  cancellationRequests: CancellationRequest[];
} {
  const refreshedPipelineIds: string[] = [];
  const clearedCancellation: string[] = [];
  const clearedResume: string[] = [];
  const cancellationRequests: CancellationRequest[] = [];

  return {
    hooks: {
      async clearCancellationRequest(taskNs, entry, logMessage) {
        clearedCancellation.push(taskNs);
        await client.write(
          taskNs,
          "status",
          entry.content,
          removeTag(entry.tags, "cancel-requested"),
          entry.updated_at
        );
        if (logMessage) await client.log(taskNs, logMessage);
      },
      async clearResumeRequest(taskNs, entry, logMessage) {
        clearedResume.push(taskNs);
        await client.write(
          taskNs,
          "status",
          entry.content,
          removeTag(entry.tags, "resume-requested"),
          entry.updated_at
        );
        if (logMessage) await client.log(taskNs, logMessage);
      },
      async markTaskCancelled(
        taskNs,
        entry,
        reason,
        _options: MarkTaskCancelledOptions
      ) {
        await client.write(
          taskNs,
          "result",
          `## Result\n\n- **Exit code:** CANCELLED\n- **Error:** ${reason}\n`
        );
        await client.write(
          taskNs,
          "status",
          entry.content,
          buildTerminalStatusTags("cancelled", entry.tags),
          entry.updated_at
        );
        await client.log(taskNs, `Task cancelled: ${reason}`);
      },
      requestCancellationForCurrentTask(request) {
        cancellationRequests.push(request);
      },
      async refreshPipelineSummary(pipelineId) {
        refreshedPipelineIds.push(pipelineId);
      },
    },
    refreshedPipelineIds,
    clearedCancellation,
    clearedResume,
    cancellationRequests,
  };
}

describe("pipeline control handlers", () => {
  it("cancels a pipeline parent before decomposition if no spec exists", async () => {
    const client = new FakeControlClient();
    const { hooks, refreshedPipelineIds } = createHooks(client);
    const taskNs = "tasks/20260403-cancel-pre-decompose";
    const entry = client.seed({
      namespace: taskNs,
      key: "status",
      content: makePipelineContent(),
      tags: ["completed", "runtime:pipeline", "type:pipeline", "cancel-requested"],
    });

    const processed = await processPipelineCancellationRequest(
      client,
      hooks,
      entry,
      null
    );

    expect(processed).toBe(true);
    expect(client.get(taskNs, "status")?.tags).toEqual([
      "cancelled",
      "runtime:pipeline",
      "type:pipeline",
    ]);
    expect(client.get(taskNs, "result")?.content).toContain(
      "- **Pipeline action:** cancelled"
    );
    expect(refreshedPipelineIds).toEqual([]);
  });

  it("requests current-task cancellation for a running phase and cancels blocked siblings", async () => {
    const client = new FakeControlClient();
    const { hooks, refreshedPipelineIds, cancellationRequests } = createHooks(client);
    const taskNs = "tasks/20260403-cancel-running";
    const entry = client.seed({
      namespace: taskNs,
      key: "status",
      content: makePipelineContent(),
      tags: ["completed", "runtime:pipeline", "type:pipeline", "cancel-requested"],
    });
    const pipeline = compilePipelineTask("20260403-cancel-running", taskNs, entry.content);
    const drafts = buildPhaseTaskDrafts(pipeline);
    client.seed({
      namespace: taskNs,
      key: "spec",
      content: JSON.stringify(pipeline, null, 2),
      tags: ["type:pipeline", "type:pipeline-spec"],
    });
    client.seed({
      namespace: drafts[0]!.namespace,
      key: "status",
      content: drafts[0]!.content,
      tags: ["running", "runtime:claude", "type:pipeline", "type:pipeline-phase", "authority:autonomous"],
    });
    client.seed({
      namespace: drafts[1]!.namespace,
      key: "status",
      content: drafts[1]!.content,
      tags: ["blocked", "runtime:claude", "type:pipeline", "type:pipeline-phase", "authority:autonomous", "depends-on:20260403-cancel-running-gather"],
    });

    const processed = await processPipelineCancellationRequest(
      client,
      hooks,
      entry,
      drafts[0]!.namespace
    );

    expect(processed).toBe(true);
    expect(cancellationRequests).toEqual([
      {
        reason: "Pipeline 20260403-cancel-running cancelled by operator",
        sourceNamespace: taskNs,
        pipelineId: "20260403-cancel-running",
      },
    ]);
    expect(client.get(drafts[1]!.namespace, "status")?.tags).toEqual([
      "cancelled",
      "runtime:claude",
      "type:pipeline",
      "type:pipeline-phase",
      "authority:autonomous",
    ]);
    expect(client.get(taskNs, "status")?.tags).toContain("cancel-requested");
    expect(refreshedPipelineIds).toEqual(["20260403-cancel-running"]);
  });

  it("finalizes pipeline cancellation once all remaining phases are terminal", async () => {
    const client = new FakeControlClient();
    const { hooks, refreshedPipelineIds } = createHooks(client);
    const taskNs = "tasks/20260403-cancel-finalize";
    const entry = client.seed({
      namespace: taskNs,
      key: "status",
      content: makePipelineContent(),
      tags: ["completed", "runtime:pipeline", "type:pipeline", "cancel-requested"],
    });
    const pipeline = compilePipelineTask("20260403-cancel-finalize", taskNs, entry.content);
    const drafts = buildPhaseTaskDrafts(pipeline);
    client.seed({
      namespace: taskNs,
      key: "spec",
      content: JSON.stringify(pipeline, null, 2),
      tags: ["type:pipeline", "type:pipeline-spec"],
    });
    client.seed({
      namespace: drafts[0]!.namespace,
      key: "status",
      content: drafts[0]!.content,
      tags: ["completed", "runtime:claude", "type:pipeline", "type:pipeline-phase", "authority:autonomous"],
    });
    client.seed({
      namespace: drafts[1]!.namespace,
      key: "status",
      content: drafts[1]!.content,
      tags: ["blocked", "runtime:claude", "type:pipeline", "type:pipeline-phase", "authority:autonomous", "depends-on:20260403-cancel-finalize-gather"],
    });

    const processed = await processPipelineCancellationRequest(
      client,
      hooks,
      entry,
      null
    );

    expect(processed).toBe(true);
    expect(client.get(drafts[1]!.namespace, "status")?.tags).toEqual([
      "cancelled",
      "runtime:claude",
      "type:pipeline",
      "type:pipeline-phase",
      "authority:autonomous",
    ]);
    expect(client.get(taskNs, "status")?.tags).toEqual([
      "cancelled",
      "runtime:pipeline",
      "type:pipeline",
    ]);
    expect(client.get(taskNs, "result")?.content).toContain(
      "- **Pipeline action:** cancelled"
    );
    expect(refreshedPipelineIds).toEqual([
      "20260403-cancel-finalize",
      "20260403-cancel-finalize",
    ]);
  });

  it("resumes cancelled tail phases while keeping completed head phases", async () => {
    const client = new FakeControlClient();
    const { hooks, refreshedPipelineIds, clearedResume } = createHooks(client);
    const taskNs = "tasks/20260403-resume-tail";
    const entry = client.seed({
      namespace: taskNs,
      key: "status",
      content: makePipelineContent(),
      tags: ["cancelled", "runtime:pipeline", "type:pipeline", "resume-requested"],
    });
    const pipeline = compilePipelineTask("20260403-resume-tail", taskNs, entry.content);
    const drafts = buildPhaseTaskDrafts(pipeline);
    client.seed({
      namespace: taskNs,
      key: "spec",
      content: JSON.stringify(pipeline, null, 2),
      tags: ["type:pipeline", "type:pipeline-spec"],
    });
    client.seed({
      namespace: drafts[0]!.namespace,
      key: "status",
      content: drafts[0]!.content,
      tags: ["completed", "runtime:claude", "type:pipeline", "type:pipeline-phase", "authority:autonomous"],
    });
    client.seed({
      namespace: drafts[1]!.namespace,
      key: "status",
      content: drafts[1]!.content,
      tags: ["cancelled", "runtime:claude", "type:pipeline", "type:pipeline-phase", "authority:autonomous", "depends-on:20260403-resume-tail-gather"],
    });

    const processed = await processPipelineResumeRequest(client, hooks, entry);

    expect(processed).toBe(true);
    expect(client.get(drafts[1]!.namespace, "status")?.tags).toEqual([
      "runtime:claude",
      "type:pipeline",
      "type:pipeline-phase",
      "authority:autonomous",
      "pending",
    ]);
    expect(client.get(drafts[1]!.namespace, "result")?.content).toContain(
      "- **Pipeline action:** resumed"
    );
    expect(client.get(taskNs, "status")?.tags).toEqual([
      "completed",
      "runtime:pipeline",
      "type:pipeline",
    ]);
    expect(client.get(taskNs, "result")?.content).toContain(
      "- **Completed phases kept:** 1"
    );
    expect(refreshedPipelineIds).toEqual(["20260403-resume-tail"]);
    expect(clearedResume).toEqual([]);
  });

  it("finalizes parent resume after a partial update already reactivated phases", async () => {
    const client = new FakeControlClient();
    const { hooks, refreshedPipelineIds, clearedResume } = createHooks(client);
    const taskNs = "tasks/20260403-resume-partial";
    const entry = client.seed({
      namespace: taskNs,
      key: "status",
      content: makePipelineContent(),
      tags: ["failed", "runtime:pipeline", "type:pipeline", "resume-requested"],
    });
    const pipeline = compilePipelineTask("20260403-resume-partial", taskNs, entry.content);
    const drafts = buildPhaseTaskDrafts(pipeline);
    client.seed({
      namespace: taskNs,
      key: "spec",
      content: JSON.stringify(pipeline, null, 2),
      tags: ["type:pipeline", "type:pipeline-spec"],
    });
    client.seed({
      namespace: drafts[0]!.namespace,
      key: "status",
      content: drafts[0]!.content,
      tags: ["completed", "runtime:claude", "type:pipeline", "type:pipeline-phase", "authority:autonomous"],
    });
    client.seed({
      namespace: drafts[1]!.namespace,
      key: "status",
      content: drafts[1]!.content,
      tags: ["pending", "runtime:claude", "type:pipeline", "type:pipeline-phase", "authority:autonomous", "depends-on:20260403-resume-partial-gather"],
    });

    const processed = await processPipelineResumeRequest(client, hooks, entry);

    expect(processed).toBe(true);
    expect(client.get(taskNs, "status")?.tags).toEqual([
      "completed",
      "runtime:pipeline",
      "type:pipeline",
    ]);
    expect(client.get(taskNs, "result")?.content).toContain(
      "- **Resumed phases:** 1"
    );
    expect(refreshedPipelineIds).toEqual(["20260403-resume-partial"]);
    expect(clearedResume).toEqual([]);
  });
});
