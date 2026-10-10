import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pipelineIRSchema } from "../src/pipeline-ir.js";

interface RecoveryEntry {
  id: string;
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

describe("code-health delivery reconciliation recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("preserves completed execution and runs terminal follow-up when recovery delivery is unavailable", async () => {
    vi.stubEnv("MUNIN_API_KEY", "synthetic-test-key");
    vi.stubEnv("MUNIN_URL", "http://munin.invalid");
    vi.stubEnv("HUGIN_DELIVERY_POLICY", "off");
    vi.stubEnv("HUGIN_CODE_HEALTH_CAPTURE", "on");
    vi.stubEnv("HUGIN_SIGNING_POLICY", "off");
    vi.stubEnv("HUGIN_SENSITIVITY_CHECKPOINT_SECRET", "synthetic-test-secret-1234567890");

    const taskId = "delivery-recovery-code-health";
    const taskNs = `tasks/${taskId}`;
    const attemptId = "123e4567-e89b-42d3-a456-426614174000";
    const now = "2026-10-10T12:30:00.000Z";
    const taskContent = `## Task: Recovered code task

- **Runtime:** claude
- **Context:** repo:sagascript
- **Working dir:** /tmp/recovered-code-task
- **Timeout:** 60000
- **Capabilities:** code
- **Permission profile:** trusted-code
- **Submitted by:** hugin
- **Submitted at:** 2026-10-10T12:00:00Z
- **Pipeline:** pipeline-recovery
- **Pipeline phase:** execute
- **Pipeline submitted by:** hugin
- **Pipeline sensitivity:** internal
- **Pipeline authority:** autonomous

### Prompt
Synthetic task fixture.`;
    const statusEntry: RecoveryEntry = {
      id: `${taskNs}/status`,
      namespace: taskNs,
      key: "status",
      content: taskContent,
      tags: [
        "running",
        "runtime:claude",
        "delivery:pending",
        `code-health-attempt:${attemptId}`,
      ],
      classification: "internal",
      created_at: now,
      updated_at: now,
    };
    const dependentNs = "tasks/downstream-phase";
    const dependentEntry: RecoveryEntry = {
      id: `${dependentNs}/status`,
      namespace: dependentNs,
      key: "status",
      content: `## Task: Continue after dependency failure

- **Runtime:** claude
- **Submitted by:** hugin
- **Pipeline:** pipeline-recovery
- **Pipeline phase:** downstream

### Prompt
Synthetic dependent fixture.`,
      tags: [
        "blocked",
        `depends-on:${taskId}`,
        "on-dep-failure:continue",
        "runtime:claude",
      ],
      classification: "internal",
      created_at: now,
      updated_at: now,
    };
    const pipelineSpec = pipelineIRSchema.parse({
      schemaVersion: 1,
      id: "pipeline-recovery",
      title: "Synthetic recovery pipeline",
      sourceTaskNamespace: "tasks/pipeline-recovery",
      sensitivity: "internal",
      submittedBy: "hugin",
      submittedAt: now,
      phases: [{
        name: "execute",
        slug: "execute",
        taskId,
        taskNamespace: taskNs,
        runtime: "claude-sdk",
        dispatcherRuntime: "claude",
        dependsOn: [],
        dependencyTaskIds: [],
        onDependencyFailure: "fail",
        prompt: "Synthetic task fixture.",
        authority: "autonomous",
        sideEffects: [],
        effectiveSensitivity: "internal",
      }],
    });
    const entries = new Map<string, RecoveryEntry>([
      [`${taskNs}/status`, statusEntry],
      [`${taskNs}/result`, {
        ...statusEntry,
        id: `${taskNs}/result`,
        key: "result",
        content: "## Result\n\n- **Exit code:** 0\n",
      }],
      [`${dependentNs}/status`, dependentEntry],
      ["tasks/pipeline-recovery/spec", {
        id: "tasks/pipeline-recovery/spec",
        namespace: "tasks/pipeline-recovery",
        key: "spec",
        content: JSON.stringify(pipelineSpec),
        tags: [],
        created_at: now,
        updated_at: now,
      }],
    ]);
    const writes: Array<{ namespace: string; key: string; content: string; tags?: string[] }> = [];
    const logs: string[] = [];
    const reads: Array<{ namespace: string; key: string }> = [];
    let writeCounter = 0;

    class FakeMuninClient {
      async read(namespace: string, key: string) {
        reads.push({ namespace, key });
        return entries.get(`${namespace}/${key}`) ?? null;
      }

      async readBatch(requests: Array<{ namespace: string; key: string }>) {
        return requests.map(({ namespace, key }) => {
          const entry = entries.get(`${namespace}/${key}`);
          return entry ? { ...entry, found: true as const } : { namespace, key, found: false as const };
        });
      }

      async write(
        namespace: string,
        key: string,
        content: string,
        tags?: string[],
        _expectedUpdatedAt?: string,
        classification?: string,
      ) {
        writes.push({ namespace, key, content, tags });
        const previous = entries.get(`${namespace}/${key}`);
        const updated_at = new Date(Date.parse(now) + ++writeCounter).toISOString();
        entries.set(`${namespace}/${key}`, {
          id: previous?.id ?? `${namespace}/${key}`,
          namespace,
          key,
          content,
          tags: tags ?? previous?.tags ?? [],
          classification: classification ?? previous?.classification,
          created_at: previous?.created_at ?? now,
          updated_at,
        });
        return { updated_at, status: previous ? "updated" : "created" };
      }

      async log(_namespace: string, message: string) {
        logs.push(message);
      }
    }

    vi.doMock("../src/munin-pagination.js", () => ({
      queryAllMuninEntries: vi.fn(async () => ({
        results: [{
          id: dependentEntry.id,
          namespace: dependentNs,
          key: "status",
          entry_type: "state",
          content_preview: "",
          tags: dependentEntry.tags,
          classification: dependentEntry.classification,
          created_at: dependentEntry.created_at,
          updated_at: dependentEntry.updated_at,
        }],
        truncated: false,
        budgetExhausted: false,
      })),
    }));

    const { __test__ } = await import("../src/index.js");
    await expect(__test__.reconcileDeliveryPending(taskNs, statusEntry, new FakeMuninClient() as never))
      .resolves.toBeUndefined();

    const structuredWrite = writes.find((write) => write.namespace === taskNs && write.key === "result-structured");
    expect(structuredWrite).toBeDefined();
    const structured = JSON.parse(structuredWrite!.content) as {
      lifecycle: string;
      outcome: string;
      resultSource: string;
      executor: string;
      exitCode: number;
      codeHealth?: { executionFact?: string; identity?: { kind?: string; attemptId?: string } };
      artifactDelivery?: { ok?: boolean };
    };
    expect(structured).toMatchObject({
      lifecycle: "failed",
      outcome: "failed",
      resultSource: "delivery-reconciliation",
      executor: "dispatcher",
      exitCode: 2,
      codeHealth: {
        executionFact: "completed",
        identity: { kind: "attempt", attemptId },
      },
      artifactDelivery: { ok: false },
    });

    expect(logs).toContain("Delivery reconciled: failed");
    expect(entries.get(`${dependentNs}/status`)?.tags).toContain("pending");
    expect(reads).toContainEqual({ namespace: "tasks/pipeline-recovery", key: "spec" });
    expect(writes).toContainEqual(expect.objectContaining({
      namespace: "tasks/pipeline-recovery",
      key: "summary",
    }));
  });
});
