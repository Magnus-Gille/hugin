#!/usr/bin/env tsx
/**
 * Resumable Gate-D-style champion/challenger runner.
 *
 * Credentials are environment-only. Recommended invocation:
 *   eval "$(m5-auth --env --tailnet)"
 *   HUGIN_BROKER_URL=... HUGIN_BROKER_TOKEN=... \
 *     npm run experiment:m5-code-loop -- ./wave.json
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { BrokerClient, BrokerHttpError } from "../src/mcp/broker-client.js";
import {
  learningExperimentCreateSchema,
  type LearningExperimentCreate,
  type LearningExperimentState,
} from "../src/learning/experiment-schema.js";
import {
  observationFromM5CodeLoop,
  type M5CodeLoopResult,
} from "../src/learning/m5-code-loop-adapter.js";
import {
  applyCodeLoopPromptPrefix,
  codeLoopPromptSha256,
} from "../src/learning/m5-code-loop-prompt.js";
import {
  M5CodeLoopClient,
  type M5CodeLoopRequest,
} from "../src/learning/m5-code-loop-client.js";

const capsSchema = z.object({
  wall_s: z.number().int().positive().max(900),
  turns: z.number().int().positive().max(40),
  completion_tokens: z.number().int().positive().max(120_000),
  edit_deadline_turn: z.number().int().positive().max(40).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.edit_deadline_turn !== undefined && value.edit_deadline_turn > value.turns) {
    ctx.addIssue({
      code: "custom",
      path: ["edit_deadline_turn"],
      message: "edit deadline must not exceed the turn cap",
    });
  }
});

const armSchema = z.object({
  caps: capsSchema,
  /** Local-only prompt content; Hugin stores only the bound prompt ref. */
  prompt_prefix_file: z.string().min(1).optional(),
}).strict();

const sampleSchema = z.object({
  id: z.string().min(1).max(120),
  holdout: z.boolean(),
  instruction_file: z.string().min(1),
  task_dir: z.string().min(1),
  seed_dir: z.string().min(1),
  m5_check_cmd: z.string().min(1).optional(),
  protected: z.array(z.string().min(1)).default([]),
}).strict();

const manifestSchema = z.object({
  schema_version: z.literal(1),
  experiment: learningExperimentCreateSchema,
  arms: z.object({
    champion: armSchema,
    challenger: armSchema,
  }).strict(),
  verifier: z.object({
    script: z.string().min(1),
    version: z.string().min(1).max(120),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    node_modules_dir: z.string().min(1),
  }).strict(),
  samples: z.array(sampleSchema).min(2).max(100),
  poll_ms: z.number().int().min(250).max(30_000).default(5_000),
  result_deadline_s: z.number().int().min(60).max(3_600).default(900),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const [index, sample] of value.samples.entries()) {
    if (ids.has(sample.id)) {
      ctx.addIssue({ code: "custom", path: ["samples", index, "id"], message: "duplicate sample id" });
    }
    ids.add(sample.id);
  }
  const holdouts = value.samples.filter((sample) => sample.holdout).length;
  if (holdouts < value.experiment.gates.minHoldoutPairs) {
    ctx.addIssue({
      code: "custom",
      path: ["samples"],
      message: `manifest needs at least ${value.experiment.gates.minHoldoutPairs} holdout samples`,
    });
  }
  for (const arm of ["champion", "challenger"] as const) {
    const config = value.experiment[arm].harness;
    const caps = value.arms[arm].caps;
    if (config.maxTurns !== caps.turns) {
      ctx.addIssue({ code: "custom", path: ["arms", arm, "caps", "turns"], message: "turn cap differs from the versioned harness config" });
    }
    if (config.editDeadlineTurn !== caps.edit_deadline_turn) {
      ctx.addIssue({ code: "custom", path: ["arms", arm, "caps", "edit_deadline_turn"], message: "edit deadline differs from the versioned harness config" });
    }
  }
});

