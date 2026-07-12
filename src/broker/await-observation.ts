/**
 * Durable-handoff evidence for the #165 role-validation trial (issue #164).
 *
 * The trial gate asks for "at least 5 tasks complete after the initiating L1
 * session closes" — the criterion that decides whether a *durable* macro-broker
 * earns its keep, as opposed to a synchronous call the conductor could have made
 * itself. Nothing in Hugin recorded it: `/v1/delegate/await` only ever READ
 * state, so there was no await log, no session-closed event, and no way to tell
 * whether a result outlived the session that asked for it.
 *
 * We cannot observe an L1 session *closing* — Claude Code sessions don't
 * announce their death, and absence of polling is not proof of it. So we record
 * the conservative, positively-observable proxy instead:
 *
 *   **durableHandoff** — a terminal result was collected by an
 *   `orchestrator_session_id` DIFFERENT from the one that submitted the task.
 *
 * A different MCP process (hence a different session id, minted at server
 * startup) collecting the result means the original conductor is gone and the
 * work outlived it. That is strictly stronger evidence than "the session
 * closed": it shows the durability was not merely available but actually USED.
 * It under-counts rather than over-counts — a task that completed after its
 * session died but was never collected is real durability we don't claim. State
 * the proxy honestly in the panel; never present it as a direct measurement of
 * session closure.
 *
 * Monotonic: evidence is added, never retracted.
 */

/** Lifecycle values an await can observe. */
export type AwaitLifecycle =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting-approval"
  | "unknown";

const TERMINAL: ReadonlySet<AwaitLifecycle> = new Set<AwaitLifecycle>([
  "completed",
  "failed",
  "cancelled",
]);

/** Bound the stored set — an await is client-driven, so this is untrusted growth. */
const MAX_SESSION_IDS = 8;

export interface AwaitObservation {
  schemaVersion: 1;
  /** The session that submitted the task, from the stored envelope. */
  submitSessionId: string | null;
  /** Distinct sessions that have awaited this task (capped). */
  awaitSessionIds: string[];
  firstAwaitAt: string;
  lastAwaitAt: string;
  /** At least one await saw the task in a terminal state. */
  terminalCollected: boolean;
  /** A session OTHER than the submitter collected a terminal result. */
  durableHandoff: boolean;
}

export interface AwaitEvent {
  /** Awaiting session. Null for a legacy client that sends none. */
  sessionId: string | null;
  at: string;
  lifecycle: AwaitLifecycle;
  /** Submitting session, from the envelope. Null when unknown. */
  submitSessionId: string | null;
}

/**
 * Fold an await into the stored observation.
 *
 * `changed` reports whether the new value is worth PERSISTING. The await
 * endpoint is a hot polling path, so a same-session re-poll that reveals nothing
 * new must not trigger a Munin write — only genuinely new evidence (a first
 * observation, a new session id, a first terminal collection, or a newly proven
 * handoff) is. `lastAwaitAt` alone deliberately does not count as a change.
 */
export function deriveAwaitObservation(
  prev: AwaitObservation | null,
  event: AwaitEvent
): { next: AwaitObservation; changed: boolean } {
  const isTerminal = TERMINAL.has(event.lifecycle);

  // The handoff is proven only when a KNOWN, DIFFERENT session collects a
  // terminal result. Unknown session (legacy client) or unknown submitter
  // proves nothing — claim nothing.
  const provesHandoff =
    isTerminal &&
    event.sessionId !== null &&
    event.submitSessionId !== null &&
    event.sessionId !== event.submitSessionId;

  const priorSessions = prev?.awaitSessionIds ?? [];
  const isNewSession =
    event.sessionId !== null &&
    !priorSessions.includes(event.sessionId) &&
    priorSessions.length < MAX_SESSION_IDS;

  const awaitSessionIds = isNewSession
    ? [...priorSessions, event.sessionId as string]
    : priorSessions;

  const terminalCollected = (prev?.terminalCollected ?? false) || isTerminal;
  const durableHandoff = (prev?.durableHandoff ?? false) || provesHandoff;

  const next: AwaitObservation = {
    schemaVersion: 1,
    submitSessionId: event.submitSessionId ?? prev?.submitSessionId ?? null,
    awaitSessionIds,
    firstAwaitAt: prev?.firstAwaitAt ?? event.at,
    lastAwaitAt: event.at,
    terminalCollected,
    durableHandoff,
  };

  const changed =
    prev === null ||
    isNewSession ||
    terminalCollected !== prev.terminalCollected ||
    durableHandoff !== prev.durableHandoff;

  return { next, changed };
}
