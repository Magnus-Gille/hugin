/**
 * The only concrete Hugin-owned R-exact configuration adapters (ADR-008).
 *
 * Candidate documents live in this local, owner-controlled store; receipts and
 * journals contain only their SHA-256 digest.  This deliberately does not
 * provide a generic config writer or any Gille/deployment/auth surface.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalizeJcs } from "../jcs.js";
import type {
  RExactConfigTarget,
  RExactRecoveryWorker,
} from "./r-exact-types.js";

export const HUGIN_CONFIG_ADAPTER_VERSION = "hugin-config-adapter-v1" as const;
/** Fixed W0.2 recovery identity for Hugin's owner-local strict config store. */
export const HUGIN_CONFIG_RECOVERY_WORKER_ID = "hugin-recovery" as const;
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-z][a-z0-9-]{2,80}$/);
const targetId = z.enum(["hugin-orin-macro-routing", "hugin-agent-prompt", "hugin-agent-harness", "hugin-tool-policy"]);
export type HuginConfigTargetId = z.infer<typeof targetId>;

const route = z.object({ workerProvider: z.literal("homeserver"), taskType: z.enum(["classify", "extract"]), sensitivity: z.enum(["public", "internal"]), nodeId: z.literal("orin"), modelId: z.literal("qwen2.5-coder:3b") }).strict();
const macroPayload = z.object({ routes: z.array(route).length(4) }).strict();
const promptPayload = z.object({ templateRef: z.string().regex(/^ref:[a-z][a-z0-9-]{2,120}$/), templateDigest: sha256 }).strict();
const harnessPayload = z.object({ allowedHarnesses: z.array(z.enum(["pi", "opencode"])).min(1).max(2) }).strict();
const toolPolicyPayload = z.object({ allowedTools: z.array(z.enum(["read", "write", "shell"])).min(1).max(3) }).strict();

const candidateSchema = z.discriminatedUnion("targetId", [
  z.object({ schemaVersion: z.literal(HUGIN_CONFIG_ADAPTER_VERSION), targetId: z.literal("hugin-orin-macro-routing"), revision, base: z.object({ revision, digest: sha256 }).strict(), config: macroPayload, candidateDigest: sha256 }).strict(),
  z.object({ schemaVersion: z.literal(HUGIN_CONFIG_ADAPTER_VERSION), targetId: z.literal("hugin-agent-prompt"), revision, base: z.object({ revision, digest: sha256 }).strict(), config: promptPayload, candidateDigest: sha256 }).strict(),
  z.object({ schemaVersion: z.literal(HUGIN_CONFIG_ADAPTER_VERSION), targetId: z.literal("hugin-agent-harness"), revision, base: z.object({ revision, digest: sha256 }).strict(), config: harnessPayload, candidateDigest: sha256 }).strict(),
  z.object({ schemaVersion: z.literal(HUGIN_CONFIG_ADAPTER_VERSION), targetId: z.literal("hugin-tool-policy"), revision, base: z.object({ revision, digest: sha256 }).strict(), config: toolPolicyPayload, candidateDigest: sha256 }).strict(),
]);
export type HuginConfigCandidate = z.infer<typeof candidateSchema>;
type ConfigPayload = HuginConfigCandidate["config"];

const payloadSchemas = {
  "hugin-orin-macro-routing": macroPayload,
  "hugin-agent-prompt": promptPayload,
  "hugin-agent-harness": harnessPayload,
  "hugin-tool-policy": toolPolicyPayload,
} as const;

