import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";

// Runtime-owned artefact delivery (issue #68). The task declares an
// `### Artifacts` JSON manifest; the agent only writes content to the declared
// local staging paths and is forbidden from making delivery claims. After the
// agent run, Hugin (not the LLM) delivers + verifies each artefact:
//   statSync local -> rsync to <remote>.partial -> remote sha256sum match ->
//   atomic `ssh mv .partial -> final`.
//
// The lifecycle protocol that wires this into the dispatcher lives in
// index.ts; this module is pure delivery mechanics + manifest validation and
// has no Munin/dispatcher coupling so it can be unit-tested in isolation.

// --- Policy ---

// `defer` (issue #72): an INFRA delivery failure (NAS unreachable, rsync/verify
// timeout) leaves the task `running + delivery:pending` instead of terminalizing,
// and a periodic retry reconciler re-attempts under a retry budget. missing-local
// / unsafe-local are still ALWAYS terminal — a deferral never resurrects a
// nonexistent or unsafe deliverable.
export type DeliveryPolicy = "off" | "warn" | "require" | "defer";

export function parseDeliveryPolicy(raw: string | undefined): DeliveryPolicy {
  const v = raw?.trim().toLowerCase();
  if (v === "off" || v === "warn" || v === "require" || v === "defer") return v;
  if (v && v.length > 0) {
    throw new Error(
      `Invalid HUGIN_DELIVERY_POLICY=${raw}; expected off | warn | require | defer`,
    );
  }
  return "require";
}

// --- Target allowlist (tuple, not just host) ---

export interface DeliveryTarget {
  user: string;
  host: string;
  remotePathPrefix: string;
  localStagingPrefix: string;
}

const deliveryTargetSchema = z.object({
  user: z.string().min(1),
  host: z.string().min(1),
  remotePathPrefix: z.string().min(1),
  localStagingPrefix: z.string().min(1),
});

// The single production NAS (research-spike → Mímir inbox). Overridable via
// HUGIN_DELIVERY_TARGETS so local/test deployments can point elsewhere.
// Deliberately NOT derived from the fetch egress allowlist (egress-policy.ts):
// that list is for outbound `fetch` hosts and has broad defaults (GitHub, API
// hosts); SSH/rsync file delivery needs its own, tighter allowlist.
export const DEFAULT_DELIVERY_TARGETS: DeliveryTarget[] = [
  {
    user: "magnus",
    host: "100.99.119.52",
    remotePathPrefix: "/home/magnus/mimir-inbox/",
    localStagingPrefix: "/home/magnus/scratch/",
  },
];

