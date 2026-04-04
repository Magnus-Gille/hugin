import { describe, expect, it } from "vitest";
import { resolveContextRefs } from "../src/context-loader.js";

describe("context-loader", () => {
  it("returns per-ref classification metadata and max sensitivity", async () => {
    const munin = {
      async read(namespace: string, key: string) {
        if (namespace === "people/magnus" && key === "profile") {
          return {
            found: true as const,
            id: "1",
            namespace,
            key,
            content: "Private profile",
            tags: [],
            classification: "client-confidential",
            created_at: "2026-04-04T10:00:00Z",
            updated_at: "2026-04-04T10:00:00Z",
          };
        }
        if (namespace === "projects/hugin" && key === "status") {
          return {
            found: true as const,
            id: "2",
            namespace,
            key,
            content: "Internal project status",
            tags: [],
            classification: "internal",
            created_at: "2026-04-04T10:00:00Z",
            updated_at: "2026-04-04T10:00:00Z",
          };
        }
        return null;
      },
    };

    const resolution = await resolveContextRefs(
      ["people/magnus/profile", "projects/hugin/status"],
      8_000,
      munin as never,
    );

    expect(resolution.refsResolved).toEqual([
      "people/magnus/profile",
      "projects/hugin/status",
    ]);
    expect(resolution.maxSensitivity).toBe("private");
    expect(resolution.refs).toEqual([
      {
        ref: "people/magnus/profile",
        namespace: "people/magnus",
        key: "profile",
        classification: "client-confidential",
        sensitivity: "private",
      },
      {
        ref: "projects/hugin/status",
        namespace: "projects/hugin",
        key: "status",
        classification: "internal",
        sensitivity: "internal",
      },
    ]);
  });
});
