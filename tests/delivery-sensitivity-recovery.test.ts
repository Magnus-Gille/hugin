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

describe("delivery recovery preserves sensitivity and grounding evidence", () => {
  it("checkpoints the exact sensitivity snapshot before delivery can crash", () => {
    const liveDelivery = sliceBetween(
      "if (deliveryEligible && task.artifactManifest)",
      "// 2. Deliver + verify.",
    );
    expect(liveDelivery).toContain("writeSensitivityCheckpoint(");
    expect(liveDelivery).toContain("taskSensitivitySnapshot");
    expect(SRC).toContain(
      "config.sensitivityCheckpointSecret.length < 32",
    );
  });

  it("persists accepted research grounding before the delivery checkpoint", () => {
    const grounding = sliceBetween(
      "let researchGroundingFailureReason",
      "const deliveryEligible",
    );
    expect(grounding).toContain('RESEARCH_GROUNDING_KEY');
    expect(grounding).toContain('JSON.stringify(validatedGrounding)');
    expect(SRC.indexOf('JSON.stringify(validatedGrounding)')).toBeLessThan(
      SRC.indexOf('if (deliveryEligible && task.artifactManifest)'),
    );
  });

  it("reuses the checkpoint in delivery reconciliation's terminal result", () => {
    const recovery = sliceBetween(
      "async function reconcileDeliveryPending(",
      "async function recoverStaleTasks(",
    );
    expect(recovery).toContain("readSensitivityCheckpoint(");
    expect(recovery).toContain("sensitivity: recoverySensitivity");
    expect(recovery).toContain("RESEARCH_GROUNDING_KEY");
    expect(recovery).toContain("parseResearchGroundingAttestation");
    expect(recovery).toContain("validateResearchGroundingAttestation");
    expect(recovery).toContain("requiredArtifactIds");
    expect(recovery).toContain("durable accepted research grounding attestation is missing or invalid");
  });
});
