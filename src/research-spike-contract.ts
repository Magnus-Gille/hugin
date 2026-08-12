import type { ArtifactManifest, DeliveryPolicy } from "./artifact-delivery.js";
import type { TaskPermissionProfile } from "./sdk-executor.js";
import type { DispatcherRuntime } from "./runtime-registry.js";
import type { Sensitivity } from "./sensitivity.js";

// A research spike is materially different from an ordinary read-only task:
// its stated result is two durable documents, gathered from the web and
// delivered by Hugin.  Do not infer that those capabilities exist from a
// generic `Capabilities: tools` routing hint.  That was the false-success
// seam in #362.
const REQUIRED_RESEARCH_CAPABILITIES = [
  "web search",
  "web fetch",
  "local staging write",
  "Hugin-managed delivery",
  "Hugin-managed Munin indexing",
] as const;

export function isResearchSpike(tags: readonly string[]): boolean {
  return tags.includes("type:research");
}

export interface ResearchSpikePreflightInput {
  tags: readonly string[];
  runtime: DispatcherRuntime;
  permissionProfile: TaskPermissionProfile | undefined;
  artifactManifest: ArtifactManifest | undefined;
  deliveryPolicy: DeliveryPolicy;
  index: ResearchSpikeIndex | undefined;
  /** A verified runtime probe result for the dedicated research lane. */
  researchRuntimeFailure?: string | null;
}

export interface ResearchSpikeIndex {
  project: string;
  slug: string;
  sensitivity: Sensitivity;
}

const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Extract the Hugin-owned index coordinates from trusted task metadata. */
export function parseResearchSpikeIndex(content: string): ResearchSpikeIndex | undefined {
  const prefix = content.split(/^###\s*Prompt\s*$/im, 1)[0] ?? content;
  const project = prefix.match(/^\s*(?:-\s*)?\*\*Project:\*\*\s*(.+)$/im)?.[1]?.trim();
  const slug = prefix.match(/^\s*(?:-\s*)?\*\*Research slug:\*\*\s*(.+)$/im)?.[1]?.trim();
  const sensitivity = prefix.match(/^\s*(?:-\s*)?\*\*Sensitivity:\*\*\s*(public|internal|private|restricted)\s*$/im)?.[1];
  if (!project || !slug || !sensitivity || !IDENTIFIER.test(project) || !IDENTIFIER.test(slug)) {
    return undefined;
  }
  // `restricted` is an old research-skill spelling.  Normalize it at the
  // contract boundary rather than accidentally treating a private task as
  // internal (the dispatcher-wide vocabulary is public|internal|private).
  return { project, slug, sensitivity: sensitivity === "restricted" ? "private" : sensitivity as Sensitivity };
}

/** At least two distinct required staging files and destinations are required. */
export function hasResearchSpikeArtifactContract(
  manifest: ArtifactManifest | undefined,
): manifest is ArtifactManifest {
  const required = manifest?.artifacts.filter((artifact) => artifact.required) ?? [];
  return required.length >= 2
    && new Set(required.map((artifact) => artifact.local)).size >= 2
    && new Set(required.map((artifact) => artifact.remote)).size >= 2;
}

/**
 * Return a deterministic, operator-readable refusal before an executor is
 * claimed or invoked.  The only currently wired Agent SDK lane is deliberately
 * read-only and has no WebSearch/WebFetch tools.  No current dispatcher lane
 * advertises the complete research contract, so every research spike is
 * rejected until #363 wires and verifies a dedicated research executor.
 *
 * Keeping the capability declaration here (rather than trusting task prose)
 * prevents a task from spending a model turn and then reporting exit 0 after
 * tool denials.  Hugin retains ownership of delivery and indexing when a
 * compatible lane is introduced.
 */
export function researchSpikePreflightFailure(
  input: ResearchSpikePreflightInput,
): string | null {
  if (!isResearchSpike(input.tags)) {
    return input.runtime === "research"
      ? "Runtime research requires the type:research task tag and its full artifact/index contract"
      : null;
  }

  const required = REQUIRED_RESEARCH_CAPABILITIES.join(", ");
  // Report the executor denial first.  This is the actionable P0 condition
  // for existing Agent SDK research tasks, even when their old task envelope
  // also predates the Hugin-owned artifact/index metadata.
  if (input.runtime === "claude" && input.permissionProfile !== "trusted-code") {
    return `Research spike cannot run on claude agent-sdk read-only: missing capabilities ${required}`;
  }
  if (!input.index) {
    return "Research spike requires valid **Project:** and **Research slug:** metadata for Hugin-managed Munin indexing";
  }
  if (!hasResearchSpikeArtifactContract(input.artifactManifest)) {
    return `Research spike requires two distinct declared required artefacts for Hugin-managed delivery; missing capability contract: ${required}`;
  }
  if (input.deliveryPolicy === "off") {
    return "Research spike requires Hugin-managed artefact delivery; HUGIN_DELIVERY_POLICY=off is incompatible";
  }
  if (input.runtime === "research") {
    if (input.index.sensitivity === "private") {
      return "Research runtime cannot accept private sensitivity because its web search/fetch tools egress to public sites";
    }
    return input.researchRuntimeFailure ?? null;
  }
  return `Research spike cannot run on ${input.runtime}: no dispatcher executor currently declares verified capabilities ${required}. Route it only after the dedicated research lane is verified.`;
}

export const __test__ = { REQUIRED_RESEARCH_CAPABILITIES };
