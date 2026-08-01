import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { taskMetadataPrefix } from "./task-document-metadata.js";

export const TRACEPOLICY_VERSION = "v1.0" as const;
export const TRACEPOLICY_ID = "trace-policy-hugin" as const;
export const TRACE_DEFAULT_SERVICE_ID = "hugin" as const;
export const TRACE_DEFAULT_INSTANCE_ID = "huginmunin" as const;
export const TRACE_DEFAULT_RELEASE = "0.1.0" as const;
export const TRACE_DEFAULT_MAX_ATTRIBUTES = 12;
export const TRACE_DEFAULT_MAX_STRING_LENGTH = 64;
export const TRACE_DEFAULT_MAX_PENDING_EXPORTS = 256;

const TRACEPARENT_RE =
  /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;
const NON_ZERO_HEX_RE = /[1-9a-f]/;
const TRACE_CONTEXT_SECTION_RE =
  /### Trace context\s*\n```json\s*\n([\s\S]*?)\n```/i;
const BANNED_TOKEN_RE =
  /:\/\/|[/?#=@\\]|(?:^|[^0-9])(?:10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168)\./i;

export const TASK_TRACE_CLASSES = [
  "diagnostic",
  "delegation",
  "maintenance",
  "publication",
  "read_only",
  "not_applicable",
] as const;

export type TaskTraceClass = (typeof TASK_TRACE_CLASSES)[number];

export const TASK_TRACE_RUNTIME_LANES = [
  "default",
  "reason-hard",
  "reason-fast",
  "numeric",
  "review",
  "not_applicable",
] as const;

export type TaskTraceRuntimeLane = (typeof TASK_TRACE_RUNTIME_LANES)[number];

export type TaskTraceSurface =
  | "task"
  | "gateway"
  | "service"
  | "synthetic";

export type TaskTracePhase =
  | "ingress"
  | "queue"
  | "execution"
  | "dependency"
  | "publication"
  | "probe"
  | "export";

export type TaskTraceOutcome =
  | "ok"
  | "degraded"
  | "failed"
  | "stale"
  | "unknown";

export type TaskTraceInvalidReason =
  | "forbidden-baggage"
  | "malformed-traceparent";

export interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  traceFlags: string;
}

export interface TaskTraceContext {
  traceparent: string;
  taskClass: TaskTraceClass;
  runtimeLane: TaskTraceRuntimeLane;
  retryOrdinal: number;
}

export interface InboundTaskTraceContext extends TaskTraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: string;
  baggage?: string;
  invalidReason?: TaskTraceInvalidReason;
}

export interface TaskTraceExporter {
  exportSpan(
    span: SerializedTaskTraceSpan,
  ): Promise<void> | void;
}

export interface TaskTraceRuntimeOptions {
  exportEnabled: boolean;
  sampleRatePerMille: number;
  release?: string;
  serviceId?: string;
  instanceId?: string;
  exporter?: TaskTraceExporter;
  maxPendingExports?: number;
  traceIdGenerator?: () => string;
  idGenerator?: () => string;
  now?: () => Date;
  maxAttributes?: number;
  maxStringLength?: number;
}

export interface TaskTraceRuntimeStats {
  exportFailures: number;
  exportDropped: number;
}

export interface SerializedTaskTraceSpan {
  kind: "trace-span";
  contract_version: typeof TRACEPOLICY_VERSION;
  policy_id: typeof TRACEPOLICY_ID;
  source: {
    source_kind: "service_internal";
    producer: string;
    producer_version: string;
  };
  service: {
    service_id: string;
    instance_id: string;
  };
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  operation: {
    surface: TaskTraceSurface;
    phase: TaskTracePhase;
  };
  started_at: string;
  ended_at: string;
  collected_at: string;
  sampled: true;
  outcome: TaskTraceOutcome;
  attributes: {
    task_class: TaskTraceClass;
    runtime_lane: TaskTraceRuntimeLane;
    retry_ordinal: number;
    error_class?: string;
  };
  diagnostic_ref: string;
  extensions: [];
}

