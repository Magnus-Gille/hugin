import { describe, expect, it, vi } from "vitest";

import {
  CONTENT_BLIND_TRACE_JOIN_FIXTURE,
  CONTENT_BLIND_TRACEPARENT,
} from "./helpers/task-tracing-fixtures.js";
import {
  TaskTraceRuntime,
  buildChildTaskTraceContext,
  buildTaskTraceContextSection,
  createInboundTaskTraceContext,
  endTaskSpan,
  parseTaskTraceContext,
  parseTraceSampleRatePerMille,
} from "../src/task-tracing.js";

describe("task tracing", () => {
  it("continues a strict W3C traceparent and strips baggage", () => {
    const context = createInboundTaskTraceContext({
      traceparent: CONTENT_BLIND_TRACEPARENT,
      baggage: "tenant.id=owner,unsafe=value",
      taskClass: CONTENT_BLIND_TRACE_JOIN_FIXTURE.taskClass,
      runtimeLane: CONTENT_BLIND_TRACE_JOIN_FIXTURE.runtimeLane,
      retryOrdinal: CONTENT_BLIND_TRACE_JOIN_FIXTURE.retryOrdinal,
      idGenerator: () => "1111111111111111",
    });

    expect(context.traceId).toBe(CONTENT_BLIND_TRACE_JOIN_FIXTURE.traceId);
    expect(context.parentSpanId).toBe(
      CONTENT_BLIND_TRACE_JOIN_FIXTURE.inboundParentSpanId,
    );
    expect(context.traceFlags).toBe(CONTENT_BLIND_TRACE_JOIN_FIXTURE.flags);
    expect(context.baggage).toBeUndefined();
    expect(context.invalidReason).toBe("forbidden-baggage");
  });

  it("replaces malformed inbound context with a fresh root", () => {
    const context = createInboundTaskTraceContext({
      traceparent: "00-not-a-traceparent",
      baggage: "bad baggage",
      taskClass: "read_only",
      runtimeLane: "default",
      retryOrdinal: 0,
      traceIdGenerator: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      idGenerator: () => "bbbbbbbbbbbbbbbb",
    });

    expect(context.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(context.parentSpanId).toBeUndefined();
    expect(context.traceFlags).toBe("01");
    expect(context.invalidReason).toBe("malformed-traceparent");
  });

  it("round-trips the persisted task trace context section", () => {
    const section = buildTaskTraceContextSection({
      traceparent: CONTENT_BLIND_TRACEPARENT,
      taskClass: "delegation",
      runtimeLane: "default",
      retryOrdinal: 2,
    });
    const content = [
      "## Task: trace fixture",
      "",
      section,
      "",
      "### Prompt",
      "hello",
    ].join("\n");

    expect(parseTaskTraceContext(content)).toEqual({
      traceparent: CONTENT_BLIND_TRACEPARENT,
      taskClass: "delegation",
      runtimeLane: "default",
      retryOrdinal: 2,
    });
  });

  it("derives child task contexts from an execution span traceparent", () => {
    expect(buildChildTaskTraceContext(CONTENT_BLIND_TRACEPARENT, {
      taskClass: "delegation",
      runtimeLane: "default",
      retryOrdinal: 12,
    })).toEqual({
      traceparent: CONTENT_BLIND_TRACEPARENT,
      taskClass: "delegation",
      runtimeLane: "default",
      retryOrdinal: 10,
    });
    expect(buildChildTaskTraceContext("not-a-traceparent", {
      taskClass: "delegation",
      runtimeLane: "default",
      retryOrdinal: 0,
    })).toBeNull();
  });

  it("preserves parentage across async work and retries", async () => {
    const records: Array<Record<string, unknown>> = [];
    const runtime = new TaskTraceRuntime({
      exportEnabled: true,
      sampleRatePerMille: 1000,
      release: "git-test",
      exporter: {
        exportSpan: async (span) => {
          records.push(span as Record<string, unknown>);
        },
      },
      traceIdGenerator: () => CONTENT_BLIND_TRACE_JOIN_FIXTURE.traceId,
      idGenerator: vi
        .fn()
        .mockReturnValueOnce("1111111111111111")
        .mockReturnValueOnce("2222222222222222")
        .mockReturnValueOnce("3333333333333333"),
      now: () => new Date("2026-08-01T12:00:00Z"),
    });

    const inbound = createInboundTaskTraceContext({
      traceparent: CONTENT_BLIND_TRACEPARENT,
      taskClass: "delegation",
      runtimeLane: "default",
      retryOrdinal: 0,
      idGenerator: () => "1111111111111111",
    });

    const root = runtime.startSpan({
      name: "task.execution",
      surface: "task",
      phase: "execution",
      taskContext: inbound,
    });

    await runtime.runWithSpan(root, async () => {
      await Promise.resolve();
      const child = runtime.startSpan({
        name: "task.result-recording",
        surface: "task",
        phase: "publication",
      });
      endTaskSpan(child, { outcome: "ok" });
    });
    endTaskSpan(root, { outcome: "ok" });

    const retry = runtime.startSpan({
      name: "task.execution.retry",
      surface: "task",
      phase: "execution",
      taskContext: {
        traceparent: CONTENT_BLIND_TRACEPARENT,
        taskClass: "delegation",
        runtimeLane: "default",
        retryOrdinal: 1,
      },
    });
    endTaskSpan(retry, { outcome: "failed", errorClass: "timeout" });

    expect(records).toHaveLength(3);
    const bySpanId = new Map(
      records.map((record) => [
        record.span_id as string,
        record,
      ]),
    );
    expect(bySpanId.get("1111111111111111")?.trace_id).toBe(
      CONTENT_BLIND_TRACE_JOIN_FIXTURE.traceId,
    );
    expect(bySpanId.get("1111111111111111")?.parent_span_id).toBe(
      CONTENT_BLIND_TRACE_JOIN_FIXTURE.inboundParentSpanId,
    );
    expect(bySpanId.get("2222222222222222")?.parent_span_id).toBe(
      "1111111111111111",
    );
    expect(bySpanId.get("3333333333333333")?.trace_id).toBe(
      CONTENT_BLIND_TRACE_JOIN_FIXTURE.traceId,
    );
    expect(bySpanId.get("3333333333333333")?.parent_span_id).toBe(
      CONTENT_BLIND_TRACE_JOIN_FIXTURE.inboundParentSpanId,
    );
    expect(bySpanId.get("3333333333333333")?.attributes).toMatchObject({
      retry_ordinal: 1,
    });
  });

  it("classifies cancellation and timeout without leaking exception details", () => {
    const runtime = new TaskTraceRuntime({
      exportEnabled: false,
      sampleRatePerMille: 1000,
      release: "git-test",
      traceIdGenerator: () => "cccccccccccccccccccccccccccccccc",
      idGenerator: () => "dddddddddddddddd",
      now: () => new Date("2026-08-01T12:00:00Z"),
    });

    const cancelled = runtime.startSpan({
      name: "task.execution",
      surface: "task",
      phase: "execution",
      taskContext: {
        taskClass: "delegation",
        runtimeLane: "default",
        retryOrdinal: 0,
      },
    });
    endTaskSpan(cancelled, { outcome: "failed", errorClass: "cancelled" });
    expect(cancelled.serialize()?.attributes).toMatchObject({
      error_class: "cancelled",
    });

    const timedOut = runtime.startSpan({
      name: "task.execution",
      surface: "task",
      phase: "execution",
      taskContext: {
        taskClass: "delegation",
        runtimeLane: "default",
        retryOrdinal: 0,
      },
    });
    endTaskSpan(timedOut, {
      outcome: "failed",
      errorClass: "timeout",
      error: new Error("timeout on https://private.example/path?token=secret"),
    });
    const serialized = timedOut.serialize();
    expect(serialized?.attributes).toMatchObject({ error_class: "timeout" });
    expect(JSON.stringify(serialized)).not.toContain("private.example");
    expect(JSON.stringify(serialized)).not.toContain("token=secret");
  });

  it("drops spans when sampling is zero or export fails, without throwing", async () => {
    const exporter = {
      exportSpan: vi.fn(async () => {
        throw new Error("write /tmp/private-url?token=secret");
      }),
    };
    const sampledOut = new TaskTraceRuntime({
      exportEnabled: true,
      sampleRatePerMille: 0,
      release: "git-test",
      exporter,
      traceIdGenerator: () => "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      idGenerator: () => "ffffffffffffffff",
      now: () => new Date("2026-08-01T12:00:00Z"),
    });
    const unsampled = sampledOut.startSpan({
      name: "task.execution",
      surface: "task",
      phase: "execution",
      taskContext: {
        taskClass: "delegation",
        runtimeLane: "default",
        retryOrdinal: 0,
      },
    });
    await expect(endTaskSpan(unsampled, { outcome: "ok" })).resolves.toBeUndefined();
    expect(exporter.exportSpan).not.toHaveBeenCalled();

    const runtime = new TaskTraceRuntime({
      exportEnabled: true,
      sampleRatePerMille: 1000,
      release: "git-test",
      exporter,
      traceIdGenerator: () => "abababababababababababababababab",
      idGenerator: () => "cdcdcdcdcdcdcdcd",
      now: () => new Date("2026-08-01T12:00:00Z"),
    });
    const span = runtime.startSpan({
      name: "task.execution",
      surface: "task",
      phase: "execution",
      taskContext: {
        taskClass: "delegation",
        runtimeLane: "default",
        retryOrdinal: 0,
      },
    });
    await expect(endTaskSpan(span, { outcome: "ok" })).resolves.toBeUndefined();
    expect(runtime.stats.exportFailures).toBe(1);
  });

  it("parses sampling rates with bounded defaults", () => {
    expect(parseTraceSampleRatePerMille(undefined)).toBe(1000);
    expect(parseTraceSampleRatePerMille("250")).toBe(250);
    expect(parseTraceSampleRatePerMille("-1")).toBe(1000);
    expect(parseTraceSampleRatePerMille(5000)).toBe(1000);
  });

  it("serializes only the allowlisted, bounded envelope", () => {
    const runtime = new TaskTraceRuntime({
      exportEnabled: false,
      sampleRatePerMille: 1000,
      release: "git-unsafe.example/path?token=secret",
      traceIdGenerator: () => "1234567890abcdef1234567890abcdef",
      idGenerator: () => "abcdefabcdefabcd",
      now: () => new Date("2026-08-01T12:00:00Z"),
    });

    const span = runtime.startSpan({
      name: "task.execution",
      surface: "task",
      phase: "execution",
      taskContext: {
        taskClass: "delegation",
        runtimeLane: "default",
        retryOrdinal: 0,
      },
      unsafeAttributes: {
        prompt: "secret prompt",
        result: "secret result",
        repository_path: "/Users/magnus/private",
        query: "token=secret",
      },
    });
    endTaskSpan(span, {
      outcome: "failed",
      errorClass: "gateway-error",
      error: {
        message: "postgres://user:pw@localhost/db",
        stack: "Error: postgres://user:pw@localhost/db",
      },
    });
    const serialized = span.serialize();

    expect(serialized?.attributes).toEqual({
      task_class: "delegation",
      runtime_lane: "default",
      retry_ordinal: 0,
      error_class: "gateway-error",
    });
    expect(serialized?.source.producer_version.length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(serialized)).not.toContain("secret prompt");
    expect(JSON.stringify(serialized)).not.toContain("/Users/magnus/private");
    expect(JSON.stringify(serialized)).not.toContain("postgres://");
  });

  it("emits the fixed Hugin to gateway join tuple", () => {
    const runtime = new TaskTraceRuntime({
      exportEnabled: false,
      sampleRatePerMille: 1000,
      release: "git-test",
      traceIdGenerator: () => CONTENT_BLIND_TRACE_JOIN_FIXTURE.traceId,
      idGenerator: () => CONTENT_BLIND_TRACE_JOIN_FIXTURE.gatewayCallSpanId,
      now: () => new Date("2026-08-01T12:00:00Z"),
    });

    const inbound = createInboundTaskTraceContext({
      traceparent: CONTENT_BLIND_TRACEPARENT,
      taskClass: CONTENT_BLIND_TRACE_JOIN_FIXTURE.taskClass,
      runtimeLane: CONTENT_BLIND_TRACE_JOIN_FIXTURE.runtimeLane,
      retryOrdinal: CONTENT_BLIND_TRACE_JOIN_FIXTURE.retryOrdinal,
      idGenerator: () => CONTENT_BLIND_TRACE_JOIN_FIXTURE.gatewayCallSpanId,
    });
    const span = runtime.startSpan({
      name: "gateway.delegate",
      surface: "gateway",
      phase: "execution",
      taskContext: inbound,
    });
    endTaskSpan(span, { outcome: "ok" });

    expect(span.traceparent).toBe(
      `00-${CONTENT_BLIND_TRACE_JOIN_FIXTURE.traceId}-${CONTENT_BLIND_TRACE_JOIN_FIXTURE.gatewayCallSpanId}-01`,
    );
    expect(span.serialize()).toMatchObject({
      trace_id: CONTENT_BLIND_TRACE_JOIN_FIXTURE.traceId,
      span_id: CONTENT_BLIND_TRACE_JOIN_FIXTURE.gatewayCallSpanId,
      parent_span_id: CONTENT_BLIND_TRACE_JOIN_FIXTURE.inboundParentSpanId,
      attributes: {
        task_class: CONTENT_BLIND_TRACE_JOIN_FIXTURE.taskClass,
        runtime_lane: CONTENT_BLIND_TRACE_JOIN_FIXTURE.runtimeLane,
        retry_ordinal: CONTENT_BLIND_TRACE_JOIN_FIXTURE.retryOrdinal,
      },
    });
  });
});
