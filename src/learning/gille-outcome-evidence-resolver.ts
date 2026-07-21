/**
 * Evidence resolver for the #266 gille outcome-export leg (hugin#272).
 *
 * `experiment-outcome-export.ts`'s module doc comment names the gap this
 * closes: gille-inference#8's import contract requires each arm to carry a
 * raw `prompt` string and a nine-field `evidenceIdentity` bundle, but
 * Hugin's own `LearningExperimentState`/`RecordedLearningObservation` are
 * deliberately content-blind (digests only, never raw prompt bytes) -- BY
 * DESIGN, so the registry itself never has to store raw content. That module
 * therefore accepts an optional, pluggable `GilleOutcomeEvidenceResolver`;
 * until now nothing implemented one, so the cadence tick's export leg always
 * recorded `"skipped: evidence-resolver-or-export-port-not-configured"`.
 *
 * This module reconstructs the required evidence AT EXPORT TIME, per
 * observation, from the original durable sources -- never from the registry
 * (which stays content-blind) and never fabricated:
 *
 *   - `prompt`: the Broker task envelope's own `prompt` field, durably held
 *     at `tasks/<taskId>` / `status` (the task's OWN original submission
 *     document -- not a copy this module makes, and not something the
 *     registry or experiment store ever holds). Requires
 *     `observation.task_id`; a sample without one cannot be anchored to a
 *     real source and is left unresolved.
 *   - `evidenceIdentity`: derived from the SAME admitted
 *     `LearningTaskExecutionEvidence` row (`admitted-attempt-evidence.ts`,
 *     shared with `candidate-pool-assembler.ts`) that already proves this
 *     attempt's prompt/harness/tool-policy identity, following exactly the
 *     field mapping gille-inference's own `evidenceIdentityFromAdmittedStamp`
 *     (src/homeserver/evidence-identity.ts) uses for the fields Hugin's
 *     stamp genuinely carries (`logicalTask`, `renderedPrompt`, `harness`,
 *     `toolPolicy`, `taxonomyVersion`). `modelArtifact`/`configEpoch` are
 *     gille/M5-side SERVER-OBSERVED facts (the exact llama-swap process
 *     identity currently serving the model) that Hugin has no visibility
 *     into at all -- honestly `{kind: "unknown", reason: "not-observed"}`,
 *     never guessed. `verifierRubric` comes from the effective quality
 *     receipt's own `rubric` (schemaVersion 2 only; a legacy schemaVersion-1
 *     receipt carries none, so this field is `unknown("legacy")`).
 *     `sampling` comes from the arm's own resolved `LearningConfiguration`
 *     model config when non-empty (real, if the candidate pool ever supplies
 *     one), else `unknown("not-observed")`. `lane` is always `"delegate"` --
 *     the only lane this resolver handles requires an admitted
 *     LearningTaskContract stamp, which is specific to the M5 `/delegate`
 *     flow (`learning-task-handshake.ts`).
 *   - `verifier`: mapped from `observation.verifier` (mechanical -> a
 *     deterministic verifier; human -> human; judge -> `advisory-judge`,
 *     never overclaiming `calibrated-judge`, since Hugin does not track
 *     calibration evidence). An observation with `verifier.kind === "none"`
 *     genuinely has no verifier evidence to attribute -- this module treats
 *     the WHOLE sample as unresolved rather than inventing a required
 *     `VerifierIdentityWire` for a verifier that never ran (`verifier` is a
 *     mandatory field of `GilleOutcomeArmEvidence`, unlike gille's own wire
 *     schema, which allows its outright absence).
 *   - `exposure`: a fixed, honest `{contaminationStatus: "coverage-incomplete"}`
 *     -- Hugin does not yet durably track sample-level contamination status;
 *     this is the weakest ("we cannot fully attest") value, never the
 *     stronger "clean" claim.
 *   - `review`: deliberately OMITTED. Hugin's richer `product_outcome`
 *     taxonomy (accepted-unchanged/minor-edit/major-rewrite/discarded/
 *     unrated) and gille's narrower one (accepted/rejected/conflicted/
 *     unrated) do not map cleanly, and Hugin does not track per-observation
 *     reviewer independence -- inventing that mapping risks overclaiming.
 *     Named, deliberate simplification; a future ticket can add it once a
 *     faithful mapping exists.
 *   - `policyEpoch`: the observation's own `configuration_fingerprint` -- a
 *     real, content-derived identity of the exact configuration in force for
 *     this arm.
 *
 * Per-experiment / per-sample, not global: `buildOutcomeExportBundle`
 * already drops any observation this resolver returns `null` for from the
 * export bundle (recording it in `unresolvedSamples`) rather than failing
 * the whole experiment's export -- exactly #272's required semantics.
 */

