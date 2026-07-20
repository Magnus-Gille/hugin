/**
 * Read view: join one task's append-only registry events into a single
 * lifecycle timeline (#232, point 6). This is the query #233's candidate
 * packager and #237's ingest are expected to build on — it resolves
 * correction chains to their effective leaf and surfaces exclusion state, but
 * still exposes the complete raw event list for callers that need full audit
 * history rather than only the current view.
 */

import type { LearningRegistryStore } from "./learning-registry-store.js";
import type {
  CorrectionEvent,
  ExclusionAdjustmentEvent,
  RegistryEvent,
} from "./learning-registry-schema.js";

export interface RegistryTimelineEntry {
  event: RegistryEvent;
  /** True when a correction event supersedes this exact event id. */
  superseded: boolean;
  /** This event's own id if unsuperseded, else the chain's unique effective leaf. */
  effectiveEventId: string;
  /** True when at least one exclusion-adjustment targets this event directly. */
  excluded: boolean;
  excludedReasons: ExclusionAdjustmentEvent["payload"]["adjustmentReason"][];
}

export interface TaskLifecycleTimeline {
  taskId: string;
  /** Primary lifecycle facts (submission/attempt-reference/terminal-outcome/publication),
   * ordered by occurredAt, each resolved to its effective (unsuperseded) state. */
  entries: RegistryTimelineEntry[];
  /** Full correction audit trail, unfiltered. */
  corrections: CorrectionEvent[];
  /** Full exclusion/erasure audit trail, unfiltered. */
  exclusionAdjustments: ExclusionAdjustmentEvent[];
  /** True when the underlying event listing could not prove completeness
   * (Munin pagination budget exhausted) — treat the timeline as provisional. */
  truncated: boolean;
}

/**
 * Resolve `eventId` forward through the correction chain to its unique
 * unsuperseded leaf. Cycles cannot occur through the store's own append path
 * (a correction's natural key is derived from its predecessor id, so at most
 * one direct child exists per predecessor), but this stays defensive against
 * a hand-assembled event list from an untrusted source.
 */
function resolveEffectiveLeaf(
  eventId: string,
  correctionByPredecessor: Map<string, CorrectionEvent>,
): string {
  let current = eventId;
  const visited = new Set<string>([current]);
  for (;;) {
    const correction = correctionByPredecessor.get(current);
    if (!correction) return current;
    if (visited.has(correction.eventId)) return current; // defensive cycle guard
    current = correction.eventId;
    visited.add(current);
  }
}

const PRIMARY_LIFECYCLE_KINDS = new Set<RegistryEvent["recordKind"]>([
  "submission",
  "attempt-reference",
  "terminal-outcome",
  "publication",
]);

export async function buildTaskLifecycleTimeline(
  store: Pick<LearningRegistryStore, "listEventsForTask">,
  taskId: string,
): Promise<TaskLifecycleTimeline> {
  const { events, truncated } = await store.listEventsForTask(taskId);

  const corrections: CorrectionEvent[] = [];
  const exclusionAdjustments: ExclusionAdjustmentEvent[] = [];
  const correctionByPredecessor = new Map<string, CorrectionEvent>();
  const exclusionsByTarget = new Map<string, ExclusionAdjustmentEvent[]>();

  for (const event of events) {
    if (event.recordKind === "correction") {
      corrections.push(event);
      correctionByPredecessor.set(event.payload.predecessorEventId, event);
    } else if (event.recordKind === "exclusion-adjustment") {
      exclusionAdjustments.push(event);
      const list = exclusionsByTarget.get(event.payload.targetEventId) ?? [];
      list.push(event);
      exclusionsByTarget.set(event.payload.targetEventId, list);
    }
  }

  const entries: RegistryTimelineEntry[] = events
    .filter((event) => PRIMARY_LIFECYCLE_KINDS.has(event.recordKind))
    .map((event) => {
      const exclusions = exclusionsByTarget.get(event.eventId) ?? [];
      return {
        event,
        superseded: correctionByPredecessor.has(event.eventId),
        effectiveEventId: resolveEffectiveLeaf(event.eventId, correctionByPredecessor),
        excluded: exclusions.length > 0,
        excludedReasons: exclusions.map((adjustment) => adjustment.payload.adjustmentReason),
      };
    })
    .sort((a, b) =>
      a.event.occurredAt.localeCompare(b.event.occurredAt)
      || a.event.eventId.localeCompare(b.event.eventId));

  return { taskId, entries, corrections, exclusionAdjustments, truncated };
}
