#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const HARBOR_PILOT_VERSION = "harbor-0.18.0-gate-d-v1";
export const HARBOR_PILOT_DEFAULT_BASE_IMAGE = "node:22.17.0-bookworm-slim";
export const HARBOR_PILOT_TASK_IDS = [
  "01-make-failing-test-pass",
  "04-add-cli-flag",
] as const;

const metaSchema = z.object({
  id: z.string().min(1),
  oracleFiles: z.array(z.string().min(1)),
}).passthrough();

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertNoSymlinks(rootInput: string): void {
  const root = resolve(rootInput);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`Harbor pilot source contains a symlink: ${path}`);
      }
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
}

function gitOutput(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function taskToml(input: {
  taskId: string;
  sourceCommit: string;
  instructionSha256: string;
  metaSha256: string;
  networkMode: "no-network" | "public";
}): string {
  return `schema_version = "1.3"

[[artifacts]]
source = "/app"
exclude = ["node_modules", ".git", ".harbor-pilot.json"]

[metadata]
pilot_version = ${JSON.stringify(HARBOR_PILOT_VERSION)}
gate_d_id = ${JSON.stringify(input.taskId)}
source_commit = ${JSON.stringify(input.sourceCommit)}
instruction_sha256 = ${JSON.stringify(input.instructionSha256)}
meta_sha256 = ${JSON.stringify(input.metaSha256)}
network_mode = ${JSON.stringify(input.networkMode)}

[agent]
timeout_sec = 900.0
network_mode = ${JSON.stringify(input.networkMode)}

[verifier]
timeout_sec = 300.0
environment_mode = "separate"
network_mode = ${JSON.stringify(input.networkMode)}

[environment]
build_timeout_sec = 900.0
network_mode = ${JSON.stringify(input.networkMode)}
workdir = "/app"
cpus = 2
memory_mb = 2048
`;
}

function dockerfile(baseImage: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,240}$/.test(baseImage)) {
    throw new Error(`unsafe Harbor pilot base image: ${baseImage}`);
  }
  if (baseImage !== HARBOR_PILOT_DEFAULT_BASE_IMAGE) {
    return `FROM ${baseImage}

COPY repo/ /app/
COPY control.json /app/.harbor-pilot.json
RUN ln -s /opt/gate-d/node_modules /app/node_modules

WORKDIR /app
`;
  }
  return `FROM ${HARBOR_PILOT_DEFAULT_BASE_IMAGE}

RUN apt-get update \\
    && apt-get install -y --no-install-recommends git python3 \\
    && rm -rf /var/lib/apt/lists/*

RUN npm install --prefix /opt/gate-d --no-audit --no-fund \\
    typescript@5.9.3 tsx@4.21.0 @types/node@22.13.0

COPY repo/ /app/
COPY control.json /app/.harbor-pilot.json
RUN ln -s /opt/gate-d/node_modules /app/node_modules

WORKDIR /app
`;
}

function verifierDockerfile(baseImage: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,240}$/.test(baseImage)) {
    throw new Error(`unsafe Harbor pilot base image: ${baseImage}`);
  }
  const setup = baseImage === HARBOR_PILOT_DEFAULT_BASE_IMAGE
    ? `RUN apt-get update \\
    && apt-get install -y --no-install-recommends python3 \\
    && rm -rf /var/lib/apt/lists/*

RUN npm install --prefix /opt/gate-d --no-audit --no-fund \\
    typescript@5.9.3 tsx@4.21.0 @types/node@22.13.0

`
    : "";
  return `FROM ${baseImage}

${setup}COPY . /tests/
RUN chmod +x /tests/test.sh /tests/gate-d-check.sh

WORKDIR /app
`;
}

const verifierScript = `#!/usr/bin/env bash
set -uo pipefail

mkdir -p /logs/verifier
# Harbor mounts the collected artifact at /app for a separate verifier. That
# mount hides the image-layer symlink created by the task environment, so the
# verifier must restore its dependency link at runtime.
if [ ! -e /app/node_modules ]; then
  ln -s /opt/gate-d/node_modules /app/node_modules
fi
set +e
bash /tests/gate-d-check.sh /tests/task /app > /logs/verifier/gate-d-check.log 2>&1
status=$?
set -e

if [ "$status" -eq 0 ]; then
  printf '%s\n' '{"reward":1,"gate_d_all_gates":1}' > /logs/verifier/reward.json
else
  printf '%s\n' '{"reward":0,"gate_d_all_gates":0}' > /logs/verifier/reward.json
fi

exit 0
`;

export interface PreparedHarborPilot {
  outputDir: string;
  tasksDir: string;
  sourceCommit: string;
  taskIds: string[];
  networkMode: "no-network" | "public";
  baseImage: string;
}

