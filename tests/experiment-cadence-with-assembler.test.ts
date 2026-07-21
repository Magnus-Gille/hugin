import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { describe, expect, it, afterEach } from "vitest";
import { MuninWriteRejectedError, type MuninClient } from "../src/munin-client.js";
import { LearningRegistryStore } from "../src/learning-registry-store.js";
import { LearningExperimentStore } from "../src/learning/experiment-store.js";
import { buildQualityBinding, buildQualityReceipt } from "../src/quality-receipt.js";
import { createCandidatePoolAssembler } from "../src/learning/candidate-pool-assembler.js";
import { createGilleOutcomeEvidenceResolver } from "../src/learning/gille-outcome-evidence-resolver.js";
import { createGilleOutcomeExportClient } from "../src/learning/experiment-outcome-export.js";
import { runExperimentCadenceTick, type ExperimentCadenceDeps } from "../src/learning/experiment-cadence.js";
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
  readonly logs: Array<{ namespace: string; content: string; tags?: string[] }> = [];

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

  async log(namespace: string, content: string, tags?: string[]) {
    this.logs.push({ namespace, content, tags });
  }
}

function munin(): InMemoryMunin & MuninClient {
  return new InMemoryMunin() as unknown as InMemoryMunin & MuninClient;
}

const ref = (namespace: string, key: string) => ({ namespace, key });

/** Seed one fully resolvable production candidate (registry + admitted evidence + bound receipt). */
async function seedResolvableCandidate(
  m: InMemoryMunin & MuninClient,
  store: LearningRegistryStore,
  input: { taskId: string; taskType: string; modelId: string; rating: "pass" | "partial" | "redo" | "wrong"; occurredAt: string },
): Promise<void> {
  const { attemptId, attemptOutcomeRef, evidence } = buildFixtureAdmittedAttempt({
    taskId: input.taskId,
    taskType: input.taskType,
  });
  await m.write(attemptOutcomeRef.namespace, attemptOutcomeRef.key, JSON.stringify(evidence), []);

  const taskOutcomeRef = ref(`tasks/${input.taskId}`, "result-structured");
  await store.recordSubmission({ taskId: input.taskId, taskOutcomeRef, occurredAt: input.occurredAt });
  await store.recordAttemptReference({
    taskId: input.taskId, attemptId, attemptStartRef: ref(`tasks/${input.taskId}`, `learning-attempt-${attemptId}`),
    taskOutcomeRef, occurredAt: input.occurredAt,
  });
  await store.recordTerminalOutcome({
    taskId: input.taskId, attemptId, outcome: "completed", taskOutcomeRef, attemptOutcomeRef,
    delegation: { modelId: input.modelId, taskType: input.taskType, nodeId: "m5" },
    occurredAt: input.occurredAt,
  });

  const statusContent = buildFixtureStatusDocument(input.taskId, `prompt for ${input.taskId}`);
  const resultContent = buildFixtureResultStructuredDocument(input.taskId);
  await m.write(`tasks/${input.taskId}`, "status", statusContent, ["status"]);
  await m.write(`tasks/${input.taskId}`, "result-structured", resultContent, ["result"]);

  const binding = buildQualityBinding({ statusContent, structuredResultContent: resultContent });
  const receipt = buildQualityReceipt({
    taskId: input.taskId, reviewerPrincipal: "codex", reviewerIndependence: "independent",
    rating: input.rating, ratingReason: `SECRET-${input.taskId}`,
    verificationOutcome: input.rating === "pass" ? "accepted_unchanged" : "major_rewrite",
    ratedAt: input.occurredAt, bindingAttestation: "server-bound", binding,
  });
  await m.write(`tasks/${input.taskId}`, "feedback", JSON.stringify({ schemaVersion: 1, taskId: input.taskId, receipts: [receipt] }), []);
}

/** One-axis (model) population: champion arm has 2 pass + 2 wrong (proposer-visible
 * rate 0.5), challenger arm is 4 pass (rate 1.0) -- a 0.5 delta comfortably above the
 * proposer's 0.1 default and enough pass-rated candidates for the packager's floor.
 * Mirrors experiment-cadence.test.ts's own `seedOneAxisPopulation`, but built from REAL
 * registry/receipt/evidence state instead of hand-seeded `PackagerCandidateInput`s. */
