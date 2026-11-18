/**
 * gateway-preflight-journey.ts — producer-owned `hugin-gateway-preflight` synthetic journey (HUGIN-388).
 *
 * Runs ONE content-free attempt against the M5 gateway and builds the closed
 * `synthetic-journey-outcome` v1 document that Heimdall ingests at
 * `POST /api/synthetic-journeys` (contract: heimdall/src/synthetic-journeys.js, HEIM-49).
 *
 * Steps (exactly the two declared ones, bound to one attempt):
 *   - `preflight`:         GET /v1/capabilities/learning-task is a fresh, exact LearningTaskContract
 *                          advertisement (same verifier Hugin uses before dispatching a task).
 *   - `gateway-admission`: GET /portal/me admits the configured key as an owner principal, i.e. the
 *                          credential Hugin dispatches with would be admitted. No prompt, task or
 *                          inference is sent, so admission is proved without content.
 *
 * Content-free by construction: only HTTP status, schema validity and two booleans are read from
 * responses. No prompt, alias, model, key, body or trace is copied into the outcome, which is built
 * from closed enums and validated by a local mirror of Heimdall's contract before any send, so a
 * producer bug fails as `runner-invalid-outcome` instead of posting a malformed document.
 *
 * Runner failure (missing config, rejected credential, validation bug) is kept distinct from
 * dependency failure (gateway not ready). Missing or partial evidence never passes.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  LEARNING_TASK_PREFLIGHT_ENDPOINT,
  buildLearningTaskPreflightRequest,
  classifyHandshakeFailure,
  verifyLearningTaskPreflightAdvertisement,
} from "./learning-task-handshake.js";
import { resolveGatewayRootUrl } from "./orchestrator/provider-config.js";

export const JOURNEY_ID = "hugin-gateway-preflight";
export const PRODUCER = "hugin";
export const STEP_IDS = ["preflight", "gateway-admission"] as const;
export const MAX_AGE_SECONDS = 900;
const MAX_LATENCY_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const DELIVERY_PATH = "/api/synthetic-journeys";

export type StepOutcome = "pass" | "fail" | "skipped";
export interface JourneyStep {
  id: (typeof STEP_IDS)[number];
  outcome: StepOutcome;
  latency_ms: number | null;
  error_class: string | null;
}
export interface JourneyOutcome {
  kind: "synthetic-journey-outcome";
  schema_version: "v1";
  journey_id: typeof JOURNEY_ID;
  producer: typeof PRODUCER;
  attempt_id: string;
  version: string;
  started_at: string;
  observed_at: string;
  max_age_seconds: number;
  outcome: "pass" | "fail" | "partial" | "unknown";
  runner_outcome: "ok" | "failed";
  latency_ms: number | null;
  error_class: string | null;
  trace_id: string | null;
  steps: JourneyStep[];
  extensions: [];
}

const SAFE_TEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,95}$/;
const ERROR_RE = /^[a-z][a-z0-9-]{1,63}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const TOP_KEYS = new Set([
  "kind", "schema_version", "journey_id", "producer", "attempt_id", "version", "started_at",
  "observed_at", "max_age_seconds", "outcome", "runner_outcome", "latency_ms", "error_class",
  "trace_id", "steps", "extensions",
]);
const STEP_KEYS = new Set(["id", "outcome", "latency_ms", "error_class"]);

const validLatency = (v: unknown): boolean =>
  v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_LATENCY_MS);

/** Local mirror of heimdall validateJourneyOutcome for this journey. Returns error codes. */
export function validateOutcome(value: JourneyOutcome): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (!TOP_KEYS.has(key)) errors.push("unknown-field");
  if (value.kind !== "synthetic-journey-outcome") errors.push("kind");
  if (value.schema_version !== "v1") errors.push("version");
  if (value.journey_id !== JOURNEY_ID) errors.push("journey-id");
  if (value.producer !== PRODUCER) errors.push("producer");
  if (!SAFE_TEXT_RE.test(value.attempt_id)) errors.push("attempt");
  if (!SAFE_TEXT_RE.test(value.version)) errors.push("producer-version");
  const started = UTC_RE.test(value.started_at) ? Date.parse(value.started_at) : NaN;
  const observed = UTC_RE.test(value.observed_at) ? Date.parse(value.observed_at) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(observed) || started > observed) errors.push("timestamps");
  if (!Number.isSafeInteger(value.max_age_seconds) || value.max_age_seconds < 1 || value.max_age_seconds > 86400) errors.push("max-age");
  if (!["pass", "fail", "partial", "unknown"].includes(value.outcome)) errors.push("outcome");
  if (!["ok", "failed"].includes(value.runner_outcome)) errors.push("runner-outcome");
  if (!validLatency(value.latency_ms)) errors.push("latency");
  if (value.error_class !== null && !ERROR_RE.test(value.error_class)) errors.push("error-class");
  if (value.trace_id !== null && !/^[a-f0-9]{32}$/.test(value.trace_id)) errors.push("trace-id");
  if (value.extensions.length !== 0) errors.push("extensions");
  const seen = new Set<string>();
  if (value.steps.length < 1 || value.steps.length > 8) errors.push("steps");
  for (const step of value.steps) {
    for (const key of Object.keys(step)) if (!STEP_KEYS.has(key)) errors.push("step-unknown-field");
    if (!(STEP_IDS as readonly string[]).includes(step.id) || seen.has(step.id)) errors.push("step-id");
    seen.add(step.id);
    if (!["pass", "fail", "skipped"].includes(step.outcome)) errors.push("step-outcome");
    if (!validLatency(step.latency_ms)) errors.push("step-latency");
    if (step.error_class !== null && !ERROR_RE.test(step.error_class)) errors.push("step-error-class");
    if (step.outcome === "pass" && (step.error_class !== null || step.latency_ms === null)) errors.push("step-pass-shape");
  }
  const complete = STEP_IDS.every((id) => seen.has(id)) && seen.size === STEP_IDS.length;
  const allPass = complete && value.steps.every((s) => s.outcome === "pass");
  const anyFail = value.steps.some((s) => s.outcome === "fail");
  if (value.outcome === "pass" && (value.runner_outcome !== "ok" || !allPass || value.error_class !== null)) errors.push("pass-consistency");
  if (value.outcome === "fail" && (value.runner_outcome !== "ok" || !complete || !anyFail || value.error_class === null)) errors.push("fail-consistency");
  if (value.outcome === "partial" && (value.runner_outcome !== "ok" || complete)) errors.push("partial-consistency");
  if (value.runner_outcome === "failed" && (value.outcome !== "unknown" || value.error_class === null)) errors.push("runner-consistency");
  return errors;
}

