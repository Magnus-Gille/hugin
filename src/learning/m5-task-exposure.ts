import { z } from "zod";
import { resolveGatewayRootUrl } from "../orchestrator/provider-config.js";
import {
  fingerprintRawTask,
  TASK_EXPOSURE_FINGERPRINT_VERSION,
} from "../task-identity.js";

export { TASK_EXPOSURE_FINGERPRINT_VERSION } from "../task-identity.js";
export const TASK_EXPOSURE_LOOKUP_MAX = 100;
// SHA-256("hugin-task-exposure-lookup-healthcheck-v1"). This is never derived
// from a task and exists only to prove endpoint/auth/schema health on an empty
// eligible-candidate day.
export const TASK_EXPOSURE_SMOKE_FINGERPRINT =
  "ffe48447b719ea42a417164a0faa430877c7c13b2a8ae485d18230c26500bdde";
export const REQUIRED_TASK_EXPOSURE_LANES = [
  "chat",
  "mcp-ask",
  "delegate",
  "delegate-disagreement",
  "delegate-shadow",
  "code-loop",
] as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });
const metadataIdSchema = z.string().min(1).max(160);

export const taskExposureCoverageSchema = z.object({
  coverage_complete: z.boolean(),
  from: isoTimestampSchema,
  through: isoTimestampSchema,
  lanes: z.array(z.string().min(1).max(80)).max(64),
  historical_backfill_complete: z.boolean(),
  historical_backfill_from: isoTimestampSchema.nullable(),
  historical_backfill_through: isoTimestampSchema.nullable(),
  historical_events_imported: z.number().int().nonnegative(),
  historical_rows_skipped_inexact: z.number().int().nonnegative(),
  incomplete_before: isoTimestampSchema,
  incomplete_reasons: z.array(z.string().min(1).max(500)).max(64),
}).strict();

export const taskExposureLookupResultSchema = z.object({
  fingerprint_sha256: sha256Schema,
  seen: z.boolean(),
  first_seen_at: isoTimestampSchema.nullable(),
  last_seen_at: isoTimestampSchema.nullable(),
  lanes: z.array(z.string().min(1).max(80)).max(64),
  model_ids: z.array(metadataIdSchema).max(256),
  harness_ids: z.array(metadataIdSchema).max(256),
}).strict();

const taskExposureLookupResponseSchema = z.object({
  schema_version: z.literal(1),
  fingerprint_version: z.literal(TASK_EXPOSURE_FINGERPRINT_VERSION),
  coverage: taskExposureCoverageSchema,
  results: z.array(taskExposureLookupResultSchema).min(1).max(TASK_EXPOSURE_LOOKUP_MAX),
}).strict();

export type TaskExposureCoverage = z.infer<typeof taskExposureCoverageSchema>;
export type TaskExposureLookupResult = z.infer<typeof taskExposureLookupResultSchema>;

export interface TaskExposureSnapshot {
  checkedAt: string;
  coverage: TaskExposureCoverage;
  result: TaskExposureLookupResult;
}

export class TaskExposureLookupError extends Error {
  constructor(public readonly code: string) {
    super(`M5 task exposure lookup failed (${code})`);
    this.name = "TaskExposureLookupError";
  }
}

/** Exact shared v1 contract: String.trim(), raw UTF-8, lowercase SHA-256. */
export function taskTextFingerprint(taskText: string): string {
  return fingerprintRawTask(taskText).digest;
}

/**
 * Resolve the owner-only root endpoint. Hugin historically accepts either a
 * gateway root or an OpenAI `/v1` base, but the exposure route never lives
 * below `/v1`.
 */
export function resolveTaskExposureLookupEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new TaskExposureLookupError("invalid-gateway-url");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/" && parsed.pathname !== "/v1" && parsed.pathname !== "/v1/") {
    throw new TaskExposureLookupError("invalid-gateway-url");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TaskExposureLookupError("invalid-gateway-url");
  }
  const resolved = resolveGatewayRootUrl({ HOMESERVER_GATEWAY_URL: parsed.origin });
  if (!resolved.ok) throw new TaskExposureLookupError("invalid-gateway-url");
  return `${resolved.baseUrl}/admin/task-exposures/lookup`;
}

async function lookupBatch(input: {
  endpoint: string;
  apiKey: string;
  fingerprints: string[];
  fetchImpl: typeof fetch;
  timeoutMs: number;
  now: () => string;
}): Promise<TaskExposureSnapshot[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: Response;
  try {
    response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fingerprint_version: TASK_EXPOSURE_FINGERPRINT_VERSION,
        fingerprints: input.fingerprints,
      }),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new TaskExposureLookupError("timeout");
    throw new TaskExposureLookupError("network-error");
  }
  if (!response.ok) {
    clearTimeout(timer);
    throw new TaskExposureLookupError(`http-${response.status}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    if (controller.signal.aborted) throw new TaskExposureLookupError("timeout");
    throw new TaskExposureLookupError("invalid-json");
  } finally {
    clearTimeout(timer);
  }
  const parsed = taskExposureLookupResponseSchema.safeParse(json);
  if (!parsed.success) throw new TaskExposureLookupError("invalid-response");
  if (parsed.data.results.length !== input.fingerprints.length) {
    throw new TaskExposureLookupError("result-mismatch");
  }
  for (let index = 0; index < input.fingerprints.length; index += 1) {
    const result = parsed.data.results[index];
    if (result?.fingerprint_sha256 !== input.fingerprints[index]) {
      throw new TaskExposureLookupError("result-mismatch");
    }
    const seenShapeValid = result.seen
      ? result.first_seen_at !== null
        && result.last_seen_at !== null
        && Date.parse(result.first_seen_at) <= Date.parse(result.last_seen_at)
      : result.first_seen_at === null
        && result.last_seen_at === null
        && result.lanes.length === 0
        && result.model_ids.length === 0
        && result.harness_ids.length === 0;
    if (!seenShapeValid) throw new TaskExposureLookupError("invalid-response");
  }
  const checkedAt = input.now();
  if (!isoTimestampSchema.safeParse(checkedAt).success) {
    throw new TaskExposureLookupError("invalid-clock");
  }
  return parsed.data.results.map((result) => ({
    checkedAt,
    coverage: parsed.data.coverage,
    result,
  }));
}

/** Dedupe, batch to the M5 limit, validate every response, then fan out by digest. */
export async function lookupTaskExposureSnapshots(input: {
  gatewayBaseUrl: string;
  apiKey: string;
  fingerprints: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => string;
}): Promise<Map<string, TaskExposureSnapshot>> {
  const fingerprints = [...new Set(input.fingerprints)];
  if (fingerprints.some((fingerprint) => !sha256Schema.safeParse(fingerprint).success)) {
    throw new TaskExposureLookupError("invalid-fingerprint");
  }
  if (fingerprints.length === 0) return new Map();
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new TaskExposureLookupError("missing-api-key");
  const endpoint = resolveTaskExposureLookupEndpoint(input.gatewayBaseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TaskExposureLookupError("invalid-timeout");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const snapshots = new Map<string, TaskExposureSnapshot>();
  for (let start = 0; start < fingerprints.length; start += TASK_EXPOSURE_LOOKUP_MAX) {
    const batch = fingerprints.slice(start, start + TASK_EXPOSURE_LOOKUP_MAX);
    const found = await lookupBatch({ endpoint, apiKey, fingerprints: batch, fetchImpl, timeoutMs, now });
    for (const snapshot of found) snapshots.set(snapshot.result.fingerprint_sha256, snapshot);
  }
  return snapshots;
}
