/**
 * Munin retrieval row schema for the procedural-retrieval subsystem (A4 / #81).
 *
 * One row per skill profile, stored at:
 *   skills/<skill-id>/retrieval
 * Tagged: procedural-retrieval, skill:<id>, task-class:<classId>,
 *         route-state:<bindingState>, sensitivity:<level>
 *
 * This schema is SECURITY-LOAD-BEARING:
 *   - hardNegatives are exclusion rules; a prompt-digest match disqualifies
 *     the row from selection entirely (not just a score penalty).
 *   - bindingState mirrors the RouteBinding lifecycle for fast fail-close
 *     without a second Munin read.
 *   - evalConfidence feeds the confidence threshold that gates local routing.
 */

import { z } from "zod";
import {
  lifecycleStateSchema,
  egressClassSchema,
  sha256HexSchema,
} from "./refs.js";

export const proceduralRetrievalRowSchema = z.object({
  schemaVersion: z.literal(1),

  /** Skill identifier — matches the `skills/<skillId>/...` namespace. */
  skillId: z.string().min(1),

  /** Profile identifier — which compiled profile this row represents. */
  profileId: z.string().min(1),

  /**
   * SHA-256 content hash of the compiled profile.
   * Used for drift detection: if the hash has changed the binding is stale.
   */
  profileHash: sha256HexSchema,

  /**
   * Task class this skill handles.  Primary retrieval key — server-side tag
   * filter uses `task-class:<taskClassId>` to keep the candidate set small.
   */
  taskClassId: z.string().min(1),

  /**
   * Short phrases that describe when this skill should be triggered.
   * Used for trigger-phrase scoring when the Munin query score is absent.
   * At least one entry required.
   */
  triggerPhrases: z.array(z.string().min(1)).min(1),

  /** Input field names that must be present before this skill can run. */
  requiredInputs: z.array(z.string()),

  /** Exact tool names the skill requires to be available. */
  requiredTools: z.array(z.string()),

  /** Human-readable conditions under which this skill must NOT be used. */
  contraindications: z.array(z.string()),

  /**
   * Hard-negative look-alike patterns.
   * A prompt-digest that matches ANY entry here MUST NOT be selected — the
   * candidate is dropped entirely before scoring and threshold checks.
   * At least one entry required (enforces that authors think about near-misses).
   */
  hardNegatives: z.array(z.string().min(1)).min(1),

  /**
   * Egress class: how far the skill may reach outside the local machine.
   * Must be consistent with the bound cell and binding fallback policy.
   */
  egressClass: egressClassSchema,

  /** Expected output artifact types this skill produces. */
  expectedArtifacts: z.array(z.string()),

  /**
   * Confidence score from the active ValidationRun (0–1 inclusive).
   * Below `RetrievalConfig.confidenceThreshold` → abstain.
   */
  evalConfidence: z.number().min(0).max(1),

  /** Known failure modes from past ValidationRuns — informational. */
  knownFailureModes: z.array(z.string()),

  /**
   * Back-reference to the RouteBinding that produced this row.
   * Used for `not-selectable` / stale checks and `RouteDecision` recording.
   */
  bindingId: z.string().min(1),

  /**
   * Mirror of the RouteBinding lifecycle state at last write.
   * Only `"active"` is selectable.  Any other value → not-selectable outcome.
   * Fail-closed: an unknown/future state is also not selectable.
   */
  bindingState: lifecycleStateSchema,
});

export type ProceduralRetrievalRow = z.infer<typeof proceduralRetrievalRowSchema>;
