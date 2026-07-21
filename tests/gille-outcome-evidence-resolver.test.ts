import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MuninWriteRejectedError, type MuninClient } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import { LearningExperimentStore } from "../src/learning/experiment-store.js";
import {
  buildQualityBinding,
  buildQualityCorrectionReceipt,
  buildQualityReceipt,
} from "../src/quality-receipt.js";
import { createGilleOutcomeEvidenceResolver } from "../src/learning/gille-outcome-evidence-resolver.js";
import { makeExperimentInput, makeObservation } from "./fixtures/learning.js";
import {
  buildFixtureAdmittedAttempt,
  buildFixtureResultStructuredDocument,
  buildFixtureStatusDocument,
} from "./helpers/candidate-evidence-fixtures.js";

// ---------------------------------------------------------------------------
// In-memory Munin double -- same contract copied across this codebase's own
// learning-* test files (see tests/experiment-cadence.test.ts's own copy).
// ---------------------------------------------------------------------------

interface StoredEntry {
  namespace: string;
  key: string;
  content: string;
  tags: string[];
  classification?: string;
  created_at: string;
  updated_at: string;
}

class InMemoryMunin {
  private entries: StoredEntry[] = [];
  private seq = 0;

  private clock(): string {
    this.seq += 1;
    return new Date(Date.UTC(2026, 6, 1, 0, 0, 0, 0) + this.seq).toISOString();
  }

  private find(namespace: string, key: string): StoredEntry | undefined {
    return this.entries.find((e) => e.namespace === namespace && e.key === key);
  }

  async read(namespace: string, key: string) {
    const entry = this.find(namespace, key);
    if (!entry) return null;
    return { ...entry, found: true } as unknown as { content: string; updated_at: string; found: true };
  }

  async write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
    createIfAbsent?: boolean,
  ) {
    const existing = this.find(namespace, key);
    if (createIfAbsent === true && existing) {
      throw new MuninWriteRejectedError(namespace, key, {
        error: "conflict",
        message: "Entry already exists.",
        conflict_reason: "already_exists",
        current_updated_at: existing.updated_at,
      });
    }
    if (expectedUpdatedAt !== undefined && (!existing || existing.updated_at !== expectedUpdatedAt)) {
      throw new MuninWriteRejectedError(namespace, key, {
        error: "conflict",
        message: "Entry version changed.",
        conflict_reason: "version_mismatch",
        current_updated_at: existing?.updated_at,
      });
    }
    const updated_at = this.clock();
    const created_at = existing?.created_at ?? updated_at;
    const next: StoredEntry = { namespace, key, content, tags: tags ?? [], classification, created_at, updated_at };
    if (existing) Object.assign(existing, next); else this.entries.push(next);
    return { ok: true, status: existing ? "updated" : "created", updated_at };
  }

  async query(opts: { namespace?: string; tags?: string[]; limit?: number; entry_type?: string }) {
    let rows = this.entries.filter((e) =>
      (!opts.namespace || e.namespace.startsWith(opts.namespace))
      && (opts.tags ?? []).every((tag) => e.tags.includes(tag)));
    rows = [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const limited = rows.slice(0, opts.limit ?? 50);
    return {
      results: limited.map((e) => ({
        id: `${e.namespace}/${e.key}`,
        namespace: e.namespace,
        key: e.key,
        entry_type: "state",
        content_preview: e.content.slice(0, 80),
        tags: e.tags,
        classification: e.classification,
        created_at: e.created_at,
        updated_at: e.updated_at,
      })),
      total: rows.length,
    };
  }

  async log() {
    // unused by this module
  }
}

function munin(): InMemoryMunin & MuninClient {
  return new InMemoryMunin() as unknown as InMemoryMunin & MuninClient;
}

const ref = (namespace: string, key: string) => ({ namespace, key });
const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");
const PRINCIPAL = "service:test-resolver";

