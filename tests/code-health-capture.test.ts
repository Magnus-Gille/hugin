import { describe, expect, it, vi } from "vitest";
import {
  createCodeHealthCaptureTool,
  type CodeHealthCaptureConfig,
} from "../src/code-health-capture.js";

const attemptId = "123e4567-e89b-42d3-a456-426614174000";

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const worker = {
    id: "ref:worker-a",
    kind: "worker",
    requested_model: "claude-sonnet-4-6",
    observed_model: "claude-sonnet-4-6",
    observed_effort: null,
  };
  return {
    record_kind: "observation",
    rubric_version: "changeability-1.0",
    version: "1.0",
    repo_owner: "Magnus-Gille",
    repo_name: "sagascript",
    task_id: "task-123",
    task_class: "implementation",
    attempt_id: attemptId,
    parent_attempt_id: null,
    record_id: "ref:record-1",
    observed_at: "2026-10-10T12:30:00Z",
    before_sha: null,
    after_sha: null,
    module_refs: [],
    reporter: worker,
    actual_worker: worker,
    occurrence_id: "ref:occurrence-1",
    dimension: "locate",
    polarity: "negative",
    cause: "code",
    supporting_refs: ["ref:evidence-1"],
    counter_refs: [],
    source_observation_ref: null,
    supersedes_record_id: null,
    correction_ref: null,
    ...overrides,
  };
}

function assessment(completeness: "complete" | "partial"): Record<string, unknown> {
  const worker = {
    id: "ref:worker-a",
    kind: "worker",
    requested_model: "claude-sonnet-4-6",
    observed_model: "claude-sonnet-4-6",
    observed_effort: null,
  };
  return {
    record_kind: "assessment",
    rubric_version: "changeability-1.0",
    version: "1.0",
    repo_owner: "Magnus-Gille",
    repo_name: "sagascript",
    task_id: "task-123",
    task_class: "implementation",
    attempt_id: attemptId,
    parent_attempt_id: null,
    child_attempt_ids: [],
    record_id: "ref:assessment-1",
    observed_at: "2026-10-10T12:30:00Z",
    before_sha: null,
    after_sha: null,
    module_refs: [],
    reporter: worker,
    actual_worker: worker,
    applicability: "applicable",
    outcome: "completed",
    completeness,
    environment: "available",
    observation_refs: ["ref:record-1"],
    ratings: ["locate", "understand", "verify"].map((dimension) => ({
      dimension,
      value: "manageable",
      reason: "grounded",
      evidence_refs: ["ref:evidence-1"],
    })),
    supersedes_record_id: null,
    correction_ref: null,
  };
}

function makeConfig(overrides: Partial<CodeHealthCaptureConfig> = {}): CodeHealthCaptureConfig {
  return {
    binding: {
      taskId: "task-123",
      taskNamespace: "tasks/task-123",
      attemptId,
      repo: { owner: "Magnus-Gille", name: "sagascript" },
    },
    namespace: "signals/code-health",
    requestedModel: "claude-sonnet-4-6",
    observedModel: () => "claude-sonnet-4-6",
    beforeSha: null,
    afterSha: null,
    classification: "internal",
    validateCodeHealthRecord: vi.fn(async (record: unknown) => ({
      valid: typeof record === "object" && record !== null,
      errors: [],
    })),
    deliverCodeHealth: vi.fn(async (request) => ({
      status: "acknowledged" as const,
      recordId: String(request.record.record_id),
      receipt: {
        record_id: String(request.record.record_id),
        collected_at: "2026-10-10T12:30:01Z",
        expires_at: "2027-10-10T12:30:01Z",
        updated_at: "2026-10-10T12:30:02Z",
        classification: "internal",
      },
    })),
    createIdempotencyKey: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...overrides,
  };
}

async function invoke(tool: ReturnType<typeof createCodeHealthCaptureTool>, record: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return tool.handler({ record, ...extra } as never, {});
}