async function seedOneAxisPopulation(
  m: InMemoryMunin & MuninClient,
  store: LearningRegistryStore,
  input: { taskType: string; idPrefix: string; startIso: string },
): Promise<void> {
  const championRatings: Array<"pass" | "wrong"> = ["pass", "pass", "wrong", "wrong"];
  for (let i = 0; i < 4; i += 1) {
    await seedResolvableCandidate(m, store, {
      taskId: `${input.idPrefix}-champ-${i}`, taskType: input.taskType, modelId: `${input.idPrefix}-champion-model`,
      rating: championRatings[i]!, occurredAt: new Date(Date.parse(input.startIso) + i * 86_400_000).toISOString(),
    });
  }
  for (let i = 0; i < 4; i += 1) {
    await seedResolvableCandidate(m, store, {
      taskId: `${input.idPrefix}-chall-${i}`, taskType: input.taskType, modelId: `${input.idPrefix}-challenger-model`,
      rating: "pass", occurredAt: new Date(Date.parse(input.startIso) + (5 + i) * 86_400_000).toISOString(),
    });
  }
}

const MECHANICAL_VERIFIER = { kind: "mechanical" as const, independent: true, id: "protected-check", version: "1" };
const HOLDOUT_SAMPLES = new Set(["case-1", "case-2"]);

/** Drive an experiment to its frozen conclusion gate (matches experiment-cadence.test.ts's
 * own `observePairs`), optionally anchoring each sample to a resolvable Hugin task_id so the
 * evidence resolver can reconstruct real export evidence for it. */
async function observePairsWithTaskIds(
  experimentStore: LearningExperimentStore,
  principal: string,
  experimentId: string,
  count: number,
  taskIdFor?: (sample: string, arm: "champion" | "challenger") => string | undefined,
): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    const sample = `case-${i}`;
    const holdout = HOLDOUT_SAMPLES.has(sample);
    await experimentStore.observe(principal, {
      experiment_id: experimentId, run_id: `${sample}-champion`, sample_id: sample, arm: "champion", holdout,
      configuration_fingerprint: (await experimentStore.read(principal, experimentId)).champion.fingerprint,
      quality_outcome: "fail", product_outcome: "discarded", verifier: MECHANICAL_VERIFIER,
      latency_ms: 1000, cost_usd: 0,
      ...(taskIdFor?.(sample, "champion") ? { task_id: taskIdFor(sample, "champion") } : {}),
    });
    await experimentStore.observe(principal, {
      experiment_id: experimentId, run_id: `${sample}-challenger`, sample_id: sample, arm: "challenger", holdout,
      configuration_fingerprint: (await experimentStore.read(principal, experimentId)).challenger.fingerprint,
      quality_outcome: "pass", product_outcome: "accepted-unchanged", verifier: MECHANICAL_VERIFIER,
      latency_ms: 1000, cost_usd: 0,
      ...(taskIdFor?.(sample, "challenger") ? { task_id: taskIdFor(sample, "challenger") } : {}),
    });
  }
}

function baseDeps(
  m: InMemoryMunin & MuninClient,
  registry: LearningRegistryStore,
  experimentStore: LearningExperimentStore,
  principal: string,
  overrides: Partial<ExperimentCadenceDeps> = {},
): ExperimentCadenceDeps {
  return {
    registry,
    experimentStore,
    munin: m,
    principal,
    loadCandidates: createCandidatePoolAssembler({ registry, munin: m }, { periods: ["2026-07"] }),
    now: () => "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("runExperimentCadenceTick with the production candidate-pool assembler", () => {
  it("proposes and packages exactly one experiment from real registry/receipt/evidence state, idempotently", async () => {
    const m = munin();
    const registry = new LearningRegistryStore(m);
    const experimentStore = new LearningExperimentStore(m);
    await seedOneAxisPopulation(m, registry, { taskType: "code-edit", idPrefix: "cadence-a", startIso: "2026-07-01T00:00:00.000Z" });
    const principal = "service:test-cadence-assembler";
    const deps = baseDeps(m, registry, experimentStore, principal);

    const tick1 = await runExperimentCadenceTick(deps);
    expect(tick1.errors).toEqual([]);
    expect(tick1.candidatesLoaded).toBe(8);
    expect(tick1.proposalsConsidered).toBe(1);
    expect(tick1.packaged).not.toBeNull();
    expect(tick1.packaged!.reused).toBe(false);

    const experimentId = tick1.packaged!.experimentId;
    const created = await experimentStore.read(principal, experimentId);
    expect(created.status).toBe("running");
    expect(created.changeAxis).toBe("model");

    // Re-running against unchanged registry/receipt state proposes the same
    // population again but packages nothing new -- already in flight.
    const tick2 = await runExperimentCadenceTick(deps);
    expect(tick2.errors).toEqual([]);
    expect(tick2.skippedInFlight).toHaveLength(1);
    expect(tick2.packaged).toBeNull();
  });
});

