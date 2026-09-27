#!/usr/bin/env node

/**
 * Operator/monitoring CLI for issue #389: one deterministic answer to "is the
 * Hugin dispatcher worker alive", derived from its `tasks/_heartbeat` Munin
 * entry via `assessWorkerLiveness`. Consumers (Claude submit/status skills,
 * Heimdall) should use this instead of re-deriving their own staleness
 * threshold. Mirrors `publication-recovery-cli.ts`'s composition-root shape:
 * build a real Munin client from env vars, call the pure assessment
 * function, translate the result into an exit code.
 */
import { parseArgs as parseNodeArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { MuninClient } from "./munin-client.js";
import {
  assessWorkerLiveness,
  type WorkerLivenessAssessment,
} from "./worker-liveness.js";

const HEARTBEAT_NAMESPACE = "tasks/_heartbeat";
const HEARTBEAT_KEY = "status";
const DEFAULT_POLL_INTERVAL_MS = 30_000;

const USAGE = `Usage: hugin-liveness [options]

Assess whether the Hugin dispatcher worker is alive from its Munin heartbeat
(tasks/_heartbeat). See docs/worker-liveness.md for the full contract.

Options:
  --json                      Emit the full assessment as JSON instead of a
                               one-line human summary
  --poll-interval-ms <n>      Poll interval used to derive the staleness
                               threshold (default: HUGIN_POLL_INTERVAL_MS or
                               30000)
  --help                      Show this help

Environment:
  MUNIN_URL       Munin base URL (default http://localhost:3030)
  MUNIN_API_KEY   Munin API key (required unless a client is injected)

Exit codes:
  0   healthy-idle or healthy-busy
  1   stale, absent, or malformed heartbeat
  2   infrastructure error (Munin unreachable, bad arguments, missing key)
`;

/** The subset of MuninClient this CLI needs — narrow and easy to fake in tests. */
export interface LivenessMuninReader {
  read(namespace: string, key: string): Promise<{ content: string } | null>;
  query(opts: {
    tags?: string[];
    namespace?: string;
    entry_type?: string;
    limit?: number;
  }): Promise<{ total: number }>;
}

export interface LivenessCliOptions {
  json: boolean;
  pollIntervalMs: number;
  help: boolean;
}

export function parseLivenessCliArgs(argv: string[]): LivenessCliOptions {
  const { values } = parseNodeArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      json: { type: "boolean", default: false },
      "poll-interval-ms": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  const envDefault = Number(process.env.HUGIN_POLL_INTERVAL_MS);
  const defaultPollIntervalMs =
    Number.isFinite(envDefault) && envDefault > 0 ? envDefault : DEFAULT_POLL_INTERVAL_MS;

  let pollIntervalMs = defaultPollIntervalMs;
  if (values["poll-interval-ms"] !== undefined) {
    const parsed = Number(values["poll-interval-ms"]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("--poll-interval-ms must be a positive number");
    }
    pollIntervalMs = parsed;
  }

  return {
    json: values.json ?? false,
    pollIntervalMs,
    help: values.help ?? false,
  };
}

/**
 * Best-effort pending-task count. `undefined` (unknown) on any failure —
 * a pending-count outage must never turn a liveness check itself into an
 * infrastructure error.
 */
async function fetchPendingCount(client: LivenessMuninReader): Promise<number | undefined> {
  try {
    const { total } = await client.query({
      tags: ["pending"],
      namespace: "tasks/",
      entry_type: "state",
      limit: 1,
    });
    return total;
  } catch {
    return undefined;
  }
}

export async function runLivenessCheck(
  client: LivenessMuninReader,
  options: { pollIntervalMs: number; now?: Date },
): Promise<WorkerLivenessAssessment> {
  const now = options.now ?? new Date();
  const entry = await client.read(HEARTBEAT_NAMESPACE, HEARTBEAT_KEY);
  const pendingCount = await fetchPendingCount(client);
  return assessWorkerLiveness({
    heartbeat: entry?.content ?? null,
    now,
    pollIntervalMs: options.pollIntervalMs,
    pendingCount,
  });
}

export function computeExitCode(assessment: Pick<WorkerLivenessAssessment, "state">): number {
  return assessment.state === "healthy-idle" || assessment.state === "healthy-busy" ? 0 : 1;
}

export function formatSummary(assessment: WorkerLivenessAssessment): string {
  const parts = [`worker ${assessment.state}`];
  if (assessment.workerId) parts.push(`worker_id=${assessment.workerId}`);
  if (assessment.ageMs !== null) parts.push(`age_ms=${assessment.ageMs}`);
  parts.push(`threshold_ms=${assessment.thresholdMs}`);
  if (assessment.currentTask) parts.push(`current_task=${assessment.currentTask}`);
  parts.push(`attention=${assessment.attention}`);
  return `${parts.join(" ")} — ${assessment.reason}`;
}

export interface LivenessCliOverrides {
  /** Test-only: skip real Munin construction and env-var checks. */
  client?: LivenessMuninReader;
  now?: Date;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  overrides: LivenessCliOverrides = {},
): Promise<number> {
  let options: LivenessCliOptions;
  try {
    options = parseLivenessCliArgs(argv);
  } catch (error) {
    process.stderr.write(
      `hugin-liveness: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let client = overrides.client;
  if (!client) {
    const apiKey = process.env.MUNIN_API_KEY?.trim();
    if (!apiKey) {
      process.stderr.write("hugin-liveness: MUNIN_API_KEY is required\n");
      return 2;
    }
    client = new MuninClient({
      baseUrl: process.env.MUNIN_URL?.trim() || "http://localhost:3030",
      apiKey,
    });
  }

  let assessment: WorkerLivenessAssessment;
  try {
    assessment = await runLivenessCheck(client, {
      pollIntervalMs: options.pollIntervalMs,
      now: overrides.now,
    });
  } catch (error) {
    process.stderr.write(
      `hugin-liveness: infrastructure error — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(assessment)}\n`);
  }

  return computeExitCode(assessment);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(
      `hugin-liveness: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
