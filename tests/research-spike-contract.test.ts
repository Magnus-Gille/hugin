import { describe, expect, it } from "vitest";
import type { ArtifactManifest } from "../src/artifact-delivery.js";
import { hasResearchSpikeArtifactContract, parseResearchSpikeIndex, researchSpikePreflightFailure } from "../src/research-spike-contract.js";
const { __test__: dispatcherTest } = await import("../src/index.js");

const manifest: ArtifactManifest = {
  artifacts: [
    { id: "detailed", local: "/scratch/detailed.md", remote: "magnus@nas:/research/detailed.md", required: true },
    { id: "popular", local: "/scratch/popular.md", remote: "magnus@nas:/reading/popular.md", required: true },
  ],
};

describe("research spike preflight (#362)", () => {
  const index = { project: "grimnir", slug: "research-contract", sensitivity: "internal" as const };

  it("parses the Hugin-owned index coordinates before the agent prompt", () => {
    expect(parseResearchSpikeIndex(`## Task\n- **Project:** grimnir\n- **Research slug:** research-contract\n- **Sensitivity:** internal\n\n### Prompt\nuntrusted **Project:** evil`)).toEqual(index);
    expect(parseResearchSpikeIndex("- **Project:** grimnir\n- **Research slug:** legacy\n- **Sensitivity:** restricted")).toEqual({ project: "grimnir", slug: "legacy", sensitivity: "private" });
    expect(parseResearchSpikeIndex("- **Project:** ../evil\n- **Research slug:** x\n- **Sensitivity:** internal")).toBeUndefined();
    const task = dispatcherTest.parseTask(`## Task: legacy private research\n- **Runtime:** claude\n- **Project:** grimnir\n- **Research slug:** legacy\n- **Sensitivity:** restricted\n\n### Prompt\nRead only`);
    expect(task?.declaredSensitivity).toBe("private");
  });

  it("does not change ordinary task admission", () => {
    expect(researchSpikePreflightFailure({
      tags: ["pending", "runtime:claude"], runtime: "claude", permissionProfile: "read-only",
      artifactManifest: undefined, deliveryPolicy: "require", index: undefined,
    })).toBeNull();
  });

  it("admits only an explicit healthy research runtime", () => {
    expect(researchSpikePreflightFailure({
      tags: ["pending", "type:research", "runtime:research"], runtime: "research", permissionProfile: "trusted-code",
      artifactManifest: manifest, deliveryPolicy: "require", index, researchRuntimeFailure: null,
    })).toBeNull();
    expect(researchSpikePreflightFailure({
      tags: ["pending", "type:research", "runtime:research"], runtime: "research", permissionProfile: "trusted-code",
      artifactManifest: manifest, deliveryPolicy: "require", index, researchRuntimeFailure: "Pi is unavailable",
    })).toBe("Pi is unavailable");
  });

  it("parses an explicit research runtime", () => {
    const task = dispatcherTest.parseTask("## Task: research\n- **Runtime:** research\n- **Sensitivity:** internal\n\n### Prompt\nInvestigate");
    expect(task?.runtime).toBe("research");
  });

  it("refuses the read-only agent-sdk before it can falsely succeed", () => {
    const failure = researchSpikePreflightFailure({
      tags: ["pending", "type:research", "runtime:claude"], runtime: "claude", permissionProfile: "read-only",
      artifactManifest: manifest, deliveryPolicy: "require", index,
    });
    expect(failure).toMatch(/claude agent-sdk read-only/);
    expect(failure).toMatch(/web search/);
    expect(failure).toMatch(/Hugin-managed Munin indexing/);
  });

  it("requires two declared artefacts even if a future executor is selected", () => {
    const failure = researchSpikePreflightFailure({
      tags: ["pending", "type:research"], runtime: "codex", permissionProfile: "trusted-code",
      artifactManifest: { artifacts: [manifest.artifacts[0]!] }, deliveryPolicy: "require", index,
    });
    expect(failure).toMatch(/two distinct declared required artefacts/);
  });

  it("rejects duplicate paths masquerading as two outputs", () => {
    expect(hasResearchSpikeArtifactContract({ artifacts: [
      manifest.artifacts[0]!,
      { ...manifest.artifacts[0]!, id: "same-document" },
    ] })).toBe(false);
  });

  it("does not permit delivery rollback for research work", () => {
    expect(researchSpikePreflightFailure({
      tags: ["type:research"], runtime: "claude", permissionProfile: "trusted-code",
      artifactManifest: manifest, deliveryPolicy: "off", index,
    })).toMatch(/HUGIN_DELIVERY_POLICY=off/);
  });

  it("requires index metadata rather than trusting the agent to write it", () => {
    expect(researchSpikePreflightFailure({
      tags: ["type:research"], runtime: "claude", permissionProfile: "trusted-code",
      artifactManifest: manifest, deliveryPolicy: "require", index: undefined,
    })).toMatch(/Research slug/);
  });

  it("makes exactly the three Hugin-owned discovery writes after delivery", async () => {
    const writes: Array<{ namespace: string; key: string; tags?: string[] }> = [];
    await dispatcherTest.writeResearchSpikeIndexes({
      write: async (namespace: string, key: string, _content: string, tags?: string[]) => {
        writes.push({ namespace, key, tags });
        return {};
      },
    }, index, manifest, "task-123", "internal");
    expect(writes.map(({ namespace, key }) => `${namespace}/${key}`)).toEqual([
      "documents/research-contract/index",
      "reading/research-contract/entry",
      "projects/grimnir/research-research-contract",
    ]);
    expect(writes.every((write) => write.tags?.includes("writer:hugin"))).toBe(true);
  });

  it("does not hide a rejected Hugin index write", async () => {
    await expect(dispatcherTest.writeResearchSpikeIndexes({
      write: async () => { throw new Error("Munin unavailable"); },
    }, index, manifest, "task-123", "internal")).rejects.toThrow("Munin unavailable");
  });
});
