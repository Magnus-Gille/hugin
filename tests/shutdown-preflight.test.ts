import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mocks = vi.hoisted(() => ({
  probeCodexSandbox: vi.fn(),
  spawnAttempts: 0,
  read: undefined as ((namespace: string, key: string) => Promise<unknown>) | undefined,
  write: undefined as ((namespace: string, key: string) => Promise<unknown>) | undefined,
}));

vi.mock("../src/codex-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex-sandbox.js")>();
  return { ...actual, probeCodexSandbox: mocks.probeCodexSandbox };
});

vi.mock("../src/process-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process-lifecycle.js")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    spawnOwnedProcess: (..._args: unknown[]) => {
      mocks.spawnAttempts++;
      const child = new EventEmitter() as EventEmitter & { stdout?: undefined; stderr?: undefined };
      const lifecycle = {
        cleanup: async () => ({ ok: true as const }),
        onCleanupFailure: () => {},
      };
      queueMicrotask(() => child.emit("error", new Error("Codex child spawn attempted")));
      return { child, lifecycle };
    },
  };
});

vi.mock("../src/munin-client.js", () => ({
  MuninClient: class {
    read(namespace: string, key: string): Promise<unknown> {
      return mocks.read?.(namespace, key) ?? Promise.resolve(null);
    }
    write(namespace: string, key: string): Promise<unknown> {
      return mocks.write?.(namespace, key) ?? Promise.resolve({});
    }
    log(): Promise<void> { return Promise.resolve(); }
    setSessionId(): void {}
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("shutdown during Codex preflight", () => {
  let tmp: string;
  let signalListeners: Set<(...args: never[]) => unknown>;

  beforeEach(() => {
    vi.resetModules();
    mocks.probeCodexSandbox.mockReset();
    mocks.spawnAttempts = 0;
    mocks.read = undefined;
    mocks.write = undefined;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-shutdown-preflight-"));
    fs.mkdirSync(path.join(tmp, ".hugin", "logs"), { recursive: true });
    vi.stubEnv("HOME", tmp);
    signalListeners = new Set(process.listeners("SIGTERM") as Array<(...args: never[]) => unknown>);
  });

  afterEach(async () => {
    for (const listener of process.listeners("SIGTERM")) {
      if (!signalListeners.has(listener as (...args: never[]) => unknown)) {
        process.removeListener("SIGTERM", listener);
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await new Promise((resolve) => setTimeout(resolve, 10));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does not spawn Codex when shutdown begins during held preflight and status persistence", async () => {
    const taskNs = "tasks/hugin-shutdown-preflight-race";
    const statusWriteStarted = deferred<void>();
    const releaseStatusWrite = deferred<void>();
    let heldStatusWrite = false;
    mocks.read = async (namespace, key) => namespace === taskNs && key === "status"
      ? {
          content: "## Task: shutdown race\n\n- **Runtime:** codex\n\n### Prompt\nDo no work.\n",
          tags: ["running", "runtime:codex"],
          updated_at: "2026-10-17T12:00:00.000Z",
        }
      : null;
    mocks.write = async (namespace, key) => {
      if (!heldStatusWrite && namespace === taskNs && key === "status") {
        heldStatusWrite = true;
        statusWriteStarted.resolve();
        await releaseStatusWrite.promise;
      }
      return {};
    };

    const probe = deferred<{
      available: boolean;
      checkedAt: string;
      command: "codex sandbox -- /bin/true";
    }>();
    mocks.probeCodexSandbox.mockReturnValue(probe.promise);

    const { __test__ } = await import("../src/index.js");
    __test__.resetState();
    __test__.setCurrentTaskForTest(taskNs);
    const task = {
      runtime: "codex",
      prompt: "Do no work.",
      workingDir: tmp,
      timeoutMs: 30_000,
    };
    const preflight = __test__.executeCodexWithPreflightChecks(task, {
      taskNs,
      muninClient: {} as never,
    });
    expect(mocks.probeCodexSandbox).toHaveBeenCalledOnce();

    const exitCalled = deferred<number | undefined>();
    vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCalled.resolve(code);
      return undefined as never;
    });
    process.emit("SIGTERM");
    await statusWriteStarted.promise;

    probe.resolve({
      available: true,
      checkedAt: new Date().toISOString(),
      command: "codex sandbox -- /bin/true",
    });
    const result = await preflight;

    expect(result.exitCode).toBe(1);
    expect(mocks.spawnAttempts).toBe(0);

    releaseStatusWrite.resolve();
    await exitCalled.promise;
    __test__.resetState();
  });
});
