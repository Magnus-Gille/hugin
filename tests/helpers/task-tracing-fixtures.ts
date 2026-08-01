export const CONTENT_BLIND_TRACE_JOIN_FIXTURE = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  inboundParentSpanId: "00f067aa0ba902b7",
  gatewayCallSpanId: "b9c7c989f97918e1",
  version: "00",
  flags: "01",
  taskClass: "delegation",
  runtimeLane: "default",
  retryOrdinal: 0,
} as const;

export const CONTENT_BLIND_TRACEPARENT =
  `${CONTENT_BLIND_TRACE_JOIN_FIXTURE.version}`
  + `-${CONTENT_BLIND_TRACE_JOIN_FIXTURE.traceId}`
  + `-${CONTENT_BLIND_TRACE_JOIN_FIXTURE.inboundParentSpanId}`
  + `-${CONTENT_BLIND_TRACE_JOIN_FIXTURE.flags}`;
