import {
  PIPELINE_RUNTIME_REGISTRY,
  pipelineIRSchema,
  pipelineRuntimeIdSchema,
  type PipelineAuthority,
  type PipelineDependencyFailure,
  type PipelineIR,
  type PipelinePhaseIR,
  type PipelinePhaseTaskDraft,
  type PipelineRuntimeId,
  type PipelineSensitivity,
} from "./pipeline-ir.js";
import { MAX_DEPENDENCIES } from "./task-graph.js";

interface ParsedPipelinePhase {
  name: string;
  dependsOn: string[];
  runtime: string;
  context?: string;
  timeout?: number;
  authority?: string;
  onDependencyFailure: PipelineDependencyFailure;
  prompt?: string;
}

interface ParsedPipelineDocument {
  title: string;
  submittedBy: string;
  submittedAt: string;
  replyTo?: string;
  replyFormat?: string;
  sensitivity: PipelineSensitivity;
  phases: ParsedPipelinePhase[];
}

function readField(content: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)`, "i"))?.[1]?.trim();
}

function readTaskTitle(content: string): string {
  return content.match(/^##\s*Task:\s*(.+)$/im)?.[1]?.trim() || "Pipeline task";
}

function assertValidSensitivity(value: string | undefined): PipelineSensitivity {
  if (!value) return "internal";
  const lowered = value.trim().toLowerCase();
  if (lowered === "public" || lowered === "internal" || lowered === "private") {
    return lowered;
  }
  throw new Error(`Unsupported pipeline sensitivity "${value}"`);
}

function slugifyPhaseName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error(`Phase name "${name}" cannot be converted into a task id`);
  }
  return slug;
}

function parseCommaList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parsePipelineBody(body: string): ParsedPipelinePhase[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const phases: ParsedPipelinePhase[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.trim() === "") {
      index++;
      continue;
    }

    const phaseMatch = line.match(/^Phase:\s*(.+)$/);
    if (!phaseMatch) {
      throw new Error(`Unexpected pipeline line: "${line}"`);
    }

    const phase: ParsedPipelinePhase = {
      name: phaseMatch[1].trim(),
      dependsOn: [],
      runtime: "",
      onDependencyFailure: "fail",
    };
    index++;

    while (index < lines.length) {
      const currentLine = lines[index];
      if (currentLine === undefined) break;
      if (/^Phase:\s*/.test(currentLine)) break;
      if (currentLine.trim() === "") {
        index++;
        continue;
      }

      const fieldMatch = currentLine.match(/^  ([A-Za-z-]+):\s*(.*)$/);
      if (!fieldMatch) {
        throw new Error(`Unexpected phase line for "${phase.name}": "${currentLine}"`);
      }

      const [, rawField, rawValue] = fieldMatch;
      switch (rawField) {
        case "Depends-on":
          phase.dependsOn = parseCommaList(rawValue);
          index++;
          break;
        case "Runtime":
          phase.runtime = rawValue.trim();
          index++;
          break;
        case "Context":
          phase.context = rawValue.trim();
          index++;
          break;
        case "Timeout": {
          const parsed = parseInt(rawValue.trim(), 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error(`Invalid timeout for phase "${phase.name}": "${rawValue}"`);
          }
          phase.timeout = parsed;
          index++;
          break;
        }
        case "Authority":
          phase.authority = rawValue.trim().toLowerCase();
          index++;
          break;
        case "On-dep-failure": {
          const value = rawValue.trim().toLowerCase();
          if (value !== "fail" && value !== "continue") {
            throw new Error(`Unsupported On-dep-failure value for phase "${phase.name}": "${rawValue}"`);
          }
          phase.onDependencyFailure = value;
          index++;
          break;
        }
        case "Prompt":
          if (rawValue.trim() !== "|") {
            throw new Error(`Phase "${phase.name}" must use "Prompt: |"`);
          }
          index++;
          const promptLines: string[] = [];
          while (index < lines.length) {
            const promptLine = lines[index];
            if (promptLine === undefined) break;
            if (/^Phase:\s*/.test(promptLine)) break;
            if (/^  [A-Za-z-]+:\s*/.test(promptLine)) break;
            if (promptLine.trim() === "") {
              promptLines.push("");
              index++;
              continue;
            }
            if (!/^    /.test(promptLine)) {
              throw new Error(
                `Prompt lines for phase "${phase.name}" must be indented by four spaces`
              );
            }
            promptLines.push(promptLine.slice(4));
            index++;
          }
          phase.prompt = promptLines.join("\n").trim();
          break;
        default:
          throw new Error(`Unsupported field "${rawField}" in phase "${phase.name}"`);
      }
    }

    phases.push(phase);
  }

  return phases;
}

function parsePipelineDocument(content: string): ParsedPipelineDocument {
  const pipelineBody = content.match(/###\s*Pipeline\s*\n([\s\S]+)$/i)?.[1];
  if (!pipelineBody) {
    throw new Error("Pipeline tasks must include a ### Pipeline section");
  }

  return {
    title: readTaskTitle(content),
    submittedBy: readField(content, "Submitted by") || "unknown",
    submittedAt: readField(content, "Submitted at") || new Date().toISOString(),
    replyTo: readField(content, "Reply-to"),
    replyFormat: readField(content, "Reply-format"),
    sensitivity: assertValidSensitivity(readField(content, "Sensitivity")),
    phases: parsePipelineBody(pipelineBody),
  };
}

function validatePhaseNames(phases: ParsedPipelinePhase[]): void {
  const names = new Set<string>();
  const slugs = new Set<string>();

  for (const phase of phases) {
    if (!phase.name) {
      throw new Error("Pipeline phases must have a name");
    }
    if (names.has(phase.name)) {
      throw new Error(`Duplicate phase name "${phase.name}"`);
    }
    names.add(phase.name);

    const slug = slugifyPhaseName(phase.name);
    if (slugs.has(slug)) {
      throw new Error(`Phase name collision after slugify for "${phase.name}"`);
    }
    slugs.add(slug);
  }
}

function validateDependencies(phases: ParsedPipelinePhase[]): void {
  const phaseNames = new Set(phases.map((phase) => phase.name));
  for (const phase of phases) {
    if (phase.dependsOn.length > MAX_DEPENDENCIES) {
      throw new Error(
        `Phase "${phase.name}" has ${phase.dependsOn.length} dependencies; max is ${MAX_DEPENDENCIES}`
      );
    }
    for (const dependency of phase.dependsOn) {
      if (!phaseNames.has(dependency)) {
        throw new Error(`Phase "${phase.name}" depends on unknown phase "${dependency}"`);
      }
      if (dependency === phase.name) {
        throw new Error(`Phase "${phase.name}" cannot depend on itself`);
      }
    }
  }
}

function validateAcyclic(phases: ParsedPipelinePhase[]): void {
  const graph = new Map(phases.map((phase) => [phase.name, phase.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Pipeline dependency cycle detected at phase "${name}"`);
    }

    visiting.add(name);
    const dependencies = graph.get(name) || [];
    for (const dependency of dependencies) {
      visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
  }

  for (const phase of phases) {
    visit(phase.name);
  }
}