type Manifest = z.infer<typeof manifestSchema>;
type LoadedSample = z.infer<typeof sampleSchema> & {
  instruction: string;
  files: Array<{ path: string; content: string }>;
  taskDir: string;
  taskFiles: Array<{ path: string; content: string }>;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`missing required environment variable ${name}`);
  return value;
}

function m5McpEndpoint(): string {
  const explicit = process.env.M5_MCP_URL;
  if (explicit) return explicit;
  const base = requiredEnv("M5_BASE_URL");
  const url = new URL(base);
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function filesUnder(
  rootInput: string,
  enforceM5Caps = true,
): Array<{ path: string; content: string }> {
  const root = resolve(rootInput);
  if (!lstatSync(root).isDirectory()) throw new Error(`seed_dir is not a directory: ${root}`);
  const output: Array<{ path: string; content: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = resolve(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`seed corpus contains a symlink: ${path}`);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) continue;
      const rel = relative(root, path);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`seed file escaped root: ${path}`);
      output.push({ path: rel, content: readFileSync(path, "utf8") });
    }
  };
  walk(root);
  if (output.length === 0) throw new Error(`seed_dir has no files: ${root}`);
  if (enforceM5Caps && output.length > 64) throw new Error(`seed_dir exceeds M5's 64-file cap: ${root}`);
  const bytes = output.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  if (enforceM5Caps && bytes > 2 * 1024 * 1024) throw new Error(`seed_dir exceeds M5's 2 MiB cap: ${root}`);
  return output;
}

function loadSamples(manifest: Manifest, manifestDir: string): LoadedSample[] {
  return manifest.samples.map((sample) => {
    const taskDir = resolve(manifestDir, sample.task_dir);
    const meta = JSON.parse(readFileSync(join(taskDir, "meta.json"), "utf8")) as {
      oracleFiles?: unknown;
    };
    const oracleFiles = Array.isArray(meta.oracleFiles)
      ? meta.oracleFiles.filter((value): value is string => typeof value === "string")
      : [];
    const missingProtection = oracleFiles.filter((path) => !sample.protected.includes(path));
    if (missingProtection.length > 0) {
      throw new Error(
        `sample ${sample.id} does not protect Gate D oracle file(s): ${missingProtection.join(", ")}`,
      );
    }
    return {
      ...sample,
      instruction: readFileSync(resolve(manifestDir, sample.instruction_file), "utf8"),
      files: filesUnder(resolve(manifestDir, sample.seed_dir)),
      taskDir,
      taskFiles: filesUnder(taskDir, false),
    };
  });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function gateDCorpusFingerprint(
  samples: LoadedSample[],
  verifier: { version: string; sha256: string },
): string {
  const contentBlindManifest = {
    verifier,
    samples: samples.map((sample) => ({
    id: sample.id,
    holdout: sample.holdout,
    instructionSha256: createHash("sha256").update(sample.instruction).digest("hex"),
    files: sample.files.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content).digest("hex"),
    })),
    taskFiles: sample.taskFiles.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.content).digest("hex"),
    })),
    m5CheckCmdSha256: sample.m5_check_cmd
      ? createHash("sha256").update(sample.m5_check_cmd).digest("hex")
      : null,
    protected: [...sample.protected].sort(),
    })),
  };
  return createHash("sha256").update(stable(contentBlindManifest)).digest("hex");
}

