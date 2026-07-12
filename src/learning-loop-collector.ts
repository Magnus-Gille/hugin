/**
 * Learning-loop evidence collector (issue #164) — the IO half.
 *
 * Gathers the raw material for src/learning-loop-health.ts's pure computation:
 *   - M5 capability evidence from the gateway ledger (already cached + fail-open).
 *   - Hugin product evidence from the broker task corpus in Munin: each task's
 *     lifecycle, submitting principal, `hugin_rate` feedback, durable-handoff
 *     observation, and the M5 route-policy provenance stored on its result (#163).
 *
 * Two hard constraints:
 *
 *   1. **Never break /heimdall.json.** The descriptor endpoint is unauthenticated
 *      and is polled by Heimdall every 60s. Any failure here degrades to "no
 *      evidence available" — it never throws, and it never blocks the route.
 *   2. **Bounded and cached.** Collecting is O(tasks × reads); a 60s dashboard
 *      poll must not re-walk the corpus. Results are cached for
 *      DEFAULT_COLLECT_TTL_MS and the corpus scan is capped.
 */

import type { MuninClient } from "./munin-client.js";
import type { LedgerClientLike } from "./orchestrator/ledger-client.js";
import type { Ledger } from "./orchestrator/ledger-client.js";
import type { ProductTaskEvidence } from "./learning-loop-health.js";
import { parseStoredEnvelope } from "./broker/task-store.js";
import type { AwaitObservation } from "./broker/await-observation.js";

/** Dashboard-facing data: refresh a few times an hour, not every 60s poll. */
export const DEFAULT_COLLECT_TTL_MS = 300_000;
/** Cap the corpus walk — trial evidence, not a full audit. */
export const DEFAULT_MAX_TASKS = 200;

const LIFECYCLE_TAGS = ["completed", "failed", "cancelled", "running", "pending"] as const;

function pickLifecycle(tags: string[]): string {
  return LIFECYCLE_TAGS.find((t) => tags.includes(t)) ?? "unknown";
}

export interface LearningLoopEvidence {
  ledger: Ledger | null;
  tasks: ProductTaskEvidence[];
}

export interface CollectorOptions {
  munin: MuninClient;
  ledgerClient: LedgerClientLike;
  ttlMs?: number;
  maxTasks?: number;
  now?: () => number;
}

export class LearningLoopCollector {
  private readonly munin: MuninClient;
  private readonly ledgerClient: LedgerClientLike;
  private readonly ttlMs: number;
  private readonly maxTasks: number;
  private readonly now: () => number;
  private cache: { data: LearningLoopEvidence; at: number } | null = null;
  /** Coalesce concurrent collections — a burst of polls must not fan out. */
  private inFlight: Promise<LearningLoopEvidence> | null = null;

  constructor(opts: CollectorOptions) {
    this.munin = opts.munin;
    this.ledgerClient = opts.ledgerClient;
    this.ttlMs = opts.ttlMs ?? DEFAULT_COLLECT_TTL_MS;
    this.maxTasks = opts.maxTasks ?? DEFAULT_MAX_TASKS;
    this.now = opts.now ?? (() => Date.now());
  }