function validateRuntimeId(phaseName: string, runtime: string): PipelineRuntimeId {
  if (runtime === "auto") {
    throw new Error(`Phase "${phaseName}" uses Runtime: auto, which is deferred until Step 6`);
  }

  const parsed = pipelineRuntimeIdSchema.safeParse(runtime.trim());
  if (!parsed.success) {
    throw new Error(`Phase "${phaseName}" uses unknown runtime "${runtime}"`);
  }
  return parsed.data;
}

function validateAuthority(phaseName: string, authority: string | undefined): PipelineAuthority {
  if (!authority || authority === "autonomous") {
    return "autonomous";
  }
  if (authority === "gated") {
    throw new Error(`Phase "${phaseName}" uses Authority: gated, which is deferred until Step 4`);
  }
  throw new Error(`Phase "${phaseName}" uses unsupported authority "${authority}"`);
}

export function compilePipelineTask(
  pipelineId: string,
  sourceTaskNamespace: string,
  content: string
): PipelineIR {
  const parsed = parsePipelineDocument(content);
  if (parsed.phases.length === 0) {
    throw new Error("Pipelines must declare at least one phase");
  }

  validatePhaseNames(parsed.phases);
  validateDependencies(parsed.phases);
  validateAcyclic(parsed.phases);

  const phaseIdByName = new Map<string, string>();
  for (const phase of parsed.phases) {
    phaseIdByName.set(phase.name, `${pipelineId}-${slugifyPhaseName(phase.name)}`);
  }

  const phases: PipelinePhaseIR[] = parsed.phases.map((phase) => {
    if (!phase.prompt) {
      throw new Error(`Phase "${phase.name}" is missing a prompt`);
    }

    const runtimeId = validateRuntimeId(phase.name, phase.runtime);
    const runtime = PIPELINE_RUNTIME_REGISTRY[runtimeId];
    const taskId = phaseIdByName.get(phase.name);
    if (!runtime || !taskId) {
      throw new Error(`Internal pipeline compiler error for phase "${phase.name}"`);
    }

    const authority = validateAuthority(phase.name, phase.authority);
    const dependencyTaskIds = phase.dependsOn.map((dependency) => {
      const dependencyTaskId = phaseIdByName.get(dependency);
      if (!dependencyTaskId) {
        throw new Error(`Internal pipeline compiler error for dependency "${dependency}"`);
      }
      return dependencyTaskId;
    });

    return {
      name: phase.name,
      slug: slugifyPhaseName(phase.name),
      taskId,
      taskNamespace: `tasks/${taskId}`,
      runtime: runtime.id,
      dispatcherRuntime: runtime.dispatcherRuntime,
      ollamaHost: runtime.ollamaHost,
      context: phase.context,
      dependsOn: phase.dependsOn,
      dependencyTaskIds,
      onDependencyFailure: phase.onDependencyFailure,
      prompt: phase.prompt,
      timeout: phase.timeout,
      authority,
      effectiveSensitivity: parsed.sensitivity,
    };
  });

  return pipelineIRSchema.parse({
    schemaVersion: 1,
    id: pipelineId,
    title: parsed.title,
    sourceTaskNamespace,
    sensitivity: parsed.sensitivity,
    replyTo: parsed.replyTo,
    replyFormat: parsed.replyFormat,
    submittedBy: parsed.submittedBy,
    submittedAt: parsed.submittedAt,
    phases,
  });
}

