#!/usr/bin/env tsx

import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MuninClient, type MuninEntry } from "./munin-client.js";
import { queryAllMuninEntries } from "./munin-pagination.js";
import {
  applyCrossClientExposure,
  buildDailyExamManifest,
  type DailyTaskHarvestSource,
} from "./learning/daily-task-exam-factory.js";
import {
  lookupTaskExposureSnapshots,
  TASK_EXPOSURE_SMOKE_FINGERPRINT,
  TaskExposureLookupError,
} from "./learning/m5-task-exposure.js";

interface CliOptions {
  since?: string;
  until?: string;
  limit: number;
  output?: string;
}

export interface MuninStartupReadinessOptions {
  /** Total number of readiness probes, including the first call. */
  maxAttempts?: number;
  /** Fixed delay between attempts; kept deterministic and bounded for oneshot use. */
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const DAILY_EXAM_MUNIN_STARTUP_MAX_ATTEMPTS = 3;
const DAILY_EXAM_MUNIN_STARTUP_RETRY_DELAY_MS = 1_000;

/**
 * Wait for Munin's HTTP endpoint before starting the harvest. The harvest is
 * deliberately invoked exactly once: it starts several serialized requests,
 * so retrying it after one branch fails can leave the prior requests queued.
 */
export async function runWithMuninStartupReadiness<T>(
  probe: () => Promise<boolean>,
  operation: () => Promise<T>,
  options: MuninStartupReadinessOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DAILY_EXAM_MUNIN_STARTUP_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DAILY_EXAM_MUNIN_STARTUP_RETRY_DELAY_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Munin startup readiness maxAttempts must be a positive integer");
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("Munin startup readiness retryDelayMs must be a non-negative integer");
  }
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));

  let lastProbeError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let ready = false;
    try {
      ready = await probe();
    } catch (error) {
      lastProbeError = error;
    }
    if (ready) return await operation();
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }
  if (lastProbeError !== undefined) throw lastProbeError;
  throw new Error("Munin startup readiness exhausted without an attempt");
}

function usage(): string {
  return [
    "Usage: npm run harvest:daily-exams -- [options]",
    "",
    "Read completed Hugin tasks from Munin and emit a content-blind, quarantined",
    "exam-candidate manifest joined to the owner-only M5 exposure snapshot. This",
    "command never runs a model, writes Munin, or imports/promotes learning evidence.",
    "",
    "Options:",
    "  --since <ISO>    Only inspect tasks updated at/after this timestamp",
    "  --lookback-hours <N>  Inspect a rolling window ending now (1..8760)",
    "  --until <ISO>    Only inspect tasks updated at/before this timestamp",
    "  --limit <N>      Maximum task status rows to inspect (default 500)",
    "  --output <path>  Write mode-0600 JSON here instead of stdout",
    "  --help           Show this help",
  ].join("\n");
}

function normalizedTimestamp(value: string, flag: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${flag} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

export function parseArgs(argv: string[], nowMs = Date.now()): CliOptions {
  const options: CliOptions = { limit: 500 };
  let lookbackHours: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--since") options.since = normalizedTimestamp(value, arg);
    else if (arg === "--lookback-hours") {
      const hours = Number(value);
      if (!Number.isInteger(hours) || hours < 1 || hours > 8_760) {
        throw new Error("--lookback-hours must be an integer from 1 to 8760");
      }
      lookbackHours = hours;
    }
    else if (arg === "--until") options.until = normalizedTimestamp(value, arg);
    else if (arg === "--output") options.output = resolve(value);
    else if (arg === "--limit") {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
        throw new Error("--limit must be an integer from 1 to 10000");
      }
      options.limit = limit;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
    index += 1;
  }
  if (options.since && lookbackHours !== undefined) {
    throw new Error("--since and --lookback-hours are mutually exclusive");
  }
  if (lookbackHours !== undefined) {
    options.since = new Date(nowMs - lookbackHours * 60 * 60 * 1_000).toISOString();
  }
  if (options.since && options.until && options.since > options.until) {
    throw new Error("--since must not be later than --until");
  }
  return options;
}

