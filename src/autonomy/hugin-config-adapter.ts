/**
 * The only concrete Hugin-owned R-exact configuration adapters (ADR-008).
 *
 * Candidate documents live in this local, owner-controlled store; receipts and
 * journals contain only their SHA-256 digest.  This deliberately does not
 * provide a generic config writer or any Gille/deployment/auth surface.
 */
import { createHash } from "node:crypto";
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
const promptPayload = z.object({ systemPrompt: z.string().min(1).max(4_096) }).strict();
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
  // These source-owned defaults are safe local config payloads, never receipt/journal content.
  "hugin-agent-prompt": { revision: "agent-prompt-v1", payload: { systemPrompt: "Complete the bounded Hugin task using only its granted context." } },
  "hugin-agent-harness": { revision: "agent-harness-v1", payload: { allowedHarnesses: ["pi", "opencode"] } },
  "hugin-tool-policy": { revision: "tool-policy-v1", payload: { allowedTools: ["read", "write", "shell"] } },
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
  #current = new Map<HuginConfigTargetId, StoredDocument>();
  #documents = new Map<string, HuginConfigCandidate>();
  #snapshots = new Map<string, StoredDocument>();
  constructor() { for (const id of targetId.options) this.#current.set(id, initialDocument(defaults[id])); }
  read(id: HuginConfigTargetId): StoredDocument { return clone(this.#current.get(id)!); }
  readPayload(id: HuginConfigTargetId): ConfigPayload { return clone(this.#current.get(id)!.payload); }
  stage(raw: unknown): HuginConfigCandidate { const candidate = validateHuginConfigCandidate(raw); this.#documents.set(candidate.candidateDigest, candidate); return clone(candidate); }
  snapshot(id: HuginConfigTargetId): { ref: string; digest: string } { const doc = this.read(id); const ref = `ref:snapshot-${doc.digest.slice(7, 31)}`; this.#snapshots.set(ref, doc); return { ref, digest: doc.digest }; }
  /** Called only by the separately authorized R-exact recovery adapter. */
  restoreSnapshot(id: HuginConfigTargetId, ref: string, expectedDigest: string): { revision: string; digest: string } {
    const snapshot = this.#snapshots.get(ref);
    if (!snapshot || snapshot.digest !== expectedDigest) throw new Error("hugin-config-snapshot-unavailable");
    this.#current.set(id, clone(snapshot));
    return { revision: snapshot.revision, digest: snapshot.digest };
  }
  replace(id: HuginConfigTargetId, expected: { revision: string; digest: string }, candidateDigest: string): void {
    const current = this.#current.get(id)!;
    if (current.revision !== expected.revision || current.digest !== expected.digest) throw new Error("hugin-config-stale-base");
    const candidate = this.#documents.get(candidateDigest);
    if (!candidate || candidate.targetId !== id || candidate.base.revision !== expected.revision || candidate.base.digest !== expected.digest) throw new Error("hugin-config-candidate-not-bound-to-base");
    this.#current.set(id, { revision: candidate.revision, payload: clone(candidate.config), digest: candidate.candidateDigest });
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

export function createHuginConfigTargets(store = new HuginConfigStore()): Record<HuginConfigTargetId, RExactConfigTarget> {
  return {
    "hugin-orin-macro-routing": new HuginTarget("hugin-orin-macro-routing", store),
    "hugin-agent-prompt": new HuginTarget("hugin-agent-prompt", store),
    "hugin-agent-harness": new HuginTarget("hugin-agent-harness", store),
    "hugin-tool-policy": new HuginTarget("hugin-tool-policy", store),
  };
}

const productionStore = new HuginConfigStore();
export const huginConfigTargets = createHuginConfigTargets(productionStore);
export function stageHuginConfigCandidate(raw: unknown): HuginConfigCandidate { return productionStore.stage(raw); }
/** Recovery-only composition seam; journals retain only the snapshot ref/digest. */
export function restoreHuginConfigSnapshot(target: HuginConfigTargetId, ref: string, digest: string) { return productionStore.restoreSnapshot(target, ref, digest); }

/** Read-only route selection uses a cloned canonical source, never a mutable exported map. */
export function selectHuginMacroRoute(input: { workerProvider: string; taskType: string; sensitivity: "public" | "internal" | "private" }): { nodeId: "orin"; modelId: "qwen2.5-coder:3b" } | null {
  if (input.sensitivity === "private") return null;
  const payload = productionStore.readPayload("hugin-orin-macro-routing");
  const routes = macroPayload.parse(payload).routes;
  const matched = routes.find((entry) => entry.workerProvider === input.workerProvider && entry.taskType === input.taskType && entry.sensitivity === input.sensitivity);
  return matched ? { nodeId: matched.nodeId, modelId: matched.modelId } : null;
}
