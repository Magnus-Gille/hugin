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

  it("suppresses context-sensitive keywords in technical discussion (#29)", () => {
    // Security architecture discussion
    expect(
      classifyPromptSensitivity("auth model, secret handling, sandboxing"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("secret scanning tools comparison"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("secret rotation and management best practices"),
    ).toBeUndefined();
    // Financial software discussion
    expect(
      classifyPromptSensitivity("invoice processing system design"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("compare tax calculation engine implementations"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("bank API integration architecture"),
    ).toBeUndefined();
    // System logs
    expect(
      classifyPromptSensitivity("read the systemd journal for errors"),
    ).toBeUndefined();
    // But bare keywords without technical context still trigger
    expect(
      classifyPromptSensitivity("what's in my bank account"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("check the tax return for 2025"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("summarize my journal"),
    ).toBe("private");
  });

  it("still catches unambiguous private-data patterns regardless of context", () => {
    // "password" is always private even in technical context
    expect(
      classifyPromptSensitivity("password handling module"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("api key rotation system"),
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
