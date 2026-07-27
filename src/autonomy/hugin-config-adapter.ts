/**
 * The only concrete Hugin-owned R-exact configuration adapters (ADR-008).
 *
 * Candidate documents live in this local, owner-controlled store; receipts and
 * journals contain only their SHA-256 digest.  This deliberately does not
 * provide a generic config writer or any Gille/deployment/auth surface.
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { canonicalizeJcs } from "../jcs.js";
import type { RExactConfigTarget } from "./r-exact-types.js";

export const HUGIN_CONFIG_ADAPTER_VERSION = "hugin-config-adapter-v1" as const;
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

/** Strict parse + digest recomputation before a candidate reaches a target. */
export function validateHuginConfigCandidate(raw: unknown): HuginConfigCandidate {
  const candidate = candidateSchema.parse(raw);
  if (candidate.targetId === "hugin-orin-macro-routing") validateMacroRoutes(candidate.config.routes);
  if (digest(candidateBody(candidate)) !== candidate.candidateDigest) throw new Error("hugin-config-candidate-digest-mismatch");
  return clone(candidate);
}

interface StoredDocument { revision: string; payload: ConfigPayload; digest: string; }
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

const domains = {
  "hugin-orin-macro-routing": "macro-routing",
  "hugin-agent-prompt": "prompt",
  "hugin-agent-harness": "harness",
  "hugin-tool-policy": "tool-policy",
} as const;

/** Owner-local canonical store; mutations are only CAS through a target. */
export class HuginConfigStore {
  #path: string;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("hugin-config-root-not-absolute");
    this.#path = join(resolve(root), "hugin-r-exact-config.json"); mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("hugin-config-root-unsafe");
    if (!this.exists()) this.write({ current: Object.fromEntries(targetId.options.map((id) => [id, initialDocument(defaults[id])])), documents: {}, snapshots: {} });
  }
  private exists() { try { lstatSync(this.#path); return true; } catch { return false; } }
  private load(): { current: Record<HuginConfigTargetId, StoredDocument>; documents: Record<string, HuginConfigCandidate>; snapshots: Record<string, { target: HuginConfigTargetId; document: StoredDocument }> } {
    const stat = lstatSync(this.#path); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("hugin-config-store-unsafe");
    try { return JSON.parse(readFileSync(this.#path, "utf8")); } catch { throw new Error("hugin-config-store-corrupt"); }
  }
  private write(state: unknown) { const temp = `${this.#path}.tmp`; const fd = openSync(temp, "w", 0o600); try { writeFileSync(fd, canonicalizeJcs(state)); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp, this.#path); const dir = openSync(resolve(this.#path, ".."), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
  read(id: HuginConfigTargetId): StoredDocument { return clone(this.load().current[id]); }
  readPayload(id: HuginConfigTargetId): ConfigPayload { return clone(this.load().current[id].payload); }
  stage(raw: unknown): HuginConfigCandidate { const candidate = validateHuginConfigCandidate(raw); const state = this.load(); state.documents[candidate.candidateDigest] = candidate; this.write(state); return clone(candidate); }
  snapshot(id: HuginConfigTargetId): { ref: string; digest: string } { const state = this.load(); const doc = state.current[id]; const ref = `ref:snapshot-${id}-${doc.digest.slice(7, 31)}`; state.snapshots[ref] = { target: id, document: doc }; this.write(state); return { ref, digest: doc.digest }; }
  /** Called only by the separately authorized R-exact recovery adapter. */
  restoreSnapshot(id: HuginConfigTargetId, ref: string, expectedDigest: string): { revision: string; digest: string } {
    const state = this.load(); const snapshot = state.snapshots[ref];
    if (!snapshot || snapshot.target !== id || snapshot.document.digest !== expectedDigest) throw new Error("hugin-config-snapshot-unavailable");
    const current = state.current[id]; if (current.digest === expectedDigest) return { revision: current.revision, digest: current.digest };
    state.current[id] = clone(snapshot.document); this.write(state); return { revision: snapshot.document.revision, digest: snapshot.document.digest };
  }
  replace(id: HuginConfigTargetId, expected: { revision: string; digest: string }, candidateDigest: string): void {
    const state = this.load(); const current = state.current[id];
    if (current.revision !== expected.revision || current.digest !== expected.digest) throw new Error("hugin-config-stale-base");
    const candidate = state.documents[candidateDigest];
    if (!candidate || candidate.targetId !== id || candidate.base.revision !== expected.revision || candidate.base.digest !== expected.digest) throw new Error("hugin-config-candidate-not-bound-to-base");
    state.current[id] = { revision: candidate.revision, payload: clone(candidate.config), digest: candidate.candidateDigest }; this.write(state);
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

// Deployment supplies its private durable root; no live directory is created by this module.

/** Read-only route selection uses a cloned canonical source, never a mutable exported map. */
export function selectHuginMacroRoute(input: { workerProvider: string; taskType: string; sensitivity: "public" | "internal" | "private" }): { nodeId: "orin"; modelId: "qwen2.5-coder:3b" } | null {
  if (input.sensitivity === "private") return null;
  const routes = macroPayload.parse(defaults["hugin-orin-macro-routing"].payload).routes;
  const matched = routes.find((entry) => entry.workerProvider === input.workerProvider && entry.taskType === input.taskType && entry.sensitivity === input.sensitivity);
  return matched ? { nodeId: matched.nodeId, modelId: matched.modelId } : null;
}
