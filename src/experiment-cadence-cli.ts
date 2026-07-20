#!/usr/bin/env tsx

/**
 * Operator/cron CLI for the continuous-improvement experiment cadence
 * (hugin#266). Runs exactly one `runExperimentCadenceTick` and prints its
 * result. Mirrors `publication-recovery-cli.ts`'s composition-root shape:
 * build real clients from env vars, call the pure/durable orchestration
 * function, translate the result into an exit code.
 *
 * Requires `MUNIN_API_KEY` (and optionally `MUNIN_URL`). The gille outcome
 * export (#8 contract) is wired in only when `HOMESERVER_GATEWAY_URL` and
 * `HOMESERVER_ADMIN_API_KEY` are both set; otherwise every concluded
 * experiment's reviewable summary records `outcomeExport.status: "skipped"`
 * with a reason, per experiment-cadence.ts's documented limitation.
 *
 * Documented limitation: there is no production-ready bulk assembler for the
 * full `PackagerCandidateInput[]` evidence pool yet (see
 * experiment-cadence.ts's module doc comment) -- this CLI reads that pool
 * from an operator/cron-supplied JSON snapshot file (`--candidates <path>`)
 * rather than inventing a whole-ledger scan under this ticket's narrower
 * orchestration scope. A future ticket can point `--candidates` at a real
 * generator's output, or replace the flag with a direct call, without
 * touching `experiment-cadence.ts` at all.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MuninClient } from "./munin-client.js";
import { LearningRegistryStore } from "./learning-registry-store.js";
import { LearningExperimentStore } from "./learning/experiment-store.js";
import { packagerCandidateInputSchema } from "./learning/candidate-packager-schema.js";
import { createGilleOutcomeExportClient } from "./learning/experiment-outcome-export.js";
import { runExperimentCadenceTick, type CadenceTickResult } from "./learning/experiment-cadence.js";

export const DEFAULT_CADENCE_PRINCIPAL = "service:hugin-experiment-cadence";

interface CliOptions {
  dryRun: boolean;
  candidatesPath?: string;
}

function usage(): string {
  return [
    "Usage: npm run experiment:cadence -- --candidates <path> [options]",
    "",
    "Run one continuous-improvement experiment-cadence tick: propose (#234) ->",
    "package (#233) -> observe running experiments -> conclude terminal ones",
    "(gille #8 outcome export attempt + a durable reviewable summary). Never",
    "promotes. Idempotent -- re-running against unchanged state is a no-op.",
    "",
    "Options:",
    "  --candidates <path>   Required. JSON file containing a",
    "                        PackagerCandidateInput[] evidence snapshot.",
    "  --dry-run             Report the would-be actions; mutate nothing.",
    "  --help                Show this help",
  ].join("\n");
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--candidates") {
      const value = argv[index + 1];
      if (!value) throw new Error("--candidates requires a value");
      options.candidatesPath = value;
      index += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.candidatesPath) {
    throw new Error("--candidates <path> is required (see --help)");
  }
  return options;
}

function loadCandidatesFromFile(path: string) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return packagerCandidateInputSchema.array().parse(raw);
}

function formatResult(result: CadenceTickResult): string {
  const lines = [
    `tick ${result.tickId}${result.dryRun ? " (dry-run)" : ""} at ${result.startedAt}`,
    `candidates loaded: ${result.candidatesLoaded}; proposals considered: ${result.proposalsConsidered}; skipped in-flight: ${result.skippedInFlight.length}`,
    result.packaged
      ? `packaged: ${result.packaged.experimentId} (scope=${result.packaged.scope}, reused=${result.packaged.reused}${result.packaged.wouldPackage ? ", would-package" : ""})`
      : "packaged: none this tick",
    `observed: ${result.observed.length}; concluded: ${result.concluded.length}; refusals: ${result.refusals.length}; errors: ${result.errors.length}`,
  ];
  for (const refusal of result.refusals) lines.push(`  refused: ${refusal.proposalId} -- ${refusal.reason}`);
  for (const decline of result.proposalDeclines) lines.push(`  declined-population: ${JSON.stringify(decline)}`);
  for (const conclusion of result.concluded) {
    lines.push(
      `  concluded: ${conclusion.experimentId} (alreadyConcluded=${conclusion.alreadyConcluded}, ` +
      `export=${conclusion.exportStatus})`,
    );
  }
  for (const error of result.errors) lines.push(`  error[${error.stage}]: ${error.message}`);
  for (const limitation of result.limitations) lines.push(`  limitation: ${limitation}`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const apiKey = process.env.MUNIN_API_KEY?.trim();
  if (!apiKey) throw new Error("MUNIN_API_KEY is required");
  const munin = new MuninClient({
    baseUrl: process.env.MUNIN_URL?.trim() || "http://localhost:3030",
    apiKey,
  });

  const registry = new LearningRegistryStore(munin);
  const experimentStore = new LearningExperimentStore(munin);
  const principal = process.env.HUGIN_CADENCE_PRINCIPAL?.trim() || DEFAULT_CADENCE_PRINCIPAL;

  const gatewayUrl = process.env.HOMESERVER_GATEWAY_URL?.trim();
  const adminApiKey = process.env.HOMESERVER_ADMIN_API_KEY?.trim();
  const gilleExport =
    gatewayUrl && adminApiKey
      ? createGilleOutcomeExportClient({ gatewayBaseUrl: gatewayUrl, apiKey: adminApiKey })
      : undefined;

  const candidates = loadCandidatesFromFile(options.candidatesPath!);

  const result = await runExperimentCadenceTick(
    { registry, experimentStore, munin, principal, loadCandidates: async () => candidates, gilleExport },
    { dryRun: options.dryRun },
  );

  process.stdout.write(`${formatResult(result)}\n`);
  if (result.errors.length > 0) {
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
