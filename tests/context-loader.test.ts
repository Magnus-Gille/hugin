import { describe, expect, it } from "vitest";
import { resolveContextRefs } from "../src/context-loader.js";

type BatchRef = { namespace: string; key: string };
type BatchEntry =
  | {
      found: true;
      id: string;
      namespace: string;
      key: string;
      content: string;
      tags: string[];
      classification: string;
      created_at: string;
      updated_at: string;
    }
  | { found: false; namespace: string; key: string };

function makeEntry(
  namespace: string,
  key: string,
  content: string,
  classification: string,
): BatchEntry {
  return {
    found: true,
    id: `${namespace}/${key}`,
    namespace,
    key,
    content,
    tags: [],
    classification,
    created_at: "2026-04-04T10:00:00Z",
    updated_at: "2026-04-04T10:00:00Z",
  };
}

describe("context-loader", () => {
  it("returns per-ref classification metadata and max sensitivity", async () => {
    const store: Record<string, BatchEntry> = {
      "people/magnus/profile": makeEntry(
        "people/magnus",
        "profile",
        "Private profile",
        "client-confidential",
      ),
      "projects/hugin/status": makeEntry(
        "projects/hugin",
        "status",
        "Internal project status",
        "internal",
      ),
    };

    const munin = {
      async readBatch(refs: BatchRef[]): Promise<BatchEntry[]> {
        return refs.map(({ namespace, key }) => {
          const hit = store[`${namespace}/${key}`];
          return hit ?? { found: false, namespace, key };
        });
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

  it("fetches multiple refs in a single batch call", async () => {
    let batchCallCount = 0;

    const munin = {
      async readBatch(refs: BatchRef[]): Promise<BatchEntry[]> {
        batchCallCount++;
        return refs.map(({ namespace, key }) =>
          makeEntry(namespace, key, `Content of ${namespace}/${key}`, "internal"),
        );
      },
    };

    const resolution = await resolveContextRefs(
      ["projects/a/info", "projects/b/info", "projects/c/info"],
      8_000,
      munin as never,
    );

    expect(batchCallCount).toBe(1);
    expect(resolution.refsResolved).toHaveLength(3);
    expect(resolution.refsMissing).toHaveLength(0);
  });

  it("handles a mix of found and missing refs", async () => {
    const munin = {
      async readBatch(refs: BatchRef[]): Promise<BatchEntry[]> {
        return refs.map(({ namespace, key }) => {
          if (namespace === "projects/hugin" && key === "status") {
            return makeEntry(namespace, key, "Project status", "internal");
          }
          return { found: false, namespace, key };
        });
      },
    };

    const resolution = await resolveContextRefs(
      ["projects/hugin/status", "projects/hugin/missing-key"],
      8_000,
      munin as never,
    );

    expect(resolution.refsResolved).toEqual(["projects/hugin/status"]);
    expect(resolution.refsMissing).toEqual(["projects/hugin/missing-key"]);
    expect(resolution.maxSensitivity).toBe("internal");
  });
});
