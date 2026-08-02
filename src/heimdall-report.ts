/**
 * Push Hugin's learning-loop typed panels (#164) to Heimdall's generic panel
 * store (`POST /api/panels`, heimdall issue #57) instead of embedding their
 * full row data in every /heimdall.json response (#317-follow-up).
 *
 * This mirrors an already-deployed, in-fleet pattern — see mimir's
 * src/heimdall-report.ts and gille-inference's scripts/post-*-panel.ts — so it
 * requires NO heimdall-side change: the ingest endpoint, auth, and per-service
 * rendering already exist and are already used by other producers.
 *
 * Env-gated and fail-soft by design:
 *   - Requires both HEIMDALL_HUB_URL (the full `.../api/panels` URL) and
 *     HEIMDALL_FLEET_TOKEN. Either absent ⇒ startHeimdallPanelReporter is a
 *     documented no-op (returns null immediately, never touches the network).
 *   - Every push has a bounded timeout and never throws past this module —
 *     a Heimdall outage must never affect Hugin's own dispatcher loop.
 */

import type { TypedPanel } from "./learning-loop-health.js";

/** The envelope Heimdall's panel-ingest.js validatePanel() accepts. */
export type PushPanel = { service: string; panel: string; kind: string } & Record<string, unknown>;

/** Push cadence — matches the `refresh: 300` the panels already declare. */
const REPORT_INTERVAL_MS = 300_000;
const PUSH_TIMEOUT_MS = 4_000;
const SERVICE = "hugin";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Convert one descriptor-shaped TypedPanel into a push envelope, or null when
 * it isn't safely pushable.
 *
 * Strips descriptor-only fields (`id` → `panel`, `fullWidth`, `refresh` —
 * Heimdall's push path doesn't use them). Also guards a real asymmetry
 * between the two consumer paths: the pull-path normalizer
 * (heimdall src/contract/panel-data.js normalizeTypedPanelData) is LENIENT —
 * an invalid `stat.value` is just dropped — but the push path's
 * validatePanel() HARD-REJECTS the whole panel for it. Hugin's own
 * "durable handoffs" panel intentionally uses a non-numeric placeholder
 * ("—") when the product-evidence corpus is unreadable (honesty about
 * denominators, not a flattering zero) — pushing that would 400 the whole
 * update. Skipping it here leaves Heimdall's last good value in place
 * (harmless staleness) rather than losing every other panel in the same
 * batch to one rejected push.
 */
export function toPushPanel(p: TypedPanel): PushPanel | null {
  const { id, fullWidth: _fullWidth, refresh: _refresh, kind, ...rest } = p;
  void _fullWidth;
  void _refresh;
  if (kind === "stat" && !isNum((rest as { value?: unknown }).value)) return null;
  if (kind === "status" && typeof (rest as { state?: unknown }).state !== "string") return null;
  if (kind === "table" && !Array.isArray((rest as { rows?: unknown }).rows)) return null;
  if (kind === "timeseries" && !Array.isArray((rest as { points?: unknown }).points)) return null;
  return { service: SERVICE, panel: id, kind, ...rest };
}

/** Filter + convert a full panel list, dropping unpushable ones. */
export function buildPushPanels(panels: TypedPanel[]): PushPanel[] {
  const out: PushPanel[] = [];
  for (const p of panels) {
    const pushed = toPushPanel(p);
    if (pushed) out.push(pushed);
  }
  return out;
}

/**
 * POST a single panel to the Heimdall hub. Fail-soft: logs and returns on any
 * non-2xx or network error; never throws.
 */
export async function pushPanel(hubUrl: string, token: string, panel: PushPanel): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PUSH_TIMEOUT_MS);
  try {
    const response = await fetch(hubUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(panel),
      signal: ac.signal,
    });
    if (!response.ok) {
      console.warn(
        `[hugin] Heimdall panel push rejected (panel=${panel.panel}, status=${response.status}).`
      );
    }
  } catch (err) {
    console.warn(
      `[hugin] Heimdall panel push failed (panel=${panel.panel}):`,
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    clearTimeout(timer);
  }
}

async function runReport(
  hubUrl: string,
  token: string,
  getPanels: () => TypedPanel[]
): Promise<void> {
  const panels = buildPushPanels(getPanels());
  for (const panel of panels) {
    await pushPanel(hubUrl, token, panel);
  }
}

/**
 * Start the periodic Heimdall panel-push loop.
 *
 * `getPanels` is called synchronously on each cycle — pass e.g.
 * `() => buildLearningLoopHealthPanels(collector)`, which is itself
 * stale-while-revalidate cached, so this never blocks on a cold corpus walk.
 *
 * Env-gated: requires both HEIMDALL_HUB_URL and HEIMDALL_FLEET_TOKEN. Returns
 * a cleanup function on success, or null when either is absent (safe to
 * call: logs one debug line, touches no network).
 *
 * The interval is unref()'d so it never prevents process exit.
 */
export function startHeimdallPanelReporter(getPanels: () => TypedPanel[]): (() => void) | null {
  const hubUrl = process.env.HEIMDALL_HUB_URL;
  const token = process.env.HEIMDALL_FLEET_TOKEN;

  if (!hubUrl || !token) {
    console.debug(
      "[hugin] Heimdall panel reporter disabled (HEIMDALL_HUB_URL/HEIMDALL_FLEET_TOKEN not set)."
    );
    return null;
  }

  const fire = (): void => {
    runReport(hubUrl, token, getPanels).catch((err) => {
      console.warn(
        "[hugin] Heimdall panel report cycle errored:",
        err instanceof Error ? err.message : String(err)
      );
    });
  };

  fire();
  const interval = setInterval(fire, REPORT_INTERVAL_MS);
  interval.unref();

  return () => clearInterval(interval);
}
