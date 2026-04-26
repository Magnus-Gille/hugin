/**
 * Append-only event journal for orchestrator delegations.
 *
 * Writes to `~/.hugin/delegation-events.jsonl` per
 * docs/orchestrator-v1-data-model.md §5. Single-writer (the Hugin broker
 * process); readers are projection consumers and the audit pipeline.
 *
 * Three event kinds: submitted, completed, rated. All three carry
 * `event_schema_version: 1`. The reader skips events with unknown schema
 * versions (forward-compat rule, §5).
 */

import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type {
  DelegationEnvelope,
  DelegationErrorKind,
  RateRequest,
} from "./types.js";

export interface DelegationSubmittedEvent {
  event_schema_version: 1;
  event_type: "delegation_submitted";
  event_ts: string;
  task_id: string;
  envelope: DelegationEnvelope;
  prompt_chars: number;
  prompt_sha256: string;
}

export interface DelegationCompletedEvent {
  event_schema_version: 1;
  event_type: "delegation_completed";
  event_ts: string;
  task_id: string;
  outcome: "completed" | "failed";
  output?: string;
  output_chars?: number;
  output_sha256?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  duration_s?: number;
  load_ms?: number;
  cost_usd?: number;
  model_effective?: string;
  runtime_effective?: string;
  runtime_row_id_effective?: string;
  host_effective?: string;
  scanner_pass?: "skipped" | "clean" | "warn" | "flag" | "redact";
  error_kind?: DelegationErrorKind;
  error_message?: string;
}

export interface DelegationRatedEvent {
  event_schema_version: 1;
  event_type: "delegation_rated";
  event_ts: string;
  task_id: string;
  rating: RateRequest["rating"];
  rating_reason: string;
  verification_outcome: RateRequest["verification_outcome"];
  rated_by: string;
  retries_count?: number;
}

export type DelegationEvent =
  | DelegationSubmittedEvent
  | DelegationCompletedEvent
  | DelegationRatedEvent;

export interface DelegationJournalConfig {
  path: string;
}

export class DelegationJournal {
  private readonly filePath: string;

  constructor(config: DelegationJournalConfig) {
    this.filePath = config.path;
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  getPath(): string {
    return this.filePath;
  }

  async append(event: DelegationEvent): Promise<void> {
    await appendFile(this.filePath, JSON.stringify(event) + "\n", "utf-8");
  }

  /**
   * Read every event in the journal. Skips lines that fail to parse or carry
   * an unknown event_schema_version (with a logged warning) per the §5
   * forward-compat rule. For v1 there is no streaming consumer; callers are
   * expected to read in full and project.
   */
  async readAll(): Promise<DelegationEvent[]> {
    if (!existsSync(this.filePath)) return [];

    const events: DelegationEvent[] = [];
    const stream = createReadStream(this.filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber++;
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as { event_schema_version?: unknown };
        if (parsed.event_schema_version !== 1) {
          console.warn(
            `[delegation-journal] skipping event with unsupported event_schema_version on line ${lineNumber}: ${String(parsed.event_schema_version)}`,
          );
          continue;
        }
        events.push(parsed as DelegationEvent);
      } catch (err) {
        console.warn(
          `[delegation-journal] failed to parse line ${lineNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return events;
  }
}

export interface DelegationProjectionRow {
  task_id: string;
  submitted_at?: string;
  envelope?: DelegationEnvelope;
  prompt_chars?: number;
  outcome?: "completed" | "failed";
  completed_at?: string;
  model_effective?: string;
  runtime_effective?: string;
  runtime_row_id_effective?: string;
  host_effective?: string;
  duration_s?: number;
  total_tokens?: number;
  cost_usd?: number;
  scanner_pass?: DelegationCompletedEvent["scanner_pass"];
  error_kind?: DelegationErrorKind;
  error_message?: string;
  rating?: RateRequest["rating"];
  rating_reason?: string;
  verification_outcome?: RateRequest["verification_outcome"];
  rated_at?: string;
  retries_count?: number;
}

/**
 * Build the per-task projection from a flat event stream. Later
 * `delegation_rated` events overwrite earlier ones (latest rating wins).
 * Order of submitted/completed events is "first wins" — they should never
 * be duplicated within a task_id under normal operation, but reconciliation
 * append-on-missing keeps that property.
 */
export function projectDelegations(
  events: DelegationEvent[],
): Map<string, DelegationProjectionRow> {
  const rows = new Map<string, DelegationProjectionRow>();
  for (const event of events) {
    const row: DelegationProjectionRow =
      rows.get(event.task_id) ?? { task_id: event.task_id };
    if (event.event_type === "delegation_submitted") {
      if (!row.submitted_at) {
        row.submitted_at = event.event_ts;
        row.envelope = event.envelope;
        row.prompt_chars = event.prompt_chars;
      }
    } else if (event.event_type === "delegation_completed") {
      if (!row.outcome) {
        row.outcome = event.outcome;
        row.completed_at = event.event_ts;
        row.model_effective = event.model_effective;
        row.runtime_effective = event.runtime_effective;
        row.runtime_row_id_effective = event.runtime_row_id_effective;
        row.host_effective = event.host_effective;
        row.duration_s = event.duration_s;
        row.total_tokens = event.total_tokens;
        row.cost_usd = event.cost_usd;
        row.scanner_pass = event.scanner_pass;
        row.error_kind = event.error_kind;
        row.error_message = event.error_message;
      }
    } else if (event.event_type === "delegation_rated") {
      row.rating = event.rating;
      row.rating_reason = event.rating_reason;
      row.verification_outcome = event.verification_outcome;
      row.rated_at = event.event_ts;
      row.retries_count = event.retries_count;
    }
    rows.set(event.task_id, row);
  }
  return rows;
}
