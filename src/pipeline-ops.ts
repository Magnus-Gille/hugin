import { type PipelineIR, type PipelinePhaseIR } from "./pipeline-ir.js";
import { type PipelinePhaseLifecycle } from "./pipeline-summary.js";

export interface PipelineResumePhasePlan {
  phase: PipelinePhaseIR;
  currentLifecycle: PipelinePhaseLifecycle;
  shouldReset: boolean;
  nextLifecycle: PipelinePhaseLifecycle;
}

export interface PipelineResumePlan {
  resumable: boolean;
  reason?: string;
  hasActivePhases: boolean;
  phases: PipelineResumePhasePlan[];
}

export function buildPipelineResumePlan(
  pipeline: PipelineIR,
  currentLifecycles: Record<string, PipelinePhaseLifecycle>
): PipelineResumePlan {
  const phases = pipeline.phases.map((phase) => ({
    phase,
    currentLifecycle: currentLifecycles[phase.taskNamespace] || "missing",
  }));

  const hasActivePhases = phases.some(
    (item) =>
      item.currentLifecycle === "pending" ||
      item.currentLifecycle === "blocked" ||
      item.currentLifecycle === "running"
  );

  const incompletePhaseNames = new Set(
    phases
      .filter((item) => item.currentLifecycle !== "completed")
      .map((item) => item.phase.name)
  );
  const resetPhaseNames = new Set(
    phases
      .filter(
        (item) =>
          item.currentLifecycle === "missing" ||
          item.currentLifecycle === "failed" ||
          item.currentLifecycle === "cancelled"
      )
      .map((item) => item.phase.name)
  );

  if (resetPhaseNames.size === 0 && hasActivePhases) {
    return {
      resumable: false,
      reason: "Pipeline is already active",
      hasActivePhases,
      phases: phases.map((item) => ({
        ...item,
        shouldReset: false,
        nextLifecycle: item.currentLifecycle,
      })),
    };
  }

  if (resetPhaseNames.size === 0) {
    return {
      resumable: false,
      reason: "Pipeline is already completed",
      hasActivePhases,
      phases: phases.map((item) => ({
        ...item,
        shouldReset: false,
        nextLifecycle: "completed",
      })),
    };
  }

  return {
    resumable: true,
    hasActivePhases,
    phases: phases.map((item) => {
      if (!resetPhaseNames.has(item.phase.name)) {
        return {
          ...item,
          shouldReset: false,
          nextLifecycle: item.currentLifecycle,
        };
      }

      const nextLifecycle =
        item.phase.dependsOn.every(
          (dependencyName) => !incompletePhaseNames.has(dependencyName)
        )
          ? "pending"
          : "blocked";

      return {
        ...item,
        shouldReset: true,
        nextLifecycle,
      };
    }),
  };
}