  async collect(): Promise<LearningLoopEvidence> {
    const nowMs = this.now();
    if (this.cache && nowMs - this.cache.at < this.ttlMs) return this.cache.data;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.collectUncached()
      .then((data) => {
        this.cache = { data, at: this.now() };
        return data;
      })
      .catch(() => {
        // Fail open: an unreachable Munin/ledger must never break the dashboard
        // endpoint. "No evidence available" is rendered honestly downstream.
        const empty: LearningLoopEvidence = { ledger: null, tasks: [] };
        return empty;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async collectUncached(): Promise<LearningLoopEvidence> {
    const [ledger, tasks] = await Promise.all([
      this.ledgerClient.getLedger().catch(() => null),
      this.collectTasks().catch(() => [] as ProductTaskEvidence[]),
    ]);
    return { ledger, tasks };
  }

  /**
   * Find every broker task's namespace.
   *
   * Deliberately NOT a single `broker:mcp-v2` tag query. Broker tasks written
   * before PR #173 lost that marker during terminal-status normalization — the
   * exact seam #173 fixed — so the tag alone silently under-counts the corpus
   * (it reported 0 tasks against a production Munin that held 1). Under-counting
   * the trial it exists to measure is the one thing this panel must never do.
   *
   * So: union the tagged entries (any key — a task's `feedback` or
   * `await-observation` doc still carries the tag even when its status doesn't)
   * with the `runtime:homeserver` status entries that back the canonical leaf,
   * then let collectOne() confirm each by the definitive marker — an embedded,
   * parseable broker envelope.
   */
  private async collectTasks(): Promise<ProductTaskEvidence[]> {
    const [tagged, homeserver] = await Promise.all([
      this.munin
        .query({
          query: "task",
          tags: ["broker:mcp-v2"],
          namespace: "tasks/",
          entry_type: "state",
          limit: this.maxTasks,
        })
        .catch(() => ({ results: [], total: 0 })),
      this.munin
        .query({
          query: "task",
          tags: ["runtime:homeserver"],
          namespace: "tasks/",
          entry_type: "state",
          limit: this.maxTasks,
        })
        .catch(() => ({ results: [], total: 0 })),
    ]);

    const namespaces = [
      ...new Set(
        [...tagged.results, ...homeserver.results]
          .map((r) => r.namespace)
          .filter((ns): ns is string => typeof ns === "string")
      ),
    ].slice(0, this.maxTasks);

    const tasks: ProductTaskEvidence[] = [];
    for (const ns of namespaces) {
      const evidence = await this.collectOne(ns).catch(() => null);
      if (evidence) tasks.push(evidence);
    }
    return tasks;
  }

  private async collectOne(namespace: string): Promise<ProductTaskEvidence | null> {
    const status = await this.munin.read(namespace, "status");
    if (!status) return null;

    // The envelope is the definitive broker marker — present and revalidated at
    // claim time, and unlike the status tag it was never dropped. A task without
    // one is an ordinary dispatcher task, not part of the #165 corpus.
    const envelope = parseStoredEnvelope(status.content);
    if (!envelope) return null;

    const taskId = namespace.replace(/^tasks\//, "");

    const [feedback, observation, structured] = await Promise.all([
      this.munin.read(namespace, "feedback").catch(() => null),
      this.munin.read(namespace, "await-observation").catch(() => null),
      this.munin.read(namespace, "result-structured").catch(() => null),
    ]);

    let rating: ProductTaskEvidence["rating"] = null;
    let verificationOutcome: string | null = null;
    if (feedback) {
      try {
        const parsed = JSON.parse(feedback.content) as {
          rating?: string;
          verification_outcome?: string;
        };
        if (
          parsed.rating === "pass" ||
          parsed.rating === "partial" ||
          parsed.rating === "redo" ||
          parsed.rating === "wrong"
        ) {
          rating = parsed.rating;
        }
        verificationOutcome = parsed.verification_outcome ?? null;
      } catch {
        // A corrupt feedback doc is one lost data point, not a broken panel.
      }
    }

    let durableHandoff = false;
    if (observation) {
      try {
        durableHandoff =
          (JSON.parse(observation.content) as AwaitObservation).durableHandoff === true;
      } catch {
        /* ignore */
      }
    }

    // Route-policy provenance, from #163's stored M5 delegation trace.
    let delegation: ProductTaskEvidence["delegation"];
    if (structured) {
      try {
        const parsed = JSON.parse(structured.content) as {
          runtimeMetadata?: {
            delegation?: {
              policyMode?: string;
              policyAction?: string;
              priceCatalogVersion?: string;
            };
          };
        };
        const d = parsed.runtimeMetadata?.delegation;
        if (d?.policyMode || d?.policyAction || d?.priceCatalogVersion) {
          delegation = {
            ...(d.policyMode ? { policyMode: d.policyMode } : {}),
            ...(d.policyAction ? { policyAction: d.policyAction } : {}),
            ...(d.priceCatalogVersion ? { priceCatalogVersion: d.priceCatalogVersion } : {}),
          };
        }
      } catch {
        /* ignore */
      }
    }

    return {
      taskId,
      lifecycle: pickLifecycle(status.tags ?? []),
      submitter: envelope?.orchestrator_submitter ?? null,
      rating,
      verificationOutcome,
      durableHandoff,
      ...(delegation ? { delegation } : {}),
    };
  }
}