interface ActiveTaskTraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string;
  taskClass: TaskTraceClass;
  runtimeLane: TaskTraceRuntimeLane;
  retryOrdinal: number;
}

export interface TaskTraceSpanOptions {
  name: string;
  surface: TaskTraceSurface;
  phase: TaskTracePhase;
  taskContext?: TaskTraceContext;
  unsafeAttributes?: Record<string, unknown>;
  startedAt?: Date;
}

export interface EndTaskTraceSpanOptions {
  outcome: TaskTraceOutcome;
  errorClass?: string;
  error?: unknown;
  endedAt?: Date;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function defaultTraceId(): string {
  return randomHex(16);
}

function defaultSpanId(): string {
  return randomHex(8);
}

function isNonZeroHex(value: string): boolean {
  return NON_ZERO_HEX_RE.test(value);
}

export function isTaskTraceClass(value: string): value is TaskTraceClass {
  return (TASK_TRACE_CLASSES as readonly string[]).includes(value);
}

export function isTaskTraceRuntimeLane(value: string): value is TaskTraceRuntimeLane {
  return (TASK_TRACE_RUNTIME_LANES as readonly string[]).includes(value);
}

export function parseTraceparent(
  value: string | undefined,
): ParsedTraceparent | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = TRACEPARENT_RE.exec(trimmed);
  if (!match) return null;
  const [, traceId, spanId, traceFlags] = match;
  if (!traceId || !spanId || !traceFlags) return null;
  if (!isNonZeroHex(traceId) || !isNonZeroHex(spanId)) return null;
  return { traceId, spanId, traceFlags };
}

function clampSamplingPerMille(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1000, Math.round(value)));
}

function formatTraceparent(
  traceId: string,
  spanId: string,
  traceFlags: string,
): string {
  return `00-${traceId}-${spanId}-${traceFlags}`;
}

function sampledFlags(sampled: boolean): string {
  return sampled ? "01" : "00";
}

function shouldSample(
  sampleRatePerMille: number,
  traceFlags?: string,
): boolean {
  if (traceFlags) {
    return (Number.parseInt(traceFlags, 16) & 0x01) === 0x01;
  }
  return clampSamplingPerMille(sampleRatePerMille) > 0;
}

function normalizeRetryOrdinal(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, Math.trunc(value)));
}

export function parseTraceSampleRatePerMille(
  value: string | number | undefined,
  fallback = 1000,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return clampSamplingPerMille(fallback);
  }
  return clampSamplingPerMille(parsed);
}

function sanitizeSafeToken(
  value: string | undefined,
  fallback: string,
  maxLength: number,
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || BANNED_TOKEN_RE.test(trimmed)) return fallback;
  const safe = trimmed
    .replace(/[^A-Za-z0-9._:+-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, maxLength);
  if (!safe || BANNED_TOKEN_RE.test(safe)) return fallback;
  return safe;
}