function verifyGateD(
  result: M5CodeLoopResult,
  sample: LoadedSample,
  verifier: Manifest["verifier"],
  manifestDir: string,
): { ran: true; passed: boolean; testsRan: boolean; id: string; version: string; durationMs: number } {
  const started = Date.now();
  const workRoot = mkdtempSync(join(tmpdir(), `hugin-gate-d-${sample.id}-`));
  const work = join(workRoot, "repo");
  try {
    cpSync(resolve(manifestDir, sample.seed_dir), work, { recursive: true });
    const nodeModules = resolve(manifestDir, verifier.node_modules_dir);
    symlinkSync(nodeModules, join(work, "node_modules"), "dir");
    const applied = spawnSync(
      "git",
      ["apply", "--whitespace=nowarn", "-"],
      { cwd: work, input: result.diff, encoding: "utf8", timeout: 60_000 },
    );
    if (applied.status !== 0) {
      return {
        ran: true,
        passed: false,
        testsRan: false,
        id: "gate-d-check",
        version: verifier.version,
        durationMs: Date.now() - started,
      };
    }
    const checked = spawnSync(
      "bash",
      [resolve(manifestDir, verifier.script), sample.taskDir, work],
      { encoding: "utf8", timeout: 300_000 },
    );
    return {
      ran: true,
      passed: checked.status === 0,
      testsRan: true,
      id: "gate-d-check",
      version: verifier.version,
      durationMs: Date.now() - started,
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function supportsIssue247(tools: Array<Record<string, unknown>>): boolean {
  const start = tools.find((tool) => tool.name === "code_loop_start");
  return !!start && JSON.stringify(start).includes("edit_deadline_turn");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readOrCreate(
  broker: BrokerClient,
  experiment: LearningExperimentCreate,
): Promise<LearningExperimentState> {
  try {
    const response = await broker.experimentStatus({ experiment_id: experiment.experiment_id }) as { state: LearningExperimentState };
    return response.state;
  } catch (err) {
    if (!(err instanceof BrokerHttpError) || err.httpStatus !== 404) throw err;
  }
  const response = await broker.experimentCreate(experiment) as { state: LearningExperimentState };
  return response.state;
}

async function runArm(input: {
  m5: M5CodeLoopClient;
  broker: BrokerClient;
  manifest: Manifest;
  sample: LoadedSample;
  arm: "champion" | "challenger";
  promptPrefix: string | undefined;
  manifestDir: string;
}): Promise<void> {
  const { m5, broker, manifest, sample, arm, promptPrefix, manifestDir } = input;
  const config = manifest.experiment[arm];
  const runId = `${manifest.experiment.experiment_id}:${sample.id}:${arm}:${config.fingerprint.slice(0, 12)}`;
  const request: M5CodeLoopRequest = {
    instruction: applyCodeLoopPromptPrefix(sample.instruction, promptPrefix),
    files: sample.files,
    check_cmd: sample.m5_check_cmd,
    protected: sample.protected,
    task_type: manifest.experiment.task_type,
    caps: manifest.arms[arm].caps,
  };
  process.stdout.write(`[${sample.id}/${arm}] starting\n`);
  const started = await m5.start(request);
  const deadline = Date.now() + manifest.result_deadline_s * 1_000;
  for (;;) {
    await sleep(manifest.poll_ms);
    const status = await m5.status(started.work_id);
    if (status.status !== "running") break;
    if (Date.now() >= deadline) {
      throw new Error(`[${sample.id}/${arm}] result deadline exceeded for ${started.work_id}`);
    }
  }
  const result = await m5.result(started.work_id);
  const externalVerification = verifyGateD(
    result,
    sample,
    manifest.verifier,
    manifestDir,
  );
  const observation = observationFromM5CodeLoop(result, {
    experimentId: manifest.experiment.experiment_id,
    runId,
    sampleId: sample.id,
    arm,
    holdout: sample.holdout,
    configurationFingerprint: config.fingerprint,
    expectedExecution: {
      model: config.model.id,
      harnessVersion: config.harness.version,
      caps: manifest.arms[arm].caps,
    },
    externalVerification,
  });
  await broker.experimentObserve(observation);
  process.stdout.write(
    `[${sample.id}/${arm}] ${observation.quality_outcome}; edit=${observation.edit_start_ms ?? "unmeasured"}ms; work=${result.work_id}\n`,
  );
}

async function main(): Promise<void> {
  const manifestArg = process.argv[2];
  if (!manifestArg) throw new Error("usage: run-m5-code-loop-experiment.ts <manifest.json> [--dry-run]");
  const manifestPath = resolve(manifestArg);
  const manifestDir = dirname(manifestPath);
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const samples = loadSamples(manifest, manifestDir);
  const promptPrefixes = Object.fromEntries(
    (["champion", "challenger"] as const).map((arm) => {
      const path = manifest.arms[arm].prompt_prefix_file;
      const prefix = path === undefined
        ? undefined
        : readFileSync(resolve(manifestDir, path), "utf8");
      if (prefix !== undefined && prefix.length > 20_000) {
        throw new Error(`${arm} prompt prefix exceeds 20,000 characters`);
      }
      const expected = codeLoopPromptSha256(prefix);
      const declared = manifest.experiment[arm].prompt.sha256;
      if (declared !== expected) {
        throw new Error(
          `${arm} prompt fingerprint mismatch: manifest=${declared} actual=${expected}`,
        );
      }
      return [arm, prefix];
    }),
  ) as Record<"champion" | "challenger", string | undefined>;
  const verifierSha256 = createHash("sha256")
    .update(readFileSync(resolve(manifestDir, manifest.verifier.script)))
    .digest("hex");
  if (verifierSha256 !== manifest.verifier.sha256) {
    throw new Error(
      `verifier fingerprint mismatch: manifest=${manifest.verifier.sha256} actual=${verifierSha256}`,
    );
  }
  const corpusFingerprint = gateDCorpusFingerprint(samples, {
    version: manifest.verifier.version,
    sha256: verifierSha256,
  });
  if (corpusFingerprint !== manifest.experiment.champion.testHarness.corpusSha256) {
    throw new Error(
      `corpus fingerprint mismatch: manifest=${manifest.experiment.champion.testHarness.corpusSha256} actual=${corpusFingerprint}`,
    );
  }
  process.stdout.write(
    `validated ${samples.length} matched samples (${samples.filter((sample) => sample.holdout).length} holdouts), corpus ${corpusFingerprint}\n`,
  );
  if (process.argv.includes("--dry-run")) return;

  const m5 = new M5CodeLoopClient({
    endpoint: m5McpEndpoint(),
    bearerToken: requiredEnv("M5_API_KEY"),
  });
  const broker = new BrokerClient({
    baseUrl: requiredEnv("HUGIN_BROKER_URL"),
    bearerToken: requiredEnv("HUGIN_BROKER_TOKEN"),
  });
  if (!supportsIssue247(await m5.toolDefinitions())) {
    throw new Error("M5 code_loop does not advertise edit_deadline_turn; deploy gille-inference #247 before creating the experiment");
  }

  let state = await readOrCreate(broker, manifest.experiment);
  if (state.status !== "running") {
    process.stdout.write(`experiment already ${state.status}: ${state.evaluation.nextAction}\n`);
    return;
  }
  const recorded = new Set(state.observations.map((observation) => observation.run_id));
  for (const [index, sample] of samples.entries()) {
    // Counterbalance first-arm order so warmth/time does not always favor one arm.
    const order: Array<"champion" | "challenger"> =
      index % 2 === 0 ? ["champion", "challenger"] : ["challenger", "champion"];
    for (const arm of order) {
      const config = manifest.experiment[arm];
      const runId = `${manifest.experiment.experiment_id}:${sample.id}:${arm}:${config.fingerprint.slice(0, 12)}`;
      if (recorded.has(runId)) {
        process.stdout.write(`[${sample.id}/${arm}] already recorded; skipping\n`);
        continue;
      }
      await runArm({
        m5,
        broker,
        manifest,
        sample,
        arm,
        promptPrefix: promptPrefixes[arm],
        manifestDir,
      });
      recorded.add(runId);
    }
  }
  state = (await broker.experimentStatus({
    experiment_id: manifest.experiment.experiment_id,
  }) as { state: LearningExperimentState }).state;
  process.stdout.write(
    `experiment ${state.status}: ${state.evaluation.reason}\nnext: ${state.evaluation.nextAction}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