function buildPhaseTaskContent(
  pipeline: PipelineIR,
  phase: PipelinePhaseIR,
  index: number
): string {
  const lines = [
    `## Task: ${pipeline.title} / ${phase.name}`,
    "",
    `- **Runtime:** ${phase.dispatcherRuntime}`,
    ...(phase.ollamaHost ? [`- **Ollama-host:** ${phase.ollamaHost}`] : []),
    ...(phase.context ? [`- **Context:** ${phase.context}`] : []),
    ...(phase.timeout ? [`- **Timeout:** ${phase.timeout}`] : []),
    "- **Submitted by:** hugin",
    `- **Submitted at:** ${new Date().toISOString()}`,
    `- **Group:** pipeline:${pipeline.id}`,
    `- **Sequence:** ${index + 1}`,
    `- **Pipeline:** ${pipeline.id}`,
    `- **Pipeline phase:** ${phase.name}`,
    `- **Pipeline submitted by:** ${pipeline.submittedBy}`,
    `- **Pipeline sensitivity:** ${phase.effectiveSensitivity}`,
    `- **Pipeline authority:** ${phase.authority}`,
    ...(phase.dependencyTaskIds.length > 0
      ? [`- **Depends on task ids:** ${phase.dependencyTaskIds.join(", ")}`]
      : []),
    ...(phase.dependsOn.length > 0
      ? [`- **Depends on phases:** ${phase.dependsOn.join(", ")}`]
      : []),
    "",
    "### Prompt",
    phase.prompt,
  ];

  return lines.join("\n");
}

export function buildPhaseTaskDrafts(pipeline: PipelineIR): PipelinePhaseTaskDraft[] {
  return pipeline.phases.map((phase, index) => {
    const tags = [
      phase.dependsOn.length === 0 ? "pending" : "blocked",
      `runtime:${phase.dispatcherRuntime}`,
      "type:pipeline",
      "type:pipeline-phase",
      ...(phase.onDependencyFailure === "continue" ? ["on-dep-failure:continue"] : []),
      ...phase.dependencyTaskIds.map((taskId) => `depends-on:${taskId}`),
    ];

    return {
      namespace: phase.taskNamespace,
      content: buildPhaseTaskContent(pipeline, phase, index),
      tags,
    };
  });
}

export function buildPipelineDecompositionResult(pipeline: PipelineIR): string {
  return [
    "## Result\n",
    "- **Exit code:** 0",
    "- **Pipeline action:** compiled and decomposed",
    `- **Pipeline id:** ${pipeline.id}`,
    `- **Phases:** ${pipeline.phases.length}`,
    `- **Spec key:** ${pipeline.sourceTaskNamespace}/spec`,
    "",
    "### Child tasks",
    ...pipeline.phases.map(
      (phase) => `- ${phase.name}: ${phase.taskNamespace} (${phase.dependsOn.length === 0 ? "pending" : "blocked"})`
    ),
  ].join("\n");
}
