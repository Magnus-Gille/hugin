import { z } from "zod";
import { resolveGatewayRootUrl } from "../orchestrator/provider-config.js";

export const TASK_EXPOSURE_FINGERPRINT_VERSION = "trim-utf8-sha256-v1" as const;
export const TASK_EXPOSURE_REQUIRED_LANES = [
  "chat",
  "mcp-ask",
  "delegate",
  "delegate-disagreement",
  "delegate-shadow",
  "code-loop",
] as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });
const taskExposureLaneSchema = z.enum(TASK_EXPOSURE_REQUIRED_LANES);

const rawCoverageSchema = z.object({
  coverage_complete: z.boolean(),
  from: isoTimestampSchema,
  through: isoTimestampSchema,
  lanes: z.array(taskExposureLaneSchema).max(TASK_EXPOSURE_REQUIRED_LANES.length),
  historical_backfill_complete: z.literal(false),
  historical_backfill_from: isoTimestampSchema.nullable(),
  historical_backfill_through: isoTimestampSchema.nullable(),
  historical_events_imported: z.number().int().nonnegative(),
  historical_rows_skipped_inexact: z.number().int().nonnegative(),
  incomplete_before: isoTimestampSchema,
  incomplete_reasons: z.array(z.string().min(1).max(500)).max(50),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.from) > Date.parse(value.through)) {
    ctx.addIssue({ code: "custom", path: ["through"], message: "coverage window is inverted" });
  }
  if (new Set(value.lanes).size !== value.lanes.length) {
    ctx.addIssue({ code: "custom", path: ["lanes"], message: "coverage lanes must be unique" });
  }
  if (Date.parse(value.incomplete_before) !== Date.parse(value.from)) {
    ctx.addIssue({
      code: "custom",
      path: ["incomplete_before"],
      message: "incomplete-before boundary must match live coverage start",
    });
  }
});

const rawResultSchema = z.object({
  fingerprint_sha256: sha256Schema,
  seen: z.boolean(),
  first_seen_at: isoTimestampSchema.nullable(),
  last_seen_at: isoTimestampSchema.nullable(),
  lanes: z.array(taskExposureLaneSchema).max(TASK_EXPOSURE_REQUIRED_LANES.length),
  model_ids: z.array(z.string().min(1).max(160)).max(1_000),
  harness_ids: z.array(z.string().min(1).max(160)).max(1_000),
}).strict().superRefine((value, ctx) => {
  if (!value.seen && (
    value.first_seen_at !== null ||
    value.last_seen_at !== null ||
    value.lanes.length > 0 ||
    value.model_ids.length > 0 ||
    value.harness_ids.length > 0
  )) {
    ctx.addIssue({ code: "custom", path: ["seen"], message: "unseen results must not carry exposure metadata" });
  }
  if (value.seen && (value.first_seen_at === null || value.last_seen_at === null || value.lanes.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["seen"], message: "seen results require timestamps and lanes" });
  }
  if (
    value.first_seen_at &&
    value.last_seen_at &&
    Date.parse(value.first_seen_at) > Date.parse(value.last_seen_at)
  ) {
    ctx.addIssue({ code: "custom", path: ["last_seen_at"], message: "exposure window is inverted" });
  }
});

const rawResponseSchema = z.object({
  schema_version: z.literal(1),
  fingerprint_version: z.literal(TASK_EXPOSURE_FINGERPRINT_VERSION),
  coverage: rawCoverageSchema,
  results: z.array(rawResultSchema).min(1).max(100),
}).strict();

export interface TaskExposureCoverageEvidence {
  coverageComplete: boolean;
  from: string;
  through: string;
  lanes: Array<(typeof TASK_EXPOSURE_REQUIRED_LANES)[number]>;
  historicalBackfillComplete: false;
  incompleteBefore: string;
  incompleteReasonCount: number;
}

export interface TaskExposureLookupResult {
  fingerprintSha256: string;
  seen: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lanes: Array<(typeof TASK_EXPOSURE_REQUIRED_LANES)[number]>;
  modelIds: string[];
  harnessIds: string[];
}

export interface TaskExposureLookupEvidence {
  coverage: TaskExposureCoverageEvidence;
  results: TaskExposureLookupResult[];
}

export type TaskExposureLookupFailureKind =
  | "configuration"
  | "authentication"
  | "transport"
  | "server"
  | "contract";

export class TaskExposureLookupError extends Error {
  constructor(
    message: string,
    public readonly kind: TaskExposureLookupFailureKind,
  ) {
    super(message);
    this.name = "TaskExposureLookupError";
  }
}