import type { MuninClient } from "../munin-client.js";
import type { LearningRegistryStore } from "../learning-registry-store.js";
import { buildTaskLifecycleTimeline } from "../learning-registry-view.js";
import { namespaceForTaskId, parseStoredEnvelope } from "../broker/task-store.js";
import { jcsDigestHex } from "../learning-registry-schema.js";
import type {
  LearningExperimentState,
  RecordedLearningObservation,
} from "./experiment-schema.js";
import type {
  EvidenceIdentityWire,
  ExposureIdentityWire,
  GilleOutcomeArmEvidence,
  GilleOutcomeEvidenceResolver,
  IdentityField,
  IdentityOrigin,
  IdentityUnknownReason,
  VerifierIdentityWire,
} from "./experiment-outcome-export.js";
import { resolveAdmittedAttemptOutcomeEvidence } from "./admitted-attempt-evidence.js";
import { resolveEffectiveQualityReceipt } from "./quality-receipt-resolution.js";

export interface GilleOutcomeEvidenceResolverDeps {
  munin: Pick<MuninClient, "read">;
  registry: Pick<LearningRegistryStore, "listEventsForTask">;
}

const STAMP_ORIGIN: IdentityOrigin = "learning-task-stamp";

function digestField(input: { id: string; version: string; digest: string }): IdentityField {
  return { kind: "digest", id: input.id, version: input.version, digest: input.digest, origin: STAMP_ORIGIN };
}

function labelField(label: string, origin: IdentityOrigin = STAMP_ORIGIN): IdentityField {
  return { kind: "label", label, origin };
}

function unknownField(reason: IdentityUnknownReason, detail?: string): IdentityField {
  return detail === undefined ? { kind: "unknown", reason } : { kind: "unknown", reason, detail };
}

const EXPOSURE_UNKNOWN: ExposureIdentityWire = { contaminationStatus: "coverage-incomplete" };

function buildEvidenceIdentity(input: {
  stamp: NonNullable<Awaited<ReturnType<typeof resolveAdmittedAttemptOutcomeEvidence>>>["requestStamp"];
  rubric: unknown;
  modelConfig: Record<string, unknown>;
}): EvidenceIdentityWire {
  const stamp = input.stamp;
  if (!stamp) {
    throw new Error("m5-admitted evidence is missing its request stamp");
  }
  return {
    modelArtifact: unknownField(
      "not-observed",
      "Hugin has no visibility into the M5 gateway's local serving-process identity",
    ),
    configEpoch: unknownField(
      "not-observed",
      "Hugin has no visibility into the M5 gateway's serving-configuration epoch",
    ),
    logicalTask: digestField({
      id: stamp.raw_input.source_ref,
      version: stamp.raw_input.source_version,
      digest: stamp.raw_input.digest,
    }),
    renderedPrompt: digestField({
      id: stamp.hugin_envelope.source_ref,
      version: stamp.hugin_envelope.source_version,
      digest: stamp.hugin_envelope.digest,
    }),
    harness: digestField({
      id: stamp.origin_config.harness.id,
      version: stamp.origin_config.harness.version,
      digest: stamp.origin_config.harness.config_digest.digest,
    }),
    taxonomyVersion: labelField(`${stamp.task_type.taxonomy_id}@${stamp.task_type.taxonomy_version}`),
    verifierRubric: input.rubric !== undefined
      ? digestField({ id: "quality-receipt-rubric", version: "v2", digest: jcsDigestHex(input.rubric) })
      : unknownField("legacy", "the effective quality receipt for this attempt carries no rubric (schemaVersion 1)"),
    sampling: Object.keys(input.modelConfig).length > 0
      ? digestField({ id: "model-config", version: "resolved", digest: jcsDigestHex(input.modelConfig) })
      : unknownField("not-observed", "Hugin does not durably record per-task model sampling parameters"),
    toolPolicy: digestField({
      id: stamp.origin_config.tool_policy.id,
      version: stamp.origin_config.tool_policy.version,
      digest: stamp.origin_config.tool_policy.config_digest.digest,
    }),
    lane: "delegate",
  };
}