describe("runExperimentCadenceTick's gille export leg with a real evidence resolver", () => {
  let server: Server | undefined;
  let gatewayBaseUrl: string;
  const receivedBundles: unknown[] = [];

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    receivedBundles.length = 0;
  });

  async function startFixtureGateway(): Promise<void> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const bundle = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        receivedBundles.push(bundle);
        const body = JSON.stringify({
          experimentId: bundle.experimentId,
          runId: bundle.runId,
          arms: bundle.arms.map((arm: { armId: string; sampleId: string }) => ({
            armId: arm.armId, sampleId: arm.sampleId, status: "imported",
          })),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture gateway failed to bind a port");
    gatewayBaseUrl = `http://127.0.0.1:${address.port}`;
  }

  it("exports a resolvable concluded experiment exactly once; a second tick does not duplicate the export", async () => {
    await startFixtureGateway();
    const m = munin();
    const registry = new LearningRegistryStore(m);
    const experimentStore = new LearningExperimentStore(m);
    await seedOneAxisPopulation(m, registry, { taskType: "code-edit", idPrefix: "export-ok", startIso: "2026-07-01T00:00:00.000Z" });
    const principal = "service:test-cadence-export-ok";

    const gilleExport = createGilleOutcomeExportClient({ gatewayBaseUrl, apiKey: "test-key" });
    const evidenceResolver = createGilleOutcomeEvidenceResolver({ munin: m, registry });
    const deps = baseDeps(m, registry, experimentStore, principal, { gilleExport, evidenceResolver });

    const tick1 = await runExperimentCadenceTick(deps);
    const experimentId = tick1.packaged!.experimentId;

    // Anchor every observation sample to one of the already-resolvable seeded
    // candidate tasks so the evidence resolver can reconstruct real evidence.
    await observePairsWithTaskIds(experimentStore, principal, experimentId, 6, (sample, arm) => {
      const index = Number(sample.split("-")[1]) - 1;
      return arm === "champion" ? `export-ok-champ-${index % 4}` : `export-ok-chall-${index % 4}`;
    });

    const tick2 = await runExperimentCadenceTick(deps);
    expect(tick2.errors).toEqual([]);
    expect(tick2.concluded).toHaveLength(1);
    expect(tick2.concluded[0]!.exportStatus).toBe("attempted");
    expect(receivedBundles).toHaveLength(1);
    const bundle = receivedBundles[0] as { experimentId: string; arms: unknown[] };
    expect(bundle.experimentId).toBe(experimentId);
    expect((bundle.arms as unknown[]).length).toBeGreaterThan(0);

    // Re-running the tick again: the reviewable summary already exists, so
    // conclusion (and therefore export) is a no-op -- never a duplicate POST.
    const tick3 = await runExperimentCadenceTick(deps);
    expect(tick3.concluded).toEqual([
      expect.objectContaining({ experimentId, alreadyConcluded: true, summaryWritten: false }),
    ]);
    expect(receivedBundles).toHaveLength(1);
  });

  it("leaves an unresolvable concluded experiment skipped-with-reason -- never fabricates evidence", async () => {
    await startFixtureGateway();
    const m = munin();
    const registry = new LearningRegistryStore(m);
    const experimentStore = new LearningExperimentStore(m);
    await seedOneAxisPopulation(m, registry, { taskType: "summarize", idPrefix: "export-skip", startIso: "2026-07-01T00:00:00.000Z" });
    const principal = "service:test-cadence-export-skip";

    const gilleExport = createGilleOutcomeExportClient({ gatewayBaseUrl, apiKey: "test-key" });
    const evidenceResolver = createGilleOutcomeEvidenceResolver({ munin: m, registry });
    const deps = baseDeps(m, registry, experimentStore, principal, { gilleExport, evidenceResolver });

    const tick1 = await runExperimentCadenceTick(deps);
    const experimentId = tick1.packaged!.experimentId;

    // No task_id on any observation -- nothing for the resolver to anchor
    // evidence to, so every sample is genuinely unresolvable.
    await observePairsWithTaskIds(experimentStore, principal, experimentId, 6);

    const tick2 = await runExperimentCadenceTick(deps);
    expect(tick2.concluded).toHaveLength(1);
    expect(tick2.concluded[0]!.exportStatus).toBe("skipped");
    expect(tick2.concluded[0]!.exportDetail).toContain("no-resolvable-evidence");
    expect(receivedBundles).toHaveLength(0);
  });
});