function formatContractTimestamp(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function diagnosticRef(serviceId: string, spanId: string): string {
  return `ref:${serviceId}-trace-${spanId}`;
}

export function createInboundTaskTraceContext(input: {
  traceparent?: string;
  baggage?: string;
  taskClass: TaskTraceClass;
  runtimeLane: TaskTraceRuntimeLane;
  retryOrdinal: number;
  traceIdGenerator?: () => string;
  idGenerator?: () => string;
  sampleRatePerMille?: number;
}): InboundTaskTraceContext {
  const parsed = parseTraceparent(input.traceparent);
  const sampleRatePerMille = clampSamplingPerMille(
    input.sampleRatePerMille ?? 1000,
  );
  const baggage = input.baggage?.trim();
  const invalidReason: TaskTraceInvalidReason | undefined = parsed
    ? baggage
      ? "forbidden-baggage"
      : undefined
    : input.traceparent
      ? "malformed-traceparent"
      : baggage
        ? "forbidden-baggage"
        : undefined;
  if (parsed) {
    return {
      traceparent: formatTraceparent(
        parsed.traceId,
        parsed.spanId,
        parsed.traceFlags,
      ),
      traceId: parsed.traceId,
      spanId: parsed.spanId,
      parentSpanId: parsed.spanId,
      traceFlags: parsed.traceFlags,
      taskClass: input.taskClass,
      runtimeLane: input.runtimeLane,
      retryOrdinal: normalizeRetryOrdinal(input.retryOrdinal),
      ...(invalidReason ? { invalidReason } : {}),
    };
  }
  const traceId = (input.traceIdGenerator ?? defaultTraceId)();
  const spanId = (input.idGenerator ?? defaultSpanId)();
  const traceFlags = sampledFlags(shouldSample(sampleRatePerMille));
  return {
    traceparent: formatTraceparent(traceId, spanId, traceFlags),
    traceId,
    spanId,
    traceFlags,
    taskClass: input.taskClass,
    runtimeLane: input.runtimeLane,
    retryOrdinal: normalizeRetryOrdinal(input.retryOrdinal),
    ...(invalidReason ? { invalidReason } : {}),
  };
}

export function buildTaskTraceContextSection(
  context: TaskTraceContext,
): string {
  return [
    "### Trace context",
    "```json",
    JSON.stringify({
      traceparent: context.traceparent,
      task_class: context.taskClass,
      runtime_lane: context.runtimeLane,
      retry_ordinal: normalizeRetryOrdinal(context.retryOrdinal),
    }, null, 2),
    "```",
  ].join("\n");
}

export function buildChildTaskTraceContext(
  traceparent: string,
  context: Pick<TaskTraceContext, "taskClass" | "runtimeLane" | "retryOrdinal">,
): TaskTraceContext | null {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) return null;
  return {
    traceparent: formatTraceparent(
      parsed.traceId,
      parsed.spanId,
      parsed.traceFlags,
    ),
    taskClass: context.taskClass,
    runtimeLane: context.runtimeLane,
    retryOrdinal: normalizeRetryOrdinal(context.retryOrdinal),
  };
}

export function parseTaskTraceContext(
  content: string,
): TaskTraceContext | null {
  const match = taskMetadataPrefix(content).match(TRACE_CONTEXT_SECTION_RE);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as {
      traceparent?: unknown;
      task_class?: unknown;
      runtime_lane?: unknown;
      retry_ordinal?: unknown;
    };
    if (typeof parsed.traceparent !== "string") return null;
    if (!parseTraceparent(parsed.traceparent)) return null;
    if (typeof parsed.task_class !== "string") return null;
    if (!isTaskTraceClass(parsed.task_class)) return null;
    if (typeof parsed.runtime_lane !== "string") return null;
    if (!isTaskTraceRuntimeLane(parsed.runtime_lane)) return null;
    if (typeof parsed.retry_ordinal !== "number") return null;
    return {
      traceparent: parsed.traceparent,
      taskClass: parsed.task_class,
      runtimeLane: parsed.runtime_lane,
      retryOrdinal: normalizeRetryOrdinal(parsed.retry_ordinal),
    };
  } catch {
    return null;
  }
}

async function appendJsonLine(
  exportPath: string,
  value: SerializedTaskTraceSpan,
): Promise<void> {
  await fs.mkdir(path.dirname(exportPath), { recursive: true });
  await fs.appendFile(
    exportPath,
    `${JSON.stringify(value)}\n`,
    "utf8",
  );
}

export function createFileTaskTraceExporter(
  exportPath: string | undefined,
): TaskTraceExporter | undefined {
  const trimmed = exportPath?.trim();
  if (!trimmed) return undefined;
  return {
    exportSpan: async (span) => appendJsonLine(trimmed, span),
  };
}

export class TaskTraceRuntime {
  readonly stats: TaskTraceRuntimeStats = { exportFailures: 0, exportDropped: 0 };
  readonly serviceId: string;
  readonly instanceId: string;
  readonly release: string;
  readonly exportEnabled: boolean;
  readonly sampleRatePerMille: number;
  readonly maxAttributes: number;
  readonly maxStringLength: number;
  readonly maxPendingExports: number;

  private readonly exporter?: TaskTraceExporter;
  private readonly traceIdGenerator: () => string;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly context =
    new AsyncLocalStorage<ActiveTaskTraceContext>();
  private readonly exportQueue: SerializedTaskTraceSpan[] = [];
  private readonly exportFlushWaiters: Array<() => void> = [];
  private exportPumpRunning = false;

