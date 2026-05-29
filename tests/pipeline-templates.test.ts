import { describe, expect, it } from "vitest";
import {
  instantiatePipelineTemplate,
  listPipelineTemplates,
  loadPipelineTemplate,
  requiredPlaceholders,
} from "../src/pipeline-templates.js";
import { compilePipelineTask } from "../src/pipeline-compiler.js";
import type { OllamaHost } from "../src/ollama-hosts.js";

const defaultOllamaHosts: OllamaHost[] = [
  {
    name: "pi",
    baseUrl: "http://127.0.0.1:11434",
    available: true,
    models: ["qwen2.5:3b"],
    lastChecked: Date.now(),
  },
  {
    name: "laptop",
    baseUrl: "http://100.1.2.3:11434",
    available: false,
    models: [],
    lastChecked: Date.now(),
  },
];

describe("listPipelineTemplates", () => {
  it("returns the three canonical template names", () => {
    const names = listPipelineTemplates();
    expect(names).toHaveLength(3);
    expect(names).toContain("research");
    expect(names).toContain("review");
    expect(names).toContain("implementation");
  });

  it("returns names sorted alphabetically", () => {
    const names = listPipelineTemplates();
    expect(names).toEqual([...names].sort());
  });
});

describe("loadPipelineTemplate", () => {
  it("returns raw template text for a known template", () => {
    const raw = loadPipelineTemplate("research");
    expect(typeof raw).toBe("string");
    expect(raw.length).toBeGreaterThan(100);
    expect(raw).toContain("${");
  });

  it("throws on unknown template name", () => {
    expect(() => loadPipelineTemplate("nonexistent")).toThrow(/unknown template/i);
  });

  it("guards against path traversal", () => {
    expect(() => loadPipelineTemplate("../src/index")).toThrow(/unknown template/i);
    expect(() => loadPipelineTemplate("../../etc/passwd")).toThrow(/unknown template/i);
  });
});

describe("requiredPlaceholders", () => {
  it("finds placeholders in research template", () => {
    const placeholders = requiredPlaceholders("research");
    expect(placeholders).toContain("title");
    expect(placeholders).toContain("topic");
    expect(placeholders).toContain("submittedBy");
    expect(placeholders).toContain("submittedAt");
  });

  it("finds placeholders in review template", () => {
    const placeholders = requiredPlaceholders("review");
    expect(placeholders).toContain("title");
    expect(placeholders).toContain("submittedBy");
    expect(placeholders).toContain("submittedAt");
  });

  it("finds placeholders in implementation template", () => {
    const placeholders = requiredPlaceholders("implementation");
    expect(placeholders).toContain("title");
    expect(placeholders).toContain("submittedBy");
    expect(placeholders).toContain("submittedAt");
  });

  it("returns distinct values (no duplicates)", () => {
    for (const name of listPipelineTemplates()) {
      const placeholders = requiredPlaceholders(name);
      expect(new Set(placeholders).size).toBe(placeholders.length);
    }
  });
});

describe("instantiatePipelineTemplate", () => {
  it("throws with a helpful message when a placeholder is left unsubstituted", () => {
    expect(() =>
      instantiatePipelineTemplate("research", {
        // omit required vars intentionally
        submittedBy: "test",
        submittedAt: "2026-05-29T10:00:00Z",
      })
    ).toThrow(/unsubstituted placeholder/i);
  });

  it("substitutes all placeholders in research template", () => {
    const vars = {
      title: "Quantum error correction survey",
      topic: "quantum error correction codes",
      submittedBy: "claude-code",
      submittedAt: "2026-05-29T10:00:00Z",
    };
    const result = instantiatePipelineTemplate("research", vars);
    expect(result).not.toContain("${");
    expect(result).toContain("Quantum error correction survey");
    expect(result).toContain("quantum error correction codes");
  });

  it("substitutes all placeholders in review template", () => {
    const vars = {
      title: "Review heimdall PR #42",
      diffSummary: "Adds OAuth2 login flow to the API gateway",
      repo: "heimdall",
      submittedBy: "claude-code",
      submittedAt: "2026-05-29T10:00:00Z",
    };
    const result = instantiatePipelineTemplate("review", vars);
    expect(result).not.toContain("${");
    expect(result).toContain("Review heimdall PR #42");
  });

  it("substitutes all placeholders in implementation template", () => {
    const vars = {
      title: "Implement rate limiter",
      featureDescription: "A token-bucket rate limiter for the broker endpoint",
      repo: "hugin",
      submittedBy: "claude-code",
      submittedAt: "2026-05-29T10:00:00Z",
    };
    const result = instantiatePipelineTemplate("implementation", vars);
    expect(result).not.toContain("${");
    expect(result).toContain("Implement rate limiter");
  });
});

