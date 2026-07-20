#!/usr/bin/env tsx

/**
 * Operator CLI for issue #225: retry ONLY the publication (push/PR) step of a
 * managed-repository task whose model work already completed. Never invokes
 * an executor or the model — it exists specifically so the paid work is not
 * repeated merely to recover from a `git push`/`gh pr create` failure.
 *
 * Requires operator credentials (MUNIN_API_KEY) and local `git`/`gh` access
 * to the same repository checkout the original task used — the same trust
 * boundary the manual recovery described in issue #225 already required.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MuninClient } from "./munin-client.js";
import { queryAllMuninEntries } from "./munin-pagination.js";
import { PUBLICATION_FAILED_TAG } from "./task-helpers.js";
import { recoverPublicationForTask, type RecoverPublicationOutcome } from "./publication-recovery.js";

interface CliOptions {
  taskId?: string;
  all: boolean;
  limit: number;
}

function usage(): string {
  return [
    "Usage: npm run recover:publication -- [options]",
    "",
    "Retry ONLY the repository-publication (push/PR) step for a managed task",
    "whose model work already completed but whose push/PR failed (tagged",
    "publication:failed). Never re-runs the executor. Idempotent: a task",
    "already tagged publication:recovered or publication:abandoned is a no-op.",
    "",
    "Options:",
    "  --task <taskId>   Recover exactly one task (namespace tasks/<taskId>)",
    "  --all             Sweep every task currently tagged publication:failed",
    "  --limit <N>       Max tasks to inspect with --all (default 100)",
    "  --help            Show this help",
  ].join("\n");
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { all: false, limit: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--task") {
      const value = argv[index + 1];
      if (!value) throw new Error("--task requires a value");
      options.taskId = value;
      index += 1;
    } else if (arg === "--limit") {
      const value = argv[index + 1];
      if (!value) throw new Error("--limit requires a value");
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
        throw new Error("--limit must be an integer from 1 to 10000");
      }
      options.limit = limit;
      index += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.taskId && !options.all) {
    throw new Error("one of --task <taskId> or --all is required");
  }
  if (options.taskId && options.all) {
    throw new Error("--task and --all are mutually exclusive");
  }
  return options;
}

function formatOutcome(outcome: RecoverPublicationOutcome): string {
  const detail = outcome.prUrl ?? outcome.reason ?? outcome.error ?? "";
  return `${outcome.taskNamespace}: ${outcome.status}${detail ? ` — ${detail}` : ""}`;
}

async function listPublicationFailedNamespaces(
  munin: MuninClient,
  limit: number,
): Promise<string[]> {
  const queried = await queryAllMuninEntries(
    munin,
    { tags: [PUBLICATION_FAILED_TAG], namespace: "tasks/", entry_type: "state" },
    { maxResults: limit },
  );
  if (queried.truncated) {
    process.stderr.write(
      `Warning: publication:failed sweep may be incomplete (budget exhausted at ${queried.results.length} rows)\n`,
    );
  }
  return [...new Set(queried.results.map((r) => r.namespace))];
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const apiKey = process.env.MUNIN_API_KEY?.trim();
  if (!apiKey) throw new Error("MUNIN_API_KEY is required");
  const munin = new MuninClient({
    baseUrl: process.env.MUNIN_URL?.trim() || "http://localhost:3030",
    apiKey,
  });

  const namespaces = options.taskId
    ? [`tasks/${options.taskId}`]
    : await listPublicationFailedNamespaces(munin, options.limit);

  if (namespaces.length === 0) {
    process.stdout.write("No publication:failed tasks found.\n");
    return;
  }

  let failures = 0;
  for (const namespace of namespaces) {
    try {
      const outcome = await recoverPublicationForTask(munin, namespace);
      process.stdout.write(`${formatOutcome(outcome)}\n`);
      if (outcome.status === "failed") failures += 1;
    } catch (error) {
      failures += 1;
      process.stderr.write(
        `${namespace}: error — ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