  constructor(options: TaskTraceRuntimeOptions) {
    this.exportEnabled = options.exportEnabled;
    this.sampleRatePerMille = clampSamplingPerMille(
      options.sampleRatePerMille,
    );
    this.maxAttributes = Math.max(
      1,
      Math.min(64, Math.trunc(options.maxAttributes ?? TRACE_DEFAULT_MAX_ATTRIBUTES)),
    );
    this.maxStringLength = Math.max(
      1,
      Math.min(256, Math.trunc(options.maxStringLength ?? TRACE_DEFAULT_MAX_STRING_LENGTH)),
    );
    this.maxPendingExports = Math.max(
      1,
      Math.min(4096, Math.trunc(options.maxPendingExports ?? TRACE_DEFAULT_MAX_PENDING_EXPORTS)),
    );
    this.serviceId = sanitizeSafeToken(
      options.serviceId,
      TRACE_DEFAULT_SERVICE_ID,
      this.maxStringLength,
    );
    this.instanceId = sanitizeSafeToken(
      options.instanceId,
      TRACE_DEFAULT_INSTANCE_ID,
      this.maxStringLength,
    );
    this.release = sanitizeSafeToken(
      options.release,
      TRACE_DEFAULT_RELEASE,
      this.maxStringLength,
    );
    this.exporter = options.exporter;
    this.traceIdGenerator = options.traceIdGenerator ?? defaultTraceId;
    this.idGenerator = options.idGenerator ?? defaultSpanId;
    this.now = options.now ?? (() => new Date());
  }

  startSpan(options: TaskTraceSpanOptions): TaskTraceSpan {
    const inherited = this.context.getStore();
    const explicitContext = options.taskContext
      ? parseTraceparent(options.taskContext.traceparent)
      : null;
    const taskClass = options.taskContext?.taskClass
      ?? inherited?.taskClass
      ?? "read_only";
    const runtimeLane = options.taskContext?.runtimeLane
      ?? inherited?.runtimeLane
      ?? "default";
    const retryOrdinal = normalizeRetryOrdinal(
      options.taskContext?.retryOrdinal ?? inherited?.retryOrdinal ?? 0,
    );

    const traceId = explicitContext?.traceId
      ?? inherited?.traceId
      ?? this.traceIdGenerator();
    const parentSpanId = explicitContext?.spanId ?? inherited?.spanId;
    const traceFlags = explicitContext?.traceFlags
      ?? inherited?.traceFlags
      ?? sampledFlags(shouldSample(this.sampleRatePerMille));
    const spanId = this.idGenerator();
    const activeContext: ActiveTaskTraceContext = {
      traceId,
      spanId,
      traceFlags,
      taskClass,
      runtimeLane,
      retryOrdinal,
    };
    return new TaskTraceSpan(this, {
      name: options.name,
      surface: options.surface,
      phase: options.phase,
      traceId,
      spanId,
      parentSpanId,
      traceFlags,
      taskClass,
      runtimeLane,
      retryOrdinal,
      activeContext,
      startedAt: options.startedAt ?? this.now(),
    });
  }

  async runWithSpan<T>(
    span: TaskTraceSpan,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    return await this.context.run(span.activeContext, fn);
  }

  async finalizeSpan(
    span: TaskTraceSpan,
    options: EndTaskTraceSpanOptions,
  ): Promise<void> {
    span.finish(options.outcome, options.errorClass, options.endedAt ?? this.now());
    if (!this.exportEnabled || !span.sampled) return;
    const serialized = span.serialize();
    if (!serialized || !this.exporter) return;
    if (this.exportQueue.length >= this.maxPendingExports) {
      this.stats.exportDropped += 1;
      return;
    }
    this.exportQueue.push(serialized);
    this.scheduleExportPump();
  }

  // Test-only seam so focused suites can deterministically drain background
  // export work without making production task completion await the sink.
  async flushExportsForTest(): Promise<void> {
    if (!this.exportPumpRunning && this.exportQueue.length === 0) return;
    await new Promise<void>((resolve) => {
      this.exportFlushWaiters.push(resolve);
    });
  }