const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalizeJcs(value)).digest("hex")}`;
const clone = <T>(value: T): T => structuredClone(value);

function validateMacroRoutes(routes: z.infer<typeof route>[]): void {
  const expected = ["classify:internal", "classify:public", "extract:internal", "extract:public"];
  const keys = routes.map((item) => `${item.taskType}:${item.sensitivity}`);
  if (keys.join("|") !== expected.join("|")) throw new Error("hugin-config-noncanonical-macro-route-matrix");
}

function candidateBody(candidate: HuginConfigCandidate): unknown {
  const { candidateDigest: _digest, ...body } = candidate;
  return body;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function validatePayload(id: HuginConfigTargetId, raw: unknown): ConfigPayload {
  const payload = payloadSchemas[id].parse(raw) as ConfigPayload;
  if (id === "hugin-orin-macro-routing") validateMacroRoutes((payload as Extract<ConfigPayload, { routes: unknown }>).routes as z.infer<typeof route>[]);
  return clone(payload);
}

/** Strict parse + digest recomputation before a candidate reaches a target. */
export function validateHuginConfigCandidate(raw: unknown): HuginConfigCandidate {
  const candidate = candidateSchema.parse(raw);
  if (candidate.targetId === "hugin-orin-macro-routing") validateMacroRoutes(candidate.config.routes);
  if (digest(candidateBody(candidate)) !== candidate.candidateDigest) throw new Error("hugin-config-candidate-digest-mismatch");
  return clone(candidate);
}

interface StoredDocument { revision: string; payload: ConfigPayload; digest: string; }
interface StoreState {
  current: Record<HuginConfigTargetId, StoredDocument>;
  documents: Record<string, HuginConfigCandidate>;
  snapshots: Record<string, { target: HuginConfigTargetId; document: StoredDocument }>;
}
const defaults: Record<HuginConfigTargetId, { revision: string; payload: ConfigPayload }> = {
  "hugin-orin-macro-routing": { revision: "orin-macro-route-v1", payload: { routes: [
    { workerProvider: "homeserver", taskType: "classify", sensitivity: "internal", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
    { workerProvider: "homeserver", taskType: "classify", sensitivity: "public", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
    { workerProvider: "homeserver", taskType: "extract", sensitivity: "internal", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
    { workerProvider: "homeserver", taskType: "extract", sensitivity: "public", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
  ] } },
  // Deliberately unconfigured: W4.4 must supply owner-approved manifests.
  "hugin-agent-prompt": { revision: "agent-prompt-unconfigured", payload: { templateRef: "ref:unconfigured-prompt", templateDigest: digest({ unconfigured: "prompt" }) } },
  "hugin-agent-harness": { revision: "agent-harness-unconfigured", payload: { allowedHarnesses: ["pi"] } },
  "hugin-tool-policy": { revision: "tool-policy-unconfigured", payload: { allowedTools: ["read"] } },
};

function initialDocument(value: { revision: string; payload: ConfigPayload }): StoredDocument {
  return { revision: value.revision, payload: clone(value.payload), digest: digest({ schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION, revision: value.revision, config: value.payload }) };
}

function validateStoredDocument(
  raw: unknown,
  id: HuginConfigTargetId,
  documents: StoreState["documents"],
): StoredDocument {
  if (!exactKeys(raw, ["revision", "payload", "digest"])) throw new Error("hugin-config-store-corrupt");
  const parsedRevision = revision.parse(raw.revision);
  const parsedDigest = sha256.parse(raw.digest);
  const payload = validatePayload(id, raw.payload);
  const candidate = documents[parsedDigest];
  if (candidate !== undefined) {
    if (
      candidate.targetId !== id
      || candidate.revision !== parsedRevision
      || canonicalizeJcs(candidate.config) !== canonicalizeJcs(payload)
    ) throw new Error("hugin-config-store-digest-mismatch");
  } else if (parsedDigest !== digest({ schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION, revision: parsedRevision, config: payload })) {
    throw new Error("hugin-config-store-digest-mismatch");
  }
  return { revision: parsedRevision, payload, digest: parsedDigest };
}

function validateStoreState(raw: unknown): StoreState {
  if (!exactKeys(raw, ["current", "documents", "snapshots"]) || !raw.current || !raw.documents || !raw.snapshots
    || typeof raw.current !== "object" || typeof raw.documents !== "object" || typeof raw.snapshots !== "object"
    || Array.isArray(raw.current) || Array.isArray(raw.documents) || Array.isArray(raw.snapshots)) {
    throw new Error("hugin-config-store-corrupt");
  }
  if (Object.keys(raw.current).sort().join("|") !== [...targetId.options].sort().join("|")) throw new Error("hugin-config-store-corrupt");
  const documents: StoreState["documents"] = {};
  for (const [key, value] of Object.entries(raw.documents)) {
    const candidate = validateHuginConfigCandidate(value);
    if (key !== candidate.candidateDigest) throw new Error("hugin-config-store-digest-mismatch");
    documents[key] = candidate;
  }
  const rawCurrent = raw.current as Record<string, unknown>;
  const current = {} as Record<HuginConfigTargetId, StoredDocument>;
  for (const id of targetId.options) current[id] = validateStoredDocument(rawCurrent[id], id, documents);
  const snapshots: StoreState["snapshots"] = {};
  for (const [ref, value] of Object.entries(raw.snapshots)) {
    if (!/^ref:snapshot-[a-z0-9-]+-[a-f0-9]{24}$/.test(ref) || !exactKeys(value, ["target", "document"])) throw new Error("hugin-config-store-corrupt");
    const id = targetId.parse(value.target);
    snapshots[ref] = { target: id, document: validateStoredDocument(value.document, id, documents) };
  }
  return { current, documents, snapshots };
}

const domains = {
  "hugin-orin-macro-routing": "macro-routing",
  "hugin-agent-prompt": "prompt",
  "hugin-agent-harness": "harness",
  "hugin-tool-policy": "tool-policy",
} as const;

/** Owner-local canonical store; mutations are only CAS through a target. */
export class HuginConfigStore {
  #path: string;
  #lockPath: string;
  constructor(root: string, options: { initialize?: boolean } = {}) {
    if (!isAbsolute(root)) throw new Error("hugin-config-root-not-absolute");
    const initialize = options.initialize ?? true;
    this.#path = join(resolve(root), "hugin-r-exact-config.json"); this.#lockPath = `${this.#path}.lock`;
    if (initialize) mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("hugin-config-root-unsafe");
    if (!initialize) {
      this.load();
      return;
    }
    this.withLock(() => {
      if (!this.exists()) this.write({ current: Object.fromEntries(targetId.options.map((id) => [id, initialDocument(defaults[id])])) as Record<HuginConfigTargetId, StoredDocument>, documents: {}, snapshots: {} });
      else this.load();
    });
  }
  /** Opens an existing store without creating files or taking its mutation lock. */
  static openReadOnly(root: string): HuginConfigStore {
    return new HuginConfigStore(root, { initialize: false });
  }
  private exists() { try { lstatSync(this.#path); return true; } catch { return false; } }
  private withLock<T>(operation: () => T): T {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      let fd: number | undefined;
      try {
        fd = openSync(this.#lockPath, "wx", 0o600);
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      try {
        writeFileSync(fd, `${process.pid}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
        return operation();
      } finally {
        if (fd !== undefined) closeSync(fd);
        unlinkSync(this.#lockPath);
      }
    }
    throw new Error("hugin-config-store-contended");
  }
  private load(): StoreState {
    const stat = lstatSync(this.#path); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("hugin-config-store-unsafe");
    try { return validateStoreState(JSON.parse(readFileSync(this.#path, "utf8"))); } catch (error) { if (error instanceof Error && error.message.startsWith("hugin-config-store-")) throw error; throw new Error("hugin-config-store-corrupt"); }
  }
  private write(state: StoreState) { const temp = `${this.#path}.${process.pid}.${randomUUID()}.tmp`; const fd = openSync(temp, "wx", 0o600); try { writeFileSync(fd, canonicalizeJcs(state)); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp, this.#path); const dir = openSync(resolve(this.#path, ".."), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
  read(id: HuginConfigTargetId): StoredDocument { return clone(this.load().current[id]); }
  readPayload(id: HuginConfigTargetId): ConfigPayload { return clone(this.load().current[id].payload); }
  candidateRevision(id: HuginConfigTargetId, candidateDigest: string): string { const candidate = this.load().documents[candidateDigest]; if (!candidate || candidate.targetId !== id) throw new Error("hugin-config-candidate-unavailable"); return candidate.revision; }
  stage(raw: unknown): HuginConfigCandidate { const candidate = validateHuginConfigCandidate(raw); return this.withLock(() => { const state = this.load(); state.documents[candidate.candidateDigest] = candidate; this.write(state); return clone(candidate); }); }
  snapshot(id: HuginConfigTargetId): { ref: string; digest: string } { return this.withLock(() => { const state = this.load(); const doc = state.current[id]; const ref = `ref:snapshot-${id}-${doc.digest.slice(7, 31)}`; state.snapshots[ref] = { target: id, document: doc }; this.write(state); return { ref, digest: doc.digest }; }); }
  /** Called only by the separately authorized R-exact recovery adapter. */
  restoreSnapshot(
    id: HuginConfigTargetId,
    ref: string,
    expectedDigest: string,
    expectedCurrent: { revision: string; digest: string },
    recoveryIdentity: string,
  ): { revision: string; digest: string } {
    if (recoveryIdentity !== HUGIN_CONFIG_RECOVERY_WORKER_ID) throw new Error("hugin-config-recovery-fence-refused");
    return this.withLock(() => {
      const state = this.load(); const snapshot = state.snapshots[ref];
      if (!snapshot || snapshot.target !== id || snapshot.document.digest !== expectedDigest) throw new Error("hugin-config-snapshot-unavailable");
      const current = state.current[id]; if (current.digest === expectedDigest && current.revision === snapshot.document.revision) return { revision: current.revision, digest: current.digest };
      if (current.revision !== expectedCurrent.revision || current.digest !== expectedCurrent.digest) throw new Error("hugin-config-stale-recovery-fence");
      state.current[id] = clone(snapshot.document); this.write(state); return { revision: snapshot.document.revision, digest: snapshot.document.digest };
    });
  }
  replace(id: HuginConfigTargetId, expected: { revision: string; digest: string }, candidateDigest: string): void {
    this.withLock(() => {
      const state = this.load(); const current = state.current[id];
      if (current.revision !== expected.revision || current.digest !== expected.digest) throw new Error("hugin-config-stale-base");
      const candidate = state.documents[candidateDigest];
      if (!candidate || candidate.targetId !== id || candidate.base.revision !== expected.revision || candidate.base.digest !== expected.digest) throw new Error("hugin-config-candidate-not-bound-to-base");
      state.current[id] = { revision: candidate.revision, payload: clone(candidate.config), digest: candidate.candidateDigest }; this.write(state);
    });
  }
}

class HuginTarget implements RExactConfigTarget {
  owner = "hugin" as const;
  domain: typeof domains[HuginConfigTargetId];
  targetScopeDigest: string;
  constructor(readonly id: HuginConfigTargetId, private readonly store: HuginConfigStore) {
    this.domain = domains[id];
    this.targetScopeDigest = digest({ schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION, targetId: id, domain: this.domain });
  }
  async read() { const current = this.store.read(this.id); return { revision: current.revision, digest: current.digest }; }
  async candidateRevision(candidateDigest: string) { return this.store.candidateRevision(this.id, candidateDigest); }
  async snapshot() { return this.store.snapshot(this.id); }
  async replaceExact(expected: { revision: string; digest: string }, candidateDigest: string) { this.store.replace(this.id, expected, candidateDigest); }
}

export function createHuginConfigTargets(store: HuginConfigStore): Record<HuginConfigTargetId, RExactConfigTarget> {
  return {
    "hugin-orin-macro-routing": new HuginTarget("hugin-orin-macro-routing", store),
    "hugin-agent-prompt": new HuginTarget("hugin-agent-prompt", store),
    "hugin-agent-harness": new HuginTarget("hugin-agent-harness", store),
    "hugin-tool-policy": new HuginTarget("hugin-tool-policy", store),
  };
}

/**
 * Concrete recovery adapter for the strict Hugin config store.
 * It accepts only Hugin-owned target IDs and the W0.2 recovery identity, then
 * delegates the compare-and-swap restore to the durable store.
 */
export class HuginConfigRecoveryWorker {
  constructor(private readonly store: HuginConfigStore) {}

  async restoreAndVerify(input: Parameters<RExactRecoveryWorker["restoreAndVerify"]>[0]) {
    if (input.recoveryWorkerIdentity !== HUGIN_CONFIG_RECOVERY_WORKER_ID) {
      throw new Error("hugin-config-recovery-fence-refused");
    }
    const id = targetId.parse(input.targetId);
    if (input.snapshotDigest !== input.baseDigest) {
      throw new Error("hugin-config-recovery-base-mismatch");
    }
    const restored = this.store.restoreSnapshot(
      id,
      input.snapshotRef,
      input.snapshotDigest,
      input.expectedCurrent,
      HUGIN_CONFIG_RECOVERY_WORKER_ID,
    );
    if (
      restored.revision !== input.baseRevision
      || restored.digest !== input.baseDigest
    ) {
      throw new Error("hugin-config-restore-readback-mismatch");
    }
    return { restoredRevision: restored.revision, restoredDigest: restored.digest };
  }
}

export function createHuginConfigRecoveryWorker(
  store: HuginConfigStore,
): Pick<RExactRecoveryWorker, "restoreAndVerify"> {
  const worker = new HuginConfigRecoveryWorker(store);
  return { restoreAndVerify: worker.restoreAndVerify.bind(worker) };
}

/** Production composition root for the owner-installed durable config resource. */
export const HUGIN_CONFIG_ROOT_ENV = "HUGIN_R_EXACT_CONFIG_ROOT";

export function selectHuginMacroRouteFromStore(store: Pick<HuginConfigStore, "readPayload">, input: { workerProvider: string; taskType: string; sensitivity: "public" | "internal" | "private" }): { nodeId: "orin"; modelId: "qwen2.5-coder:3b" } | null {
  if (input.sensitivity === "private") return null;
  const routes = macroPayload.parse(store.readPayload("hugin-orin-macro-routing")).routes;
  const matched = routes.find((entry) => entry.workerProvider === input.workerProvider && entry.taskType === input.taskType && entry.sensitivity === input.sensitivity);
  return matched ? { nodeId: matched.nodeId, modelId: matched.modelId } : null;
}

/** Fail closed until deployment explicitly supplies the owner-local durable root. */
export function selectHuginMacroRoute(input: { workerProvider: string; taskType: string; sensitivity: "public" | "internal" | "private" }): { nodeId: "orin"; modelId: "qwen2.5-coder:3b" } | null {
  const root = process.env[HUGIN_CONFIG_ROOT_ENV];
  if (!root) return null;
  try { return selectHuginMacroRouteFromStore(HuginConfigStore.openReadOnly(root), input); }
  catch { return null; }
}
