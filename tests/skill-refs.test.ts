import { describe, it, expect } from "vitest";
import {
  canonicalJSONString,
  contentHash,
  tupleHashesMatch,
  lifecycleStateSchema,
  tupleRefSchema,
  type TupleRef,
} from "../src/skill/refs.js";

const H = (n: string) => n.repeat(64).slice(0, 64);

describe("skill/refs canonical hashing", () => {
  it("is key-order independent (canonical)", () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b = { c: { x: 2, y: 1 }, a: 2, b: 1 };
    expect(canonicalJSONString(a)).toBe(canonicalJSONString(b));
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("preserves array order (arrays are not sorted)", () => {
    expect(contentHash([1, 2, 3])).not.toBe(contentHash([3, 2, 1]));
  });

  it("drops undefined members like JSON.stringify", () => {
    expect(canonicalJSONString({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("produces a 64-char sha256 hex and is stable across calls", () => {
    const h1 = contentHash({ skillId: "x", v: 1 });
    const h2 = contentHash({ v: 1, skillId: "x" });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
  });

  it("different content → different hash", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe("skill/refs shared schemas", () => {
  it("lifecycle enum covers the full state machine", () => {
    for (const s of [
      "draft",
      "candidate",
      "shadow",
      "active",
      "stale",
      "quarantined",
      "disabled",
    ]) {
      expect(lifecycleStateSchema.safeParse(s).success).toBe(true);
    }
    expect(lifecycleStateSchema.safeParse("promoted").success).toBe(false);
  });

  it("tupleRef requires 64-char hex hashes", () => {
    const good: TupleRef = {
      taskClassId: "c",
      taskClassVersion: 1,
      taskClassHash: H("a"),
      skillProfileId: "p",
      skillProfileHash: H("b"),
      cellManifestId: "m",
      cellManifestHash: H("c"),
      evalSuiteId: "e",
      evalSuiteHash: H("d"),
    };
    expect(tupleRefSchema.safeParse(good).success).toBe(true);
    expect(
      tupleRefSchema.safeParse({ ...good, taskClassHash: "short" }).success,
    ).toBe(false);
  });

  it("tupleHashesMatch detects drift on any artifact hash", () => {
    const base: TupleRef = {
      taskClassId: "c",
      taskClassVersion: 1,
      taskClassHash: H("a"),
      skillProfileId: "p",
      skillProfileHash: H("b"),
      cellManifestId: "m",
      cellManifestHash: H("c"),
      evalSuiteId: "e",
      evalSuiteHash: H("d"),
    };
    expect(tupleHashesMatch(base, { ...base })).toBe(true);
    expect(tupleHashesMatch(base, { ...base, skillProfileHash: H("f") })).toBe(false);
  });
});