export interface PreflightJourneyOptions {
  /** Gateway origin, e.g. http://127.0.0.1:8080 (HOMESERVER_GATEWAY_URL). */
  gatewayUrl: string | undefined;
  /** Owner-scope gateway key Hugin dispatches with (never logged, never in the outcome). */
  gatewayKey: string | undefined;
  version?: string;
  timeoutMs?: number;
  /** Injectable clock (ms) and fetch for tests. */
  now?: () => number;
  fetchFn?: typeof fetch;
  /** Fixed attempt id, so a retried delivery re-sends the identical document. */
  attemptId?: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const newAttemptId = (): string => `attempt-${randomBytes(12).toString("hex")}`;
const step = (id: JourneyStep["id"], outcome: StepOutcome, latency: number | null, error: string | null = null): JourneyStep =>
  ({ id, outcome, latency_ms: latency, error_class: error });

function classifyError(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  if (err instanceof Error && err.name === "ResponseTooLarge") return "invalid-response";
  return "dependency-network";
}

async function boundedJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    const e = new Error("too large");
    e.name = "ResponseTooLarge";
    throw e;
  }
  try { return JSON.parse(text); } catch { return null; }
}

interface Observation { ok: boolean; errorClass: string | null; latencyMs: number }

async function observe(
  url: string,
  key: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  now: () => number,
  accept: (status: number, body: unknown) => string | null,
): Promise<Observation> {
  const t0 = now();
  const elapsed = (): number => Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(now() - t0)));
  try {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, errorClass: "auth-denied", latencyMs: elapsed() };
    }
    const body = await boundedJson(res);
    const err = accept(res.status, body);
    return { ok: err === null, errorClass: err, latencyMs: elapsed() };
  } catch (err) {
    return { ok: false, errorClass: classifyError(err), latencyMs: elapsed() };
  }
}

const acceptAdmission = (status: number, body: unknown): string | null => {
  if (status !== 200) return "dependency-http";
  const b = body as { alias?: unknown; tier?: unknown } | null;
  if (typeof b?.alias !== "string" || b.alias === "" || typeof b.tier !== "string") return "invalid-response";
  return b.tier === "owner" ? null : "admission-denied";
};