function buildVerifier(verifier: RecordedLearningObservation["verifier"]): VerifierIdentityWire | null {
  if (verifier.kind === "none") return null;
  const mode: VerifierIdentityWire["mode"] =
    verifier.kind === "mechanical" ? "deterministic"
    : verifier.kind === "human" ? "human"
    // Hugin does not track calibration evidence for a "judge" verifier -- never
    // overclaim "calibrated-judge" without it.
    : "advisory-judge";
  return {
    name: verifier.id ?? verifier.kind,
    independent: verifier.independent,
  mode,
  };
}

/**
 * Build the pluggable resolver `experiment-cadence.ts` injects as
 * `deps.evidenceResolver`. Read-only over Munin and the #232 registry.
 */
export function createGilleOutcomeEvidenceResolver(
  deps: GilleOutcomeEvidenceResolverDeps,
): GilleOutcomeEvidenceResolver {
  return {
    async resolveArmEvidence(input: {
      experiment: LearningExperimentState;
      observation: RecordedLearningObservation;
    }): Promise<GilleOutcomeArmEvidence | null> {
      const { experiment, observation } = input;
      const taskId = observation.task_id;
      if (!taskId) return null;

      if (observation.verifier.kind === "none") return null;
      const verifier = buildVerifier(observation.verifier);
      if (!verifier) return null;

      const statusEntry = await deps.munin.read(namespaceForTaskId(taskId), "status");
      if (!statusEntry) return null;
      const envelope = parseStoredEnvelope(statusEntry.content);
      if (!envelope || !envelope.prompt) return null;

      const timeline = await buildTaskLifecycleTimeline(deps.registry, taskId);
      if (timeline.truncated) return null;
      const outcomeEntry = timeline.entries.find(
        (entry) => entry.event.recordKind === "terminal-outcome" && !entry.superseded && !entry.excluded,
      );
      if (!outcomeEntry || outcomeEntry.event.recordKind !== "terminal-outcome") return null;
      const attemptOutcomeRef = outcomeEntry.event.payload.attemptOutcomeRef;
      if (!attemptOutcomeRef) return null;

      const attemptId = outcomeEntry.event.attemptId;
      const evidence = await resolveAdmittedAttemptOutcomeEvidence(deps.munin, attemptOutcomeRef, { taskId, attemptId });
      if (!evidence || !evidence.requestStamp) return null;
      const receipt = await resolveEffectiveQualityReceipt(deps.munin, taskId, attemptId);
      if (!receipt) return null;

      const configuration = observation.arm === "champion" ? experiment.champion : experiment.challenger;
      const evidenceIdentity = buildEvidenceIdentity({
        stamp: evidence.requestStamp,
        rubric: receipt.schemaVersion === 2 ? receipt.rubric : undefined,
        modelConfig: configuration.model.config,
      });

      const nodeId = outcomeEntry.event.payload.delegation?.nodeId;
      const validNodeId = nodeId === "m5" || nodeId === "orin" ? nodeId : undefined;

      return {
        prompt: envelope.prompt,
        evidenceIdentity,
        verifier,
        exposure: EXPOSURE_UNKNOWN,
        policyEpoch: observation.configuration_fingerprint,
        ...(validNodeId ? { nodeId: validNodeId } : {}),
      };
    },
  };
}