describe("code-health SDK capture tool", () => {
  it("validates then appends the exact canonical record with Hugin-bound namespace and identity", async () => {
    const config = makeConfig();
    const tool = createCodeHealthCaptureTool(config);
    const record = observation();

    const result = await invoke(tool, record);

    expect(result.isError).toBeFalsy();
    expect(config.validateCodeHealthRecord).toHaveBeenCalledWith(record);
    expect(config.deliverCodeHealth).toHaveBeenCalledWith({
      action: "append",
      namespace: "signals/code-health",
      idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      record,
      classification: "internal",
    });
    expect(tool.snapshot()).toMatchObject({
      observationRefs: ["ref:record-1"],
      assessmentRefs: [],
      assessmentState: "missing",
      captureDelivery: [{
        recordId: "ref:record-1",
        recordKind: "observation",
        status: "acknowledged",
        updatedAt: "2026-10-10T12:30:02Z",
      }],
    });
    expect(JSON.stringify(result)).not.toContain("summary");
  });

  it("rejects invalid canonical records without delivery", async () => {
    const config = makeConfig({
      validateCodeHealthRecord: vi.fn(async () => ({ valid: false, errors: ["secret-like details"] })),
    });
    const tool = createCodeHealthCaptureTool(config);

    const result = await invoke(tool, observation());

    expect(result.isError).toBe(true);
    expect(config.deliverCodeHealth).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-like details");
    expect(tool.snapshot()).toBeUndefined();
  });

  it.each([
    ["repo_name", "gille-inference"],
    ["task_id", "other-task"],
    ["attempt_id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["before_sha", "a".repeat(40)],
    ["after_sha", "b".repeat(40)],
  ])("rejects a canonical record that contradicts Hugin-bound %s", async (field, value) => {
    const config = makeConfig();
    const tool = createCodeHealthCaptureTool(config);

    const result = await invoke(tool, observation({ [field]: value }));

    expect(result.isError).toBe(true);
    expect(config.deliverCodeHealth).not.toHaveBeenCalled();
  });

  it("rejects conflicting requested/observed worker identity and unknown child lineage", async () => {
    const config = makeConfig();
    const tool = createCodeHealthCaptureTool(config);
    const worker = {
      id: "ref:worker-a",
      kind: "worker",
      requested_model: "other-model",
      observed_model: "other-model",
      observed_effort: null,
    };

    const result = await invoke(tool, observation({ reporter: worker, actual_worker: worker }));

    expect(result.isError).toBe(true);
    expect(config.deliverCodeHealth).not.toHaveBeenCalled();
  });

  it("rejects corrections without an exact expected updated_at and passes a supplied CAS unchanged", async () => {
    const missingCasConfig = makeConfig();
    const missingCasTool = createCodeHealthCaptureTool(missingCasConfig);
    const correction = observation({
      record_id: "ref:record-correction",
      supersedes_record_id: "ref:record-1",
      source_observation_ref: "ref:record-1",
    });
    const missingCas = await invoke(missingCasTool, correction);
    expect(missingCas.isError).toBe(true);
    expect(missingCasConfig.deliverCodeHealth).not.toHaveBeenCalled();

    const config = makeConfig();
    const tool = createCodeHealthCaptureTool(config);
    await invoke(tool, correction, { expected_updated_at: "2026-10-10T12:30:02.123Z" });
    expect(config.deliverCodeHealth).toHaveBeenCalledWith(expect.objectContaining({
      expected_updated_at: "2026-10-10T12:30:02.123Z",
    }));
  });

  it("records assessment completeness and explicit queued/unsaved delivery outcomes", async () => {
    const queuedConfig = makeConfig({
      deliverCodeHealth: vi.fn(async (request) => ({
        status: "queued" as const,
        recordId: String(request.record.record_id),
      })),
    });
    const queuedTool = createCodeHealthCaptureTool(queuedConfig);
    await invoke(queuedTool, assessment("partial"));

    expect(queuedTool.snapshot()).toMatchObject({
      assessmentRefs: ["ref:assessment-1"],
      assessmentState: "partial",
      captureDelivery: [{ recordId: "ref:assessment-1", status: "queued" }],
    });
  });

  it("keeps acknowledgements and exact server timestamps while limiting observations per attempt", async () => {
    const config = makeConfig();
    const tool = createCodeHealthCaptureTool(config);
    for (let index = 1; index <= 3; index++) {
      await invoke(tool, observation({ record_id: `ref:record-${index}` }));
    }
    const fourth = await invoke(tool, observation({ record_id: "ref:record-4" }));

    expect(fourth.isError).toBe(true);
    expect(config.deliverCodeHealth).toHaveBeenCalledTimes(3);
    expect(tool.snapshot().captureDelivery[0]?.updatedAt).toBe("2026-10-10T12:30:02Z");
  });

  it("serializes concurrent same-ID reports and admits no more than three concurrent observations", async () => {
    const config = makeConfig();
    const tool = createCodeHealthCaptureTool(config);
    const duplicate = observation({ record_id: "ref:parallel-same" });
    const sameIdResults = await Promise.all([
      invoke(tool, duplicate),
      invoke(tool, duplicate),
    ]);
    expect(sameIdResults[0]).toEqual(sameIdResults[1]);
    expect(config.deliverCodeHealth).toHaveBeenCalledTimes(1);

    const boundedResults = await Promise.all([1, 2, 3, 4].map((index) =>
      invoke(tool, observation({ record_id: `ref:parallel-${index}` })),
    ));
    expect(boundedResults.filter((result) => result.isError)).toHaveLength(2);
    expect(config.deliverCodeHealth).toHaveBeenCalledTimes(3);
    expect(tool.snapshot()?.observationRefs).toHaveLength(3);
  });

  it("returns safe bound metadata and the canonical required-field guide", async () => {
    const tool = createCodeHealthCaptureTool(makeConfig());
    const result = await tool.contextTool.handler({}, {});
    const text = result.content?.find((block) => block.type === "text")?.text;
    const context = JSON.parse(text ?? "{}");

    expect(context.binding).toMatchObject({
      repo_owner: "Magnus-Gille",
      repo_name: "sagascript",
      task_id: "task-123",
      attempt_id: attemptId,
      requested_model: "claude-sonnet-4-6",
      observed_model: "claude-sonnet-4-6",
    });
    expect(context.observation.required).toContain("source_observation_ref");
    expect(context.assessment.enums.rating_reason).toContain("insufficient_evidence");
    expect(text).not.toContain("Test prompt");
    expect(text).not.toContain("workingDir");
  });

  it("returns explicit unsaved state when delivery throws, without changing SDK task outcome", async () => {
    const config = makeConfig({
      deliverCodeHealth: vi.fn(async () => { throw new Error("private transport details"); }),
    });
    const tool = createCodeHealthCaptureTool(config);

    const result = await invoke(tool, observation());

    expect(result.isError).toBeFalsy();
    expect(tool.snapshot().captureDelivery).toEqual([{
      recordId: "ref:record-1",
      recordKind: "observation",
      status: "unsaved",
    }]);
    expect(JSON.stringify(result)).not.toContain("private transport details");
  });
});
