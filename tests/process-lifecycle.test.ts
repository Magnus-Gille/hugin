import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { __test__ as lifecycleTestHooks, createOwnedProcessLifecycle, exitCodeAfterCleanup, spawnOwnedProcess, terminateAllOwnedProcesses, terminateBeforePersistence, waitForPersistenceBounded } from "../src/process-lifecycle.js";

class FakeChild extends EventEmitter {
  pid: number | undefined;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

describe("owned process lifecycle", () => {
  beforeEach(() => lifecycleTestHooks.resetOwnedProcessAdmission());

  it("escalates to SIGKILL even when ChildProcess.killed is already true", async () => {
    const child = new FakeChild();
    child.pid = 41;
    child.killed = true;
    const signals: string[] = [];
    let present = true;
    const lifecycle = createOwnedProcessLifecycle(child as never, {
      termGraceMs: 5,
      killWaitMs: 40,
      pollIntervalMs: 1,
      signalGroup: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") present = false;
      },
      probeGroup: () => present,
    });
    child.emit("spawn");

    const result = await lifecycle.terminate();

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("makes cancellation idempotent while cleanup is in progress", async () => {
    const child = new FakeChild();
    child.pid = 42;
    let present = true;
    const signals: string[] = [];
    const lifecycle = createOwnedProcessLifecycle(child as never, {
      termGraceMs: 5,
      killWaitMs: 40,
      pollIntervalMs: 1,
      signalGroup: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") present = false;
      },
      probeGroup: () => present,
    });
    child.emit("spawn");

    const first = lifecycle.terminate();
    const second = lifecycle.terminate();

    expect(second).toBe(first);
    await first;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails closed without a valid successful-spawn PID and never falls back to child.kill", async () => {
    const child = new FakeChild();
    child.pid = 1;
    const signalGroup = vi.fn();
    const lifecycle = createOwnedProcessLifecycle(child as never, { signalGroup });
    child.emit("spawn");

    const result = await lifecycle.terminate();

    expect(result.ok).toBe(false);
    expect(signalGroup).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not use a PID unless the child emitted successful spawn", async () => {
    const child = new FakeChild();
    child.pid = 46;
    const signalGroup = vi.fn();
    const lifecycle = createOwnedProcessLifecycle(child as never, { signalGroup });
    const cleanup = lifecycle.terminate();
    child.emit("error", new Error("spawn failed"));

    expect(await cleanup).toEqual({ ok: true });
    expect(signalGroup).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("retires a process group after ESRCH and never signals that handle again", async () => {
    const child = new FakeChild();
    child.pid = 43;
    const signalGroup = vi.fn(() => {
      const error = Object.assign(new Error("gone"), { code: "ESRCH" });
      throw error;
    });
    const lifecycle = createOwnedProcessLifecycle(child as never, { signalGroup });
    child.emit("spawn");

    await lifecycle.terminate();
    await lifecycle.terminate();

    expect(signalGroup).toHaveBeenCalledTimes(1);
    expect(signalGroup).toHaveBeenCalledWith(43, "SIGTERM");
  });

  it("reports bounded verification failure instead of claiming cleanup", async () => {
    const child = new FakeChild();
    child.pid = 45;
    const signals: string[] = [];
    const lifecycle = createOwnedProcessLifecycle(child as never, {
      termGraceMs: 5,
      killWaitMs: 10,
      pollIntervalMs: 1,
      signalGroup: (_pid, signal) => { signals.push(signal); },
      probeGroup: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
    });
    child.emit("spawn");

    const result = await lifecycle.terminate();

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/verification failed \(EPERM\)/) });
  });

  it("does not report leader exit 0 as success when owned-group cleanup fails", () => {
    expect(exitCodeAfterCleanup(0, { ok: false, error: "probe denied" })).toBe(1);
    expect(exitCodeAfterCleanup(0, { ok: true })).toBe(0);
  });

  it("notifies executor finalization when bounded cleanup fails before child exit", async () => {
    const child = new FakeChild();
    child.pid = 47;
    const lifecycle = createOwnedProcessLifecycle(child as never, {
      termGraceMs: 2,
      killWaitMs: 4,
      pollIntervalMs: 1,
      signalGroup: vi.fn(),
      probeGroup: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
    });
    child.emit("spawn");
    const failure = vi.fn();
    lifecycle.onCleanupFailure(failure);

    const cleanup = await lifecycle.terminate();

    expect(cleanup.ok).toBe(false);
    expect(failure).toHaveBeenCalledWith(cleanup);
    expect(child.listenerCount("exit")).toBe(1);
  });

  it("bounds waiting on a hung persistence promise", async () => {
    const onTimeout = vi.fn();
    await waitForPersistenceBounded(new Promise<void>(() => {}), 5, onTimeout);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("tracks a pending spawn during shutdown and terminates it when spawn completes", async () => {
    const child = new FakeChild();
    child.pid = 48;
    let present = true;
    const signals: string[] = [];
    const lifecycle = createOwnedProcessLifecycle(child as never, {
      spawnWaitMs: 5,
      termGraceMs: 2,
      killWaitMs: 10,
      pollIntervalMs: 1,
      signalGroup: (_pid, signal) => { signals.push(signal); present = false; },
      probeGroup: () => present,
    });

    const shutdownCleanup = terminateAllOwnedProcesses();
    child.emit("spawn");
    await shutdownCleanup;

    expect(signals).toEqual(["SIGTERM"]);
  });

  it.skipIf(process.platform === "win32")("allows a normal owned process while admission is open", async () => {
    const managed = spawnOwnedProcess(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("synthetic child did not exit")), 2_000);
      managed.child.once("exit", (code) => {
        clearTimeout(deadline);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    expect(await managed.lifecycle.cleanup()).toEqual({ ok: true });
  });

  it.skipIf(process.platform === "win32")("closes process admission before taking the shutdown snapshot", async () => {
    await terminateAllOwnedProcesses();

    const lateChild = new FakeChild();
    expect(() => createOwnedProcessLifecycle(lateChild as never)).toThrow(/admission/);
    expect(() => spawnOwnedProcess(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }))
      .toThrow(/admission/);
    expect(lateChild.listenerCount("spawn")).toBe(0);
  });

  it("signals before an unresolved external persistence operation can settle", async () => {
    const child = new FakeChild();
    child.pid = 44;
    const signals: string[] = [];
    const lifecycle = createOwnedProcessLifecycle(child as never, {
      signalGroup: (_pid, signal) => signals.push(signal),
      probeGroup: () => false,
    });
    child.emit("spawn");
    let persistenceSettled = false;
    const persist = vi.fn(() => new Promise<void>(() => {}).then(() => { persistenceSettled = true; }));

    const persistence = terminateBeforePersistence(lifecycle, persist, vi.fn());

    expect(signals).toEqual(["SIGTERM"]);
    expect(persist).toHaveBeenCalledOnce();
    expect(persistenceSettled).toBe(false);
    expect(await lifecycle.cleanup()).toEqual({ ok: true });
    void persistence;
  });

  it.skipIf(process.platform === "win32")("kills a TERM-ignoring parent and grandchild process group", async () => {
    const grandchildCode = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);";
    const parentCode = [
      "const {spawn}=require('node:child_process');",
      `const grandchild=spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:'ignore'});`,
      "process.stdout.write(String(grandchild.pid)+'\\n');",
      "process.on('SIGTERM',()=>{});",
      "setInterval(()=>{},1000);",
    ].join("");
    const managed = spawnOwnedProcess(process.execPath, ["-e", parentCode], {
      stdio: ["ignore", "pipe", "ignore"],
    }, { termGraceMs: 50, killWaitMs: 1_000, pollIntervalMs: 5 });
    let grandchildPid = 0;
    managed.child.stdout?.on("data", (chunk: Buffer) => {
      const parsed = Number(chunk.toString().trim());
      if (Number.isSafeInteger(parsed) && parsed > 1) grandchildPid = parsed;
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("synthetic child did not report PID")), 2_000);
      const poll = setInterval(() => {
        if (grandchildPid > 1) {
          clearTimeout(deadline);
          clearInterval(poll);
          resolve();
        }
      }, 5);
    });

    const result = await managed.lifecycle.terminate();

    expect(result).toEqual({ ok: true });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("synthetic leader did not exit")), 1_000);
      managed.child.once("exit", () => {
        clearTimeout(deadline);
        resolve();
      });
      if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });

  it.skipIf(process.platform === "win32")("cleans descendants when the leader exits normally", async () => {
    const grandchildCode = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);";
    const parentCode = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:'ignore'});`,
      "process.exit(0);",
    ].join("");
    const managed = spawnOwnedProcess(process.execPath, ["-e", parentCode], {
      stdio: ["ignore", "ignore", "ignore"],
    }, { termGraceMs: 50, killWaitMs: 1_000, pollIntervalMs: 5 });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("synthetic leader did not exit")), 2_000);
      managed.child.once("exit", (code) => {
        clearTimeout(deadline);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    let groupGone = false;
    const groupPid = managed.child.pid;
    if (!Number.isSafeInteger(groupPid) || groupPid! <= 1) throw new Error("successful child did not expose a valid PID");
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      try {
        process.kill(-groupPid!, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          groupGone = true;
          break;
        }
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await managed.lifecycle.cleanup();
    expect(groupGone).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("rejects the group-dependent path on Windows", () => {
    expect(() => spawnOwnedProcess(process.execPath, ["-e", ""], { stdio: "ignore" })).toThrow(/POSIX/);
  });
});
