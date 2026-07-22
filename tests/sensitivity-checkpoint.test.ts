import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  buildSensitivityCheckpoint,
  parseSensitivityCheckpoint,
} from "../src/sensitivity-checkpoint.js";

const childContent = `## Task: generated phase

- **Runtime:** ollama
- **Submitted by:** hugin
- **Pipeline:** parent-1
- **Pipeline phase:** review
- **Pipeline submitted by:** ratatoskr
- **Sensitivity:** internal

### Prompt
Review the invoice.`;
const childNamespace = "tasks/parent-1-review";

const mismatch = {
  declared: "internal" as const,
  effective: "private" as const,
  mismatch: true,
  detectorMax: "private" as const,
  reasons: ["declared:internal", "prompt:private"],
};

describe("trusted sensitivity checkpoints", () => {
  it("round-trips only for the exact generated task content", () => {
    const checkpoint = buildSensitivityCheckpoint(
      childNamespace,
      childContent,
      mismatch,
    );
    expect(
      parseSensitivityCheckpoint(checkpoint, childNamespace, childContent),
    ).toEqual(mismatch);
    expect(
      parseSensitivityCheckpoint(
        checkpoint,
        childNamespace,
        childContent.replace("ratatoskr", "claude-code"),
      ),
    ).toBeUndefined();
    expect(
      parseSensitivityCheckpoint(checkpoint, "tasks/replayed", childContent),
    ).toBeUndefined();
  });

  it("rejects free-form task prose without a Hugin checkpoint envelope", () => {
    expect(
      parseSensitivityCheckpoint(
        JSON.stringify(mismatch),
        childNamespace,
        childContent,
      ),
    ).toBeUndefined();
    expect(
      parseSensitivityCheckpoint("not-json", childNamespace, childContent),
    ).toBeUndefined();
  });

  it("never grants owner override authority from parsed pipeline prose", () => {
    const dispatcher = readFileSync(
      path.join(__dirname, "..", "src", "index.ts"),
      "utf8",
    );
    const start = dispatcher.indexOf("function getTaskSensitivityAssessment(");
    const end = dispatcher.indexOf("function getTaskRuntimeLabel(", start);
    const assessment = dispatcher.slice(start, end);
    expect(assessment).toContain(
      "allowOwnerOverride: !task.pipeline && isOwnerSubmitter(task.submittedBy)",
    );
    expect(assessment).not.toContain("task.pipeline?.submittedBy");
  });
});
