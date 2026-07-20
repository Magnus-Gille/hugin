#!/usr/bin/env tsx

/**
 * Operator CLI for hugin#267: print the rolling one-shot-vs-harness
 * comparison computed straight from the durable #232 registry. Read-only —
 * never mutates the registry, never calls a runtime, never touches routing.
 *
 *   npm run report:harness-comparison -- [--months 2026-06,2026-07]
 *
 * Defaults to the current and previous UTC calendar month when `--months` is
 * omitted, since that is where a standing (even shadowed, 0%-fraction) lane's
 * recent evidence lives.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MuninClient } from "./munin-client.js";
import { LearningRegistryStore } from "./learning-registry-store.js";
import {
  buildHarnessLaneComparisonReport,
  formatHarnessLaneComparisonReport,
} from "./harness-lane-comparison-report.js";

function usage(): string {
  return [
    "Usage: npm run report:harness-comparison -- [options]",
    "",
    "Print the rolling one-shot-vs-harness comparison (hugin#267), computed",
    "read-only from the durable #232 learning registry. Never mutates",
    "anything, never calls a runtime, never affects routing.",
    "",
    "Options:",
    "  --months <YYYY-MM[,YYYY-MM...]>   UTC occurrence period(s) to query",
    "                                    (default: current + previous month)",
    "  --help                            Show this help",
  ].join("\n");
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseArgs(argv: string[], now: () => Date = () => new Date()): { months: string[] } {
  let months: string[] | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else if (arg === "--months") {
      const value = argv[index + 1];
      if (!value) throw new Error("--months requires a value");
      months = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      index += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (months === undefined) {
    const current = now();
    const currentPeriod = current.toISOString().slice(0, 7);
    const previous = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
    const previousPeriod = previous.toISOString().slice(0, 7);
    months = [previousPeriod, currentPeriod];
  }
  if (months.length === 0) throw new Error("--months requires at least one period");
  for (const month of months) {
    if (!PERIOD_PATTERN.test(month)) {
      throw new Error(`invalid --months value "${month}" — expected UTC "YYYY-MM"`);
    }
  }
  return { months };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { months } = parseArgs(argv);
  const apiKey = process.env.MUNIN_API_KEY?.trim();
  if (!apiKey) throw new Error("MUNIN_API_KEY is required");
  const munin = new MuninClient({
    baseUrl: process.env.MUNIN_URL?.trim() || "http://localhost:3030",
    apiKey,
  });
  const registry = new LearningRegistryStore(munin);

  const report = await buildHarnessLaneComparisonReport(registry, months);
  process.stdout.write(`${formatHarnessLaneComparisonReport(report)}\n`);
  if (report.truncated) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
