/**
 * Version-drift self-check (issue #123).
 *
 * The 2026-06-17 incident: a `deps-bump-all` task upgraded
 * `@anthropic-ai/claude-agent-sdk` (and its vendored `cli.js` runtime) on disk
 * while the Hugin worker process kept running. The worker's in-memory SDK
 * code (cached at import time) kept driving the protocol, but every task
 * spawned a freshly-read `cli.js` off disk — now a different, incompatible
 * version — so every agent-sdk task died with an opaque `exit 1`.
 *
 * A snapshot taken once at worker startup (representing what this process
 * actually has loaded) compared against a fresh on-disk read before each task
 * detects exactly that skew. Pure and side-effect-free so it is unit-tested
 * without touching the filesystem; the caller (src/index.ts) owns the actual
 * `fs` reads and is responsible for failing open on a read error — only a
 * confirmed mismatch here should ever block a task.
 */

export interface VersionSnapshot {
  /** `version` field from the on-disk @anthropic-ai/claude-agent-sdk package.json. */
  sdkVersion: string;
  /** Resolved absolute path to the SDK's vendored cli.js runtime. */
  cliPath: string;
  /** Size in bytes of cli.js, a cheap proxy for "did the binary content change". */
  cliSizeBytes: number;
  /** mtime (epoch ms) of cli.js — catches an in-place rewrite at the same size. */
  cliMtimeMs: number;
}

export interface RawVersionSnapshotInput {
  sdkVersion: string | null | undefined;
  cliPath: string;
  cliSizeBytes: number;
  cliMtimeMs: number;
}

/** Normalize a raw on-disk reading into a {@link VersionSnapshot}. */
export function buildVersionSnapshot(raw: RawVersionSnapshotInput): VersionSnapshot {
  const trimmed = raw.sdkVersion?.trim();
  return {
    sdkVersion: trimmed ? trimmed : "unknown",
    cliPath: raw.cliPath,
    cliSizeBytes: raw.cliSizeBytes,
    cliMtimeMs: raw.cliMtimeMs,
  };
}

export interface VersionDriftResult {
  drifted: boolean;
  /** Names of the {@link VersionSnapshot} fields that differ, if any. */
  changedFields: string[];
  /** Human-readable summary for logs/alerts. Always set, even when not drifted. */
  message: string;
}

const FIELD_LABELS: Array<{ field: keyof VersionSnapshot; label: string }> = [
  { field: "sdkVersion", label: "sdkVersion" },
  { field: "cliPath", label: "cliPath" },
  { field: "cliSizeBytes", label: "cliSizeBytes" },
  { field: "cliMtimeMs", label: "cliMtimeMs" },
];

/**
 * Compare a startup baseline snapshot against a freshly-read current snapshot.
 */
export function compareVersionSnapshots(
  baseline: VersionSnapshot,
  current: VersionSnapshot,
): VersionDriftResult {
  const changedFields: string[] = [];
  const changes: string[] = [];

  for (const { field, label } of FIELD_LABELS) {
    if (baseline[field] !== current[field]) {
      changedFields.push(field);
      changes.push(`${label} ${baseline[field]} → ${current[field]}`);
    }
  }

  const drifted = changedFields.length > 0;
  return {
    drifted,
    changedFields,
    message: drifted
      ? `deps changed under live worker (${changes.join("; ")}) — restart the worker to pick up the current on-disk SDK/binary.`
      : "no drift",
  };
}
