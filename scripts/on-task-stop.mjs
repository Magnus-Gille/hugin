#!/usr/bin/env node
// Hugin Stop Hook — captures last_assistant_message when a Hugin-spawned session ends.
// Only fires for Hugin tasks (checks HUGIN_TASK_ID env var).
// Writes result to ~/.hugin/hook-results/<task-id>.json for Hugin to pick up.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const taskId = process.env.HUGIN_TASK_ID;
if (!taskId) process.exit(0); // Not a Hugin task

// Read JSON from stdin
let input = "";
for await (const chunk of process.stdin) input += chunk;

let data;
try {
  data = JSON.parse(input);
} catch {
  process.exit(0); // Can't parse — don't block
}

const lastMessage = data.last_assistant_message;
if (!lastMessage) process.exit(0);

const resultDir = join(process.env.HOME || "/home/magnus", ".hugin", "hook-results");
mkdirSync(resultDir, { recursive: true });

const result = {
  task_id: taskId,
  task_namespace: process.env.HUGIN_TASK_NAMESPACE || `tasks/${taskId}`,
  session_id: data.session_id || null,
  last_assistant_message: lastMessage,
  completed_at: new Date().toISOString(),
};

writeFileSync(join(resultDir, `${taskId}.json`), JSON.stringify(result));
process.exit(0);