export interface TaskExposureClientConfig {
  baseUrl: string;
  bearerToken: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function intersectLanes(
  left: TaskExposureCoverageEvidence["lanes"],
  right: TaskExposureCoverageEvidence["lanes"],
): TaskExposureCoverageEvidence["lanes"] {
  const rightSet = new Set(right);
  return left.filter((lane) => rightSet.has(lane));
}

function normalizeCoverage(
  raw: z.infer<typeof rawCoverageSchema>,
): TaskExposureCoverageEvidence {
  return {
    coverageComplete: raw.coverage_complete,
    from: new Date(raw.from).toISOString(),
    through: new Date(raw.through).toISOString(),
    lanes: [...raw.lanes].sort(),
    historicalBackfillComplete: raw.historical_backfill_complete,
    incompleteBefore: new Date(raw.incomplete_before).toISOString(),
    incompleteReasonCount: raw.incomplete_reasons.length,
  };
}

function normalizeResult(raw: z.infer<typeof rawResultSchema>): TaskExposureLookupResult {
  return {
    fingerprintSha256: raw.fingerprint_sha256,
    seen: raw.seen,
    firstSeenAt: raw.first_seen_at ? new Date(raw.first_seen_at).toISOString() : null,
    lastSeenAt: raw.last_seen_at ? new Date(raw.last_seen_at).toISOString() : null,
    lanes: [...new Set(raw.lanes)].sort(),
    modelIds: [...new Set(raw.model_ids)].sort(),
    harnessIds: [...new Set(raw.harness_ids)].sort(),
  };
}

export class TaskExposureClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TaskExposureClientConfig) {
    const sovereign = resolveGatewayRootUrl(
      { HOMESERVER_GATEWAY_URL: config.baseUrl },
      "HOMESERVER_GATEWAY_URL",
    );
    if (!sovereign.ok) {
      throw new TaskExposureLookupError("task exposure gateway is not sovereign", "configuration");
    }
    let base: URL;
    try {
      base = new URL(sovereign.baseUrl);
    } catch {
      throw new TaskExposureLookupError("task exposure gateway URL is invalid", "configuration");
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new TaskExposureLookupError("task exposure gateway must use http(s)", "configuration");
    }
    if (base.username || base.password || base.search || base.hash) {
      throw new TaskExposureLookupError(
        "task exposure gateway URL must not contain credentials, query, or fragment",
        "configuration",
      );
    }
    if (base.pathname !== "/" && base.pathname !== "") {
      throw new TaskExposureLookupError("task exposure gateway URL must be a root URL", "configuration");
    }
    if (config.bearerToken.trim() === "") {
      throw new TaskExposureLookupError("task exposure owner credential is required", "configuration");
    }
    this.endpoint = new URL("/admin/task-exposures/lookup", base).toString();
    this.token = config.bearerToken;
    const timeoutMs = config.requestTimeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new TaskExposureLookupError(
        "task exposure timeout must be an integer from 1000 to 60000 ms",
        "configuration",
      );
    }
    this.timeoutMs = timeoutMs;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async lookupBatch(fingerprints: string[]): Promise<z.infer<typeof rawResponseSchema>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          fingerprint_version: TASK_EXPOSURE_FINGERPRINT_VERSION,
          fingerprints,
        }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        const kind = response.status === 401 || response.status === 403
          ? "authentication"
          : response.status >= 500
            ? "server"
            : "contract";
        throw new TaskExposureLookupError(
          `task exposure lookup returned HTTP ${response.status}`,
          kind,
        );
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new TaskExposureLookupError("task exposure lookup response transport failed", "transport");
      }
      if (text.length > 1_000_000) {
        throw new TaskExposureLookupError("task exposure lookup response is too large", "contract");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new TaskExposureLookupError("task exposure lookup returned invalid JSON", "contract");
      }
      const parsed = rawResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new TaskExposureLookupError("task exposure lookup violated its schema", "contract");
      }
      const actual = parsed.data.results.map((result) => result.fingerprint_sha256);
      if (JSON.stringify(actual) !== JSON.stringify(fingerprints)) {
        throw new TaskExposureLookupError("task exposure lookup result order/binding drifted", "contract");
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof TaskExposureLookupError) throw error;
      const detail = error instanceof Error && error.name === "AbortError" ? "timed out" : "failed";
      throw new TaskExposureLookupError(`task exposure lookup transport ${detail}`, "transport");
    } finally {
      clearTimeout(timer);
    }
  }

  async lookup(fingerprints: string[]): Promise<TaskExposureLookupEvidence> {
    const unique = [...new Set(fingerprints)];
    if (unique.length !== fingerprints.length || unique.length === 0) {
      throw new TaskExposureLookupError(
        "task exposure lookup requires unique non-empty fingerprints",
        "configuration",
      );
    }
    if (!unique.every((fingerprint) => sha256Schema.safeParse(fingerprint).success)) {
      throw new TaskExposureLookupError("task exposure lookup received an invalid fingerprint", "configuration");
    }

    let coverage: TaskExposureCoverageEvidence | undefined;
    const results: TaskExposureLookupResult[] = [];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const batch = unique.slice(offset, offset + 100);
      const response = await this.lookupBatch(batch);
      const current = normalizeCoverage(response.coverage);
      if (!coverage) {
        coverage = current;
      } else {
        coverage = {
          coverageComplete: coverage.coverageComplete && current.coverageComplete,
          from: coverage.from > current.from ? coverage.from : current.from,
          through: coverage.through < current.through ? coverage.through : current.through,
          lanes: intersectLanes(coverage.lanes, current.lanes),
          historicalBackfillComplete: false,
          incompleteBefore: coverage.incompleteBefore > current.incompleteBefore
            ? coverage.incompleteBefore
            : current.incompleteBefore,
          incompleteReasonCount: Math.max(
            coverage.incompleteReasonCount,
            current.incompleteReasonCount,
          ),
        };
      }
      results.push(...response.results.map(normalizeResult));
    }
    if (!coverage || coverage.from > coverage.through) {
      throw new TaskExposureLookupError("task exposure batch coverage has no common window", "contract");
    }
    return { coverage, results };
  }
}
