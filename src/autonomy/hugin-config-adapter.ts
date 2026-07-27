/**
 * Strict, content-blind configuration boundary for the ADR-008 Hugin targets.
 *
 * This is deliberately an adapter/store for immutable configuration identities,
 * not a generic configuration service.  It accepts no prompt, model, gateway,
 * logging, deployment, or credential material.  R-exact application remains
 * owned by the controller; this module only exposes the bounded current base.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeJcs } from "../jcs.js";

export const HUGIN_CONFIG_ADAPTER_VERSION = "hugin-config-adapter-v1" as const;

const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-z][a-z0-9-]{2,80}$/);
const targetId = z.enum([
  "hugin-orin-macro-routing",
  "hugin-agent-prompt",
  "hugin-agent-harness",
  "hugin-tool-policy",
]);

export type HuginConfigTargetId = z.infer<typeof targetId>;
export type HuginConfigBase = { revision: string; digest: string };

const routeSchema = z.object({
  workerProvider: z.literal("homeserver"),
  taskType: z.enum(["classify", "extract"]),
  sensitivity: z.enum(["public", "internal"]),
  nodeId: z.literal("orin"),
  // This is a fixed implementation identity, not a mutable model setting.
  modelId: z.literal("qwen2.5-coder:3b"),
}).strict();

const storedConfigSchema = z.discriminatedUnion("targetId", [
  z.object({ schemaVersion: z.literal(HUGIN_CONFIG_ADAPTER_VERSION), targetId: z.literal("hugin-orin-macro-routing"), revision, routes: z.array(routeSchema).length(4) }).strict(),
  z.object({ schemaVersion: z.literal(HUGIN_CONFIG_ADAPTER_VERSION), targetId: z.literal("hugin-agent-prompt"), revision, promptTemplateDigest: sha256 }).strict(),
  z.object({ schemaVersion: z.literal(HUGIN_CONFIG_ADAPTER_VERSION), targetId: z.literal("hugin-agent-harness"), revision, harnessPolicyDigest: sha256 }).strict(),
  z.object({ schemaVersion: z.literal(HUGIN_CONFIG_ADAPTER_VERSION), targetId: z.literal("hugin-tool-policy"), revision, toolPolicyDigest: sha256 }).strict(),
]);

export type HuginStoredConfig = z.infer<typeof storedConfigSchema>;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeJcs(value)).digest("hex")}`;
}

const macroRouteConfig: HuginStoredConfig = {
  schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION,
  targetId: "hugin-orin-macro-routing",
  revision: "orin-macro-route-v1",
  routes: [
    { workerProvider: "homeserver", taskType: "classify", sensitivity: "public", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
    { workerProvider: "homeserver", taskType: "classify", sensitivity: "internal", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
    { workerProvider: "homeserver", taskType: "extract", sensitivity: "public", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
    { workerProvider: "homeserver", taskType: "extract", sensitivity: "internal", nodeId: "orin", modelId: "qwen2.5-coder:3b" },
  ],
};

/** Fixed store: only named, schema-validated content identities are observable. */
const configs: Readonly<Record<HuginConfigTargetId, HuginStoredConfig>> = Object.freeze({
  "hugin-orin-macro-routing": macroRouteConfig,
  "hugin-agent-prompt": { schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION, targetId: "hugin-agent-prompt", revision: "agent-prompt-v1", promptTemplateDigest: digest("hugin-agent-prompt-v1") },
  "hugin-agent-harness": { schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION, targetId: "hugin-agent-harness", revision: "agent-harness-v1", harnessPolicyDigest: digest("hugin-agent-harness-v1") },
  "hugin-tool-policy": { schemaVersion: HUGIN_CONFIG_ADAPTER_VERSION, targetId: "hugin-tool-policy", revision: "tool-policy-v1", toolPolicyDigest: digest("hugin-tool-policy-v1") },
});

export function readHuginConfig(target: HuginConfigTargetId): HuginStoredConfig {
  return storedConfigSchema.parse(configs[target]);
}

export function readHuginConfigBase(target: HuginConfigTargetId): HuginConfigBase {
  const config = readHuginConfig(target);
  return { revision: config.revision, digest: digest(config) };
}

/** Validate an adapter document before any caller can treat it as a target. */
export function validateHuginConfig(raw: unknown): HuginStoredConfig {
  return storedConfigSchema.parse(raw);
}

export function selectHuginMacroRoute(input: {
  workerProvider: string;
  taskType: string;
  sensitivity: "public" | "internal" | "private";
}): { nodeId: "orin"; modelId: "qwen2.5-coder:3b" } | null {
  if (input.sensitivity === "private") return null;
  const config = readHuginConfig("hugin-orin-macro-routing");
  if (config.targetId !== "hugin-orin-macro-routing") return null;
  const route = config.routes.find((candidate) =>
    candidate.workerProvider === input.workerProvider
    && candidate.taskType === input.taskType
    && candidate.sensitivity === input.sensitivity,
  );
  return route ? { nodeId: route.nodeId, modelId: route.modelId } : null;
}