  private scheduleExportPump(): void {
    if (this.exportPumpRunning || !this.exporter) return;
    this.exportPumpRunning = true;
    void this.pumpExports();
  }

  private async pumpExports(): Promise<void> {
    try {
      while (this.exportQueue.length > 0) {
        const serialized = this.exportQueue[0];
        if (!serialized || !this.exporter) break;
        try {
          await this.exporter.exportSpan(serialized);
        } catch {
          this.stats.exportFailures += 1;
        } finally {
          this.exportQueue.shift();
        }
      }
    } finally {
      this.exportPumpRunning = false;
      if (this.exportQueue.length > 0) {
        this.scheduleExportPump();
      } else {
        this.resolveExportFlushWaiters();
      }
    }
  }

  private resolveExportFlushWaiters(): void {
    const waiters = this.exportFlushWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }
}

export class TaskTraceSpan {
  readonly traceparent: string;
  readonly sampled: boolean;
  readonly activeContext: ActiveTaskTraceContext;

  private outcome: TaskTraceOutcome | null = null;
  private errorClass?: string;
  private endedAt?: Date;

  constructor(
    private readonly runtime: TaskTraceRuntime,
    private readonly state: {
      name: string;
      surface: TaskTraceSurface;
      phase: TaskTracePhase;
      traceId: string;
      spanId: string;
      parentSpanId?: string;
      traceFlags: string;
      taskClass: TaskTraceClass;
      runtimeLane: TaskTraceRuntimeLane;
      retryOrdinal: number;
      activeContext: ActiveTaskTraceContext;
      startedAt: Date;
    },
  ) {
    this.traceparent = formatTraceparent(
      state.traceId,
      state.spanId,
      state.traceFlags,
    );
    this.sampled = shouldSample(
      runtime.sampleRatePerMille,
      state.traceFlags,
    );
    this.activeContext = state.activeContext;
  }

  finish(
    outcome: TaskTraceOutcome,
    errorClass: string | undefined,
    endedAt: Date,
  ): void {
    this.outcome = outcome;
    this.errorClass = errorClass
      ? sanitizeSafeToken(
          errorClass,
          "internal-error",
          this.runtime.maxStringLength,
        )
      : undefined;
    this.endedAt = endedAt;
  }

  serialize(): SerializedTaskTraceSpan | null {
    if (!this.outcome || !this.endedAt || !this.sampled) return null;
    const attributes: SerializedTaskTraceSpan["attributes"] = {
      task_class: this.state.taskClass,
      runtime_lane: this.state.runtimeLane,
      retry_ordinal: this.state.retryOrdinal,
    };
    if (this.errorClass) {
      attributes.error_class = this.errorClass;
    }
    return {
      kind: "trace-span",
      contract_version: TRACEPOLICY_VERSION,
      policy_id: TRACEPOLICY_ID,
      source: {
        source_kind: "service_internal",
        producer: this.runtime.serviceId,
        producer_version: this.runtime.release,
      },
      service: {
        service_id: this.runtime.serviceId,
        instance_id: this.runtime.instanceId,
      },
      trace_id: this.state.traceId,
      span_id: this.state.spanId,
      ...(this.state.parentSpanId
        ? { parent_span_id: this.state.parentSpanId }
        : {}),
      operation: {
        surface: this.state.surface,
        phase: this.state.phase,
      },
      started_at: formatContractTimestamp(this.state.startedAt),
      ended_at: formatContractTimestamp(this.endedAt),
      collected_at: formatContractTimestamp(this.endedAt),
      sampled: true,
      outcome: this.outcome,
      attributes,
      diagnostic_ref: diagnosticRef(this.runtime.serviceId, this.state.spanId),
      extensions: [],
    };
  }

  async end(options: EndTaskTraceSpanOptions): Promise<void> {
    await this.runtime.finalizeSpan(this, options);
  }
}

export async function endTaskSpan(
  span: TaskTraceSpan,
  options: EndTaskTraceSpanOptions,
): Promise<void> {
  await span.end(options);
}
