import { describe, expect, it } from "vitest";

import { createImmutableLearningArtifact } from "../src/learning-task-store.js";
import { MuninWriteRejectedError, type MuninClient } from "../src/munin-client.js";

const write = {
  namespace: "tasks/task-1",
  key: "learning-attempt-11111111-1111-4111-8111-111111111111",
  content: '{"immutable":true}',
  tags: ["learning-task-attempt"],
  classification: "internal",
};

describe("immutable learning artifacts", () => {
  it("requires create-if-absent and an exact created acknowledgement", async () => {
    const calls: unknown[][] = [];
    const client = {
      write: async (...args: unknown[]) => {
        calls.push(args);
        return { status: "updated" };
      },
    } as unknown as MuninClient;
    await expect(createImmutableLearningArtifact(client, write)).rejects.toThrow(/non-created/);
    expect(calls[0]?.[6]).toBe(true);
  });

  it("accepts only a typed already-exists conflict with byte-identical readback", async () => {
    const exact = {
      write: async () => {
        throw new MuninWriteRejectedError(write.namespace, write.key, {
          error: "conflict",
          conflict_reason: "already_exists",
        });
      },
      read: async () => ({ content: write.content, classification: write.classification }),
    } as unknown as MuninClient;
    await expect(createImmutableLearningArtifact(exact, write, { allowExactExisting: true }))
      .resolves.toBe("exact-existing");

    const divergent = {
      ...exact,
      read: async () => ({ content: '{"immutable":false}' }),
    } as unknown as MuninClient;
    await expect(createImmutableLearningArtifact(divergent, write, { allowExactExisting: true }))
      .rejects.toThrow(/collision differs/);

    const classificationDrift = {
      ...exact,
      read: async () => ({ content: write.content, classification: "public" }),
    } as unknown as MuninClient;
    await expect(createImmutableLearningArtifact(
      classificationDrift,
      write,
      { allowExactExisting: true },
    )).rejects.toThrow(/collision differs/);
  });
});
