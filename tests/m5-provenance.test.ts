import { describe, expect, it } from "vitest";
import { extractM5Provenance, sanitizeProviderTokenCount } from "../src/m5-provenance.js";

// Verbatim shape of a real M5 gateway /delegate response, captured live from
// the tailnet gateway on 2026-07-11. Ground truth for what we must preserve.
const LIVE_M5_RESPONSE = {
  delegated: true,
  escalate: false,
  taskType: "qa-factual",
  nodeId: "m5",
  modelId: "mellum",
  decisionReason:
    "viable (10/10 pass, rate 1) + delegate-policy(shadow): shadow — no verifier-backed lane",
  outcome: "unverified",
  score: null,
  output: "PROV_OK",
  metrics: { latencyMs: 15502, ttftMs: 15462, promptTokens: 50, completionTokens: 5 },
  ledgerId: "487bae49-e751-4fc8-a10c-8f12f6aa59a4",
  formatRetried: false,
  delegatePolicy: {
    mode: "shadow",
    action: "shadow",
    reason: "no verifier-backed lane; production should escalate until checking is cheap",
    requiredSuccessRate: 0.95,
    productionSource: true,
    evidence: { taskType: "qa-factual", modelId: "mellum", verifier: null, attempts: 0 },
  },
  costTrace: {
    id: "fc5e98f9-2d7c-4792-b2c3-c936d29d44fb",
    delegationId: "487bae49-e751-4fc8-a10c-8f12f6aa59a4",
    priceCatalogVersion: "2026-07-08",
    costStatus: "unverified",
  },
};