/** Run one attempt. Never throws; configuration/validation problems become runner failures. */
export async function runPreflightAttempt(opts: PreflightJourneyOptions): Promise<JourneyOutcome> {
  const now = opts.now ?? Date.now;
  const startMs = now();
  const base = {
    kind: "synthetic-journey-outcome" as const,
    schema_version: "v1" as const,
    journey_id: JOURNEY_ID as typeof JOURNEY_ID,
    producer: PRODUCER as typeof PRODUCER,
    attempt_id: opts.attemptId ?? newAttemptId(),
    version: opts.version ?? "hugin@0.0.0",
    started_at: iso(startMs),
    max_age_seconds: MAX_AGE_SECONDS,
    trace_id: null,
    extensions: [] as [],
  };
  const runnerFailure = (errorClass: string): JourneyOutcome => ({
    ...base,
    observed_at: iso(Math.max(startMs, now())),
    outcome: "unknown",
    runner_outcome: "failed",
    latency_ms: 0,
    error_class: errorClass,
    steps: STEP_IDS.map((id) => step(id, "skipped", null, "runner-unavailable")),
  });

  // Same ROOT-URL validation the dispatcher applies (no credentials/path/query, loopback/LAN/
  // tailnet host only), so the journey never sends the owner key somewhere Hugin would not.
  const resolved = resolveGatewayRootUrl({ GATEWAY: opts.gatewayUrl }, "GATEWAY");
  if (!resolved.ok) return runnerFailure("runner-config");
  const origin = new URL(resolved.baseUrl).origin;
  const key = opts.gatewayKey?.trim();
  if (!key) return runnerFailure("runner-config");

  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  // The preflight acceptor judges the advertisement against a request built exactly like the
  // dispatcher's, using Hugin's own verifier. Hugin-host clock is sampled at request/observation.
  let request: ReturnType<typeof buildLearningTaskPreflightRequest>;
  try {
    request = buildLearningTaskPreflightRequest(iso(now()), randomUUID());
  } catch {
    return runnerFailure("runner-invalid-outcome");
  }
  const acceptPreflight = (status: number, body: unknown): string | null => {
    if (status !== 200) return "dependency-http";
    try {
      verifyLearningTaskPreflightAdvertisement(body, request, now);
      return null;
    } catch (err) {
      return classifyHandshakeFailure(err);
    }
  };

  const preflight = await observe(`${origin}${LEARNING_TASK_PREFLIGHT_ENDPOINT}`, key, fetchFn, timeoutMs, now, acceptPreflight);
  // A rejected key is the runner's own credential problem, never the gateway's.
  if (preflight.errorClass === "auth-denied") return runnerFailure("runner-auth");
  const steps: JourneyStep[] = [];
  let errorClass: string | null = null;
  if (preflight.ok) {
    steps.push(step("preflight", "pass", preflight.latencyMs));
    const admission = await observe(`${origin}/portal/me`, key, fetchFn, timeoutMs, now, acceptAdmission);
    if (admission.errorClass === "auth-denied") return runnerFailure("runner-auth");
    if (admission.ok) steps.push(step("gateway-admission", "pass", admission.latencyMs));
    else {
      steps.push(step("gateway-admission", "fail", admission.latencyMs, admission.errorClass));
      errorClass = admission.errorClass;
    }
  } else {
    steps.push(step("preflight", "fail", preflight.latencyMs, preflight.errorClass));
    steps.push(step("gateway-admission", "skipped", null, "blocked-by-preflight"));
    errorClass = preflight.errorClass;
  }
  const endMs = Math.max(startMs, now());
  const outcome: JourneyOutcome = {
    ...base,
    observed_at: iso(endMs),
    outcome: errorClass === null ? "pass" : "fail",
    runner_outcome: "ok",
    latency_ms: Math.min(MAX_LATENCY_MS, Math.round(endMs - startMs)),
    error_class: errorClass,
    steps,
  };
  // A local contract violation is a producer bug, never a green result.
  if (validateOutcome(outcome).length > 0) return runnerFailure("runner-invalid-outcome");
  return outcome;
}

export interface DeliveryOptions {
  /** Full Heimdall URL, e.g. https://heimdall.example/api/synthetic-journeys. */
  url: string | undefined;
  token: string | undefined;
  timeoutMs?: number;
  /** Delays between attempts; the identical document (same attempt_id) is re-sent. */
  retryDelaysMs?: number[];
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}
export interface DeliveryResult {
  delivered: boolean;
  attempts: number;
  status?: number;
  /** Failure class only — never the token, payload or response body. */
  error?: string;
}

/** https only (plain http solely for loopback), exact ingest path, no userinfo/query/fragment. */
export function safeDeliveryUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    return (u.protocol === "https:" || (u.protocol === "http:" && loopback)) &&
      u.pathname === DELIVERY_PATH && u.username === "" && u.password === "" &&
      u.search === "" && u.hash === "";
  } catch {
    return false;
  }
}

/** POST the outcome; retry only transport errors and 5xx. 4xx (including replay conflicts) are final. */
export async function deliverOutcome(outcome: JourneyOutcome, opts: DeliveryOptions): Promise<DeliveryResult> {
  if (!opts.url || !opts.token) return { delivered: false, attempts: 0, error: "delivery-config" };
  if (!safeDeliveryUrl(opts.url)) return { delivered: false, attempts: 0, error: "delivery-config" };
  if (validateOutcome(outcome).length > 0) return { delivered: false, attempts: 0, error: "invalid-outcome" };
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = opts.retryDelaysMs ?? [0, 1000, 4000];
  const body = JSON.stringify(outcome);
  let last: DeliveryResult = { delivered: false, attempts: 0, error: "delivery-transport" };
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i]! > 0) await sleep(delays[i]!);
    try {
      const res = await fetchFn(opts.url, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      await res.body?.cancel().catch(() => undefined);
      last = {
        delivered: res.ok,
        attempts: i + 1,
        status: res.status,
        ...(res.ok ? {} : { error: res.status >= 500 ? "delivery-server-error" : "delivery-rejected" }),
      };
      if (res.ok || res.status < 500) return last;
    } catch {
      last = { delivered: false, attempts: i + 1, error: "delivery-transport" };
    }
  }
  return last;
}
