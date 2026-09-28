import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeWrite {
  namespace: string;
  key: string;
  content: string;
  tags?: string[];
}

// Issue #389: the outer poll loop only emits a heartbeat between claimed
// tasks. A single task can run for up to the 12h dispatcher ceiling, so
// without a during-execution heartbeat a busy-but-alive worker looks
// identical to a dead one from Munin's `tasks/_heartbeat` entry alone.
describe("heartbeat during task execution (#389)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function importDispatcher(
    writes: FakeWrite[],
    getLoadedModels?: () => Promise<Record<string, string[]>>,
  ) {
    const fakeHome = path.join(process.cwd(), ".tmp-test-home-heartbeat");
    fs.mkdirSync(path.join(fakeHome, ".hugin"), { recursive: true });

    vi.stubEnv("MUNIN_API_KEY", "test-key");
    vi.stubEnv("MUNIN_URL", "http://munin.test");
    vi.stubEnv("HUGIN_ALLOWED_SUBMITTERS", "hugin");
    vi.stubEnv("HUGIN_SIGNING_POLICY", "off");
    vi.stubEnv("HUGIN_SCHEDULER_SHADOW", "off");
    vi.stubEnv("HUGIN_VERSION_DRIFT_CHECK", "off");
    vi.stubEnv("HUGIN_SENSITIVITY_CHECKPOINT_SECRET", "x".repeat(32));
    vi.stubEnv("HOME", fakeHome);

    class FakeMuninClient {
      constructor(_config: unknown) {}
      async query(_args: unknown) {
        return { results: [], total: 0 };
      }
      async read(_namespace: string, _key: string) {
        return null;
      }
      async readBatch(requests: Array<{ namespace: string; key: string }>) {
        return requests.map(({ namespace, key }) => ({
          namespace,
          key,
          found: false as const,
        }));
      }
      async write(
        namespace: string,
        key: string,
        content: string,
        tags?: string[],
      ) {
        writes.push({ namespace, key, content, tags });
        return { updated_at: new Date().toISOString(), status: "updated" };
      }
      async log(_namespace: string, _message: string) {}
      async health() {
        return true;
      }
      setSessionId(_sessionId: string) {}
      getSessionId() {
        return "session-0";
      }
    }

    vi.doMock("../src/munin-client.js", async () => {
      const actual = await vi.importActual<typeof import("../src/munin-client.js")>(
        "../src/munin-client.js",
      );
      return { ...actual, MuninClient: FakeMuninClient };
    });

    vi.doMock("../src/ollama-hosts.js", async () => {
      const actual = await vi.importActual<typeof import("../src/ollama-hosts.js")>(
        "../src/ollama-hosts.js",
      );
      return getLoadedModels ? { ...actual, getLoadedModels } : actual;
    });

    const mod = await import("../src/index.js");
    // Network is disabled for this test — getLoadedModels()'s best-effort
    // /api/ps probe must fail fast rather than depend on real ollama hosts.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network disabled in test")),
    );
    return mod;
  }

  it("keeps emitting a fresh heartbeat with current_task set while a task is in flight", async () => {
    const writes: FakeWrite[] = [];
    const { __test__ } = await importDispatcher(writes);
    __test__.resetState();
    __test__.setCurrentTaskForTest("tasks/long-running-task");

    __test__.startTaskHeartbeat("tasks/long-running-task");

    // Advance past 3 renewal intervals to simulate a long task blocking the
    // outer poll loop for well over a single poll interval.
    await vi.advanceTimersByTimeAsync(__test__.LEASE_RENEWAL_INTERVAL_MS * 3);

    const heartbeatWrites = writes.filter((w) => w.namespace === "tasks/_heartbeat");
    expect(heartbeatWrites.length).toBeGreaterThanOrEqual(3);

    const last = heartbeatWrites[heartbeatWrites.length - 1]!;
    const parsed = JSON.parse(last.content) as {
      current_task: string | null;
      polled_at: string;
    };
    expect(parsed.current_task).toBe("tasks/long-running-task");
    expect(Date.now() - Date.parse(parsed.polled_at)).toBeLessThan(1_000);

    __test__.stopTaskHeartbeat();
    fs.rmSync(path.join(process.cwd(), ".tmp-test-home-heartbeat"), {
      recursive: true,
      force: true,
    });
  });

  it("stops emitting the during-task heartbeat once the timer is cleared", async () => {
    const writes: FakeWrite[] = [];
    const { __test__ } = await importDispatcher(writes);
    __test__.resetState();
    __test__.setCurrentTaskForTest("tasks/short-task");

    __test__.startTaskHeartbeat("tasks/short-task");
    await vi.advanceTimersByTimeAsync(__test__.LEASE_RENEWAL_INTERVAL_MS);
    const countAfterOneTick = writes.filter((w) => w.namespace === "tasks/_heartbeat").length;
    expect(countAfterOneTick).toBeGreaterThanOrEqual(1);

    __test__.stopTaskHeartbeat();
    __test__.setCurrentTaskForTest(null);

    await vi.advanceTimersByTimeAsync(__test__.LEASE_RENEWAL_INTERVAL_MS * 3);
    const countAfterStop = writes.filter((w) => w.namespace === "tasks/_heartbeat").length;
    expect(countAfterStop).toBe(countAfterOneTick);

    fs.rmSync(path.join(process.cwd(), ".tmp-test-home-heartbeat"), {
      recursive: true,
      force: true,
    });
  });

  it("also stops the heartbeat when the timer's own currentTask guard fires (task changed underneath it)", async () => {
    const writes: FakeWrite[] = [];
    const { __test__ } = await importDispatcher(writes);
    __test__.resetState();
    __test__.setCurrentTaskForTest("tasks/task-a");

    __test__.startTaskHeartbeat("tasks/task-a");
    // Simulate the dispatcher moving on to a different task without an
    // explicit stopLeaseRenewal() call (defensive guard inside the timer).
    __test__.setCurrentTaskForTest("tasks/task-b");

    await vi.advanceTimersByTimeAsync(__test__.LEASE_RENEWAL_INTERVAL_MS * 2);
    const heartbeatWrites = writes.filter((w) => w.namespace === "tasks/_heartbeat");
    expect(heartbeatWrites.length).toBe(0);

    fs.rmSync(path.join(process.cwd(), ".tmp-test-home-heartbeat"), {
      recursive: true,
      force: true,
    });
  });

  it("continues heartbeats after lease renewal stops during delivery", async () => {
    const writes: FakeWrite[] = [];
    const { __test__ } = await importDispatcher(writes);
    __test__.resetState();
    __test__.setCurrentTaskForTest("tasks/delivery-task");
    __test__.startLeaseRenewal("tasks/delivery-task", "content", ["running"]);
    __test__.startTaskHeartbeat("tasks/delivery-task");

    await vi.advanceTimersByTimeAsync(__test__.LEASE_RENEWAL_INTERVAL_MS);
    const beforeDelivery = writes.filter((w) => w.namespace === "tasks/_heartbeat").length;
    const leaseWritesBeforeDelivery = writes.filter(
      (w) => w.namespace === "tasks/delivery-task" && w.key === "status",
    ).length;

    __test__.stopLeaseRenewal();
    await vi.advanceTimersByTimeAsync(__test__.TASK_HEARTBEAT_INTERVAL_MS * 2);

    const heartbeatWrites = writes.filter((w) => w.namespace === "tasks/_heartbeat");
    const leaseWritesAfterDelivery = writes.filter(
      (w) => w.namespace === "tasks/delivery-task" && w.key === "status",
    ).length;
    expect(heartbeatWrites.length).toBeGreaterThanOrEqual(beforeDelivery + 2);
    expect(leaseWritesAfterDelivery).toBe(leaseWritesBeforeDelivery);

    __test__.stopTaskHeartbeat();
    __test__.setCurrentTaskForTest(null);
    fs.rmSync(path.join(process.cwd(), ".tmp-test-home-heartbeat"), {
      recursive: true,
      force: true,
    });
  });

  it("serializes overlapping emissions and writes the newest snapshot last", async () => {
    const writes: FakeWrite[] = [];
    let releaseFirstModels!: () => void;
    const firstModelsReady = new Promise<void>((resolve) => {
      releaseFirstModels = resolve;
    });
    let modelCalls = 0;
    const getLoadedModels = vi.fn(async () => {
      modelCalls++;
      if (modelCalls === 1) await firstModelsReady;
      return {};
    });
    const { __test__ } = await importDispatcher(writes, getLoadedModels);
    __test__.resetState();
    __test__.setCurrentTaskForTest("tasks/old-task");

    const first = __test__.emitHeartbeat(0);
    await Promise.resolve();
    __test__.setCurrentTaskForTest(null);
    const second = __test__.emitHeartbeat(0);
    releaseFirstModels();
    await Promise.all([first, second]);

    const heartbeatWrites = writes.filter((w) => w.namespace === "tasks/_heartbeat");
    expect(heartbeatWrites).toHaveLength(2);
    expect(JSON.parse(heartbeatWrites.at(-1)!.content).current_task).toBeNull();
    expect(heartbeatWrites.map((w) => JSON.parse(w.content).current_task)).not.toEqual([
      null,
      "tasks/old-task",
    ]);

    fs.rmSync(path.join(process.cwd(), ".tmp-test-home-heartbeat"), {
      recursive: true,
      force: true,
    });
  });
});
