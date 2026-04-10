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

  it("flags credential assignments even next to technical nouns (#35 codex review)", () => {
    // Bare "API key" mentions with a digit-containing value must trip
    expect(
      classifyPromptSensitivity("my API key is abc123"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("API key: abc123"),
    ).toBe("private");
    // Value-bearing credential lines must trip even with technical modifiers
    expect(
      classifyPromptSensitivity("rotate auth module password: hunter2"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("auth service bearer token: eyJhbGciOiJIUzI1NiJ9"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9"),
    ).toBe("private");
    // Natural-language assignment with filler between keyword and value
    expect(
      classifyPromptSensitivity("the API key for prod is sk-1234"),
    ).toBe("private");
    // Credential discussion without a value still passes
    expect(
      classifyPromptSensitivity("compare bearer token management frameworks"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("password handling module design"),
    ).toBeUndefined();
  });

  it("does not false-positive on slug-like sk- identifiers (#35 codex review)", () => {
    // All-lowercase sk- slugs without known provider prefix must not trip
    expect(
      classifyPromptSensitivity("sk-telemetry-auth-pipeline-id"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("slug: sk-user-onboarding-flow-prod"),
    ).toBeUndefined();
    // Real provider-prefixed keys still trip
    expect(
      classifyPromptSensitivity("sk-ant-api03-1234567890abcdefghij"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("sk-proj-1234567890abcdefghij"),
    ).toBe("private");
  });

  it("catches bare sk- secrets without provider prefix (#35 codex round 2)", () => {
    // Legacy/generic sk- keys with entropy (uppercase or digits) must trip
    // via the SECRET_SHAPED_PATTERNS entropy fallback
    expect(
      classifyPromptSensitivity(
        "legacy key sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
      ),
    ).toBe("private");
    expect(
      classifyPromptSensitivity(
        "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
      ),
    ).toBe("private");
    // But long all-lowercase slugs without entropy stay non-private
    expect(
      classifyPromptSensitivity(
        "sk-some-very-long-namespace-slug-without-caps-or-digits",
      ),
    ).toBeUndefined();
  });

  it("scans all credential keywords and spans line breaks (#35 codex round 2)", () => {
    // Finding 2a: value-bearing credential later in long line (first keyword
    // has no value in its window, but second keyword does)
    expect(
      classifyPromptSensitivity(
        "API key auth design and implementation notes before the prod password: hunter2",
      ),
    ).toBe("private");
    // Finding 2b: newlines between keyword and value must be normalized
    expect(
      classifyPromptSensitivity("API key rotation settings\n: abc123"),
    ).toBe("private");
    expect(
      classifyPromptSensitivity("API key for prod\nis abc123"),
    ).toBe("private");
  });

  it("rejects descriptive prose as credential assignment (#35 codex round 2)", () => {
    // Finding 3: value indicator followed by a plain English word must not trip
    expect(
      classifyPromptSensitivity("The API key is required for this endpoint."),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("The password is hashed using argon2."),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("The private key is encrypted at rest."),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("The bearer token is managed by the SDK."),
    ).toBeUndefined();
    // Placeholder syntax is also not a secret
    expect(
      classifyPromptSensitivity("password: $SECRET_VAR"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("api key: ${API_KEY}"),
    ).toBeUndefined();
    expect(
      classifyPromptSensitivity("password: <YOUR_PASSWORD>"),
    ).toBeUndefined();
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
