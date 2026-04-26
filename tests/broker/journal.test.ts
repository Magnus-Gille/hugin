import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DelegationJournal,
  projectDelegations,
  type DelegationCompletedEvent,
  type DelegationRatedEvent,
  type DelegationSubmittedEvent,
} from "../../src/broker/journal.js";
import type { DelegationEnvelope } from "../../src/broker/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "broker-journal-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function envelope(taskId: string): DelegationEnvelope {
  return {
    envelope_version: 1,
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    orchestrator_session_id: "sess-1",
    orchestrator_submitter: "claude-code",
    task_type: "summarize",
    prompt: "Summarize the README.",
    alias_requested: "tiny",
    alias_map_version: 1,
    task_id: taskId,
    broker_principal: "claude-code",
    received_at: "2026-04-26T12:00:00Z",
    alias_resolved: {
      alias: "tiny",
      family: "one-shot",
      model_requested: "qwen2.5:3b",
      runtime: "ollama",
      runtime_row_id: "ollama-pi",
      host: "pi",
    },
    policy_version: "zdr-v1+rlv-v1",
  };
}

function submitted(taskId: string): DelegationSubmittedEvent {
  return {
    event_schema_version: 1,
    event_type: "delegation_submitted",
    event_ts: "2026-04-26T12:00:00Z",
    task_id: taskId,
    envelope: envelope(taskId),
    prompt_chars: 21,
    prompt_sha256: "a".repeat(64),
  };
}

function completed(taskId: string): DelegationCompletedEvent {
  return {
    event_schema_version: 1,
    event_type: "delegation_completed",
    event_ts: "2026-04-26T12:01:00Z",
    task_id: taskId,
    outcome: "completed",
    runtime_effective: "ollama",
    runtime_row_id_effective: "ollama-pi",
    host_effective: "pi",
    duration_s: 30,
    scanner_pass: "clean",
  };
}

function rated(taskId: string, rating: DelegationRatedEvent["rating"]): DelegationRatedEvent {
  return {
    event_schema_version: 1,
    event_type: "delegation_rated",
    event_ts: "2026-04-26T12:02:00Z",
    task_id: taskId,
    rating,
    rating_reason: "looked good",
    verification_outcome: "accepted_unchanged",
    rated_by: "claude-code",
  };
}

describe("DelegationJournal", () => {
  it("appends and reads back events", async () => {
    const j = new DelegationJournal({ path: path.join(tmpDir, "events.jsonl") });
    await j.append(submitted("t1"));
    await j.append(completed("t1"));
    const events = await j.readAll();
    expect(events).toHaveLength(2);
    expect(events[0]!.event_type).toBe("delegation_submitted");
    expect(events[1]!.event_type).toBe("delegation_completed");
  });

  it("returns empty array if file missing", async () => {
    const j = new DelegationJournal({
      path: path.join(tmpDir, "missing.jsonl"),
    });
    expect(await j.readAll()).toEqual([]);
  });

  it("skips events with unsupported event_schema_version (forward-compat)", async () => {
    const file = path.join(tmpDir, "events.jsonl");
    const future = JSON.stringify({
      event_schema_version: 99,
      event_type: "delegation_future",
      task_id: "t1",
    });
    writeFileSync(file, future + "\n" + JSON.stringify(submitted("t2")) + "\n");
    const j = new DelegationJournal({ path: file });
    const events = await j.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]!.task_id).toBe("t2");
  });

  it("skips unparseable lines and continues", async () => {
    const file = path.join(tmpDir, "events.jsonl");
    writeFileSync(file, "not-json\n" + JSON.stringify(submitted("t1")) + "\n");
    const j = new DelegationJournal({ path: file });
    const events = await j.readAll();
    expect(events).toHaveLength(1);
  });
});

describe("projectDelegations", () => {
  it("merges submitted/completed/rated for one task_id", () => {
    const rows = projectDelegations([
      submitted("t1"),
      completed("t1"),
      rated("t1", "pass"),
    ]);
    const row = rows.get("t1");
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("completed");
    expect(row?.rating).toBe("pass");
    expect(row?.envelope?.alias_requested).toBe("tiny");
  });

  it("first-wins for submitted/completed but latest-wins for rated", () => {
    const rows = projectDelegations([
      submitted("t1"),
      completed("t1"),
      rated("t1", "redo"),
      rated("t1", "pass"),
    ]);
    expect(rows.get("t1")?.rating).toBe("pass");
  });

  it("handles tasks with submitted-only state (running)", () => {
    const rows = projectDelegations([submitted("t1")]);
    const row = rows.get("t1");
    expect(row?.outcome).toBeUndefined();
    expect(row?.submitted_at).toBeDefined();
  });
});