export function writeManifestFile(outputPath: string, json: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, json, { encoding: "utf8" });
    closeSync(fd);
    fd = undefined;
    // Atomic replacement does not follow an existing destination symlink.
    renameSync(temporary, outputPath);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort cleanup */ }
    }
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export function taskExposureFingerprintsForLookup(candidates: Array<{
  lane: string;
  crossClientExposure: { fingerprintSha256?: string };
}>): string[] {
  const eligible = [...new Set(candidates.flatMap((candidate) =>
    candidate.lane === "provisional-holdout" && candidate.crossClientExposure.fingerprintSha256
      ? [candidate.crossClientExposure.fingerprintSha256]
      : []))];
  return eligible.length > 0 ? eligible : [TASK_EXPOSURE_SMOKE_FINGERPRINT];
}

async function loadSources(
  munin: MuninClient,
  options: CliOptions,
): Promise<{ sources: DailyTaskHarvestSource[]; historyComplete: boolean }> {
  const queried = await queryAllMuninEntries(
    munin,
    {
      tags: ["completed"],
      namespace: "tasks/",
      entry_type: "state",
      ...(options.since ? { since: options.since } : {}),
      ...(options.until ? { until: options.until } : {}),
    },
    {
      maxPages: Math.max(1, Math.ceil(options.limit / 50)),
      maxResults: options.limit,
    },
  );
  const namespaces = [...new Set(
    queried.results
      .filter((entry) => entry.key === "status" && entry.namespace.startsWith("tasks/"))
      .map((entry) => entry.namespace),
  )].sort();
  const [statuses, results, feedback] = await Promise.all([
    munin.readBatch(namespaces.map((namespace) => ({ namespace, key: "status" }))),
    munin.readBatch(namespaces.map((namespace) => ({ namespace, key: "result-structured" }))),
    munin.readBatch(namespaces.map((namespace) => ({ namespace, key: "feedback" }))),
  ]);
  const sources: DailyTaskHarvestSource[] = [];
  for (let index = 0; index < namespaces.length; index += 1) {
    const status = statuses[index];
    if (!status?.found) continue;
    const result = results[index];
    sources.push({
      status: status as MuninEntry,
      resultStructured: result?.found ? result as MuninEntry : null,
      feedback: feedback[index]?.found ? feedback[index] as MuninEntry : null,
    });
  }
  return { sources, historyComplete: !queried.truncated };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const apiKey = process.env.MUNIN_API_KEY?.trim();
  if (!apiKey) throw new Error("MUNIN_API_KEY is required");
  const munin = new MuninClient({
    baseUrl: process.env.MUNIN_URL?.trim() || "http://localhost:3030",
    apiKey,
  });
  const loaded = await runWithMuninStartupReadiness(
    () => munin.health(),
    () => loadSources(munin, options),
  );
  const generatedAt = new Date().toISOString();
  const provisionalManifest = buildDailyExamManifest({
    generatedAt,
    historyComplete: loaded.historyComplete,
    sources: loaded.sources,
  });
  // Even an empty eligible day proves the minted-owner endpoint/auth/schema
  // with a fixed non-task digest. Its result is intentionally discarded.
  const lookupFingerprints = taskExposureFingerprintsForLookup(provisionalManifest.candidates);
  let lookupFailure: TaskExposureLookupError | undefined;
  let manifest;
  try {
    const snapshots = await lookupTaskExposureSnapshots({
      gatewayBaseUrl: process.env.HOMESERVER_GATEWAY_URL?.trim() ?? "",
      apiKey: process.env.HOMESERVER_GATEWAY_API_KEY?.trim() ?? "",
      fingerprints: lookupFingerprints,
    });
    manifest = applyCrossClientExposure(provisionalManifest, { snapshots });
  } catch (error) {
    lookupFailure = error instanceof TaskExposureLookupError
      ? error
      : new TaskExposureLookupError("unexpected-error");
    manifest = applyCrossClientExposure(provisionalManifest, {
      error: { code: lookupFailure.code, checkedAt: new Date().toISOString() },
    });
  }
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.output) {
    writeManifestFile(options.output, json);
    process.stderr.write(
      `Wrote ${manifest.candidates.length} content-blind candidate record(s) to ${options.output}\n`,
    );
  } else {
    process.stdout.write(json);
  }
  // Persist the safe quarantine manifest before failing the oneshot service.
  // This prevents a stale successful snapshot from surviving an auth/network
  // fault while deployment/systemd still receive a non-zero acceptance signal.
  if (lookupFailure) throw lookupFailure;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