describe("extractM5Provenance", () => {
  it("preserves the full provenance set from a real gateway response", () => {
    const p = extractM5Provenance(LIVE_M5_RESPONSE);

    // The join key to the authoritative M5 ledger row (#163 acceptance).
    expect(p.ledgerId).toBe("487bae49-e751-4fc8-a10c-8f12f6aa59a4");
    // Effective node + model actually used (may differ from what we requested).
    expect(p.nodeId).toBe("m5");
    expect(p.modelId).toBe("mellum");
    expect(p.taskType).toBe("qa-factual");
    // Verification outcome/score.
    expect(p.outcome).toBe("unverified");
    expect(p.score).toBeUndefined(); // null score is absent, not 0
    // Escalation decision.
    expect(p.delegated).toBe(true);
    expect(p.escalated).toBe(false);
    expect(p.decisionReason).toContain("viable");
    // Route/policy version.
    expect(p.policyMode).toBe("shadow");
    expect(p.policyAction).toBe("shadow");
    expect(p.policyReason).toContain("no verifier-backed lane");
    expect(p.priceCatalogVersion).toBe("2026-07-08");
    expect(p.costTraceId).toBe("fc5e98f9-2d7c-4792-b2c3-c936d29d44fb");
    expect(p.formatRetried).toBe(false);
  });

  it("captures verifier identity when the gateway ran a verifier", () => {
    const p = extractM5Provenance({
      ...LIVE_M5_RESPONSE,
      outcome: "pass",
      score: 1,
      verifierNotes: "answerIs matched exactly",
      delegatePolicy: {
        ...LIVE_M5_RESPONSE.delegatePolicy,
        evidence: { ...LIVE_M5_RESPONSE.delegatePolicy.evidence, verifier: "answerIs" },
      },
    });
    expect(p.verifier).toBe("answerIs");
    expect(p.verifierNotes).toBe("answerIs matched exactly");
    expect(p.outcome).toBe("pass");
    expect(p.score).toBe(1);
  });

  // --- Untrusted input: bounds + enums (#163 "treat provider responses as
  // untrusted"). A hostile/buggy gateway value must be DROPPED, never thrown,
  // and never allowed to poison the downstream Zod contract.

  it("drops a non-numeric score instead of throwing", () => {
    const p = extractM5Provenance({ ...LIVE_M5_RESPONSE, score: "high" });
    expect(p.score).toBeUndefined();
    expect(p.ledgerId).toBe("487bae49-e751-4fc8-a10c-8f12f6aa59a4"); // rest survives
  });

  it("drops a non-finite score", () => {
    expect(extractM5Provenance({ score: Number.NaN }).score).toBeUndefined();
    expect(extractM5Provenance({ score: Number.POSITIVE_INFINITY }).score).toBeUndefined();
  });

  it("drops an out-of-enum outcome", () => {
    expect(extractM5Provenance({ outcome: "pass" }).outcome).toBe("pass");
    expect(extractM5Provenance({ outcome: "totally-made-up" }).outcome).toBeUndefined();
    expect(extractM5Provenance({ outcome: 42 }).outcome).toBeUndefined();
  });

  it("drops non-string ids and non-boolean flags", () => {
    const p = extractM5Provenance({
      ledgerId: { evil: true },
      nodeId: 7,
      modelId: null,
      delegated: "yes",
      escalate: 1,
    });
    expect(p.ledgerId).toBeUndefined();
    expect(p.nodeId).toBeUndefined();
    expect(p.modelId).toBeUndefined();
    expect(p.delegated).toBeUndefined();
    expect(p.escalated).toBeUndefined();
  });

  it("caps unbounded strings so a hostile gateway cannot bloat the Munin doc", () => {
    const p = extractM5Provenance({ decisionReason: "x".repeat(10_000) });
    expect(p.decisionReason!.length).toBeLessThanOrEqual(1000);
  });

  it("drops empty strings rather than emitting schema-invalid min(1) values", () => {
    const p = extractM5Provenance({ ledgerId: "", decisionReason: "   " });
    expect(p.ledgerId).toBeUndefined();
    expect(p.decisionReason).toBeUndefined();
  });

  // Codex review of #163: Zod 4's .int() rejects values outside the safe-integer
  // range even though Number.isInteger() accepts them — so an unsafe-integer
  // token count would sail through the sanitizer and then throw inside
  // buildStructuredTaskResult, losing the result of a paid run. Verified against
  // zod 4.3.6: Number.isInteger(2**53) === true, but z.number().int() rejects it.
  it("drops token counts outside the safe-integer range", () => {
    expect(sanitizeProviderTokenCount(42)).toBe(42);
    expect(sanitizeProviderTokenCount(0)).toBe(0);
    expect(sanitizeProviderTokenCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(sanitizeProviderTokenCount(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(sanitizeProviderTokenCount(-1)).toBeNull();
    expect(sanitizeProviderTokenCount(1.5)).toBeNull();
    expect(sanitizeProviderTokenCount("50")).toBeNull();
    expect(sanitizeProviderTokenCount(Number.NaN)).toBeNull();
  });

  // Codex review of #163: a finite-but-out-of-scale score was being retained as
  // a valid trace. M5's real scale is 0..1 (observed live: 0, 0.2, 0.7, 1, null).
  it("drops a score outside M5's 0..1 scale", () => {
    expect(extractM5Provenance({ score: 0 }).score).toBe(0);
    expect(extractM5Provenance({ score: 0.7 }).score).toBe(0.7);
    expect(extractM5Provenance({ score: 1 }).score).toBe(1);
    expect(extractM5Provenance({ score: -1 }).score).toBeUndefined();
    expect(extractM5Provenance({ score: 2 }).score).toBeUndefined();
    expect(extractM5Provenance({ score: 100 }).score).toBeUndefined();
  });

  it("never throws on junk input", () => {
    expect(() => extractM5Provenance(null)).not.toThrow();
    expect(() => extractM5Provenance("nope")).not.toThrow();
    expect(() => extractM5Provenance([])).not.toThrow();
    expect(() => extractM5Provenance({ delegatePolicy: "not-an-object" })).not.toThrow();
    expect(() => extractM5Provenance({ costTrace: 5 })).not.toThrow();
    expect(extractM5Provenance(null)).toEqual({});
  });

  it("falls back to costTrace.delegationId when ledgerId is absent", () => {
    const p = extractM5Provenance({
      costTrace: { delegationId: "d-9", priceCatalogVersion: "2026-07-08" },
    });
    expect(p.ledgerId).toBe("d-9");
  });
});