export function prepareGateDHarborPilot(input: {
  sourceRepo: string;
  outputDir: string;
  taskIds?: readonly string[];
  networkMode?: "no-network" | "public";
  baseImage?: string;
}): PreparedHarborPilot {
  const sourceRepo = resolve(input.sourceRepo);
  const outputDir = resolve(input.outputDir);
  const taskIds = [...(input.taskIds ?? HARBOR_PILOT_TASK_IDS)];
  const networkMode = input.networkMode ?? "no-network";
  const baseImage = input.baseImage ?? HARBOR_PILOT_DEFAULT_BASE_IMAGE;
  const sourceGateD = join(sourceRepo, "gate-d");
  const checkPath = join(sourceGateD, "check.sh");

  const dirty = gitOutput(sourceRepo, ["status", "--short"]);
  if (dirty) {
    throw new Error("Gate D source repository must be clean before a reproducible Harbor run");
  }
  const sourceCommit = gitOutput(sourceRepo, ["rev-parse", "HEAD"]);
  mkdirSync(outputDir, { recursive: false });
  const tasksDir = join(outputDir, "tasks");
  mkdirSync(tasksDir);

  for (const taskId of taskIds) {
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(taskId)) {
      throw new Error(`unsafe Gate D task id: ${taskId}`);
    }
    const sourceTask = join(sourceGateD, "tasks", taskId);
    const instructionPath = join(sourceTask, "INSTRUCTION.md");
    const metaPath = join(sourceTask, "meta.json");
    const seedPath = join(sourceTask, "repo");
    assertNoSymlinks(sourceTask);
    const meta = metaSchema.parse(JSON.parse(readFileSync(metaPath, "utf8")));
    if (meta.id !== taskId) {
      throw new Error(`Gate D meta id mismatch: expected ${taskId}, got ${meta.id}`);
    }

    const taskDir = join(tasksDir, taskId);
    const environmentDir = join(taskDir, "environment");
    const testsTaskDir = join(taskDir, "tests", "task");
    mkdirSync(environmentDir, { recursive: true });
    mkdirSync(testsTaskDir, { recursive: true });

    const instruction = readFileSync(instructionPath, "utf8");
    writeFileSync(join(taskDir, "instruction.md"), instruction);
    writeFileSync(join(taskDir, "task.toml"), taskToml({
      taskId,
      sourceCommit,
      instructionSha256: sha256File(instructionPath),
      metaSha256: sha256File(metaPath),
      networkMode,
    }));
    writeFileSync(join(environmentDir, "Dockerfile"), dockerfile(baseImage));
    writeFileSync(join(environmentDir, "control.json"), `${JSON.stringify({
      schema_version: 1,
      pilot_version: HARBOR_PILOT_VERSION,
      task_id: taskId,
      protected: meta.oracleFiles,
    }, null, 2)}\n`);
    cpSync(seedPath, join(environmentDir, "repo"), { recursive: true });

    const testsDir = join(taskDir, "tests");
    writeFileSync(join(testsDir, "Dockerfile"), verifierDockerfile(baseImage));
    writeFileSync(join(testsDir, "test.sh"), verifierScript, { mode: 0o755 });
    cpSync(checkPath, join(testsDir, "gate-d-check.sh"));
    cpSync(metaPath, join(testsTaskDir, "meta.json"));
    cpSync(seedPath, join(testsTaskDir, "repo"), { recursive: true });
    const hiddenOracle = (meta as { hiddenOracle?: unknown }).hiddenOracle;
    if (typeof hiddenOracle === "string" && hiddenOracle) {
      const hiddenPath = resolve(sourceTask, hiddenOracle);
      if (relative(sourceTask, hiddenPath).startsWith("..")) {
        throw new Error(`hidden oracle escaped task root: ${hiddenOracle}`);
      }
      const hiddenTarget = join(testsTaskDir, hiddenOracle);
      mkdirSync(dirname(hiddenTarget), { recursive: true });
      cpSync(hiddenPath, hiddenTarget);
    }
  }

  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    pilot_version: HARBOR_PILOT_VERSION,
    harbor_version: "0.18.0",
    source_repo: basename(sourceRepo),
    source_commit: sourceCommit,
    task_ids: taskIds,
    network_mode: networkMode,
    base_image: baseImage,
  }, null, 2)}\n`);

  return { outputDir, tasksDir, sourceCommit, taskIds, networkMode, baseImage };
}

async function main(): Promise<void> {
  const [sourceRepo, outputDir, networkModeArg, baseImage] = process.argv.slice(2);
  if (!sourceRepo || !outputDir) {
    throw new Error("usage: prepare-gate-d.ts <gille-inference-repo> <new-output-dir>");
  }
  if (networkModeArg && networkModeArg !== "no-network" && networkModeArg !== "public") {
    throw new Error("network mode must be no-network or public");
  }
  const prepared = prepareGateDHarborPilot({
    sourceRepo,
    outputDir,
    networkMode: networkModeArg as "no-network" | "public" | undefined,
    baseImage,
  });
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
