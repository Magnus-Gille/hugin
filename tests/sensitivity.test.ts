import { describe, expect, it } from "vitest";
import {
  buildSensitivityAssessment,
  classifyContextSensitivity,
  classifyPromptSensitivity,
  getDispatcherRuntimeMaxSensitivity,
  muninClassificationToSensitivity,
  sensitivityToMuninClassification,
} from "../src/sensitivity.js";

describe("sensitivity helpers", () => {
  it("classifies local file archives and config homes conservatively", () => {
    expect(classifyContextSensitivity("files", "/home/magnus/workspace")).toBe(
      "private",
    );
    expect(
      classifyContextSensitivity(undefined, "/home/magnus/.codex/automations"),
    ).toBe("private");
    expect(
      classifyContextSensitivity("repo:hugin", "/home/magnus/repos/hugin"),
    ).toBe("internal");
  });

  it("raises prompt sensitivity on strong private-data terms", () => {
    expect(classifyPromptSensitivity("Summarize my journal and bank notes")).toBe(
      "private",
    );
    expect(classifyPromptSensitivity("Summarize release notes")).toBeUndefined();
  });

  it("ignores private-data keywords inside code blocks and namespace paths", () => {
    // Inline code — should not trigger
    expect(
      classifyPromptSensitivity("Consolidate `clients/invoices` namespace"),
    ).toBeUndefined();
    // Fenced code block — should not trigger
    expect(
      classifyPromptSensitivity("Implement:\n```\nclients/tax/returns\n```"),
    ).toBeUndefined();
    // Namespace path without backticks — should not trigger
    expect(
      classifyPromptSensitivity("Move projects/journal entries to archive"),
    ).toBeUndefined();
    // Bare keyword outside code — should still trigger
    expect(
      classifyPromptSensitivity("Send the invoice to the client"),
    ).toBe("private");
  });

  it("maps Munin classifications conservatively", () => {
    expect(muninClassificationToSensitivity("public")).toBe("public");
    expect(muninClassificationToSensitivity("internal")).toBe("internal");
    expect(muninClassificationToSensitivity("client-confidential")).toBe(
      "private",
    );
    expect(muninClassificationToSensitivity("unknown-tier")).toBe("private");
    expect(sensitivityToMuninClassification("private")).toBe(
      "client-confidential",
    );
  });

  it("builds a monotonic assessment and flags mismatches", () => {
    const assessment = buildSensitivityAssessment({
      declared: "public",
      baseline: "internal",
      refs: "private",
    });

    expect(assessment.effective).toBe("private");
    expect(assessment.mismatch).toBe(true);
    expect(assessment.reasons).toContain("declared:public");
    expect(assessment.reasons).toContain("context-refs:private");
  });

  it("treats cloud runtimes as internal-only and ollama as private-safe", () => {
    expect(getDispatcherRuntimeMaxSensitivity("claude")).toBe("internal");
    expect(getDispatcherRuntimeMaxSensitivity("codex")).toBe("internal");
    expect(getDispatcherRuntimeMaxSensitivity("ollama")).toBe("private");
  });
});
