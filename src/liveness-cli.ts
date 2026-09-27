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
  isSafeWorkerLivenessId,
  WORKER_LIVENESS_MAX_POLL_INTERVAL_MS,
  type WorkerLivenessAssessment,
} from "./worker-liveness.js";

const HEARTBEAT_NAMESPACE = "tasks/_heartbeat";
const HEARTBEAT_KEY = "status";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const PENDING_COUNT_TIMEOUT_MS = 5_000;

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
  }, options?: { signal?: AbortSignal }): Promise<{ total: number }>;
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

  const envPollInterval = process.env.HUGIN_POLL_INTERVAL_MS;
  const defaultPollIntervalMs = envPollInterval === undefined
    ? DEFAULT_POLL_INTERVAL_MS
    : parsePollInterval(envPollInterval, "HUGIN_POLL_INTERVAL_MS");

  let pollIntervalMs = defaultPollIntervalMs;
  if (values["poll-interval-ms"] !== undefined) {
    pollIntervalMs = parsePollInterval(values["poll-interval-ms"], "--poll-interval-ms");
  }

  return {
    json: values.json ?? false,
    pollIntervalMs,
    help: values.help ?? false,
  };
}

function parsePollInterval(raw: string, source: string): number {
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed)
    || parsed <= 0
    || parsed > WORKER_LIVENESS_MAX_POLL_INTERVAL_MS
  ) {
    throw new Error(
      `${source} must be a positive integer no greater than ${WORKER_LIVENESS_MAX_POLL_INTERVAL_MS}`,
    );
  }
  return parsed;
}

/**
 * Best-effort pending-task count. `undefined` (unknown) on any failure —
 * a pending-count outage must never turn a liveness check itself into an
 * infrastructure error.
 */
async function fetchPendingCount(client: LivenessMuninReader): Promise<number | undefined> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = client.query({
      tags: ["pending"],
      namespace: "tasks/",
      entry_type: "state",
      limit: 1,
    }, { signal: controller.signal });
    return await Promise.race([
      query.then(({ total }) => total).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, PENDING_COUNT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function runLivenessCheck(
  client: LivenessMuninReader,
  options: { pollIntervalMs: number; now?: Date },
): Promise<WorkerLivenessAssessment> {
  const entry = await client.read(HEARTBEAT_NAMESPACE, HEARTBEAT_KEY);
  const pendingCount = await fetchPendingCount(client);
  const now = options.now ?? new Date();
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
  if (isSafeWorkerLivenessId(assessment.workerId)) {
    parts.push(`worker_id=${assessment.workerId}`);
  }
  if (assessment.ageMs !== null) parts.push(`age_ms=${assessment.ageMs}`);
  parts.push(`threshold_ms=${assessment.thresholdMs}`);
  if (isSafeWorkerLivenessId(assessment.currentTask)) {
    parts.push(`current_task=${assessment.currentTask}`);
  }
  parts.push(`attention=${assessment.attention}`);
  return `${parts.join(" ")} — ${assessment.reason.replace(/[\r\n]/g, " ")}`;
}

export interface LivenessCliOverrides {
  /** Test-only: skip real Munin construction and env-var checks. */
  client?: LivenessMuninReader;
  now?: Date;
}

function redactConfiguredApiKey(value: string): string {
  const apiKey = process.env.MUNIN_API_KEY?.trim();
  return apiKey ? value.split(apiKey).join("[REDACTED]") : value;
}

function writeStderr(value: string): void {
  process.stderr.write(redactConfiguredApiKey(value));
}

function writeStdout(value: string): void {
  process.stdout.write(redactConfiguredApiKey(value));
}

function extractHttpStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null) {
    for (const key of ["httpStatus", "statusCode", "status"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
        return value;
      }
    }
  }
  const message = error instanceof Error ? error.message : "";
  const match = message.match(/\b(?:HTTP|Munin)\s+([1-5]\d{2})\b/i);
  return match ? Number(match[1]) : null;
}

function formatInfrastructureError(error: unknown): string {
  const status = extractHttpStatus(error);
  return status === null
    ? "hugin-liveness: infrastructure error\n"
    : `hugin-liveness: infrastructure error (HTTP ${status})\n`;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  overrides: LivenessCliOverrides = {},
): Promise<number> {
  let options: LivenessCliOptions;
  try {
    options = parseLivenessCliArgs(argv);
  } catch (error) {
    writeStderr("hugin-liveness: invalid arguments\n");
    return 2;
  }

  if (options.help) {
    writeStdout(USAGE);
    return 0;
  }

  let client = overrides.client;
  if (!client) {
    const apiKey = process.env.MUNIN_API_KEY?.trim();
    if (!apiKey) {
      writeStderr("hugin-liveness: configuration error\n");
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
    writeStderr(formatInfrastructureError(error));
    return 2;
  }

  if (options.json) {
    writeStdout(`${JSON.stringify(assessment, null, 2)}\n`);
  } else {
    writeStdout(`${formatSummary(assessment)}\n`);
  }

  return computeExitCode(assessment);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    writeStderr(formatInfrastructureError(error));
    process.exitCode = 2;
  });
}
