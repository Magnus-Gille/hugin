import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeJcs } from "../src/jcs.js";
import { HUGIN_CONFIG_ADAPTER_VERSION, HUGIN_CONFIG_RECOVERY_WORKER_ID, HUGIN_CONFIG_ROOT_ENV, HuginConfigStore, createHuginConfigRecoveryWorker, createHuginConfigTargets, selectHuginMacroRoute, selectHuginMacroRouteFromStore, validateHuginConfigCandidate } from "../src/autonomy/hugin-config-adapter.js";
import { selectOrinMacroRoute } from "../src/orchestrator/orin-macro-route.js";

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
  it.each([["homeserver", "classify", "public", true], ["homeserver", "extract", "internal", true], ["homeserver", "classify", "private", false], ["homeserver", "summarize", "public", false], ["openrouter", "classify", "public", false]])("preserves the Orin route matrix", (workerProvider, taskType, sensitivity, allowed) => {
    const store = new HuginConfigStore(mkdtempSync(join(tmpdir(), "hugin-config-route-")));
    expect(selectHuginMacroRouteFromStore(store, { workerProvider, taskType, sensitivity: sensitivity as "public" | "internal" | "private" }) !== null).toBe(allowed);
  });

  it("uses the owner-configured durable store in the actual selector across promote, restart, and exact recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-runtime-"));
    const priorRoot = process.env[HUGIN_CONFIG_ROOT_ENV];
    delete process.env[HUGIN_CONFIG_ROOT_ENV];
    expect(selectHuginMacroRoute({ workerProvider: "homeserver", taskType: "classify", sensitivity: "public" })).toBeNull();
    process.env[HUGIN_CONFIG_ROOT_ENV] = root;
    try {
      const store = new HuginConfigStore(root);
      const target = createHuginConfigTargets(store)["hugin-orin-macro-routing"];
      const base = await target.read();
      expect(selectOrinMacroRoute({ workerProvider: "homeserver", taskType: "classify", sensitivity: "public" })).toEqual({ nodeId: "orin", modelId: "qwen2.5-coder:3b" });
      const snapshot = await target.snapshot();
      const staged = store.stage(candidate("hugin-orin-macro-routing", base));
      await target.replaceExact(base, staged.candidateDigest);
      expect(await target.read()).toEqual({ revision: staged.revision, digest: staged.candidateDigest });
      expect(selectOrinMacroRoute({ workerProvider: "homeserver", taskType: "extract", sensitivity: "internal" })).toEqual({ nodeId: "orin", modelId: "qwen2.5-coder:3b" });
      const restarted = new HuginConfigStore(root);
      expect(selectHuginMacroRouteFromStore(restarted, { workerProvider: "homeserver", taskType: "classify", sensitivity: "public" })).toEqual({ nodeId: "orin", modelId: "qwen2.5-coder:3b" });
      const recovery = createHuginConfigRecoveryWorker(restarted);
      await recovery.restoreAndVerify({
        snapshotRef: snapshot.ref,
        snapshotDigest: snapshot.digest,
        targetId: "hugin-orin-macro-routing",
        baseRevision: base.revision,
        baseDigest: base.digest,
        expectedCurrent: { revision: staged.revision, digest: staged.candidateDigest },
        recoveryWorkerIdentity: HUGIN_CONFIG_RECOVERY_WORKER_ID,
      });
      expect(await createHuginConfigTargets(new HuginConfigStore(root))["hugin-orin-macro-routing"].read()).toEqual(base);
      expect(selectOrinMacroRoute({ workerProvider: "homeserver", taskType: "classify", sensitivity: "public" })).toEqual({ nodeId: "orin", modelId: "qwen2.5-coder:3b" });
    } finally {
      if (priorRoot === undefined) delete process.env[HUGIN_CONFIG_ROOT_ENV];
      else process.env[HUGIN_CONFIG_ROOT_ENV] = priorRoot;
    }
  });

  it("does not create an uninstalled durable root while reading the live selector", () => {
    const parent = mkdtempSync(join(tmpdir(), "hugin-config-uninstalled-"));
    const root = join(parent, "not-installed");
    const priorRoot = process.env[HUGIN_CONFIG_ROOT_ENV];
    process.env[HUGIN_CONFIG_ROOT_ENV] = root;
    try {
      expect(selectOrinMacroRoute({ workerProvider: "homeserver", taskType: "classify", sensitivity: "public" })).toBeNull();
      expect(existsSync(root)).toBe(false);
    } finally {
      if (priorRoot === undefined) delete process.env[HUGIN_CONFIG_ROOT_ENV];
      else process.env[HUGIN_CONFIG_ROOT_ENV] = priorRoot;
    }
  });

  it("performs an exact staged CAS with snapshot/readback and refuses stale state", async () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-")); const store = new HuginConfigStore(root); const target = createHuginConfigTargets(store)["hugin-orin-macro-routing"];
    const base = await target.read(); const doc = store.stage(candidate("hugin-orin-macro-routing", base));
    const snap = await target.snapshot(); await target.replaceExact(base, doc.candidateDigest);
    expect(await target.read()).toEqual({ revision: "orin-macro-route-v2", digest: doc.candidateDigest }); expect(snap.digest).toBe(base.digest);
    await expect(target.replaceExact(base, doc.candidateDigest)).rejects.toThrow("stale-base");
    expect(store.restoreSnapshot("hugin-orin-macro-routing", snap.ref, snap.digest, { revision: "orin-macro-route-v2", digest: doc.candidateDigest }, HUGIN_CONFIG_RECOVERY_WORKER_ID)).toEqual(base);
    expect(await target.read()).toEqual(base);
    expect(await createHuginConfigTargets(new HuginConfigStore(root))["hugin-orin-macro-routing"].read()).toEqual(base);
  });

  it("fences target-bound recovery so an old snapshot cannot overwrite later state", async () => {
    const store = new HuginConfigStore(mkdtempSync(join(tmpdir(), "hugin-config-"))); const targets = createHuginConfigTargets(store);
    const first = targets["hugin-orin-macro-routing"]; const other = targets["hugin-agent-harness"]; const base = await first.read(); const otherCurrent = await other.read(); const snap = await first.snapshot(); const doc = store.stage(candidate("hugin-orin-macro-routing", base)); await first.replaceExact(base, doc.candidateDigest);
    expect(() => store.restoreSnapshot("hugin-agent-harness", snap.ref, snap.digest, otherCurrent, HUGIN_CONFIG_RECOVERY_WORKER_ID)).toThrow("snapshot-unavailable");
    expect(() => store.restoreSnapshot("hugin-orin-macro-routing", snap.ref, snap.digest, { revision: "later", digest: digest("later") }, HUGIN_CONFIG_RECOVERY_WORKER_ID)).toThrow("stale-recovery-fence");
    const current = await first.read(); expect(() => store.restoreSnapshot("hugin-orin-macro-routing", snap.ref, snap.digest, current, "wrong-worker")).toThrow("recovery-fence");
    expect(await first.read()).toEqual({ revision: "orin-macro-route-v2", digest: doc.candidateDigest });
  });

  it("binds recovery to the strict store's exact owner, current state, and target", async () => {
    const store = new HuginConfigStore(mkdtempSync(join(tmpdir(), "hugin-config-")));
    const targets = createHuginConfigTargets(store);
    const target = targets["hugin-orin-macro-routing"];
    const base = await target.read();
    const snapshot = await target.snapshot();
    const doc = store.stage(candidate("hugin-orin-macro-routing", base));
    await target.replaceExact(base, doc.candidateDigest);
    const recovery = createHuginConfigRecoveryWorker(store);
    const input = {
      snapshotRef: snapshot.ref,
      snapshotDigest: snapshot.digest,
      targetId: "hugin-orin-macro-routing",
      baseRevision: base.revision,
      baseDigest: base.digest,
      expectedCurrent: { revision: doc.revision, digest: doc.candidateDigest },
      recoveryWorkerIdentity: HUGIN_CONFIG_RECOVERY_WORKER_ID,
    };
    await expect(recovery.restoreAndVerify({ ...input, targetId: "gille-model" }))
      .rejects.toThrow();
    await expect(recovery.restoreAndVerify({ ...input, expectedCurrent: base }))
      .rejects.toThrow("stale-recovery-fence");
    await expect(recovery.restoreAndVerify({
      ...input,
      expectedCurrent: { revision: "other-revision", digest: doc.candidateDigest },
    })).rejects.toThrow("stale-recovery-fence");
    await expect(recovery.restoreAndVerify({ ...input, recoveryWorkerIdentity: "other-worker" }))
      .rejects.toThrow("recovery-fence");
    await expect(recovery.restoreAndVerify(input)).resolves.toEqual({
      restoredRevision: base.revision,
      restoredDigest: base.digest,
    });
    expect(await target.read()).toEqual(base);
  });

  it("rejects malformed, duplicate/noncanonical, cross-owner, protected and unbound candidates before mutation", async () => {
    const store = new HuginConfigStore(mkdtempSync(join(tmpdir(), "hugin-config-"))); const target = createHuginConfigTargets(store)["hugin-orin-macro-routing"]; const before = await target.read();
    const bad = candidate("hugin-orin-macro-routing", before); bad.config.routes.reverse();
    expect(() => validateHuginConfigCandidate(bad)).toThrow("noncanonical");
    for (const id of ["gille-model", "gille-model-config", "hugin-logging", "hugin-test-harness", "gille-tool-policy", "hugin-deploy", "hugin-auth", "hugin-key", "hugin-safety-gate", "hugin-risk-budget", "hugin-retention", "unknown-target"]) expect(() => validateHuginConfigCandidate({ ...bad, targetId: id })).toThrow();
    await expect(target.replaceExact(before, digest("not-staged"))).rejects.toThrow("not-bound"); expect(await target.read()).toEqual(before);
  });

  it("fails closed on a syntactically valid store whose current document is not bound to its digest", () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-corrupt-"));
    const store = new HuginConfigStore(root);
    const path = join(root, "hugin-r-exact-config.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.current["hugin-orin-macro-routing"].digest = `sha256:${"f".repeat(64)}`;
    writeFileSync(path, JSON.stringify(state));
    expect(() => new HuginConfigStore(root)).toThrow("hugin-config-store-digest-mismatch");
    expect(() => selectHuginMacroRouteFromStore(store, {
      workerProvider: "homeserver", taskType: "classify", sensitivity: "public",
    })).toThrow("hugin-config-store-digest-mismatch");
  });
});