/** Register a completed, admitted, resolvable Hugin attempt for `taskId`. */
async function seedAdmittedAttempt(
  m: InMemoryMunin & MuninClient,
  store: LearningRegistryStore,
  taskId: string,
  occurredAt: string,
): Promise<{ attemptId: string; taskOutcomeRef: { namespace: string; key: string }; statusContent: string; resultContent: string }> {
  const { attemptId, attemptOutcomeRef, evidence } = buildFixtureAdmittedAttempt({ taskId, taskType: "code-edit" });
  await m.write(attemptOutcomeRef.namespace, attemptOutcomeRef.key, JSON.stringify(evidence), []);

  const taskOutcomeRef = ref(`tasks/${taskId}`, "result-structured");
  await store.recordSubmission({ taskId, taskOutcomeRef, occurredAt });
  await store.recordAttemptReference({
    taskId, attemptId, attemptStartRef: ref(`tasks/${taskId}`, `learning-attempt-${attemptId}`), taskOutcomeRef, occurredAt,
  });
  await store.recordTerminalOutcome({
    taskId, attemptId, outcome: "completed", taskOutcomeRef, attemptOutcomeRef,
    delegation: { modelId: "model-a", taskType: "code-edit", nodeId: "m5" },
    occurredAt,
  });

  const statusContent = buildFixtureStatusDocument(taskId, `prompt bytes for ${taskId}`);
  const resultContent = buildFixtureResultStructuredDocument(taskId);
  await m.write(`tasks/${taskId}`, "status", statusContent, ["status"]);
  await m.write(`tasks/${taskId}`, "result-structured", resultContent, ["result"]);

  return { attemptId, taskOutcomeRef, statusContent, resultContent };
}

async function createExperimentWithObservation(
  m: InMemoryMunin & MuninClient,
  taskId: string,
  overrides: Partial<Parameters<typeof makeObservation>[2]> = {},
) {
  const experimentStore = new LearningExperimentStore(m);
  await experimentStore.create(PRINCIPAL, makeExperimentInput());
  await experimentStore.observe(PRINCIPAL, makeObservation("case-1", "champion", { task_id: taskId, ...overrides }));
  return experimentStore.read(PRINCIPAL, "wave-six-edit-deadline");
}

