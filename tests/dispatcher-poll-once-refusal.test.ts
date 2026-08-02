import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeEntry {
  id: string;
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

interface FakeWrite {
  namespace: string;
  key: string;
  content: string;
  tags?: string[];
  expectedUpdatedAt?: string;
  classification?: string;
}

describe("pollOnce — managed checkout refusal", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("short-circuits before model spend, classifies as infra failure, and persists checkout-gate friction", async () => {
    const fakeHome = path.join(process.cwd(), ".tmp-test-home");
    fs.mkdirSync(path.join(fakeHome, ".hugin"), { recursive: true });

    vi.stubEnv("MUNIN_API_KEY", "test-key");
    vi.stubEnv("MUNIN_URL", "http://munin.test");
    vi.stubEnv("HUGIN_ALLOWED_SUBMITTERS", "hugin");
    vi.stubEnv("HUGIN_SIGNING_POLICY", "off");
    vi.stubEnv("HUGIN_SCHEDULER_SHADOW", "off");
    vi.stubEnv("HUGIN_VERSION_DRIFT_CHECK", "off");
    vi.stubEnv("HUGIN_SENSITIVITY_CHECKPOINT_SECRET", "x".repeat(32));
    vi.stubEnv("HOME", fakeHome);

    const taskNs = "tasks/task-checkout-refusal";
    const createdAt = "2026-08-01T10:00:00.000Z";
    const entries = new Map<string, FakeEntry>();
    const writes: FakeWrite[] = [];
    const logs: Array<{ namespace: string; message: string }> = [];
    let writeCounter = 0;

    const taskContent = `## Task: Managed checkout refusal

- **Runtime:** claude
- **Working dir:** /home/magnus/repos/demo
- **Timeout:** 60000
- **Capabilities:** code
- **Permission profile:** trusted-code
- **Submitted by:** hugin

### Prompt
Edit the repository.`;

    const statusEntry: FakeEntry = {
      id: "status-0",
      namespace: taskNs,
      key: "status",
      content: taskContent,
      tags: ["pending", "runtime:claude"],
      classification: "internal",
      created_at: createdAt,
      updated_at: createdAt,
    };
    entries.set(`${taskNs}/status`, statusEntry);

    const prepareManagedCheckoutMock = vi.fn().mockResolvedValue({
      branch: {
        action: "created",
        branchName: "hugin/task-checkout-refusal",
        baseBranch: "main",
        baseCommit: "a".repeat(40),
      },
      refusalReason: "working tree has ignored leftover state",
    });
    const executeSdkTaskMock = vi.fn();

    class FakeMuninClient {
      private sessionId = "session-0";

      constructor(_config: unknown) {}

      async query(_args: unknown) {
        return { results: [], total: 0 };
      }

      async read(namespace: string, key: string) {
        return entries.get(`${namespace}/${key}`) ?? null;
      }

      async readBatch(
        requests: Array<{ namespace: string; key: string }>,
      ) {
        return requests.map(({ namespace, key }) => entries.get(`${namespace}/${key}`) ?? null);
      }

      async write(
        namespace: string,
        key: string,
        content: string,
        tags?: string[],
        expectedUpdatedAt?: string,
        classification?: string,
        _createOnly?: boolean,
      ) {
        writes.push({ namespace, key, content, tags, expectedUpdatedAt, classification });
        const existing = entries.get(`${namespace}/${key}`);
        const updatedAt = new Date(Date.parse(createdAt) + ++writeCounter).toISOString();
        const next: FakeEntry = {
          id: existing?.id ?? `${namespace}/${key}/${writeCounter}`,
          namespace,
          key,
          content,
          tags: tags ?? existing?.tags ?? [],
          classification: classification ?? existing?.classification,
          created_at: existing?.created_at ?? createdAt,
          updated_at: updatedAt,
        };
        entries.set(`${namespace}/${key}`, next);
        return { updated_at: updatedAt, status: existing ? "updated" : "created" };
      }

      async log(namespace: string, message: string) {
        logs.push({ namespace, message });
      }

      async health() {
        return true;
      }

      setSessionId(sessionId: string) {
        this.sessionId = sessionId;
      }

      getSessionId() {
        return this.sessionId;
      }
    }

    vi.doMock("../src/munin-client.js", async () => {
      const actual = await vi.importActual<typeof import("../src/munin-client.js")>(
        "../src/munin-client.js",
      );
      return {
        ...actual,
        MuninClient: FakeMuninClient,
      };
    });

    vi.doMock("../src/munin-pagination.js", () => ({
      queryAllMuninEntries: vi.fn(async (_munin: unknown, options: { tags?: string[] }) => {
        if (options.tags?.includes("pending")) {
          return {
            results: [
              {
                id: statusEntry.id,
                namespace: taskNs,
                key: "status",
                entry_type: "state",
                content_preview: "",
                tags: [...statusEntry.tags],
                classification: statusEntry.classification,
                created_at: statusEntry.created_at,
                updated_at: statusEntry.updated_at,
              },
            ],
            truncated: false,
            budgetExhausted: false,
          };
        }
        return { results: [], truncated: false, budgetExhausted: false };
      }),
    }));

    vi.doMock("../src/task-helpers.js", async () => {
      const actual = await vi.importActual<typeof import("../src/task-helpers.js")>(
        "../src/task-helpers.js",
      );
      return {
        ...actual,
        prepareManagedCheckout: prepareManagedCheckoutMock,
      };
    });

    vi.doMock("../src/sdk-executor.js", async () => {
      const actual = await vi.importActual<typeof import("../src/sdk-executor.js")>(
        "../src/sdk-executor.js",
      );
      return {
        ...actual,
        executeSdkTask: executeSdkTaskMock,
      };
    });

    const { __test__ } = await import("../src/index.js");
    __test__.resetState();

    const result = await __test__.pollOnce();

    expect(result).toEqual({ hadTask: true, queueDepth: 1 });
    expect(prepareManagedCheckoutMock).toHaveBeenCalledWith(
      "/home/magnus/repos/demo",
      "task-checkout-refusal",
      expect.objectContaining({
        reposRoot: "/home/magnus/repos",
        mutationCapable: true,
      }),
    );
    expect(executeSdkTaskMock).not.toHaveBeenCalled();

    const finalStatus = entries.get(`${taskNs}/status`);
    expect(finalStatus?.tags).toEqual(
      expect.arrayContaining(["failed", "failure:infra", "runtime:claude"]),
    );

    const resultEntry = entries.get(`${taskNs}/result`);
    expect(resultEntry?.content).toContain("- **Failure kind:** CHECKOUT_CONTAMINATED");
    expect(resultEntry?.content).toContain("working tree has ignored leftover state");

    const structuredEntry = entries.get(`${taskNs}/result-structured`);
    expect(structuredEntry).toBeDefined();
    const structured = JSON.parse(structuredEntry!.content) as {
      lifecycle: string;
      outcome: string;
      exitCode: number;
      errorMessage?: string;
      repositoryOutcome?: { state?: string };
    };
    expect(structured.lifecycle).toBe("failed");
    expect(structured.outcome).toBe("failed");
    expect(structured.exitCode).toBe(1);
    expect(structured.errorMessage).toBe("working tree has ignored leftover state");
    expect(structured.repositoryOutcome?.state).toBe("checkout-contaminated");

    const frictionWrite = writes.find((write) => write.namespace === "signals/friction");
    expect(frictionWrite).toBeDefined();
    expect(frictionWrite?.tags).toEqual(
      expect.arrayContaining([
        "friction:tool_failure",
        "failure-kind:CHECKOUT_CONTAMINATED",
        "source:hugin-preflight",
      ]),
    );
    const frictionContent = JSON.parse(frictionWrite!.content) as {
      reporter?: string;
      failure_kind?: string;
      detail?: string;
    };
    expect(frictionContent.reporter).toBe("hugin-preflight");
    expect(frictionContent.failure_kind).toBe("CHECKOUT_CONTAMINATED");
    expect(frictionContent.detail).toContain("ignored leftover state");

    expect(
      logs.some(
        (entry) =>
          entry.namespace === taskNs &&
          entry.message.includes("Task failed (CHECKOUT_CONTAMINATED)"),
      ),
    ).toBe(true);

    expect(__test__.inspectState()).toEqual({
      currentTask: null,
      currentTaskConfig: null,
      lastPendingQueueSnapshot: expect.objectContaining({ pendingCount: 0 }),
    });
  });

  it("classifies orchestrator pi-harness admission refusal as infra failure, persists friction, and marks the checkout contaminated", async () => {
    const fakeHome = path.join(process.cwd(), ".tmp-test-home");
    fs.mkdirSync(path.join(fakeHome, ".hugin", "logs"), { recursive: true });

    vi.stubEnv("MUNIN_API_KEY", "test-key");
    vi.stubEnv("MUNIN_URL", "http://munin.test");
    vi.stubEnv("HUGIN_ALLOWED_SUBMITTERS", "hugin");
    vi.stubEnv("HUGIN_SIGNING_POLICY", "off");
    vi.stubEnv("HUGIN_SCHEDULER_SHADOW", "off");
    vi.stubEnv("HUGIN_VERSION_DRIFT_CHECK", "off");
    vi.stubEnv("HUGIN_SENSITIVITY_CHECKPOINT_SECRET", "x".repeat(32));
    vi.stubEnv("HOME", fakeHome);

    const taskNs = "tasks/task-pi-harness-admission-refusal";
    const createdAt = "2026-08-01T10:00:00.000Z";
    const entries = new Map<string, FakeEntry>();
    const writes: FakeWrite[] = [];
    const logs: Array<{ namespace: string; message: string }> = [];
    let writeCounter = 0;

    const taskContent = `## Task: Orchestrator pi-harness admission refusal

- **Runtime:** orchestrator
- **Working dir:** /home/magnus/repos/demo
- **Timeout:** 60000
- **Capabilities:** code
- **Permission profile:** trusted-code
- **Submitted by:** hugin

### Prompt
Edit the repository.`;

    const statusEntry: FakeEntry = {
      id: "status-0",
      namespace: taskNs,
      key: "status",
      content: taskContent,
      tags: ["pending", "runtime:orchestrator"],
      classification: "internal",
      created_at: createdAt,
      updated_at: createdAt,
    };
    entries.set(`${taskNs}/status`, statusEntry);

    const prepareManagedCheckoutMock = vi.fn().mockResolvedValue({
      branch: {
        action: "created",
        branchName: "hugin/task-pi-harness-admission-refusal",
        baseBranch: "main",
        baseCommit: "a".repeat(40),
      },
      degraded: true,
      degradedReason: "read-only task proceeded against unverified working directory",
    });
    const runOrchestratorTaskMock = vi.fn();

    class FakeMuninClient {
      private sessionId = "session-0";

      constructor(_config: unknown) {}

      async query(_args: unknown) {
        return { results: [], total: 0 };
      }

      async read(namespace: string, key: string) {
        return entries.get(`${namespace}/${key}`) ?? null;
      }

      async readBatch(
        requests: Array<{ namespace: string; key: string }>,
      ) {
        return requests.map(({ namespace, key }) => entries.get(`${namespace}/${key}`) ?? null);
      }

      async write(
        namespace: string,
        key: string,
        content: string,
        tags?: string[],
        expectedUpdatedAt?: string,
        classification?: string,
        _createOnly?: boolean,
      ) {
        writes.push({ namespace, key, content, tags, expectedUpdatedAt, classification });
        const existing = entries.get(`${namespace}/${key}`);
        const updatedAt = new Date(Date.parse(createdAt) + ++writeCounter).toISOString();
        const next: FakeEntry = {
          id: existing?.id ?? `${namespace}/${key}/${writeCounter}`,
          namespace,
          key,
          content,
          tags: tags ?? existing?.tags ?? [],
          classification: classification ?? existing?.classification,
          created_at: existing?.created_at ?? createdAt,
          updated_at: updatedAt,
        };
        entries.set(`${namespace}/${key}`, next);
        return { updated_at: updatedAt, status: existing ? "updated" : "created" };
      }

      async log(namespace: string, message: string) {
        logs.push({ namespace, message });
      }

      async health() {
        return true;
      }

      setSessionId(sessionId: string) {
        this.sessionId = sessionId;
      }

      getSessionId() {
        return this.sessionId;
      }
    }

    vi.doMock("../src/munin-client.js", async () => {
      const actual = await vi.importActual<typeof import("../src/munin-client.js")>(
        "../src/munin-client.js",
      );
      return {
        ...actual,
        MuninClient: FakeMuninClient,
      };
    });

    vi.doMock("../src/munin-pagination.js", () => ({
      queryAllMuninEntries: vi.fn(async (_munin: unknown, options: { tags?: string[] }) => {
        if (options.tags?.includes("pending")) {
          return {
            results: [
              {
                id: statusEntry.id,
                namespace: taskNs,
                key: "status",
                entry_type: "state",
                content_preview: "",
                tags: [...statusEntry.tags],
                classification: statusEntry.classification,
                created_at: statusEntry.created_at,
                updated_at: statusEntry.updated_at,
              },
            ],
            truncated: false,
            budgetExhausted: false,
          };
        }
        return { results: [], truncated: false, budgetExhausted: false };
      }),
    }));

    vi.doMock("../src/task-helpers.js", async () => {
      const actual = await vi.importActual<typeof import("../src/task-helpers.js")>(
        "../src/task-helpers.js",
      );
      return {
        ...actual,
        prepareManagedCheckout: prepareManagedCheckoutMock,
      };
    });

    vi.doMock("../src/orchestrator/config.js", async () => {
      const actual = await vi.importActual<typeof import("../src/orchestrator/config.js")>(
        "../src/orchestrator/config.js",
      );
      return {
        ...actual,
        effectiveOrchestratorConfig: vi.fn(() => ({
          maxIterations: 1,
          maxConcurrency: 1,
          maxOutputChars: 4000,
          maxTokens: 4000,
          perCallTimeoutMs: 60_000,
          roles: {
            planner: { provider: "openrouter", model: "planner" },
            worker: { provider: "pi-harness", model: "worker-pi" },
            verifier: { provider: "openrouter", model: "verifier" },
            synthesizer: { provider: "openrouter", model: "synthesizer" },
          },
        })),
      };
    });

    vi.doMock("../src/orchestrator/orchestrator-executor.js", async () => {
      const actual =
        await vi.importActual<typeof import("../src/orchestrator/orchestrator-executor.js")>(
          "../src/orchestrator/orchestrator-executor.js",
        );
      return {
        ...actual,
        runOrchestratorTask: runOrchestratorTaskMock,
      };
    });

    const { __test__ } = await import("../src/index.js");
    __test__.resetState();

    const result = await __test__.pollOnce();

    expect(result).toEqual({ hadTask: true, queueDepth: 1 });
    expect(prepareManagedCheckoutMock).toHaveBeenCalledWith(
      "/home/magnus/repos/demo",
      "task-pi-harness-admission-refusal",
      expect.objectContaining({
        reposRoot: "/home/magnus/repos",
        mutationCapable: true,
      }),
    );
    expect(runOrchestratorTaskMock).not.toHaveBeenCalled();

    const finalStatus = entries.get(`${taskNs}/status`);
    expect(finalStatus?.tags).toEqual(
      expect.arrayContaining(["failed", "failure:infra", "runtime:orchestrator"]),
    );

    const resultEntry = entries.get(`${taskNs}/result`);
    expect(resultEntry?.content).toContain("- **Failure kind:** PI_HARNESS_ADMISSION_REFUSED");
    expect(resultEntry?.content).toContain("dispatcher only has degraded read-only checkout state");

    const structuredEntry = entries.get(`${taskNs}/result-structured`);
    expect(structuredEntry).toBeDefined();
    const structured = JSON.parse(structuredEntry!.content) as {
      lifecycle: string;
      outcome: string;
      exitCode: number;
      errorMessage?: string;
      repositoryOutcome?: { state?: string };
    };
    expect(structured.lifecycle).toBe("failed");
    expect(structured.outcome).toBe("failed");
    expect(structured.exitCode).toBe(1);
    expect(structured.errorMessage).toBe(
      "pi-harness worker requires a verified managed task-branch checkout before model spending; " +
        "the dispatcher only has degraded read-only checkout state",
    );
    expect(structured.repositoryOutcome?.state).toBe("checkout-contaminated");

    const frictionWrite = writes.find((write) => write.namespace === "signals/friction");
    expect(frictionWrite).toBeDefined();
    expect(frictionWrite?.tags).toEqual(
      expect.arrayContaining([
        "friction:tool_failure",
        "failure-kind:PI_HARNESS_ADMISSION_REFUSED",
        "source:hugin-preflight",
      ]),
    );
    const frictionContent = JSON.parse(frictionWrite!.content) as {
      reporter?: string;
      failure_kind?: string;
      detail?: string;
    };
    expect(frictionContent.reporter).toBe("hugin-preflight");
    expect(frictionContent.failure_kind).toBe("PI_HARNESS_ADMISSION_REFUSED");
    expect(frictionContent.detail).toContain("dispatcher only has degraded read-only checkout state");

    expect(
      logs.some(
        (entry) =>
          entry.namespace === taskNs &&
          entry.message.includes("Task failed (PI_HARNESS_ADMISSION_REFUSED)"),
      ),
    ).toBe(true);

    expect(__test__.inspectState()).toEqual({
      currentTask: null,
      currentTaskConfig: null,
      lastPendingQueueSnapshot: expect.objectContaining({ pendingCount: 0 }),
    });
  });

  it("marks repositoryOutcome checkout-contaminated when pi-harness binding admission fails after a clean checkout gate", async () => {
    const fakeHome = path.join(process.cwd(), ".tmp-test-home");
    fs.mkdirSync(path.join(fakeHome, ".hugin", "logs"), { recursive: true });

    vi.stubEnv("MUNIN_API_KEY", "test-key");
    vi.stubEnv("MUNIN_URL", "http://munin.test");
    vi.stubEnv("HUGIN_ALLOWED_SUBMITTERS", "hugin");
    vi.stubEnv("HUGIN_SIGNING_POLICY", "off");
    vi.stubEnv("HUGIN_SCHEDULER_SHADOW", "off");
    vi.stubEnv("HUGIN_VERSION_DRIFT_CHECK", "off");
    vi.stubEnv("HUGIN_SENSITIVITY_CHECKPOINT_SECRET", "x".repeat(32));
    vi.stubEnv("HOME", fakeHome);

    const taskNs = "tasks/task-pi-harness-builder-refusal";
    const createdAt = "2026-08-01T11:00:00.000Z";
    const entries = new Map<string, FakeEntry>();
    const writes: FakeWrite[] = [];
    const logs: Array<{ namespace: string; message: string }> = [];
    let writeCounter = 0;

    const taskContent = `## Task: Orchestrator pi-harness builder refusal

- **Runtime:** orchestrator
- **Working dir:** /home/magnus/repos/demo
- **Timeout:** 60000
- **Capabilities:** code
- **Permission profile:** trusted-code
- **Submitted by:** hugin

### Prompt
Edit the repository.`;

    const statusEntry: FakeEntry = {
      id: "status-0",
      namespace: taskNs,
      key: "status",
      content: taskContent,
      tags: ["pending", "runtime:orchestrator"],
      classification: "internal",
      created_at: createdAt,
      updated_at: createdAt,
    };
    entries.set(`${taskNs}/status`, statusEntry);

    const prepareManagedCheckoutMock = vi.fn().mockResolvedValue({
      branch: {
        action: "created",
        branchName: "hugin/task-pi-harness-builder-refusal",
        baseBranch: "main",
        baseCommit: "a".repeat(40),
      },
    });
    const preparePiHarnessWorktreeBindingMock = vi.fn().mockResolvedValue({
      ok: false,
      reason: "selected worktree path could not be verified clean",
      effectiveWorkerPermissionProfile: "trusted-code",
    });
    const runOrchestratorTaskMock = vi.fn();

    class FakeMuninClient {
      private sessionId = "session-0";

      constructor(_config: unknown) {}

      async query(_args: unknown) {
        return { results: [], total: 0 };
      }

      async read(namespace: string, key: string) {
        return entries.get(`${namespace}/${key}`) ?? null;
      }

      async readBatch(
        requests: Array<{ namespace: string; key: string }>,
      ) {
        return requests.map(({ namespace, key }) => entries.get(`${namespace}/${key}`) ?? null);
      }

      async write(
        namespace: string,
        key: string,
        content: string,
        tags?: string[],
        expectedUpdatedAt?: string,
        classification?: string,
        _createOnly?: boolean,
      ) {
        writes.push({ namespace, key, content, tags, expectedUpdatedAt, classification });
        const existing = entries.get(`${namespace}/${key}`);
        const updatedAt = new Date(Date.parse(createdAt) + ++writeCounter).toISOString();
        const next: FakeEntry = {
          id: existing?.id ?? `${namespace}/${key}/${writeCounter}`,
          namespace,
          key,
          content,
          tags: tags ?? existing?.tags ?? [],
          classification: classification ?? existing?.classification,
          created_at: existing?.created_at ?? createdAt,
          updated_at: updatedAt,
        };
        entries.set(`${namespace}/${key}`, next);
        return { updated_at: updatedAt, status: existing ? "updated" : "created" };
      }

      async log(namespace: string, message: string) {
        logs.push({ namespace, message });
      }

      async health() {
        return true;
      }

      setSessionId(sessionId: string) {
        this.sessionId = sessionId;
      }

      getSessionId() {
        return this.sessionId;
      }
    }

    vi.doMock("../src/munin-client.js", async () => {
      const actual = await vi.importActual<typeof import("../src/munin-client.js")>(
        "../src/munin-client.js",
      );
      return {
        ...actual,
        MuninClient: FakeMuninClient,
      };
    });

    vi.doMock("../src/munin-pagination.js", () => ({
      queryAllMuninEntries: vi.fn(async (_munin: unknown, options: { tags?: string[] }) => {
        if (options.tags?.includes("pending")) {
          return {
            results: [
              {
                id: statusEntry.id,
                namespace: taskNs,
                key: "status",
                entry_type: "state",
                content_preview: "",
                tags: [...statusEntry.tags],
                classification: statusEntry.classification,
                created_at: statusEntry.created_at,
                updated_at: statusEntry.updated_at,
              },
            ],
            truncated: false,
            budgetExhausted: false,
          };
        }
        return { results: [], truncated: false, budgetExhausted: false };
      }),
    }));

    vi.doMock("../src/task-helpers.js", async () => {
      const actual = await vi.importActual<typeof import("../src/task-helpers.js")>(
        "../src/task-helpers.js",
      );
      return {
        ...actual,
        prepareManagedCheckout: prepareManagedCheckoutMock,
      };
    });

    vi.doMock("../src/orchestrator/config.js", async () => {
      const actual = await vi.importActual<typeof import("../src/orchestrator/config.js")>(
        "../src/orchestrator/config.js",
      );
      return {
        ...actual,
        effectiveOrchestratorConfig: vi.fn(() => ({
          maxIterations: 1,
          maxConcurrency: 1,
          maxOutputChars: 4000,
          maxTokens: 4000,
          perCallTimeoutMs: 60_000,
          roles: {
            planner: { provider: "openrouter", model: "planner" },
            worker: { provider: "pi-harness", model: "worker-pi" },
            verifier: { provider: "openrouter", model: "verifier" },
            synthesizer: { provider: "openrouter", model: "synthesizer" },
          },
        })),
      };
    });

    vi.doMock("../src/orchestrator/pi-harness-admission.js", async () => {
      const actual =
        await vi.importActual<typeof import("../src/orchestrator/pi-harness-admission.js")>(
          "../src/orchestrator/pi-harness-admission.js",
        );
      return {
        ...actual,
        preparePiHarnessWorktreeBinding: preparePiHarnessWorktreeBindingMock,
      };
    });

    vi.doMock("../src/orchestrator/orchestrator-executor.js", async () => {
      const actual =
        await vi.importActual<typeof import("../src/orchestrator/orchestrator-executor.js")>(
          "../src/orchestrator/orchestrator-executor.js",
        );
      return {
        ...actual,
        runOrchestratorTask: runOrchestratorTaskMock,
      };
    });

    const { __test__ } = await import("../src/index.js");
    __test__.resetState();

    const result = await __test__.pollOnce();

    expect(result).toEqual({ hadTask: true, queueDepth: 1 });
    expect(prepareManagedCheckoutMock).toHaveBeenCalledWith(
      "/home/magnus/repos/demo",
      "task-pi-harness-builder-refusal",
      expect.objectContaining({
        reposRoot: "/home/magnus/repos",
        mutationCapable: true,
      }),
    );
    expect(preparePiHarnessWorktreeBindingMock).toHaveBeenCalled();
    expect(runOrchestratorTaskMock).not.toHaveBeenCalled();

    const finalStatus = entries.get(`${taskNs}/status`);
    expect(finalStatus?.tags).toEqual(
      expect.arrayContaining(["failed", "failure:infra", "runtime:orchestrator"]),
    );

    const resultEntry = entries.get(`${taskNs}/result`);
    expect(resultEntry?.content).toContain("- **Failure kind:** PI_HARNESS_ADMISSION_REFUSED");
    expect(resultEntry?.content).toContain("selected worktree path could not be verified clean");

    const structuredEntry = entries.get(`${taskNs}/result-structured`);
    expect(structuredEntry).toBeDefined();
    const structured = JSON.parse(structuredEntry!.content) as {
      lifecycle: string;
      outcome: string;
      exitCode: number;
      errorMessage?: string;
      repositoryOutcome?: { state?: string };
    };
    expect(structured.lifecycle).toBe("failed");
    expect(structured.outcome).toBe("failed");
    expect(structured.exitCode).toBe(1);
    expect(structured.errorMessage).toBe("selected worktree path could not be verified clean");
    expect(structured.repositoryOutcome?.state).toBe("checkout-contaminated");

    const frictionWrite = writes.find((write) => write.namespace === "signals/friction");
    expect(frictionWrite).toBeDefined();
    expect(frictionWrite?.tags).toEqual(
      expect.arrayContaining([
        "friction:tool_failure",
        "failure-kind:PI_HARNESS_ADMISSION_REFUSED",
        "source:hugin-preflight",
      ]),
    );
    const frictionContent = JSON.parse(frictionWrite!.content) as {
      reporter?: string;
      failure_kind?: string;
      detail?: string;
    };
    expect(frictionContent.reporter).toBe("hugin-preflight");
    expect(frictionContent.failure_kind).toBe("PI_HARNESS_ADMISSION_REFUSED");
    expect(frictionContent.detail).toContain("selected worktree path could not be verified clean");

    expect(
      logs.some(
        (entry) =>
          entry.namespace === taskNs &&
          entry.message.includes("Task failed (PI_HARNESS_ADMISSION_REFUSED)"),
      ),
    ).toBe(true);

    expect(__test__.inspectState()).toEqual({
      currentTask: null,
      currentTaskConfig: null,
      lastPendingQueueSnapshot: expect.objectContaining({ pendingCount: 0 }),
    });
  });
});