// Key correctness tests: each template must produce a document that compiles
// into a valid PipelineIR with the expected structure.
describe("template compilation correctness", () => {
  it("research template compiles into 3-phase PipelineIR with correct dependencies", () => {
    const vars = {
      title: "AI safety alignment survey",
      topic: "AI safety and alignment research directions",
      submittedBy: "claude-code",
      submittedAt: "2026-05-29T10:00:00Z",
    };
    const doc = instantiatePipelineTemplate("research", vars);
    const ir = compilePipelineTask(
      "test-research-001",
      "tasks/test-research-001",
      doc,
      defaultOllamaHosts,
    );

    expect(ir.phases.length).toBeGreaterThanOrEqual(3);
    // First phase has no dependencies
    expect(ir.phases[0]?.dependsOn).toHaveLength(0);
    // Subsequent phases depend on earlier ones
    expect(ir.phases[1]?.dependsOn.length).toBeGreaterThan(0);
    expect(ir.phases[2]?.dependsOn.length).toBeGreaterThan(0);
    // All phases have prompts
    for (const phase of ir.phases) {
      expect(phase.prompt.length).toBeGreaterThan(10);
    }
  });

  it("review template compiles into 3-phase PipelineIR with correct dependencies", () => {
    const vars = {
      title: "Code review for PR #99",
      diffSummary: "Refactors authentication middleware",
      repo: "hugin",
      submittedBy: "claude-code",
      submittedAt: "2026-05-29T10:00:00Z",
    };
    const doc = instantiatePipelineTemplate("review", vars);
    const ir = compilePipelineTask(
      "test-review-001",
      "tasks/test-review-001",
      doc,
      defaultOllamaHosts,
    );

    expect(ir.phases.length).toBeGreaterThanOrEqual(3);
    expect(ir.phases[0]?.dependsOn).toHaveLength(0);
    expect(ir.phases[1]?.dependsOn.length).toBeGreaterThan(0);
    expect(ir.phases[2]?.dependsOn.length).toBeGreaterThan(0);
  });

  it("implementation template compiles into 3-phase PipelineIR with correct dependencies", () => {
    const vars = {
      title: "Implement webhook delivery",
      featureDescription: "HTTP webhook delivery for task completion events",
      repo: "hugin",
      submittedBy: "claude-code",
      submittedAt: "2026-05-29T10:00:00Z",
    };
    const doc = instantiatePipelineTemplate("implementation", vars);
    const ir = compilePipelineTask(
      "test-impl-001",
      "tasks/test-impl-001",
      doc,
      defaultOllamaHosts,
    );

    expect(ir.phases.length).toBeGreaterThanOrEqual(3);
    expect(ir.phases[0]?.dependsOn).toHaveLength(0);
    expect(ir.phases[1]?.dependsOn.length).toBeGreaterThan(0);
    expect(ir.phases[2]?.dependsOn.length).toBeGreaterThan(0);
  });

  it("research template sensitivity is internal by default", () => {
    const vars = {
      title: "Test",
      topic: "test topic",
      submittedBy: "claude-code",
      submittedAt: "2026-05-29T10:00:00Z",
    };
    const doc = instantiatePipelineTemplate("research", vars);
    const ir = compilePipelineTask(
      "test-research-002",
      "tasks/test-research-002",
      doc,
      defaultOllamaHosts,
    );
    expect(ir.sensitivity).toBe("internal");
  });
});