describe("createGilleOutcomeEvidenceResolver", () => {
  it("resolves prompt, evidence identity, verifier, exposure, and policy epoch for a fully admitted sample", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-resolvable";
    await seedAdmittedAttempt(m, store, taskId, "2026-07-05T00:00:00.000Z");

    const statusContent = buildFixtureStatusDocument(taskId, `prompt bytes for ${taskId}`);
    const resultContent = buildFixtureResultStructuredDocument(taskId);
    const binding = buildQualityBinding({ statusContent, structuredResultContent: resultContent });
    const receipt = buildQualityReceipt({
      taskId, reviewerPrincipal: "codex", reviewerIndependence: "independent",
      rating: "pass", ratingReason: "SECRET-RAW-TEXT", verificationOutcome: "accepted_unchanged",
      ratedAt: "2026-07-05T00:00:00.000Z", bindingAttestation: "server-bound", binding,
    });
    await m.write(`tasks/${taskId}`, "feedback", JSON.stringify({ schemaVersion: 1, taskId, receipts: [receipt] }), []);

    const experiment = await createExperimentWithObservation(m, taskId);
    const observation = experiment.observations[0]!;

    const resolver = createGilleOutcomeEvidenceResolver({ munin: m, registry: store });
    const evidence = await resolver.resolveArmEvidence({ experiment, observation });

    expect(evidence).not.toBeNull();
    expect(evidence!.prompt).toBe(`prompt bytes for ${taskId}`);
    expect(evidence!.evidenceIdentity.lane).toBe("delegate");
    expect(evidence!.evidenceIdentity.logicalTask.kind).toBe("digest");
    expect(evidence!.evidenceIdentity.renderedPrompt.kind).toBe("digest");
    expect(evidence!.evidenceIdentity.harness.kind).toBe("digest");
    expect(evidence!.evidenceIdentity.toolPolicy.kind).toBe("digest");
    expect(evidence!.evidenceIdentity.taxonomyVersion.kind).toBe("label");
    // Hugin genuinely has no visibility into these -- must stay honestly unknown.
    expect(evidence!.evidenceIdentity.modelArtifact).toEqual(
      expect.objectContaining({ kind: "unknown", reason: "not-observed" }),
    );
    expect(evidence!.evidenceIdentity.configEpoch).toEqual(
      expect.objectContaining({ kind: "unknown", reason: "not-observed" }),
    );
    // v1 legacy receipt carries no rubric.
    expect(evidence!.evidenceIdentity.verifierRubric).toEqual(
      expect.objectContaining({ kind: "unknown", reason: "legacy" }),
    );
    expect(evidence!.verifier).toEqual({ name: "protected-check", independent: true, mode: "deterministic" });
    expect(evidence!.exposure).toEqual({ contaminationStatus: "coverage-incomplete" });
    expect(evidence!.policyEpoch).toBe(observation.configuration_fingerprint);
    expect(evidence!.nodeId).toBe("m5");

    // Never leaks the receipt's own free-text rating reason.
    expect(JSON.stringify(evidence)).not.toContain("SECRET-RAW-TEXT");
  });

  it("resolves a real digest verifierRubric from a schemaVersion-2 (attempt-bound) correction receipt", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-v2-rubric";
    const { attemptId } = await seedAdmittedAttempt(m, store, taskId, "2026-07-05T00:00:00.000Z");

    const statusContent = buildFixtureStatusDocument(taskId, `prompt bytes for ${taskId}`);
    const resultContent = buildFixtureResultStructuredDocument(taskId);
    const binding = buildQualityBinding({ statusContent, structuredResultContent: resultContent });
    const v1 = buildQualityReceipt({
      taskId, reviewerPrincipal: "codex", reviewerIndependence: "independent",
      rating: "partial", ratingReason: "SECRET-V1", verificationOutcome: "minor_edit",
      ratedAt: "2026-07-05T00:00:00.000Z", bindingAttestation: "server-bound", binding,
    });
    const v2 = buildQualityCorrectionReceipt({
      taskId, attemptId, correctsReceiptId: v1.receiptId,
      reviewerPrincipal: "codex", reviewerIndependence: "independent",
      rating: "pass", ratingReason: "SECRET-V2", verificationOutcome: "accepted_unchanged",
      ratedAt: "2026-07-06T00:00:00.000Z",
      rubric: {
        id: "default-rubric", version: "1",
        config_digest: {
          algorithm: "sha256", canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: "source-doc:hugin/rubric/default", source_type: "rubric-config", source_version: "v1",
          digest: hash("rubric"),
        },
      },
      verifier: { id: "codex-verifier", version: "1" },
      failure: { taxonomy: { id: "hugin-failure-taxonomy", version: "1" }, code: "none" },
      bindingAttestation: "server-bound", binding,
    });
    await m.write(`tasks/${taskId}`, "feedback", JSON.stringify({ schemaVersion: 2, taskId, receipts: [v1, v2] }), []);

    const experiment = await createExperimentWithObservation(m, taskId);
    const observation = experiment.observations[0]!;
    const resolver = createGilleOutcomeEvidenceResolver({ munin: m, registry: store });
    const evidence = await resolver.resolveArmEvidence({ experiment, observation });

    expect(evidence).not.toBeNull();
    expect(evidence!.evidenceIdentity.verifierRubric.kind).toBe("digest");
  });

  it("returns null (unresolved) when the observation has no task_id to anchor evidence to", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const experimentStore = new LearningExperimentStore(m);
    await experimentStore.create(PRINCIPAL, makeExperimentInput());
    await experimentStore.observe(PRINCIPAL, makeObservation("case-1", "champion", { task_id: undefined }));
    const experiment = await experimentStore.read(PRINCIPAL, "wave-six-edit-deadline");

    const resolver = createGilleOutcomeEvidenceResolver({ munin: m, registry: store });
    const evidence = await resolver.resolveArmEvidence({ experiment, observation: experiment.observations[0]! });
    expect(evidence).toBeNull();
  });

  it("returns null when the observation carries no verifier (kind 'none') rather than fabricating one", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-no-verifier";
    await seedAdmittedAttempt(m, store, taskId, "2026-07-05T00:00:00.000Z");
    const experiment = await createExperimentWithObservation(m, taskId, {
      verifier: { kind: "none", independent: false },
    });
    const resolver = createGilleOutcomeEvidenceResolver({ munin: m, registry: store });
    const evidence = await resolver.resolveArmEvidence({ experiment, observation: experiment.observations[0]! });
    expect(evidence).toBeNull();
  });

  it("returns null when no admitted attempt-outcome evidence resolves for the task (unresolvable, per-sample)", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-unregistered";
    // No registry events, no evidence row, no status doc seeded for this task.
    const experimentStore = new LearningExperimentStore(m);
    await experimentStore.create(PRINCIPAL, makeExperimentInput());
    await experimentStore.observe(PRINCIPAL, makeObservation("case-1", "champion", { task_id: taskId }));
    const experiment = await experimentStore.read(PRINCIPAL, "wave-six-edit-deadline");

    const resolver = createGilleOutcomeEvidenceResolver({ munin: m, registry: store });
    const evidence = await resolver.resolveArmEvidence({ experiment, observation: experiment.observations[0]! });
    expect(evidence).toBeNull();
  });

  it("returns null when no quality receipt is bound to the task's current content", async () => {
    const m = munin();
    const store = new LearningRegistryStore(m);
    const taskId = "task-no-receipt-resolver";
    await seedAdmittedAttempt(m, store, taskId, "2026-07-05T00:00:00.000Z");
    // No feedback ledger written.
    const experiment = await createExperimentWithObservation(m, taskId);
    const resolver = createGilleOutcomeEvidenceResolver({ munin: m, registry: store });
    const evidence = await resolver.resolveArmEvidence({ experiment, observation: experiment.observations[0]! });
    expect(evidence).toBeNull();
  });
});
