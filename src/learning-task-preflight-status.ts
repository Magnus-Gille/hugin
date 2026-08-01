import type { TypedPanel } from "./learning-loop-health.js";

export interface LearningTaskPreflightObservation {
  checkedAt: string;
  outcome: "ok" | "failed";
  errorClass?: string;
  detail?: string;
}

export interface LearningTaskPreflightSnapshot {
  checkedAt: string | null;
  outcome: "unknown" | "ok" | "failed";
  errorClass?: string;
}

function sanitizeErrorClass(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const safe = trimmed
    .replace(/[^A-Za-z0-9._:+-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64);
  return safe || undefined;
}

export function classifyLearningTaskPreflightError(
  reason: string | undefined,
): string {
  const normalized = reason?.trim().toLowerCase() ?? "";
  if (normalized.includes("capability downgrade")) return "capability-downgrade";
  if (normalized.includes("unsupported") || normalized.includes("partial contract")) {
    return "unsupported-contract";
  }
  if (normalized.includes("freshness") || normalized.includes("cache ttl")) {
    return "stale-preflight";
  }
  if (normalized.includes("http")) return "preflight-http-error";
  if (normalized.includes("clock") || normalized.includes("durable attempt start")) {
    return "clock-order";
  }
  return "preflight-failed";
}

export function createLearningTaskPreflightStore(): {
  record(observation: LearningTaskPreflightObservation): void;
  snapshot(): LearningTaskPreflightSnapshot;
} {
  let snapshot: LearningTaskPreflightSnapshot = {
    checkedAt: null,
    outcome: "unknown",
  };
  return {
    record(observation) {
      snapshot = {
        checkedAt: observation.checkedAt,
        outcome: observation.outcome,
        ...(observation.outcome === "failed"
          ? { errorClass: sanitizeErrorClass(observation.errorClass) ?? "preflight-failed" }
          : {}),
      };
    },
    snapshot() {
      return { ...snapshot };
    },
  };
}

export function buildLearningTaskPreflightPanel(
  snapshot: LearningTaskPreflightSnapshot,
): TypedPanel {
  if (snapshot.outcome === "ok") {
    return {
      id: "hugin-learning-task-preflight",
      label: "Authenticated learning-task preflight",
      kind: "status",
      refresh: 300,
      state: "pass",
      message: "Authenticated learning-task preflight succeeded.",
    };
  }
  if (snapshot.outcome === "failed") {
    return {
      id: "hugin-learning-task-preflight",
      label: "Authenticated learning-task preflight",
      kind: "status",
      refresh: 300,
      state: "fail",
      message: `Authenticated learning-task preflight failed (${snapshot.errorClass ?? "preflight-failed"}).`,
    };
  }
  return {
    id: "hugin-learning-task-preflight",
    label: "Authenticated learning-task preflight",
    kind: "status",
    refresh: 300,
    state: "unknown",
    message: "Authenticated learning-task preflight has not run yet.",
  };
}
