import { describe, expect, it } from "vitest";
import {
  deriveAwaitObservation,
  type AwaitObservation,
} from "../../src/broker/await-observation.js";

const SUBMIT = "session-A";

describe("deriveAwaitObservation", () => {
  it("records the first await and marks it as a change worth persisting", () => {
    const { next, changed } = deriveAwaitObservation(null, {
      sessionId: SUBMIT,
      at: "2026-07-12T10:00:00Z",
      lifecycle: "running",
      submitSessionId: SUBMIT,
    });
    expect(changed).toBe(true);
    expect(next.submitSessionId).toBe(SUBMIT);
    expect(next.awaitSessionIds).toEqual([SUBMIT]);
    expect(next.firstAwaitAt).toBe("2026-07-12T10:00:00Z");
    expect(next.terminalCollected).toBe(false);
    expect(next.durableHandoff).toBe(false);
  });

  // The write path is fire-and-forget on a HOT path (every poll of hugin_await
  // hits it). Re-polling from the same session with no state change must NOT
  // trigger a Munin write, or a client polling every 2s would hammer the store.
  it("does not report a change when the same session re-polls the same lifecycle", () => {
    const first = deriveAwaitObservation(null, {
      sessionId: SUBMIT, at: "2026-07-12T10:00:00Z", lifecycle: "running", submitSessionId: SUBMIT,
    }).next;

    const { next, changed } = deriveAwaitObservation(first, {
      sessionId: SUBMIT, at: "2026-07-12T10:00:30Z", lifecycle: "running", submitSessionId: SUBMIT,
    });
    expect(changed).toBe(false);
    // lastAwaitAt still advances in the derived value; it just isn't worth a write.
    expect(next.lastAwaitAt).toBe("2026-07-12T10:00:30Z");
  });

  it("marks terminalCollected when an await observes a terminal lifecycle", () => {
    const first = deriveAwaitObservation(null, {
      sessionId: SUBMIT, at: "2026-07-12T10:00:00Z", lifecycle: "running", submitSessionId: SUBMIT,
    }).next;

    const { next, changed } = deriveAwaitObservation(first, {
      sessionId: SUBMIT, at: "2026-07-12T10:05:00Z", lifecycle: "completed", submitSessionId: SUBMIT,
    });
    expect(changed).toBe(true);
    expect(next.terminalCollected).toBe(true);
    // Same session collected it — the submitting L1 session was still alive, so
    // this does NOT evidence durable value.
    expect(next.durableHandoff).toBe(false);
  });

  // THE #165 gate signal: a LATER session collected a terminal result the
  // submitting session never saw. That is the durable macro-broker earning its
  // keep — the work outlived the conductor that asked for it.
  it("marks durableHandoff when a different session collects the terminal result", () => {
    const first = deriveAwaitObservation(null, {
      sessionId: SUBMIT, at: "2026-07-12T10:00:00Z", lifecycle: "running", submitSessionId: SUBMIT,
    }).next;

    const { next, changed } = deriveAwaitObservation(first, {
      sessionId: "session-B", at: "2026-07-12T11:00:00Z", lifecycle: "completed", submitSessionId: SUBMIT,
    });
    expect(changed).toBe(true);
    expect(next.durableHandoff).toBe(true);
    expect(next.terminalCollected).toBe(true);
    expect(next.awaitSessionIds).toEqual([SUBMIT, "session-B"]);
  });

  it("does not claim durableHandoff for a different session that only saw it running", () => {
    const { next } = deriveAwaitObservation(null, {
      sessionId: "session-B", at: "2026-07-12T11:00:00Z", lifecycle: "running", submitSessionId: SUBMIT,
    });
    // A second session peeked while it was still running — no terminal result
    // was collected, so nothing is proven yet.
    expect(next.durableHandoff).toBe(false);
    expect(next.terminalCollected).toBe(false);
  });

  it("treats failed and cancelled as terminal collections too", () => {
    for (const lifecycle of ["failed", "cancelled"] as const) {
      const { next } = deriveAwaitObservation(null, {
        sessionId: "session-B", at: "2026-07-12T11:00:00Z", lifecycle, submitSessionId: SUBMIT,
      });
      expect(next.terminalCollected).toBe(true);
      expect(next.durableHandoff).toBe(true);
    }
  });

  it("never un-sets durableHandoff once proven", () => {
    const proven = deriveAwaitObservation(null, {
      sessionId: "session-B", at: "2026-07-12T11:00:00Z", lifecycle: "completed", submitSessionId: SUBMIT,
    }).next;

    const { next, changed } = deriveAwaitObservation(proven, {
      sessionId: SUBMIT, at: "2026-07-12T12:00:00Z", lifecycle: "completed", submitSessionId: SUBMIT,
    });
    expect(next.durableHandoff).toBe(true); // monotonic — evidence is not retracted
    expect(changed).toBe(true); // a new session id was added to the set
  });

  it("caps the session-id set so a hostile client cannot grow the document unboundedly", () => {
    let obs: AwaitObservation | null = null;
    for (let i = 0; i < 50; i++) {
      obs = deriveAwaitObservation(obs, {
        sessionId: `session-${i}`, at: "2026-07-12T10:00:00Z", lifecycle: "running", submitSessionId: SUBMIT,
      }).next;
    }
    expect(obs!.awaitSessionIds.length).toBeLessThanOrEqual(8);
  });

  it("tolerates a missing session id from a legacy client without claiming evidence", () => {
    const { next } = deriveAwaitObservation(null, {
      sessionId: null, at: "2026-07-12T10:00:00Z", lifecycle: "completed", submitSessionId: SUBMIT,
    });
    // An old hugin-mcp that sends no session id cannot prove a cross-session
    // handoff. Record the collection, claim nothing.
    expect(next.terminalCollected).toBe(true);
    expect(next.durableHandoff).toBe(false);
  });

  it("claims nothing when the submitting session is unknown", () => {
    const { next } = deriveAwaitObservation(null, {
      sessionId: "session-B", at: "2026-07-12T10:00:00Z", lifecycle: "completed", submitSessionId: null,
    });
    expect(next.durableHandoff).toBe(false);
  });
});
