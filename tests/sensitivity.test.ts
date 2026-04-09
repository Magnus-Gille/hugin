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

  it("still catches truly unambiguous private-data patterns", () => {
    // Vocabulary that does not appear in technical discussion
    expect(
      classifyPromptSensitivity("summarize my medical history"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("draft a salary negotiation email"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("copy the number from my passport"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("what's in my diary this week"),
    ).toBe("private");
  });

  it("suppresses credential vocabulary in technical discussion", () => {
    // Research and code work about auth systems must not trip sensitivity
    expect(
      classifyPromptSensitivity("password handling module"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("api key rotation system"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("compare bearer token management frameworks"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("private key signing service architecture"),
    ).toBeUndefined();
    // Real research-spike content from Grimnir workflows
    expect(
      classifyPromptSensitivity("Auth model (API key? OAuth? scopes?)"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity(
        "Evaluate the OAuth 2.1 and API key auth story for the managed-agents API",
      ),
    ).toBeUndefined();
    // But a bare credential reference with no technical framing still trips
    expect(
      classifyPromptSensitivity("my password is in the notes app"),
    ).toBe("private");
  });

  it("always flags secret-shaped credential strings regardless of context", () => {
    // Real credentials must trip even inside code fences or technical framing
    expect(
      classifyPromptSensitivity("rotate this token: sk-ant-1234567890abcdefghij"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity(
        "example in the docs:\n```\nghp_1234567890abcdefghijklmnopqrstuvwxyz12\n```",
      ),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("AWS key AKIA1234567890ABCDEF for the CI role"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...",
      ),
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
