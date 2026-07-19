import { describe, expect, it, vi } from "vitest";
import {
  finalizeManagedCheckoutFailure,
  renewTaskLease,
  type MutableTaskStatus,
} from "../src/managed-checkout-failure.js";

describe("managed checkout refusal finalization", () => {
  it("waits for lease renewal, preserves auto-routing tags, and writes one structured result", async () => {
    const status: MutableTaskStatus = {
      content: "## Task: checkout failure",
      tags: ["running", "runtime:ollama", "routing:auto", "type:code"],
      updated_at: "claim-version",
    };
    let releaseRenewal!: () => void;
    const renewalGate = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    const writes: Array<{
      key: string;
      tags?: string[];
      expectedUpdatedAt?: string;
    }> = [];
    const client = {
      async write(
        _namespace: string,
        key: string,
        _content: string,
        tags?: string[],
        expectedUpdatedAt?: string,
      ) {
        writes.push({ key, tags, expectedUpdatedAt });
        if (key === "status" && tags?.includes("running")) {
          await renewalGate;
          return { updated_at: "renewed-version" };
        }
        return { updated_at: "terminal-version" };
      },
      log: vi.fn(async () => undefined),
    };

    const renewal = renewTaskLease({
      client,
      taskNs: "tasks/test-auto",
      status,
      renewedTags: status.tags,
    });
    const structuredWrite = vi.fn(async () => undefined);
    const finalization = finalizeManagedCheckoutFailure({
      client,
      taskNs: "tasks/test-auto",
      status,
      classification: "internal",
      resultContent: "## Result\n\ncheckout failed\n",
      writeStructuredResult: structuredWrite,
      logMessage: "checkout refused",
      stopLeaseRenewal: async () => {
        releaseRenewal();
        await renewal;
      },
    });

    await finalization;

    const statusWrites = writes.filter((write) => write.key === "status");
    expect(statusWrites).toHaveLength(2);
    expect(statusWrites[1]).toEqual({
      key: "status",
      tags: ["failed", "runtime:ollama", "type:code", "routing:auto"],
      expectedUpdatedAt: "renewed-version",
    });
    expect(writes.filter((write) => write.key === "result")).toHaveLength(1);
    expect(structuredWrite).toHaveBeenCalledTimes(1);
    expect(client.log).toHaveBeenCalledTimes(1);
    expect(status.updated_at).toBe("terminal-version");
  });

  it("keeps the terminal refusal and audit log when structured output fails", async () => {
    const status: MutableTaskStatus = {
      content: "## Task: checkout failure",
      tags: ["running", "runtime:claude"],
      updated_at: "claim-version",
    };
    const writes: string[] = [];
    const client = {
      async write(_namespace: string, key: string) {
        writes.push(key);
        return { updated_at: "terminal-version" };
      },
      log: vi.fn(async () => undefined),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await finalizeManagedCheckoutFailure({
      client,
      taskNs: "tasks/test-structured-failure",
      status,
      resultContent: "## Result\n",
      writeStructuredResult: async () => {
        throw new Error("schema unavailable");
      },
      logMessage: "checkout refused",
      stopLeaseRenewal: async () => undefined,
    });

    expect(writes).toEqual(["status", "result"]);
    expect(status.tags).toEqual(["failed", "runtime:claude"]);
    expect(client.log).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
