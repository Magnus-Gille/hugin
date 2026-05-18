import { describe, it, expect, vi } from "vitest";
import { finalizeTaskCompletion } from "../src/task-helpers.js";

function makeClient() {
  const writes: Array<{ key: string; tags: string[] }> = [];
  const logs: string[] = [];
  return {
    writes,
    logs,
    client: {
      write: vi.fn(async (_ns: string, key: string, _content: string, tags: string[]) => {
        writes.push({ key, tags });
      }),
      log: vi.fn(async (_ns: string, message: string) => {
        logs.push(message);
      }),
    },
  };
}

describe("finalizeTaskCompletion", () => {
  it("writes status before structured result in the normal path", async () => {
    const { client } = makeClient();
    const writeOrder: string[] = [];

    client.write.mockImplementation(async (_ns: string, key: string) => {
      writeOrder.push(key);
    });

    await finalizeTaskCompletion(client, "tasks/test-001", {
      statusContent: "## Task",
      terminalTags: ["completed", "runtime:ollama"],
      writeStructuredResult: async () => {
        writeOrder.push("result-structured");
      },
      logMessage: "Task completed in 5s",
    });

    expect(writeOrder[0]).toBe("status");
    expect(writeOrder[1]).toBe("result-structured");
  });

  it("status is written terminal even when writeStructuredResult throws", async () => {
    const { client, writes } = makeClient();

    const result = await finalizeTaskCompletion(client, "tasks/test-002", {
      statusContent: "## Task",
      terminalTags: ["completed", "runtime:claude"],
      writeStructuredResult: async () => {
        throw new Error("Zod parse error: invalid schema");
      },
      logMessage: "Task completed in 3s",
    });

    // Status write must have happened
    expect(writes.some((w) => w.key === "status")).toBe(true);
    const statusWrite = writes.find((w) => w.key === "status")!;
    expect(statusWrite.tags).toContain("completed");

    // Structured result failure is reported but non-fatal
    expect(result.structuredResultOk).toBe(false);
    expect(result.structuredResultError).toBeInstanceOf(Error);
  });

  it("status write failure propagates (status is the non-negotiable write)", async () => {
    const { client } = makeClient();
    client.write.mockRejectedValueOnce(new Error("Munin network error"));

    await expect(
      finalizeTaskCompletion(client, "tasks/test-003", {
        statusContent: "## Task",
        terminalTags: ["failed", "runtime:codex"],
        writeStructuredResult: async () => {},
        logMessage: "Task failed",
      }),
    ).rejects.toThrow("Munin network error");
  });

  it("a rejected CAS with expectedUpdatedAt bails without finalizing (single-owner, #68)", async () => {
    const { client, writes, logs } = makeClient();
    client.write.mockRejectedValueOnce(new Error("expected_updated_at mismatch"));
    const structured = vi.fn(async () => {});

    const result = await finalizeTaskCompletion(client, "tasks/test-005", {
      statusContent: "## Task",
      terminalTags: ["completed", "delivery:verified"],
      expectedUpdatedAt: "2026-05-18T00:00:00Z",
      writeStructuredResult: structured,
      logMessage: "should not be logged",
    });

    expect(result.statusCasLost).toBe(true);
    expect(result.structuredResultOk).toBe(false);
    // No structured write, no log, no successful status write — the new owner
    // (startup delivery reconciliation) stands.
    expect(structured).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it("passes expectedUpdatedAt through to the status CAS write", async () => {
    const { client } = makeClient();
    await finalizeTaskCompletion(client, "tasks/test-006", {
      statusContent: "## Task",
      terminalTags: ["completed"],
      expectedUpdatedAt: "2026-05-18T12:00:00Z",
      writeStructuredResult: async () => {},
      logMessage: "ok",
    });
    expect(client.write).toHaveBeenCalledWith(
      "tasks/test-006",
      "status",
      "## Task",
      ["completed"],
      "2026-05-18T12:00:00Z",
      undefined,
    );
  });

  it("log is written after status even when structured result fails", async () => {
    const { client, logs } = makeClient();

    await finalizeTaskCompletion(client, "tasks/test-004", {
      statusContent: "## Task",
      terminalTags: ["completed"],
      writeStructuredResult: async () => {
        throw new Error("boom");
      },
      logMessage: "Task completed in 10s",
    });

    expect(logs).toContain("Task completed in 10s");
  });
});
