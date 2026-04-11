import { describe, expect, it } from "vitest";
import {
  buildSensitivityAssessment,
  classifyContextSensitivity,
  classifyPromptSensitivity,
  detectPromptSensitivity,
  getDispatcherRuntimeMaxSensitivity,
  maxSensitivity,
  muninClassificationToSensitivity,
  namespaceFallbackSensitivity,
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

  it("resists Unicode/whitespace bypasses (#35 codex round 3)", () => {
    // Tab instead of space between keyword parts
    expect(
      classifyPromptSensitivity("api\tkey: abc123"),
    ).toBe("private");
    // Non-breaking space (NBSP, U+00A0)
    expect(
      classifyPromptSensitivity("api\u00A0key: abc123"),
    ).toBe("private");
    // Zero-width space (U+200B) inside the keyword
    expect(
      classifyPromptSensitivity("api\u200Bkey: abc123"),
    ).toBe("private");
    // Zero-width space inside a known provider-prefix secret
    expect(
      classifyPromptSensitivity("sk-\u200Bproj-1234567890abcdefghij"),
    ).toBe("private");
    // Cyrillic 'а' homoglyph replacing Latin 'a' in password
    expect(
      classifyPromptSensitivity("p\u0430ssword: hunter2"),
    ).toBe("private");
    // Fullwidth ASCII should NFKC-fold to plain ASCII
    expect(
      classifyPromptSensitivity("ＡＰＩ key: abc123"),
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

  describe("detectPromptSensitivity (#36)", () => {
    it("flags secret-shaped matches as hardPrivate", () => {
      expect(
        detectPromptSensitivity("sk-ant-api03-1234567890abcdefghij"),
      ).toEqual({ sensitivity: "private", hardPrivate: true });
      expect(
        detectPromptSensitivity("AWS key AKIA1234567890ABCDEF"),
      ).toEqual({ sensitivity: "private", hardPrivate: true });
      expect(
        detectPromptSensitivity(
          "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...",
        ),
      ).toEqual({ sensitivity: "private", hardPrivate: true });
    });

    it("flags credential assignments as soft private (overridable)", () => {
      // Shape-based heuristic, not entropy — the owner should be able to
      // override these (e.g. RFC examples, documentation).
      const r = detectPromptSensitivity("API key: abc123");
      expect(r.sensitivity).toBe("private");
      expect(r.hardPrivate).toBe(false);
    });

    it("flags always-private vocabulary as soft private", () => {
      const r = detectPromptSensitivity("summarize my medical history");
      expect(r.sensitivity).toBe("private");
      expect(r.hardPrivate).toBe(false);
    });

    it("returns hardPrivate=false when nothing matches", () => {
      expect(detectPromptSensitivity("build a weather dashboard")).toEqual({
        sensitivity: undefined,
        hardPrivate: false,
      });
    });
  });

  describe("owner override (#36)", () => {
    it("caps effective at declared when override allowed and detector is soft", () => {
      const a = buildSensitivityAssessment({
        declared: "internal",
        baseline: "internal",
        prompt: "private",
        allowOwnerOverride: true,
      });
      expect(a.effective).toBe("internal");
      expect(a.mismatch).toBe(true);
      expect(a.override?.applied).toBe(true);
      expect(a.override?.detectorMax).toBe("private");
      expect(a.reasons.some((r) => r.startsWith("owner-override:"))).toBe(
        true,
      );
    });

    it("refuses to override hard-private (secret-shaped) matches", () => {
      const a = buildSensitivityAssessment({
        declared: "internal",
        baseline: "internal",
        prompt: "private",
        hardPrivate: true,
        allowOwnerOverride: true,
      });
      expect(a.effective).toBe("private");
      expect(a.mismatch).toBe(true);
      expect(a.override).toBeUndefined();
      expect(a.reasons).toContain("owner-override-blocked:hard-private");
    });

    it("ignores allowOwnerOverride without a declared value", () => {
      const a = buildSensitivityAssessment({
        baseline: "internal",
        prompt: "private",
        allowOwnerOverride: true,
      });
      expect(a.effective).toBe("private");
      expect(a.override).toBeUndefined();
    });

    it("does not apply override when detector <= declared", () => {
      const a = buildSensitivityAssessment({
        declared: "private",
        baseline: "internal",
        prompt: "internal",
        allowOwnerOverride: true,
      });
      expect(a.effective).toBe("private");
      expect(a.mismatch).toBe(false);
      expect(a.override).toBeUndefined();
    });

    it("preserves legacy monotonic behavior when override not requested", () => {
      const a = buildSensitivityAssessment({
        declared: "internal",
        baseline: "internal",
        prompt: "private",
      });
      expect(a.effective).toBe("private");
      expect(a.mismatch).toBe(true);
      expect(a.override).toBeUndefined();
    });

    it("allows owner to route a false-positive research task as internal", () => {
      // Real-world case from #36: a research spike that mentions "API key"
      // vocabulary gets flagged as private by the classifier. Owner knows
      // better and declares internal — override should kick in.
      const detection = detectPromptSensitivity(
        "Evaluate the OAuth 2.1 and API key story for the managed-agents API. The bearer token value for this example is mF_9.B5f-4.1JqM.",
      );
      const a = buildSensitivityAssessment({
        declared: "internal",
        baseline: "internal",
        prompt: detection.sensitivity,
        hardPrivate: detection.hardPrivate,
        allowOwnerOverride: true,
      });
      // Detector still tripped (credential assignment heuristic), but the
      // match is soft so owner-override lowers it to internal.
      expect(detection.sensitivity).toBe("private");
      expect(detection.hardPrivate).toBe(false);
      expect(a.effective).toBe("internal");
      expect(a.override?.applied).toBe(true);
    });

    it("blocks owner override when a real-looking secret is in the prompt", () => {
      // Counter-case: the prompt contains an actual-looking API key, so
      // detection is hard. Owner's declared=internal should be rejected.
      const detection = detectPromptSensitivity(
        "rotate this token: sk-ant-api03-1234567890abcdefghij",
      );
      expect(detection.hardPrivate).toBe(true);
      const a = buildSensitivityAssessment({
        declared: "internal",
        baseline: "internal",
        prompt: detection.sensitivity,
        hardPrivate: detection.hardPrivate,
        allowOwnerOverride: true,
      });
      expect(a.effective).toBe("private");
      expect(a.override).toBeUndefined();
    });
  });

  describe("tasks/* namespace floor clamping", () => {
    // Regression: an owner-override task with effective sensitivity "public"
    // used to produce a Munin write at classification "public", which Munin
    // rejects below the `tasks/*` floor of `internal`. Hugin silently
    // swallowed the rejection, leaving the task stuck as `running` forever.
    // The fix clamps artifact classification up to the namespace floor.
    it("clamps public effective sensitivity up to the tasks/* floor", () => {
      const floor = namespaceFallbackSensitivity("tasks/");
      expect(floor).toBe("internal");
      expect(maxSensitivity("public", floor)).toBe("internal");
      expect(sensitivityToMuninClassification(maxSensitivity("public", floor))).toBe(
        "internal",
      );
    });

    it("preserves private effective sensitivity through the clamp", () => {
      const floor = namespaceFallbackSensitivity("tasks/");
      expect(maxSensitivity("private", floor)).toBe("private");
      expect(sensitivityToMuninClassification(maxSensitivity("private", floor))).toBe(
        "client-confidential",
      );
    });
  });
});
