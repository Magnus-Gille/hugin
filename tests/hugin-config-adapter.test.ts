import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeJcs } from "../src/jcs.js";
import { HUGIN_CONFIG_ADAPTER_VERSION, HuginConfigStore, createHuginConfigTargets, selectHuginMacroRoute, validateHuginConfigCandidate } from "../src/autonomy/hugin-config-adapter.js";

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalizeJcs(value)).digest("hex")}`;
function candidate(targetId: "hugin-orin-macro-routing" = "hugin-orin-macro-routing", base = { revision: "orin-macro-route-v1", digest: "" }) {
  const body = { schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION, targetId, revision: "orin-macro-route-v2", base, config: { routes: [
    { workerProvider: "homeserver", taskType: "classify", sensitivity: "internal", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
    { workerProvider: "homeserver", taskType: "classify", sensitivity: "public", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
    { workerProvider: "homeserver", taskType: "extract", sensitivity: "internal", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
    { workerProvider: "homeserver", taskType: "extract", sensitivity: "public", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
  ] } } as const;
  return { ...body, candidateDigest: digest(body) };
}

describe("Hugin strict autonomous config adapters", () => {
  it.each([["homeserver", "classify", "public", true], ["homeserver", "extract", "internal", true], ["homeserver", "classify", "private", false], ["homeserver", "summarize", "public", false], ["openrouter", "classify", "public", false]])("preserves the Orin route matrix", (workerProvider, taskType, sensitivity, allowed) => expect(selectHuginMacroRoute({ workerProvider, taskType, sensitivity: sensitivity as "public" | "internal" | "private" }) !== null).toBe(allowed));

  it("performs an exact staged CAS with snapshot/readback and refuses stale state", async () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-")); const store = new HuginConfigStore(root); const target = createHuginConfigTargets(store)["hugin-orin-macro-routing"];
    const base = await target.read(); const doc = store.stage(candidate("hugin-orin-macro-routing", base));
    const snap = await target.snapshot(); await target.replaceExact(base, doc.candidateDigest);
    expect(await target.read()).toEqual({ revision: "orin-macro-route-v2", digest: doc.candidateDigest }); expect(snap.digest).toBe(base.digest);
    await expect(target.replaceExact(base, doc.candidateDigest)).rejects.toThrow("stale-base");
    expect(store.restoreSnapshot("hugin-orin-macro-routing", snap.ref, snap.digest)).toEqual(base);
    expect(await target.read()).toEqual(base);
    expect(await createHuginConfigTargets(new HuginConfigStore(root))["hugin-orin-macro-routing"].read()).toEqual(base);
  });

  it("rejects malformed, duplicate/noncanonical, cross-owner, protected and unbound candidates before mutation", async () => {
    const store = new HuginConfigStore(mkdtempSync(join(tmpdir(), "hugin-config-"))); const target = createHuginConfigTargets(store)["hugin-orin-macro-routing"]; const before = await target.read();
    const bad = candidate("hugin-orin-macro-routing", before); bad.config.routes.reverse();
    expect(() => validateHuginConfigCandidate(bad)).toThrow("noncanonical");
    for (const id of ["gille-model", "gille-model-config", "hugin-logging", "hugin-test-harness", "gille-tool-policy", "hugin-deploy", "hugin-auth", "hugin-key", "hugin-safety-gate", "hugin-risk-budget", "hugin-retention", "unknown-target"]) expect(() => validateHuginConfigCandidate({ ...bad, targetId: id })).toThrow();
    await expect(target.replaceExact(before, digest("not-staged"))).rejects.toThrow("not-bound"); expect(await target.read()).toEqual(before);
  });
});
