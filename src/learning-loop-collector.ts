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
  /**
   * Whether the task corpus was actually readable. A failed query must NOT
   * degrade into an empty task list that renders as a measured zero — "we could
   * not look" and "we looked and found nothing" are different facts, and the
   * whole point of this panel is not to confuse them.
   */
  available: boolean;
  /** Per-task reads that failed — counts derived from this are a lower bound. */
  readFailures: number;
  /** The corpus walk hit its cap — counts derived from this are a lower bound. */
  truncated: boolean;
}

const UNAVAILABLE: LearningLoopEvidence = {
  ledger: null,
  tasks: [],
  available: false,
  readFailures: 0,
  truncated: false,
};

interface CorpusResult {
  tasks: ProductTaskEvidence[];
  available: boolean;
  readFailures: number;
  truncated: boolean;
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

  /**
   * Return the best evidence available RIGHT NOW, without ever blocking the
   * caller on a cold walk.
   *
   * `/heimdall.json` is unauthenticated and polled every 60s, and a cold
   * collection is up to `maxTasks` × several serialized Munin reads — easily
   * tens of seconds. Awaiting that on the request path would hang the descriptor
   * and blank Hugin's whole Heimdall page (the #135 regression), no exception
   * required. So: stale-while-revalidate. Serve the cached snapshot (even if
   * stale) or an explicit "unavailable" immediately, and refresh in the
   * background.
   */
  collect(): LearningLoopEvidence {
    const nowMs = this.now();
    const fresh = this.cache !== null && nowMs - this.cache.at < this.ttlMs;
    if (!fresh) void this.refresh();
    // Stale data is still honest data; "unavailable" is honest too. Neither is
    // worth hanging the dashboard for.
    return this.cache?.data ?? UNAVAILABLE;
  }

  /** Force a collection and wait for it. For tests and warmup, not the hot path. */
  async refresh(): Promise<LearningLoopEvidence> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.collectUncached()
      .then((data) => {
        this.cache = { data, at: this.now() };
        return data;
      })
      .catch(() => {
        // Fail open — but as "unavailable", never as an empty measured corpus.
        // A rejected collection is NOT cached, so the next tick retries.
        return UNAVAILABLE;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async collectUncached(): Promise<LearningLoopEvidence> {
    const [ledger, corpus] = await Promise.all([
      this.ledgerClient.getLedger().catch(() => null),
      this.collectTasks().catch(
        (): CorpusResult => ({ tasks: [], available: false, readFailures: 0, truncated: false })
      ),
    ]);
    return { ledger, ...corpus };
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
  private async collectTasks(): Promise<CorpusResult> {
    // A FAILED query is not an empty corpus. If we cannot enumerate the tasks,
    // say the corpus is unavailable — never let it collapse into a confident
    // zero downstream.
    const [tagged, homeserver] = await Promise.all([
      this.munin
        .query({
          query: "task",
          tags: ["broker:mcp-v2"],
          namespace: "tasks/",
          entry_type: "state",
          limit: this.maxTasks,
        })
        .then((r) => ({ ok: true as const, r }))
        .catch(() => ({ ok: false as const })),
      this.munin
        .query({
          query: "task",
          tags: ["runtime:homeserver"],
          namespace: "tasks/",
          entry_type: "state",
          limit: this.maxTasks,
        })
        .then((r) => ({ ok: true as const, r }))
        .catch(() => ({ ok: false as const })),
    ]);

    if (!tagged.ok && !homeserver.ok) {
      return { tasks: [], available: false, readFailures: 0, truncated: false };
    }

    const all = [
      ...new Set(
        [...(tagged.ok ? tagged.r.results : []), ...(homeserver.ok ? homeserver.r.results : [])]
          .map((r) => r.namespace)
          .filter((ns): ns is string => typeof ns === "string")
      ),
    ];
    const namespaces = all.slice(0, this.maxTasks);
    // A cap that hides what it dropped turns a lower bound into a fact.
    const truncated = all.length > namespaces.length || !tagged.ok || !homeserver.ok;

    const tasks: ProductTaskEvidence[] = [];
    let readFailures = 0;
    for (const ns of namespaces) {
      const evidence = await this.collectOne(ns).catch(() => {
        readFailures++;
        return null;
      });
      if (evidence) tasks.push(evidence);
    }
    return { tasks, available: true, readFailures, truncated };
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
              modelId?: string;
              taskType?: string;
            };
          };
        };
        const d = parsed.runtimeMetadata?.delegation;
        if (d?.policyMode || d?.policyAction || d?.priceCatalogVersion) {
          delegation = {
            ...(d.policyMode ? { policyMode: d.policyMode } : {}),
            ...(d.policyAction ? { policyAction: d.policyAction } : {}),
            ...(d.priceCatalogVersion ? { priceCatalogVersion: d.priceCatalogVersion } : {}),
            // Needed to tie a route-policy claim to the exact ledger row that
            // backs it, instead of to any verified sample anywhere.
            ...(d.modelId ? { modelId: d.modelId } : {}),
            ...(d.taskType ? { taskType: d.taskType } : {}),
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
      // Deterministic ordering for "most recent policy" — never array order.
      ...(status.updated_at ? { updatedAt: status.updated_at } : {}),
      ...(delegation ? { delegation } : {}),
    };
  }
}