export function loadDeliveryTargets(
  raw: string | undefined,
): DeliveryTarget[] {
  if (!raw || !raw.trim()) return DEFAULT_DELIVERY_TARGETS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid HUGIN_DELIVERY_TARGETS: not valid JSON (${(err as Error).message})`,
    );
  }
  const result = z.array(deliveryTargetSchema).min(1).safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid HUGIN_DELIVERY_TARGETS: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  // Normalize prefixes to end with a slash so prefix checks are boundary-safe
  // (`/a/scratch` must not match `/a/scratch-evil/x`).
  return result.data.map((t) => ({
    ...t,
    remotePathPrefix: t.remotePathPrefix.endsWith("/")
      ? t.remotePathPrefix
      : `${t.remotePathPrefix}/`,
    localStagingPrefix: t.localStagingPrefix.endsWith("/")
      ? t.localStagingPrefix
      : `${t.localStagingPrefix}/`,
  }));
}

// --- Manifest ---

export interface ArtifactEntry {
  id: string;
  local: string;
  remote: string; // "user@host:/abs/path"
  required: boolean;
}

export interface ArtifactManifest {
  artifacts: ArtifactEntry[];
}

const artifactEntrySchema = z.object({
  id: z.string().min(1),
  local: z.string().min(1),
  remote: z.string().min(1),
  required: z.boolean(),
});

const manifestSchema = z.array(artifactEntrySchema).min(1);

export interface ParsedRemote {
  user: string;
  host: string;
  path: string;
}

// Reject anything that could break out of an argv element or a single-quoted
// remote shell word: traversal, NUL, CR/LF, and shell metacharacters. Paths in
// the manifest are machine-substituted by the skill, so this is a hard reject,
// not an escaping problem.
const UNSAFE_PATH = /(\.\.|\0|[\r\n]|[;&|`$(){}<>*?!\\"'\s])/;

function pathIsSafe(p: string): boolean {
  return p.length > 0 && p.startsWith("/") && !UNSAFE_PATH.test(p);
}

function localPathIsSafe(p: string): boolean {
  // Local staging paths are also absolute and traversal-free; spaces are still
  // disallowed (the skill controls these names).
  return p.length > 0 && p.startsWith("/") && !UNSAFE_PATH.test(p);
}

export function parseRemote(remote: string): ParsedRemote | null {
  const m = remote.match(/^([^@/\s]+)@([^:/\s]+):(\/.*)$/);
  if (!m) return null;
  return { user: m[1], host: m[2], path: m[3] };
}

// Detect un-substituted skill placeholders (`<slug>`, `<project>`,
// `<YYYY-MM-DD>`, any `<...>`). A hand-templated SKILL.md placeholder bug must
// fail BEFORE the paid spike, not after.
const PLACEHOLDER = /<[^>]+>/;

export interface ManifestParseResult {
  present: boolean;
  manifest: ArtifactManifest | null;
  error: string | null;
  // True only for the "### Artifacts after ### Prompt" grammar violation. This
  // is a structural prompt-leak hazard independent of the delivery feature, so
  // the dispatcher must reject it even when HUGIN_DELIVERY_POLICY=off (Codex
  // review #5 — otherwise the manifest leaks into the agent prompt in rollback
  // mode).
  grammarViolation?: boolean;
}

/**
 * Extract and validate the `### Artifacts` manifest from raw task content.
 *
 * Grammar rule (debate F11): `### Artifacts` MUST appear before `### Prompt`.
 * Prompt extraction in index.ts is `/###\s*Prompt\s*\n([\s\S]+)$/i` → EOF, so a
 * manifest placed after `### Prompt` would leak into the agent prompt. We treat
 * "manifest after prompt" as a hard validation error, not a silent skip.
 *
 * Validation (all pre-spike, before any spend):
 *   - section present and a single fenced ```json block
 *   - parses as JSON, matches the manifest schema
 *   - no un-substituted `<placeholder>` in local/remote
 *   - remote parses as user@host:/abs/path
 *   - (user, host, remote-prefix) matches an allowed target tuple
 *   - local path under that tuple's localStagingPrefix
 *   - no `..` / NUL / newline / shell metacharacters in any path
 */
export function parseArtifactManifest(
  content: string,
  targets: DeliveryTarget[],
): ManifestParseResult {
  const artifactsIdx = content.search(/^###\s*Artifacts\s*$/im);
  if (artifactsIdx === -1) {
    return { present: false, manifest: null, error: null };
  }

  const promptIdx = content.search(/^###\s*Prompt\s*$/im);
  if (promptIdx !== -1 && artifactsIdx > promptIdx) {
    return {
      present: true,
      manifest: null,
      grammarViolation: true,
      error:
        "### Artifacts section must appear before ### Prompt (otherwise the manifest leaks into the agent prompt)",
    };
  }

  // Bound the manifest to the section between `### Artifacts` and the next
  // `### ` heading (or EOF) so a fenced block inside `### Prompt` can't be
  // mistaken for the manifest.
  const after = content.slice(artifactsIdx);
  const nextHeading = after.slice(1).search(/^###\s+/m);
  const section =
    nextHeading === -1 ? after : after.slice(0, nextHeading + 1);

  const fence = section.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (!fence) {
    return {
      present: true,
      manifest: null,
      error: "### Artifacts section has no fenced ```json block",
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fence[1]);
  } catch (err) {
    return {
      present: true,
      manifest: null,
      error: `### Artifacts manifest is not valid JSON: ${(err as Error).message}`,
    };
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      present: true,
      manifest: null,
      error: `### Artifacts manifest shape invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }

  const seenIds = new Set<string>();
  for (const entry of parsed.data) {
    if (PLACEHOLDER.test(entry.local) || PLACEHOLDER.test(entry.remote)) {
      return {
        present: true,
        manifest: null,
        error: `artefact "${entry.id}" has an un-substituted placeholder (skill template bug): local=${entry.local} remote=${entry.remote}`,
      };
    }
    if (seenIds.has(entry.id)) {
      return {
        present: true,
        manifest: null,
        error: `duplicate artefact id "${entry.id}"`,
      };
    }
    seenIds.add(entry.id);

    if (!localPathIsSafe(entry.local)) {
      return {
        present: true,
        manifest: null,
        error: `artefact "${entry.id}" local path is unsafe (must be absolute, no .., NUL, newline, whitespace, or shell metacharacters): ${entry.local}`,
      };
    }

    const remote = parseRemote(entry.remote);
    if (!remote) {
      return {
        present: true,
        manifest: null,
        error: `artefact "${entry.id}" remote must be user@host:/absolute/path: ${entry.remote}`,
      };
    }
    if (!pathIsSafe(remote.path)) {
      return {
        present: true,
        manifest: null,
        error: `artefact "${entry.id}" remote path is unsafe: ${remote.path}`,
      };
    }

    const target = targets.find(
      (t) =>
        t.user === remote.user &&
        t.host === remote.host &&
        remote.path.startsWith(t.remotePathPrefix),
    );
    if (!target) {
      return {
        present: true,
        manifest: null,
        error: `artefact "${entry.id}" target ${remote.user}@${remote.host}:${remote.path} is not in the HUGIN_DELIVERY_TARGETS allowlist`,
      };
    }
    if (!entry.local.startsWith(target.localStagingPrefix)) {
      return {
        present: true,
        manifest: null,
        error: `artefact "${entry.id}" local path ${entry.local} is not under the allowed staging prefix ${target.localStagingPrefix}`,
      };
    }
  }

  return {
    present: true,
    manifest: { artifacts: parsed.data },
    error: null,
  };
}

// --- Delivery ---

export type ArtifactStatus =
  | "verified"
  | "missing-local"
  | "unsafe-local"
  | "delivery-failed"
  | "verify-failed";

export interface ArtifactDeliveryRecord {
  id: string;
  status: ArtifactStatus;
  remote: string;
  bytes?: number;
  sha256?: string;
  error?: string;
}

export type DeliveryFailureKind =
  // Local staging file missing/empty = the agent didn't produce the
  // deliverable = the #68 bug. ALWAYS terminal.
  | "missing-local"
  // Local staging path is a symlink or resolves outside the allowed staging
  // root = symlink-escape exfiltration attempt (Codex review #3). ALWAYS
  // terminal — never deliver, never retry.
  | "unsafe-local"
  // SSH unreachable / rsync timeout / verify timeout / remote command failure
  // = infrastructure. Terminal only under `require`.
  | "infra";

export interface DeliveryResult {
  ok: boolean;
  records: ArtifactDeliveryRecord[];
  failureKind?: DeliveryFailureKind;
  error?: string;
}

export interface DeliverOptions {
  manifest: ArtifactManifest;
  /** Per-artefact state from a prior attempt; `verified` artefacts are skipped. */
  priorRecords?: ArtifactDeliveryRecord[];
  /** Append a line to the per-task log (SDK log stream is already closed). */
  appendLog: (line: string) => void;
  /** Overall wall-clock budget for the whole delivery (default 120s). */
  timeoutMs?: number;
  /** Per remote/rsync command timeout (default 45s). */
  commandTimeoutMs?: number;
  /** Reject artefacts larger than this (default 25 MiB). */
  maxBytes?: number;
  /** Abort signal (operator cancel / shutdown). */
  signal?: AbortSignal;
  /**
   * Allowed local staging prefixes (slash-normalized, from the delivery target
   * tuples). The resolved REAL path of every local artefact must stay under
   * one of these. The manifest's string allowlist alone follows symlinks, so a
   * task could stage a symlink under the allowed prefix pointing at any
   * readable file (e.g. ~/.ssh keys) and exfiltrate it (Codex review #3).
   * Empty/undefined disables the realpath containment check (the lstat
   * symlink-reject still applies).
   */
  stagingPrefixes?: string[];
  /** Test seam. */
  spawnFn?: typeof spawn;
  /** Test seam: stat. */
  statFn?: (p: string) => { size: number };
  /** Test seam: lstat (no symlink follow). */
  lstatFn?: (p: string) => { isSymbolicLink: () => boolean };
  /** Test seam: realpath. */
  realpathFn?: (p: string) => string;
  /** Test seam: local hash. */
  hashFn?: (p: string) => string;
}

const SSH_BASE_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
];

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sha256File(p: string): string {
  const h = createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runSpawn(
  spawnFn: typeof spawn,
  cmd: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    // Force HOME so systemd-user SSH finds keys/known_hosts (the git helper
    // already learned this lesson — see task-helpers.ts runGitFetch).
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: process.env.HOME || "/home/magnus",
    };
    const child = spawnFn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (o: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(o);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr: `${stderr}\n[aborted]`, timedOut: true });
    };
    if (signal) {
      if (signal.aborted) {
        child.kill("SIGKILL");
        finish({ code: null, stdout, stderr: "[aborted]", timedOut: true });
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) =>
      finish({ code, stdout, stderr, timedOut: false }),
    );
    child.on("error", (err) =>
      finish({ code: null, stdout, stderr: String(err), timedOut: false }),
    );
  });
}

/**
 * Deliver + verify every artefact in the manifest, idempotently.
 *
 * Per artefact:
 *   1. statSync local — missing/empty + `required` → terminal `missing-local`
 *      (this IS the #68 bug; never retried as infra).
 *   2. rsync local → `<remote>.partial` (argv array, no shell interpolation).
 *   3. remote `sha256sum <remote>.partial` == local sha256 (mismatch → fail,
 *      no rename, so a half-written file is never promoted).
 *   4. atomic `ssh mv -- <remote>.partial <remote>`.
 *
 * `priorRecords` lets a retry skip already-`verified` artefacts and repair
 * only the failed ones (idempotent self-heal).
 */
export async function deliverArtifacts(
  opts: DeliverOptions,
): Promise<DeliveryResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const statFn = opts.statFn ?? ((p: string) => fs.statSync(p));
  const lstatFn =
    opts.lstatFn ?? ((p: string) => fs.lstatSync(p) as { isSymbolicLink: () => boolean });
  const realpathFn = opts.realpathFn ?? ((p: string) => fs.realpathSync(p));
  const stagingPrefixes = opts.stagingPrefixes ?? [];
  const hashFn = opts.hashFn ?? sha256File;
  const commandTimeoutMs = opts.commandTimeoutMs ?? 45_000;
  const overallTimeoutMs = opts.timeoutMs ?? 120_000;
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  const deadline = Date.now() + overallTimeoutMs;

  const prior = new Map(
    (opts.priorRecords ?? []).map((r) => [r.id, r] as const),
  );
  const records: ArtifactDeliveryRecord[] = [];

  const cmdTimeout = () =>
    Math.max(1, Math.min(commandTimeoutMs, deadline - Date.now()));

  for (const a of opts.manifest.artifacts) {
    const existing = prior.get(a.id);
    if (existing?.status === "verified") {
      opts.appendLog(`[delivery] ${a.id}: already verified, skipping`);
      records.push(existing);
      continue;
    }

    const remote = parseRemote(a.remote);
    if (!remote) {
      // Should be unreachable: the manifest was validated pre-spike.
      records.push({
        id: a.id,
        status: "delivery-failed",
        remote: a.remote,
        error: "unparseable remote (validation invariant violated)",
      });
      return {
        ok: false,
        records,
        failureKind: "infra",
        error: `artefact ${a.id}: unparseable remote`,
      };
    }

    // 0. Symlink-escape guard (Codex review #3). The manifest validated
    //    `a.local` as a *string* under an allowed staging prefix, but
    //    statSync/readFileSync/rsync all follow symlinks. Reject if the final
    //    component is a symlink, and require the resolved real path to remain
    //    under an allowed staging prefix (catches symlinked parent dirs too).
    //    ALWAYS terminal — this is an exfiltration attempt, never retry.
    const unsafeLocal = (error: string): DeliveryResult => {
      records.push({
        id: a.id,
        status: "unsafe-local",
        remote: a.remote,
        error,
      });
      opts.appendLog(`[delivery] ${a.id}: UNSAFE local path — ${error}`);
      return {
        ok: false,
        records,
        failureKind: "unsafe-local",
        error: `artefact "${a.id}" local path rejected: ${error}`,
      };
    };
    try {
      if (lstatFn(a.local).isSymbolicLink()) {
        return unsafeLocal(
          `local staging path is a symlink (symlink-escape blocked): ${a.local}`,
        );
      }
    } catch {
      // lstat failure here = path absent; fall through to the stat-based
      // missing-local handling below for a consistent failure kind.
    }
    if (stagingPrefixes.length > 0) {
      let real: string;
      try {
        real = realpathFn(a.local);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code && code !== "ENOENT") {
          // realpath failed for a non-absence reason (EACCES, ELOOP, …). We
          // cannot prove containment, so refuse rather than silently skip the
          // guard (Codex review D). ENOENT falls through to the stat-based
          // missing-local handling below for a consistent failure kind.
          return unsafeLocal(
            `realpath failed (${code}); cannot verify containment under the allowed staging root: ${a.local}`,
          );
        }
        real = "";
      }
      if (real) {
        const contained = stagingPrefixes.some(
          (prefix) => real === prefix.replace(/\/$/, "") || real.startsWith(prefix),
        );
        if (!contained) {
          return unsafeLocal(
            `resolves outside the allowed staging root (${real} not under ${stagingPrefixes.join(", ")})`,
          );
        }
      }
    }

    // 1. Local staging file must exist and be non-empty.
    let size: number;
    try {
      size = statFn(a.local).size;
    } catch {
      const rec: ArtifactDeliveryRecord = {
        id: a.id,
        status: "missing-local",
        remote: a.remote,
        error: `local staging file does not exist: ${a.local}`,
      };
      records.push(rec);
      if (a.required) {
        opts.appendLog(`[delivery] ${a.id}: MISSING local file ${a.local}`);
        return {
          ok: false,
          records,
          failureKind: "missing-local",
          error: `required artefact "${a.id}" was not produced (no local file at ${a.local})`,
        };
      }
      opts.appendLog(`[delivery] ${a.id}: optional local file absent, skipping`);
      continue;
    }
    if (size === 0) {
      records.push({
        id: a.id,
        status: "missing-local",
        remote: a.remote,
        bytes: 0,
        error: `local staging file is empty: ${a.local}`,
      });
      if (a.required) {
        opts.appendLog(`[delivery] ${a.id}: EMPTY local file ${a.local}`);
        return {
          ok: false,
          records,
          failureKind: "missing-local",
          error: `required artefact "${a.id}" is empty at ${a.local}`,
        };
      }
      continue;
    }
    if (size > maxBytes) {
      records.push({
        id: a.id,
        status: "delivery-failed",
        remote: a.remote,
        bytes: size,
        error: `artefact exceeds max size ${maxBytes} bytes (${size})`,
      });
      return {
        ok: false,
        records,
        failureKind: "infra",
        error: `artefact "${a.id}" exceeds max size (${size} > ${maxBytes})`,
      };
    }

    const localHash = hashFn(a.local);
    const partial = `${remote.path}.partial`;
    const remoteDir = remote.path.slice(0, remote.path.lastIndexOf("/")) || "/";
    const sshHost = `${remote.user}@${remote.host}`;

    const fail = (
      status: ArtifactStatus,
      error: string,
    ): DeliveryResult => {
      records.push({
        id: a.id,
        status,
        remote: a.remote,
        bytes: size,
        sha256: localHash,
        error,
      });
      opts.appendLog(`[delivery] ${a.id}: ${status} — ${error}`);
      return { ok: false, records, failureKind: "infra", error };
    };

    // 2a. Ensure remote directory exists.
    const mkdir = await runSpawn(
      spawnFn,
      "ssh",
      [...SSH_BASE_ARGS, sshHost, "--", `mkdir -p ${shellQuote(remoteDir)}`],
      cmdTimeout(),
      opts.signal,
    );
    if (mkdir.code !== 0) {
      return fail(
        "delivery-failed",
        `remote mkdir -p ${remoteDir} failed${mkdir.timedOut ? " (timeout)" : ""}: ${mkdir.stderr.trim()}`,
      );
    }

    // 2b. rsync to a .partial temp path (never the final path directly).
    const rsync = await runSpawn(
      spawnFn,
      "rsync",
      [
        "-az",
        "--timeout=30",
        "-e",
        `ssh ${SSH_BASE_ARGS.join(" ")}`,
        "--",
        a.local,
        `${sshHost}:${partial}`,
      ],
      cmdTimeout(),
      opts.signal,
    );
    if (rsync.code !== 0) {
      return fail(
        "delivery-failed",
        `rsync to ${partial} failed${rsync.timedOut ? " (timeout)" : ""}: ${rsync.stderr.trim()}`,
      );
    }

    // 3. Verify remote hash == local hash BEFORE promoting.
    const verify = await runSpawn(
      spawnFn,
      "ssh",
      [...SSH_BASE_ARGS, sshHost, "--", `sha256sum -- ${shellQuote(partial)}`],
      cmdTimeout(),
      opts.signal,
    );
    if (verify.code !== 0) {
      return fail(
        "verify-failed",
        `remote sha256sum failed${verify.timedOut ? " (timeout)" : ""}: ${verify.stderr.trim()}`,
      );
    }
    const remoteHash = verify.stdout.trim().split(/\s+/)[0];
    if (remoteHash !== localHash) {
      return fail(
        "verify-failed",
        `hash mismatch: local ${localHash} != remote ${remoteHash}`,
      );
    }

    // 4. Atomic rename into place.
    const mv = await runSpawn(
      spawnFn,
      "ssh",
      [
        ...SSH_BASE_ARGS,
        sshHost,
        "--",
        `mv -- ${shellQuote(partial)} ${shellQuote(remote.path)}`,
      ],
      cmdTimeout(),
      opts.signal,
    );
    if (mv.code !== 0) {
      return fail(
        "delivery-failed",
        `atomic mv ${partial} -> ${remote.path} failed${mv.timedOut ? " (timeout)" : ""}: ${mv.stderr.trim()}`,
      );
    }

    records.push({
      id: a.id,
      status: "verified",
      remote: a.remote,
      bytes: size,
      sha256: localHash,
    });
    opts.appendLog(
      `[delivery] ${a.id}: verified (${size} bytes, sha256 ${localHash})`,
    );
  }

  return { ok: true, records };
}

/** Render the runtime-authored `### Artifact Delivery` section. */
export function renderArtifactDeliverySection(
  result: DeliveryResult,
): string {
  const lines = ["", "### Artifact Delivery", ""];
  lines.push(`- **Delivery:** ${result.ok ? "verified" : "FAILED"}`);
  if (!result.ok && result.failureKind) {
    lines.push(`- **Failure kind:** ${result.failureKind}`);
  }
  if (!result.ok && result.error) {
    lines.push(`- **Error:** ${result.error}`);
  }
  for (const r of result.records) {
    const detail =
      r.status === "verified"
        ? `${r.bytes} bytes, sha256 ${r.sha256}`
        : r.error || r.status;
    lines.push(`- \`${r.id}\` → ${r.remote}: **${r.status}** (${detail})`);
  }
  return lines.join("\n");
}
