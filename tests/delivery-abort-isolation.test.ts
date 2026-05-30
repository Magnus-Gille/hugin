import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// Regression guard for review finding F1 (#77 follow-up):
// The lease reaper now invokes `reconcileDeliveryPending` on its own timer,
// concurrently with the poll loop's live in-process delivery. The two paths must
// use DISTINCT AbortController module slots — if the reconcile path shared
// `currentDeliveryAbort` with the live delivery, a concurrent reconcile would
// clobber it and the live delivery could no longer be aborted by operator cancel
// or shutdown. The live path uses `currentDeliveryAbort`; the reconcile path
// (`reconcileDeliveryPending`) uses `currentReconcileAbort`; shutdown aborts both.
//
// These paths live in module-global state inside src/index.ts and are not
// individually exported, so the invariant is guarded by source inspection.

const SRC = readFileSync(
  path.join(__dirname, "..", "src", "index.ts"),
  "utf8",
);

function sliceFn(name: string, until: string): string {
  const start = SRC.indexOf(name);
  const end = SRC.indexOf(until, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("F1: reconcile-path delivery uses a separate abort slot from the live delivery", () => {
  it("declares both abort slots", () => {
    expect(SRC).toContain("let currentDeliveryAbort: AbortController | null");
    expect(SRC).toContain("let currentReconcileAbort: AbortController | null");
  });

  it("reconcileDeliveryPending uses currentReconcileAbort and NEVER currentDeliveryAbort", () => {
    const body = sliceFn(
      "async function reconcileDeliveryPending(",
      "async function recoverStaleTasks(",
    );
    expect(body).toContain("currentReconcileAbort = abort");
    expect(body).toContain("currentReconcileAbort = null");
    // The smoking gun: the reconcile path must not touch the live-delivery slot.
    expect(body).not.toContain("currentDeliveryAbort");
  });

  it("shutdown aborts BOTH the live delivery and the reconcile delivery", () => {
    // Both controllers must be torn down on shutdown so neither path can leave a
    // hung rsync running.
    expect(SRC).toContain("currentDeliveryAbort.abort()");
    expect(SRC).toContain("currentReconcileAbort.abort()");
  });
});
