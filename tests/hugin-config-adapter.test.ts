import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
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

function candidateWithRoutes(
  base: { revision: string; digest: string },
  routes: ReturnType<typeof candidate>["config"]["routes"],
) {
  const body = {
    schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION,
    targetId: "hugin-orin-macro-routing" as const,
    revision: "orin-macro-route-v2",
    base,
    config: { routes },
  };
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

  it("accepts only a canonical unique subset and makes promotion plus exact restore change the live selector", async () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-subset-"));
    const store = new HuginConfigStore(root);
    const target = createHuginConfigTargets(store)["hugin-orin-macro-routing"];
    const base = await target.read();
    const snapshot = await target.snapshot();
    const staged = store.stage(candidateWithRoutes(base, []));
    await target.replaceExact(base, staged.candidateDigest);
    expect(selectHuginMacroRouteFromStore(store, {
      workerProvider: "homeserver", taskType: "classify", sensitivity: "public",
    })).toBeNull();
    await createHuginConfigRecoveryWorker(store).restoreAndVerify({
      snapshotRef: snapshot.ref, snapshotDigest: snapshot.digest,
      targetId: "hugin-orin-macro-routing", baseRevision: base.revision,
      baseDigest: base.digest, expectedCurrent: { revision: staged.revision, digest: staged.candidateDigest },
      recoveryWorkerIdentity: HUGIN_CONFIG_RECOVERY_WORKER_ID,
    });
    expect(selectHuginMacroRouteFromStore(store, {
      workerProvider: "homeserver", taskType: "classify", sensitivity: "public",
    })).toEqual({ nodeId: "orin", modelId: "qwen2.5-coder:3b" });
    const duplicate = candidateWithRoutes(base, [
      candidate().config.routes[0]!, candidate().config.routes[0]!,
    ]);
    expect(() => validateHuginConfigCandidate(duplicate)).toThrow("noncanonical");
  });

  it("exposes only the real macro-routing target", () => {
    const targets = createHuginConfigTargets(new HuginConfigStore(mkdtempSync(join(tmpdir(), "hugin-config-only-"))));
    expect(Object.keys(targets)).toEqual(["hugin-orin-macro-routing"]);
    expect(() => validateHuginConfigCandidate({ ...candidate(), targetId: "hugin-agent-prompt" })).toThrow();
  });

  it.skipIf(process.platform !== "linux")("uses kernel ownership for contention and recovers only after SIGKILL closes the holder fd", async () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-kernel-lock-"));
    const store = new HuginConfigStore(root);
    const { revision, digest: baseDigest } = store.read("hugin-orin-macro-routing");
    const base = { revision, digest: baseDigest };
    const lockPath = join(root, "hugin-r-exact-config.json.lock");
    const child = spawn(
      "/usr/bin/flock",
      ["--exclusive", "--nonblock", "--no-fork", lockPath, process.execPath, "-e", "process.stdout.write('locked'); setInterval(() => {}, 1_000)"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    await once(child.stdout!, "data");
    const heldIdentity = statSync(lockPath);
    const started = Date.now();
    expect(() => store.stage(candidate("hugin-orin-macro-routing", base))).toThrow("hugin-config-store-contended");
    expect(Date.now() - started).toBeLessThan(100);

    child.kill("SIGKILL");
    await once(child, "exit");

    expect(() => store.stage(candidate("hugin-orin-macro-routing", base))).not.toThrow();
    const releasedIdentity = statSync(lockPath);
    expect(releasedIdentity.dev).toBe(heldIdentity.dev);
    expect(releasedIdentity.ino).toBe(heldIdentity.ino);
  });

  it.skipIf(process.platform !== "linux")("never interprets stale-looking lock-file contents as authority to reclaim the path", () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-stale-looking-lock-"));
    const lockPath = join(root, "hugin-r-exact-config.json.lock");
    writeFileSync(lockPath, '{"version":1,"pid":2147483647,"processStartTime":"1","bootId":"stale"}\n', { mode: 0o600 });
    const before = statSync(lockPath);
    const store = new HuginConfigStore(root);
    const { revision, digest: baseDigest } = store.read("hugin-orin-macro-routing");

    expect(() => store.stage(candidate("hugin-orin-macro-routing", { revision, digest: baseDigest }))).not.toThrow();
    const after = statSync(lockPath);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(lockPath, "utf8")).toContain('"pid":2147483647');
    expect(readdirSync(root).filter((name) => name.includes(".reclaim-"))).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")("releases only the acquired kernel lock and never unlinks a replacement pathname", () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-release-race-"));
    const lockPath = join(root, "hugin-r-exact-config.json.lock");
    let hookCalled = false;
    let armed = false;
    const store = new HuginConfigStore(root, {
      onLockReleaseReadyForTest: () => {
        if (!armed) return;
        hookCalled = true;
        // This is the former identity-lstat -> unlink race window.
        unlinkSync(lockPath);
        writeFileSync(lockPath, "live replacement\n", { mode: 0o600 });
      },
    });
    const { revision, digest: baseDigest } = store.read("hugin-orin-macro-routing");
    armed = true;

    expect(() => store.stage(candidate("hugin-orin-macro-routing", { revision, digest: baseDigest }))).not.toThrow();
    expect(hookCalled).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("live replacement\n");
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
    const first = targets["hugin-orin-macro-routing"]; const base = await first.read(); const snap = await first.snapshot(); const doc = store.stage(candidate("hugin-orin-macro-routing", base)); await first.replaceExact(base, doc.candidateDigest);
    expect(() => store.restoreSnapshot("hugin-agent-harness" as "hugin-orin-macro-routing", snap.ref, snap.digest, base, HUGIN_CONFIG_RECOVERY_WORKER_ID)).toThrow();
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

  it("rejects an oversized persisted store before parsing it", () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-oversized-"));
    new HuginConfigStore(root);
    const path = join(root, "hugin-r-exact-config.json");
    writeFileSync(path, "{".repeat(256 * 1024 + 1), "utf8");

    expect(() => new HuginConfigStore(root)).toThrowError("hugin-config-store-too-large");
  });

  it("rejects raw document cardinality before deep document validation", () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-document-limit-"));
    new HuginConfigStore(root);
    const path = join(root, "hugin-r-exact-config.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    state.documents = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`invalid-document-${index}`, {}]),
    );
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    expect(() => new HuginConfigStore(root)).toThrowError(
      "hugin-config-store-documents-limit",
    );
  });

  it("rejects raw snapshot cardinality before deep snapshot validation", () => {
    const root = mkdtempSync(join(tmpdir(), "hugin-config-snapshot-limit-"));
    new HuginConfigStore(root);
    const path = join(root, "hugin-r-exact-config.json");
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    state.snapshots = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`invalid-snapshot-${index}`, {}]),
    );
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    expect(() => new HuginConfigStore(root)).toThrowError(
      "hugin-config-store-snapshots-limit",
    );
  });
});
