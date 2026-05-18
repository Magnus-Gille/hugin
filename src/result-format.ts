export interface ResultRoutingMetadata {
  replyTo?: string;
  replyFormat?: string;
  group?: string;
  sequence?: number;
}

export interface TaskResultDocumentInput extends ResultRoutingMetadata {
  exitCode: number | string;
  // Runtime-owned artefact delivery failure (issue #68). When set, renders a
  // `- **Failure kind:** <kind>` line right after the exit code. The exit code
  // itself MUST be a positive integer (e.g. 2) for delivery failures —
  // Ratatoskr decides success by `/\*\*Exit code:\*\*\s*(\d+)/`, so a
  // non-numeric/negative code mis-renders a failed delivery as success.
  failureKind?: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  executor: string;
  resultSource: string;
  logFile: string;
  body: string;
  costUsd?: number | null;
  timedOut?: boolean;
  autoRouted?: boolean;
  routingReason?: string;
  prUrl?: string;
}

export function buildRoutingMetadataLines(metadata: ResultRoutingMetadata): string[] {
  const lines: string[] = [];

  if (metadata.replyTo) {
    lines.push(`- **Reply-to:** ${metadata.replyTo}`);
  }
  if (metadata.replyFormat) {
    lines.push(`- **Reply-format:** ${metadata.replyFormat}`);
  }
  if (metadata.group) {
    lines.push(`- **Group:** ${metadata.group}`);
  }
  if (metadata.sequence !== undefined) {
    lines.push(`- **Sequence:** ${metadata.sequence}`);
  }

  return lines;
}

export function buildTaskResultDocument(input: TaskResultDocumentInput): string {
  const lines = [
    input.timedOut ? "## Result (task timed out)" : "## Result",
    "",
    `- **Exit code:** ${input.exitCode}`,
    ...(input.failureKind ? [`- **Failure kind:** ${input.failureKind}`] : []),
    `- **Started at:** ${input.startedAt}`,
    `- **Completed at:** ${input.completedAt}`,
    `- **Duration:** ${input.durationSeconds}s`,
    `- **Executor:** ${input.executor}`,
    `- **Result source:** ${input.resultSource}`,
    `- **Log file:** ${input.logFile}`,
  ];

  if (input.costUsd !== null && input.costUsd !== undefined) {
    lines.push(`- **Cost:** $${input.costUsd.toFixed(4)}`);
  }

  if (input.prUrl) {
    lines.push(`- **PR:** ${input.prUrl}`);
  }

  if (input.autoRouted && input.routingReason) {
    lines.push(`- **Auto-routed:** ${input.routingReason}`);
  }

  lines.push(...buildRoutingMetadataLines(input));
  lines.push("", input.body);

  return lines.join("\n");
}
