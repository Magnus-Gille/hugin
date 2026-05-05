import { describe, expect, it } from "vitest";
import {
  FRICTION_CATEGORY,
  FRICTION_SCHEMA_VERSION,
  reportFrictionInputSchema,
} from "../../src/friction/schema.js";

describe("friction schema", () => {
  it("accepts a minimal valid input", () => {
    const parsed = reportFrictionInputSchema.parse({
      friction_type: "reasoning_limit",
      severity: "medium",
      summary: "Hit a ceiling on the matrix algebra step.",
      detail: "Tried two simplifications, both wrong.",
    });
    expect(parsed.friction_type).toBe("reasoning_limit");
    expect(parsed.severity).toBe("medium");
  });

  it("accepts all optional fields when valid", () => {
    const parsed = reportFrictionInputSchema.parse({
      friction_type: "tool_failure",
      severity: "high",
      summary: "ssh hung.",
      detail: "Tried 3 times, all timed out at 30s.",
      resource_assessment: "appropriate",
      alias_suggested: "medium",
      tool_name: "ssh",
      task_id: "t-123",
      tags: ["network", "infra"],
    });
    expect(parsed.alias_suggested).toBe("medium");
    expect(parsed.tags).toEqual(["network", "infra"]);
  });

  it("rejects unknown friction_type", () => {
    expect(() =>
      reportFrictionInputSchema.parse({
        friction_type: "made_up",
        severity: "low",
        summary: "x",
        detail: "y",
      }),
    ).toThrow();
  });

  it("rejects unknown alias_suggested values (uses broker vocabulary)", () => {
    expect(() =>
      reportFrictionInputSchema.parse({
        friction_type: "reasoning_limit",
        severity: "low",
        summary: "x",
        detail: "y",
        alias_suggested: "frontier", // not in {tiny, medium, large-reasoning, pi-large-coder}
      }),
    ).toThrow();
  });

  it("rejects empty summary or detail", () => {
    expect(() =>
      reportFrictionInputSchema.parse({
        friction_type: "ambiguity",
        severity: "low",
        summary: "",
        detail: "y",
      }),
    ).toThrow();
    expect(() =>
      reportFrictionInputSchema.parse({
        friction_type: "ambiguity",
        severity: "low",
        summary: "x",
        detail: "",
      }),
    ).toThrow();
  });

  it("rejects too-long summary or detail", () => {
    expect(() =>
      reportFrictionInputSchema.parse({
        friction_type: "ambiguity",
        severity: "low",
        summary: "x".repeat(501),
        detail: "y",
      }),
    ).toThrow();
    expect(() =>
      reportFrictionInputSchema.parse({
        friction_type: "ambiguity",
        severity: "low",
        summary: "x",
        detail: "y".repeat(8_001),
      }),
    ).toThrow();
  });

  it("rejects more than 16 tags", () => {
    expect(() =>
      reportFrictionInputSchema.parse({
        friction_type: "ambiguity",
        severity: "low",
        summary: "x",
        detail: "y",
        tags: Array.from({ length: 17 }, (_, i) => `t${i}`),
      }),
    ).toThrow();
  });

  it("FRICTION_CATEGORY covers every friction_type", () => {
    const types = [
      "reasoning_limit",
      "knowledge_gap",
      "context_window_limit",
      "tool_missing",
      "confidence_low",
      "tool_failure",
      "permission_denied",
      "connectivity",
      "ambiguity",
      "prerequisite_missing",
      "scope_mismatch",
    ] as const;
    for (const t of types) {
      expect(FRICTION_CATEGORY[t]).toMatch(/^(capability|environment|specification)$/);
    }
  });

  it("FRICTION_SCHEMA_VERSION is 1", () => {
    expect(FRICTION_SCHEMA_VERSION).toBe(1);
  });
});
