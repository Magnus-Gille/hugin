import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// Delivery recovery lives inside the dispatcher module and is not independently
// exported. Guard the two durability seams together: the live path must persist
// the already-computed content-blind snapshot before marking delivery pending,
// and reconciliation must reuse that exact snapshot in the terminal result.
const SRC = readFileSync(
  path.join(__dirname, "..", "src", "index.ts"),
  "utf8",
);

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("delivery recovery preserves sensitivity evidence (#280)", () => {
  it("checkpoints the exact sensitivity snapshot before delivery can crash", () => {
    const liveDelivery = sliceBetween(
      "if (deliveryEligible && task.artifactManifest)",
      "// 2. Deliver + verify.",
    );
    expect(liveDelivery).toContain("writeSensitivityCheckpoint(");
    expect(liveDelivery).toContain("taskSensitivitySnapshot");
  });

  it("reuses the checkpoint in delivery reconciliation's terminal result", () => {
    const recovery = sliceBetween(
      "async function reconcileDeliveryPending(",
      "async function recoverStaleTasks(",
    );
    expect(recovery).toContain("readSensitivityCheckpoint(");
    expect(recovery).toContain("sensitivity: recoverySensitivity");
  });
});
