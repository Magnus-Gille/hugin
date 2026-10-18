import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSensitivityCheckpoint } from "../src/sensitivity-checkpoint.js";
import type { TaskExecutionSensitivity } from "../src/task-result-schema.js";

interface TestEntry {
  id: string;
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

const CHECKPOINT_SECRET = "test-only-hugin-checkpoint-secret";
const testRoots: string[] = [];

describe("pipeline child sensitivity at dispatcher admission", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const testRoot of testRoots.splice(0)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  async function dispatchChild(options: {
    context: string;
    sensitivity: TaskExecutionSensitivity;
    prompt?: string;
    redirectManagedRepoToFilesAfterCheckout?: boolean;
    redirectFilesRootToRepoAfterCheckout?: boolean;
  }) {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-pipeline-sensitivity-"));
    testRoots.push(testRoot);
    const home = path.join(testRoot, "home");
    const reposRoot = path.join(testRoot, "repos");
    const workspace = path.join(testRoot, "workspace");
    const scratch = path.join(testRoot, "scratch");
    const files = path.join(testRoot, "files");
    for (const directory of [path.join(home, ".hugin", "logs"), reposRoot, workspace, scratch, files]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const safeRepo = path.join(reposRoot, "safe-repo");
    fs.mkdirSync(safeRepo, { recursive: true });
    const filesAlias = path.join(reposRoot, "files-alias");
    fs.symlinkSync(files, filesAlias, "dir");

    vi.stubEnv("HOME", home);
    vi.stubEnv("MUNIN_API_KEY", "test-only-munin-key");
    vi.stubEnv("MUNIN_URL", "http://munin.test");
    vi.stubEnv("HUGIN_ALLOWED_SUBMITTERS", "hugin");
    vi.stubEnv("HUGIN_SIGNING_POLICY", "off");
    vi.stubEnv("HUGIN_SCHEDULER_SHADOW", "off");
    vi.stubEnv("HUGIN_VERSION_DRIFT_CHECK", "off");
    vi.stubEnv("HUGIN_CLAUDE_AUTH_PREFLIGHT", "off");
    vi.stubEnv("HUGIN_CODE_HEALTH_CAPTURE", "off");
    vi.stubEnv("HUGIN_DELIVERY_POLICY", "off");
    vi.stubEnv("HUGIN_SENSITIVITY_CHECKPOINT_SECRET", CHECKPOINT_SECRET);
    vi.stubEnv("HUGIN_REPOS_ROOT", reposRoot);
    vi.stubEnv("HUGIN_WORKSPACE", workspace);
    vi.stubEnv("HUGIN_SCRATCH", scratch);
    vi.stubEnv("HUGIN_FILES", files);

    const taskNs = `tasks/pipeline-sensitivity-${options.context.replaceAll(/[^a-z0-9]+/gi, "-")}`;
    const taskContent = `## Task: Pipeline sensitivity check

- **Runtime:** claude
- **Context:** ${options.context}
- **Timeout:** 60000
- **Capabilities:** code
- **Permission profile:** trusted-code
- **Submitted by:** hugin
- **Submitted at:** 2026-08-01T10:00:00.000Z
- **Pipeline:** pipeline-sensitivity-check
- **Pipeline phase:** inspect
- **Pipeline submitted by:** ratatoskr
- **Sensitivity:** internal
- **Pipeline sensitivity:** internal
- **Pipeline authority:** autonomous

### Prompt
${options.prompt ?? "Review the example."}`;
    const now = "2026-08-01T10:00:00.000Z";
    const entries = new Map<string, TestEntry>();
    entries.set(`${taskNs}/status`, {
      id: `${taskNs}/status`,
      namespace: taskNs,
      key: "status",
      content: taskContent,
      tags: [
        "pending",
        "runtime:claude",
        "type:pipeline",
        "type:pipeline-phase",
        "sensitivity:internal",
      ],
      classification: "internal",
      created_at: now,
      updated_at: now,
    });
    entries.set(`${taskNs}/sensitivity-checkpoint`, {
      id: `${taskNs}/sensitivity-checkpoint`,
      namespace: taskNs,
      key: "sensitivity-checkpoint",
      content: buildSensitivityCheckpoint(taskNs, taskContent, options.sensitivity, CHECKPOINT_SECRET),
      tags: ["type:task-sensitivity-checkpoint"],
      classification: "internal",
      created_at: now,
      updated_at: now,
    });

    const prepareManagedCheckoutMock = vi.fn().mockImplementation(async () => {
      if (options.redirectManagedRepoToFilesAfterCheckout) {
        fs.rmdirSync(safeRepo);
        fs.symlinkSync(files, safeRepo, "dir");
      }
      if (options.redirectFilesRootToRepoAfterCheckout) {
        fs.rmdirSync(files);
        fs.symlinkSync(safeRepo, files, "dir");
      }
      return { branch: { action: "skipped" } };
    });
    const executorWorkingDirs: string[] = [];
    const executeSdkTaskMock = vi.fn(async (config: { workingDir: string }) => {
      executorWorkingDirs.push(config.workingDir);
      return {
        exitCode: 0 as const,
        output: "test execution completed",
        logFile: path.join(home, ".hugin", "logs", "pipeline-sensitivity.log"),
        resultText: "test execution completed",
        costUsd: 0,
        numTurns: 1,
        durationApiMs: 1,
      };
    });
    let writeCounter = 0;

    class FakeMuninClient {
      constructor(_config: unknown) {}

      async query(_args: unknown) {
        return { results: [], total: 0 };
      }

      async read(namespace: string, key: string) {
        return entries.get(`${namespace}/${key}`) ?? null;
      }

      async readBatch(requests: Array<{ namespace: string; key: string }>) {
        return requests.map(({ namespace, key }) => entries.get(`${namespace}/${key}`) ?? null);
      }

      async write(
        namespace: string,
        key: string,
        content: string,
        tags?: string[],
        _expectedUpdatedAt?: string,
        classification?: string,
      ) {
        const current = entries.get(`${namespace}/${key}`);
        const updatedAt = new Date(Date.parse(now) + ++writeCounter).toISOString();
        const next: TestEntry = {
          id: current?.id ?? `${namespace}/${key}`,
          namespace,
          key,
          content,
          tags: tags ?? current?.tags ?? [],
          classification: classification ?? current?.classification,
          created_at: current?.created_at ?? now,
          updated_at: updatedAt,
        };
        entries.set(`${namespace}/${key}`, next);
        return { updated_at: updatedAt, status: current ? "updated" : "created" };
      }

      async log(_namespace: string, _message: string) {}
      async health() { return true; }
      setSessionId(_sessionId: string) {}
      getSessionId() { return "session-test"; }
    }

    vi.doMock("../src/munin-client.js", async () => {
      const actual = await vi.importActual<typeof import("../src/munin-client.js")>("../src/munin-client.js");
      return { ...actual, MuninClient: FakeMuninClient };
    });
    vi.doMock("../src/munin-pagination.js", () => ({
      queryAllMuninEntries: vi.fn(async (_client: unknown, query: { tags?: string[] }) => {
        const status = entries.get(`${taskNs}/status`);
        if (query.tags?.includes("pending") && status) {
          return {
            results: [{
              id: status.id,
              namespace: taskNs,
              key: "status",
              entry_type: "state",
              content_preview: status.content,
              tags: [...status.tags],
              classification: status.classification,
              created_at: status.created_at,
              updated_at: status.updated_at,
            }],
            truncated: false,
            budgetExhausted: false,
          };
        }
        return { results: [], truncated: false, budgetExhausted: false };
      }),
    }));
    vi.doMock("../src/task-helpers.js", async () => {
      const actual = await vi.importActual<typeof import("../src/task-helpers.js")>("../src/task-helpers.js");
      return { ...actual, prepareManagedCheckout: prepareManagedCheckoutMock };
    });
    vi.doMock("../src/sdk-executor.js", async () => {
      const actual = await vi.importActual<typeof import("../src/sdk-executor.js")>("../src/sdk-executor.js");
      return { ...actual, executeSdkTask: executeSdkTaskMock };
    });

    const { __test__ } = await import("../src/index.js");
    __test__.resetState();
    const result = await __test__.pollOnce();
    return { result, entries, taskNs, safeRepo, files, prepareManagedCheckoutMock, executeSdkTaskMock, executorWorkingDirs };
  }

  it("blocks a cloud pipeline child when a repo alias canonically resolves into the files root", async () => {
    const snapshot: TaskExecutionSensitivity = {
      declared: "internal",
      effective: "internal",
      mismatch: true,
      detectorMax: "private",
      reasons: ["declared:internal", "prompt:private", "owner-override:internal<private"],
      override: { applied: true, detectorMax: "private" },
    };
    const dispatch = await dispatchChild({ context: "repo:files-alias", sensitivity: snapshot });

    expect(dispatch.result.hadTask).toBe(true);
    expect(dispatch.prepareManagedCheckoutMock.mock.calls.length).toBe(0);
    expect(dispatch.executeSdkTaskMock.mock.calls.length).toBe(0);
    const status = dispatch.entries.get(`${dispatch.taskNs}/status`);
    expect(status?.tags).toContain("failed");
    expect(status?.classification).toBe("client-confidential");
    expect(dispatch.entries.get(`${dispatch.taskNs}/result`)?.content).toContain("private-sensitivity");
  });

  it("honors only an authenticated soft-signal override on a separate managed repository", async () => {
    const snapshot: TaskExecutionSensitivity = {
      declared: "internal",
      effective: "internal",
      mismatch: true,
      detectorMax: "private",
      reasons: ["declared:internal", "prompt:private", "owner-override:internal<private"],
      override: { applied: true, detectorMax: "private" },
    };
    const dispatch = await dispatchChild({
      context: "repo:safe-repo",
      sensitivity: snapshot,
      prompt: "Review the invoice example.",
    });

    expect(dispatch.prepareManagedCheckoutMock.mock.calls.length).toBe(1);
    expect(dispatch.executeSdkTaskMock.mock.calls.length).toBe(1);
    expect(dispatch.executorWorkingDirs).toEqual([dispatch.safeRepo]);
    expect(dispatch.entries.get(`${dispatch.taskNs}/status`)?.tags).toContain("completed");
  });

  it("rechecks sensitivity when the canonical workspace changes after checkout", async () => {
    const snapshot: TaskExecutionSensitivity = {
      declared: "internal",
      effective: "internal",
      mismatch: false,
    };
    const dispatch = await dispatchChild({
      context: "repo:safe-repo",
      sensitivity: snapshot,
      redirectManagedRepoToFilesAfterCheckout: true,
    });

    expect(dispatch.prepareManagedCheckoutMock.mock.calls.length).toBe(1);
    expect(dispatch.executeSdkTaskMock.mock.calls.length).toBe(0);
    const status = dispatch.entries.get(`${dispatch.taskNs}/status`);
    expect(status?.tags).toContain("failed");
    expect(status?.classification).toBe("client-confidential");
    expect(dispatch.entries.get(`${dispatch.taskNs}/result`)?.content).toContain("private-sensitivity");
  });

  it("rechecks sensitivity when configured roots change but the canonical cwd stays the same", async () => {
    const snapshot: TaskExecutionSensitivity = {
      declared: "internal",
      effective: "internal",
      mismatch: false,
    };
    const dispatch = await dispatchChild({
      context: "repo:safe-repo",
      sensitivity: snapshot,
      redirectFilesRootToRepoAfterCheckout: true,
    });

    expect(dispatch.prepareManagedCheckoutMock.mock.calls.length).toBe(1);
    expect(dispatch.executeSdkTaskMock.mock.calls.length).toBe(0);
    const status = dispatch.entries.get(`${dispatch.taskNs}/status`);
    expect(status?.tags).toContain("failed");
    expect(status?.classification).toBe("client-confidential");
    expect(dispatch.entries.get(`${dispatch.taskNs}/result`)?.content).toContain("private-sensitivity");
  });
});
