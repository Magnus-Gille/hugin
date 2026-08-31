/**
 * Durable, bounded storage for standalone friction reports whose Munin write
 * did not complete. Each event is one file so concurrent MCP processes cannot
 * clobber one another's queue; a content-addressed filename makes retrying the
 * same event idempotent while preserving distinct event payloads.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { redactCredentialTokens } from "../exfiltration-scanner.js";
import { MAX_MUNIN_TAGS, MAX_MUNIN_TAG_CHARS } from "./munin-key.js";

export const FRICTION_OUTBOX_SCHEMA_VERSION = 1 as const;
export const DEFAULT_FRICTION_OUTBOX_MAX_ENTRIES = 256;
export const DEFAULT_FRICTION_OUTBOX_MAX_BYTES = 1_048_576;
export const DEFAULT_FRICTION_OUTBOX_REPLAY_TIMEOUT_MS = 2_000;
const MAX_CONTENT_CHARS = 64_000;
const MAX_NAMESPACE_CHARS = 200;
const MAX_KEY_CHARS = 240;
// JSON escaping can expand a schema-valid 64k-character content field to six
// bytes per UTF-16 code unit, plus bounded tags and metadata. Keep crash-temp
// recovery aligned with the accepted schema rather than stranding valid
// Unicode/control-heavy entries above an arbitrary 128 KiB reader cap.
const MAX_ENTRY_FILE_BYTES = 512 * 1024;
const OUTBOX_TEMP_PATTERN = /^\.([0-9a-f]{64}\.json)\.\d+\.[0-9a-f-]+\.tmp$/;
const OUTBOX_TEMP_CANDIDATE_PATTERN = /^\..+\.tmp$/;
const OUTBOX_CLAIM_PATTERN = /^\.([0-9a-f]{64}\.json)\.\d+\.[0-9a-f-]+\.(overflow|malformed|recovery|restore)\.claim$/;
const OUTBOX_QUARANTINE_PATTERN = /^[0-9a-f]{64}\.[0-9a-f-]+\.quarantine$/;
type ClaimReason = "overflow" | "malformed" | "recovery" | "restore";

const frictionOutboxEntrySchema = z.object({
  version: z.literal(FRICTION_OUTBOX_SCHEMA_VERSION),
  enqueuedAt: z.string().datetime(),
  namespace: z.string().min(1).max(MAX_NAMESPACE_CHARS),
  key: z.string().min(1).max(MAX_KEY_CHARS),
  content: z.string().max(MAX_CONTENT_CHARS),
  tags: z.array(z.string().max(MAX_MUNIN_TAG_CHARS)).max(MAX_MUNIN_TAGS),
  classification: z.string().min(1).max(64),
});

export type FrictionOutboxEntry = z.infer<typeof frictionOutboxEntrySchema>;

export interface FrictionOutboxWriter {
  write(
    namespace: string,
    key: string,
    content: string,
    tags?: string[],
    expectedUpdatedAt?: string,
    classification?: string,
    createIfAbsent?: boolean,
  ): Promise<unknown>;
  read?: (
    namespace: string,
    key: string,
  ) => Promise<{ content: string; tags: string[]; classification?: string } | null>;
}

export interface FrictionOutboxConfig {
  /** Directory containing mode-0600 JSON event files. */
  directory: string;
  maxEntries?: number;
  maxBytes?: number;
  replayTimeoutMs?: number;
  now?: () => Date;
  stderr?: (line: string) => void;
}

export interface FrictionOutboxStatus {
  pendingCount: number;
  pendingBytes: number;
  oldestAt: string | null;
  quarantinedCount: number;
}

export type FrictionOutboxEnqueueResult =
  | (FrictionOutboxStatus & { stored: true; duplicate: boolean })
  | (FrictionOutboxStatus & { stored: false; reason: "outbox_full" | "outbox_error" });

export interface FrictionOutboxReplayResult extends FrictionOutboxStatus {
  replayed: number;
  failed: number;
  malformed: number;
}

interface PendingFile {
  name: string;
  size: number;
  entry: FrictionOutboxEntry | null;
  kind: "event" | "orphan-temp" | "orphan-claim" | "malformed";
  quarantined?: boolean;
  completeTemp?: boolean;
  claimReason?: ClaimReason;
}

interface QuarantineBudget {
  entries: number;
  bytes: number;
}

export function defaultFrictionOutboxDirectory(): string {
  const stateHome = process.env.XDG_STATE_HOME?.trim()
    || path.join(process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir(), ".local", "state");
  return path.join(stateHome, "hugin", "friction-outbox");
}

export function createFrictionOutbox(config: FrictionOutboxConfig): FrictionOutbox {
  return new FrictionOutbox(config);
}

export class FrictionOutbox {
  private readonly directory: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly replayTimeoutMs: number;
  private readonly now: () => Date;
  private readonly stderr: (line: string) => void;
  private readonly activeAdmissions = new Map<string, number>();
  private maintenanceQueue: Promise<void> = Promise.resolve();

  constructor(config: FrictionOutboxConfig) {
    this.directory = config.directory;
    this.maxEntries = positiveBound(config.maxEntries, DEFAULT_FRICTION_OUTBOX_MAX_ENTRIES);
    this.maxBytes = positiveBound(config.maxBytes, DEFAULT_FRICTION_OUTBOX_MAX_BYTES);
    this.replayTimeoutMs = positiveBound(
      config.replayTimeoutMs,
      DEFAULT_FRICTION_OUTBOX_REPLAY_TIMEOUT_MS,
    );
    this.now = config.now ?? (() => new Date());
    this.stderr = config.stderr ?? ((line) => process.stderr.write(line));
  }

  async enqueue(entry: Omit<FrictionOutboxEntry, "version" | "enqueuedAt"> & {
    enqueuedAt?: string;
  }): Promise<FrictionOutboxEnqueueResult> {
    let reserved = false;
    let reservedFileName: string | undefined;
    try {
      const normalized = frictionOutboxEntrySchema.parse({
        ...entry,
        version: FRICTION_OUTBOX_SCHEMA_VERSION,
        enqueuedAt: entry.enqueuedAt ?? this.now().toISOString(),
      });
      const encoded = `${JSON.stringify(normalized)}\n`;
      const fileName = `${identityDigest(normalized)}.json`;
      const finalPath = path.join(this.directory, fileName);
      await this.ensureDirectory();
      // Maintenance never performs Munin I/O. It is deliberately serialized
      // only within this instance; separate processes use atomic rename/link
      // claims and may briefly overshoot the soft bound without losing an
      // event.
      await this.runMaintenance(false);
      const current = await this.listPending();
      const existingAtPath = current.find((file) => file.name === fileName);
      if (existingAtPath && pendingIdentityName(existingAtPath) !== fileName) {
        throw new Error("outbox contains an unsafe event-name collision");
      }
      const existing = existingAtPath ?? current.find((file) => pendingIdentityName(file) === fileName);
      const activeCurrent = current.filter((file) => !file.quarantined);
      const activeIdentityNames = new Set(activeCurrent.map(pendingIdentityName));
      const unmaterializedAdmissions = [...this.activeAdmissions.entries()]
        .filter(([reservedName]) => !activeIdentityNames.has(reservedName)
          && !current.some((file) => file.name === reservedName
          || (file.entry !== null && `${identityDigest(file.entry)}.json` === reservedName)));
      if (existing) {
        if (existing.kind === "event") {
          return { stored: true, duplicate: true, ...statusFromFiles(current) };
        }
        throw new Error("outbox contains an unsafe event-name collision");
      }
      const matchingTemp = current.some((file) => file.kind === "orphan-temp"
        && tempEventIdentity(file.name) === fileName);
      if (matchingTemp && await waitForStoredEvent(finalPath, normalized)) {
        return { stored: true, duplicate: true, ...statusFromFiles(await this.listPending()) };
      }
      if (
        activeIdentityNames.size + unmaterializedAdmissions.length >= this.maxEntries
        || activeCurrent.reduce((total, file) => total + file.size, 0)
          + unmaterializedAdmissions.reduce((total, [, size]) => total + size, 0)
          + Buffer.byteLength(encoded) > this.maxBytes
      ) {
        return { stored: false, reason: "outbox_full", ...statusFromFiles(current) };
      }
      this.activeAdmissions.set(fileName, Buffer.byteLength(encoded));
      reservedFileName = fileName;
      reserved = true;

      const tempPath = path.join(this.directory, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await fs.open(tempPath, "wx", 0o600);
      let duplicate = false;
      try {
        await handle.writeFile(encoded, "utf8");
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        // link() gives us an atomic create-if-absent final name without
        // allowing a concurrent process to replace an existing event.
        await fs.link(tempPath, finalPath);
      } catch (error) {
        if (isErrno(error, "EEXIST")) {
          duplicate = true;
        } else if (isErrno(error, "ENOENT") && await waitForStoredEvent(finalPath, normalized)) {
          // A sibling may have atomically recovered this exact temp path
          // between our fsync and link. The event is durable; report the
          // idempotent outcome instead of turning that race into an error.
          duplicate = true;
        } else {
          throw error;
        }
      } finally {
        await fs.unlink(tempPath).catch(() => undefined);
      }
      await this.runMaintenance(true, fileName);
      const after = await this.listPending();
      return { stored: true, duplicate, ...statusFromFiles(after) };
    } catch (error) {
      this.log(`friction-mcp: unable to spool event: ${redactFrictionDiagnostic(error)}\n`);
      return { stored: false, reason: "outbox_error", ...(await this.safeStatus()) };
    } finally {
      if (reserved && reservedFileName) this.activeAdmissions.delete(reservedFileName);
    }
  }

  async status(): Promise<FrictionOutboxStatus> {
    try {
      await this.runMaintenance(true);
    } catch (error) {
      this.log(`friction-mcp: unable to maintain outbox bounds: ${redactFrictionDiagnostic(error)}\n`);
    }
    return statusFromFiles(await this.listPending());
  }

  async replay(writer: FrictionOutboxWriter): Promise<FrictionOutboxReplayResult> {
    await this.ensureDirectory();
    // Replay deliberately performs no outbox bookkeeping while doing Munin
    // I/O. Maintenance is local-only and runs before the writer is called.
    await this.runMaintenance(true);
    return await this.replayPending(writer);
  }

  private async replayPending(writer: FrictionOutboxWriter): Promise<FrictionOutboxReplayResult> {
    const files = await this.listPending();
    let replayed = 0;
    let failed = 0;
    let malformed = 0;

    for (const file of files) {
      if (file.kind === "orphan-temp" || file.kind === "orphan-claim") {
        malformed++;
        failed++;
        this.log(
          `friction-mcp: orphan outbox ${file.kind === "orphan-claim" ? "claim" : "temp"} retained: `
          + `${outboxFileLabel(file.name)}\n`,
        );
        continue;
      }
      if (!file.entry) {
        malformed++;
        failed++;
        this.log(
          `friction-mcp: malformed outbox entry ${file.quarantined ? "quarantined" : "retained"}: `
          + `${outboxFileLabel(file.name)}\n`,
        );
        continue;
      }
      try {
        const result = await withTimeout(
          writer.write(
            file.entry.namespace,
            file.entry.key,
            file.entry.content,
            file.entry.tags,
            undefined,
            file.entry.classification,
            true,
          ),
          this.replayTimeoutMs,
        );
        if (!isCreatedResult(result)) {
          throw new Error("Munin write returned an ambiguous non-created result");
        }
        await this.removePendingFile(file.name);
        replayed++;
      } catch (error) {
        if (isAlreadyPresent(error) && writer.read) {
          try {
            const existing = await withTimeout(
              writer.read(file.entry.namespace, file.entry.key),
              this.replayTimeoutMs,
            );
            if (
              existing
              && existing.content === file.entry.content
              && sameTags(existing.tags, file.entry.tags)
              && sameClassification(existing.classification, file.entry.classification)
            ) {
              await this.removePendingFile(file.name);
              replayed++;
              continue;
            }
          } catch {
            // Keep the event for a later replay; the original diagnostic is
            // intentionally not exposed because it may contain response data.
          }
        }
        failed++;
        this.log(
          `friction-mcp: replay failed for ${file.name}: ${redactFrictionDiagnostic(error)}\n`,
        );
      }
    }

    return { replayed, failed, malformed, ...(await this.safeStatus()) };
  }

  private async removePendingFile(fileName: string): Promise<void> {
    try {
      await fs.unlink(path.join(this.directory, fileName));
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
  }

  private async runMaintenance(
    trimValidOverflow: boolean,
    protectedFileName?: string,
  ): Promise<void> {
    const previous = this.maintenanceQueue;
    const next = previous.catch(() => undefined).then(async () => {
      const quarantineBudget = await this.readQuarantineBudget();
      let files = await this.listPending();
      await this.recoverOrphanTemps(files);
      files = await this.listPending();
      await this.quarantineMalformedFiles(files, quarantineBudget);
      files = await this.listPending();
      await this.recoverOrphanClaims(files, quarantineBudget);
      files = await this.listPending();
      if (trimValidOverflow) {
        await this.trimActiveOverflow(files, protectedFileName, quarantineBudget);
      }
      files = await this.listPending();
      await this.trimQuarantineOverflow(files, quarantineBudget);
    });
    this.maintenanceQueue = next.catch(() => undefined);
    return next;
  }

  private async recoverOrphanTemps(files: PendingFile[]): Promise<void> {
    for (const file of files) {
      if (file.kind !== "orphan-temp" || !file.completeTemp || !file.entry) continue;
      const claimPath = await this.claimRootFile(
        path.join(this.directory, file.name),
        file.name,
        "recovery",
        `${identityDigest(file.entry)}.json`,
      );
      if (claimPath) {
        await this.recoverValidClaim(path.relative(this.directory, claimPath));
      }
    }
  }

  private async quarantineMalformedFiles(
    files: PendingFile[],
    quarantineBudget: QuarantineBudget,
  ): Promise<void> {
    for (const file of files) {
      if (file.quarantined || file.kind !== "malformed") continue;
      await this.quarantineMalformed(
        path.join(this.directory, file.name),
        file.name,
        file.size,
        quarantineBudget,
      );
    }
  }

  private async recoverOrphanClaims(
    files: PendingFile[],
    quarantineBudget: QuarantineBudget,
  ): Promise<void> {
    for (const file of files) {
      if (file.quarantined || file.kind !== "orphan-claim") continue;
      if (file.claimReason === "recovery" || file.claimReason === "restore") {
        await this.recoverValidClaim(file.name);
        continue;
      }
      const moved = await this.finishClaim(file.name, file.size, quarantineBudget);
      if (!moved) await this.recoverValidClaim(file.name);
    }
  }

  private async trimActiveOverflow(
    files: PendingFile[],
    protectedFileName: string | undefined,
    quarantineBudget: QuarantineBudget,
  ): Promise<void> {
    let active = files.filter((file) => !file.quarantined);
    let activeBytes = active.reduce((total, file) => total + file.size, 0);
    const candidates = active
      .filter((file) => file.kind === "event" && file.name !== protectedFileName)
      .sort((left, right) => {
        const leftAt = left.entry?.enqueuedAt ?? "";
        const rightAt = right.entry?.enqueuedAt ?? "";
        return leftAt.localeCompare(rightAt) || left.name.localeCompare(right.name);
      });
    for (const candidate of candidates) {
      if (active.length <= this.maxEntries && activeBytes <= this.maxBytes) break;
      const moved = await this.quarantineEvent(candidate, quarantineBudget);
      if (!moved) continue;
      active = active.filter((file) => file.name !== candidate.name);
      activeBytes -= candidate.size;
    }
  }

  private async trimQuarantineOverflow(
    files: PendingFile[],
    quarantineBudget: QuarantineBudget,
  ): Promise<void> {
    const candidates = files
      .filter((file) => file.quarantined && OUTBOX_QUARANTINE_PATTERN.test(path.basename(file.name)))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const candidate of candidates) {
      if (
        quarantineBudget.entries <= this.maxEntries
        && quarantineBudget.bytes <= this.maxBytes
      ) break;
      const claimPath = await this.claimQuarantineFile(candidate);
      if (!claimPath) continue;
      quarantineBudget.entries = Math.max(0, quarantineBudget.entries - 1);
      quarantineBudget.bytes = Math.max(0, quarantineBudget.bytes - candidate.size);
      await this.recoverValidClaim(path.relative(this.directory, claimPath));
    }
  }

  private async listPending(): Promise<PendingFile[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const files: PendingFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const filePath = path.join(this.directory, entry.name);
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const tempIdentity = tempEventIdentity(entry.name);
        if (tempIdentity || OUTBOX_TEMP_CANDIDATE_PATTERN.test(entry.name)) {
          let parsed: FrictionOutboxEntry | null = null;
          if (tempIdentity && stat.size <= MAX_ENTRY_FILE_BYTES) {
            try {
              parsed = frictionOutboxEntrySchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
            } catch {
              parsed = null;
            }
          }
          const completeTemp = parsed !== null && `${identityDigest(parsed)}.json` === tempIdentity;
          files.push({
            name: entry.name,
            size: stat.size,
            entry: completeTemp ? parsed : null,
            kind: "orphan-temp",
            completeTemp,
          });
          continue;
        }
        const claim = claimInfo(entry.name);
        if (claim) {
          files.push({
            name: entry.name,
            size: stat.size,
            entry: null,
            kind: "orphan-claim",
            claimReason: claim.reason,
          });
          continue;
        }
        if (!entry.name.endsWith(".json")) continue;
        const raw = await fs.readFile(filePath, "utf8");
        try {
          const parsed = frictionOutboxEntrySchema.parse(JSON.parse(raw));
          files.push({ name: entry.name, size: stat.size, entry: parsed, kind: "event" });
        } catch {
          files.push({ name: entry.name, size: stat.size, entry: null, kind: "malformed" });
        }
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
    }
    const quarantineDirectory = path.join(this.directory, "quarantine");
    try {
      const quarantined = await fs.readdir(quarantineDirectory, { withFileTypes: true });
      for (const entry of quarantined) {
        if (!entry.isFile()) continue;
        try {
          const quarantinePath = path.join(quarantineDirectory, entry.name);
          const stat = await fs.lstat(quarantinePath);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const raw = await fs.readFile(quarantinePath, "utf8");
          try {
            const parsed = frictionOutboxEntrySchema.parse(JSON.parse(raw));
            files.push({
              name: path.join("quarantine", entry.name),
              size: stat.size,
              entry: parsed,
              kind: "event",
              quarantined: true,
            });
          } catch {
            files.push({
              name: path.join("quarantine", entry.name),
              size: stat.size,
              entry: null,
              kind: "malformed",
              quarantined: true,
            });
          }
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    return files.sort((left, right) => {
      const leftAt = left.entry?.enqueuedAt ?? "";
      const rightAt = right.entry?.enqueuedAt ?? "";
      return leftAt.localeCompare(rightAt) || left.name.localeCompare(right.name);
    });
  }

  private async quarantineMalformed(
    filePath: string,
    fileName: string,
    fileSize: number,
    quarantineBudget: QuarantineBudget,
  ): Promise<string | null> {
    const claimPath = await this.claimRootFile(filePath, fileName, "malformed");
    if (!claimPath) return null;
    return await this.finishClaim(
      path.relative(this.directory, claimPath),
      fileSize,
      quarantineBudget,
    );
  }

  private async quarantineEvent(
    file: PendingFile,
    quarantineBudget: QuarantineBudget,
  ): Promise<string | null> {
    if (!file.entry || file.quarantined) return null;
    const claimPath = await this.claimRootFile(
      path.join(this.directory, file.name),
      file.name,
      "overflow",
    );
    if (!claimPath) return null;
    const quarantinePath = await this.finishClaim(
      path.relative(this.directory, claimPath),
      file.size,
      quarantineBudget,
    );
    if (!quarantinePath) {
      // A full quarantine must not strand a valid overflow claim outside the
      // replayable event namespace. Restore it atomically to its content
      // address when possible; malformed claims remain visible for diagnosis.
      await this.recoverValidClaim(path.relative(this.directory, claimPath));
    }
    return quarantinePath;
  }

  private async claimQuarantineFile(file: PendingFile): Promise<string | null> {
    const fileName = path.basename(file.name);
    const safeBase = file.entry
      ? `${identityDigest(file.entry)}.json`
      : `${createHash("sha256").update(file.name).digest("hex")}.json`;
    return await this.claimRootFile(
      path.join(this.directory, file.name),
      fileName,
      "restore",
      safeBase,
    );
  }

  private async claimRootFile(
    filePath: string,
    fileName: string,
    reason: ClaimReason,
    safeBaseOverride?: string,
  ): Promise<string | null> {
    const safeBase = safeBaseOverride ?? (/^[0-9a-f]{64}\.json$/.test(fileName)
      ? fileName
      : `${createHash("sha256").update(fileName).digest("hex")}.json`);
    const claimName = `.${safeBase}.${process.pid}.${randomUUID()}.${reason}.claim`;
    try {
      const claimPath = path.join(this.directory, claimName);
      await fs.rename(filePath, claimPath);
      return claimPath;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      this.log(
        `friction-mcp: unable to claim outbox entry ${outboxFileLabel(fileName)}: `
        + `${redactFrictionDiagnostic(error)}\n`,
      );
      return null;
    }
  }

  private async finishClaim(
    claimName: string,
    fileSize: number,
    existingBudget?: QuarantineBudget,
  ): Promise<string | null> {
    const quarantineDirectory = path.join(this.directory, "quarantine");
    try {
      const quarantineBudget = existingBudget ?? await this.readQuarantineBudget();
      if (
        quarantineBudget.entries >= this.maxEntries
        || quarantineBudget.bytes + fileSize > this.maxBytes
      ) return null;
      await fs.mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
      await fs.chmod(quarantineDirectory, 0o700);
      const targetName = `${createHash("sha256").update(claimName).digest("hex")}.${randomUUID()}.quarantine`;
      const targetPath = path.join(quarantineDirectory, targetName);
      await fs.rename(path.join(this.directory, claimName), targetPath);
      await fs.chmod(targetPath, 0o600);
      quarantineBudget.entries++;
      quarantineBudget.bytes += fileSize;
      this.log(`friction-mcp: quarantined outbox entry: ${outboxFileLabel(claimName)}\n`);
      return path.join("quarantine", targetName);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      this.log(
        `friction-mcp: unable to finish outbox quarantine ${outboxFileLabel(claimName)}: `
        + `${redactFrictionDiagnostic(error)}\n`,
      );
      return null;
    }
  }

  private async recoverValidClaim(claimName: string): Promise<boolean> {
    const claim = claimInfo(path.basename(claimName));
    if (!claim) return false;
    const claimPath = path.join(this.directory, claimName);
    let parsed: FrictionOutboxEntry;
    try {
      const raw = await fs.readFile(claimPath, "utf8");
      parsed = frictionOutboxEntrySchema.parse(JSON.parse(raw));
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        this.log(
          `friction-mcp: retained non-replayable outbox claim ${outboxFileLabel(claimName)}: `
          + `${redactFrictionDiagnostic(error)}\n`,
        );
      }
      return false;
    }
    if (`${identityDigest(parsed)}.json` !== claim.safeBase) return false;
    let durableHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      durableHandle = await fs.open(claimPath, "r");
      await durableHandle.sync();
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        this.log(
          `friction-mcp: unable to sync outbox claim ${outboxFileLabel(claimName)}: `
          + `${redactFrictionDiagnostic(error)}\n`,
        );
      }
      return false;
    } finally {
      await durableHandle?.close().catch(() => undefined);
    }
    const finalPath = path.join(this.directory, claim.safeBase);
    try {
      await fs.link(claimPath, finalPath);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        if (!isErrno(error, "ENOENT")) {
          this.log(
            `friction-mcp: unable to restore outbox claim ${outboxFileLabel(claimName)}: `
            + `${redactFrictionDiagnostic(error)}\n`,
          );
        }
        return false;
      }
      if (!(await sameStoredEvent(finalPath, parsed))) return false;
    }
    try {
      await fs.unlink(claimPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    return true;
  }

  private async readQuarantineBudget(): Promise<QuarantineBudget> {
    const quarantineDirectory = path.join(this.directory, "quarantine");
    let existing: Dirent[];
    try {
      existing = await fs.readdir(quarantineDirectory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { entries: 0, bytes: 0 };
      throw error;
    }
    await fs.chmod(quarantineDirectory, 0o700);
    const budget: QuarantineBudget = { entries: 0, bytes: 0 };
    for (const entry of existing) {
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.lstat(path.join(quarantineDirectory, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        budget.bytes += stat.size;
        budget.entries++;
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
    return budget;
  }

  private async safeStatus(): Promise<FrictionOutboxStatus> {
    try {
      return statusFromFiles(await this.listPending());
    } catch {
      return { pendingCount: 0, pendingBytes: 0, oldestAt: null, quarantinedCount: 0 };
    }
  }

  private log(line: string): void {
    try {
      this.stderr(line);
    } catch {
      // Diagnostics must never turn a non-blocking friction report into a task error.
    }
  }
}

function tempEventIdentity(fileName: string): string | null {
  return OUTBOX_TEMP_PATTERN.exec(fileName)?.[1] ?? null;
}

function pendingIdentityName(file: PendingFile): string {
  return file.entry
    ? `${identityDigest(file.entry)}.json`
    : tempEventIdentity(file.name) ?? file.name;
}

function claimInfo(fileName: string): { safeBase: string; reason: ClaimReason } | null {
  const match = OUTBOX_CLAIM_PATTERN.exec(fileName);
  if (!match) return null;
  return { safeBase: match[1]!, reason: match[2] as ClaimReason };
}

async function sameStoredEvent(
  filePath: string,
  expected: FrictionOutboxEntry,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const parsed = frictionOutboxEntrySchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
    return identityDigest(parsed) === identityDigest(expected);
  } catch {
    return false;
  }
}

async function waitForStoredEvent(
  filePath: string,
  expected: FrictionOutboxEntry,
): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await sameStoredEvent(filePath, expected)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

function identityDigest(entry: FrictionOutboxEntry): string {
  return createHash("sha256")
    .update(JSON.stringify({
      namespace: entry.namespace,
      key: entry.key,
      content: entry.content,
      tags: entry.tags,
      classification: entry.classification,
    }))
    .digest("hex");
}

function outboxFileLabel(fileName: string): string {
  return redactFrictionDiagnostic(fileName);
}

function statusFromFiles(files: PendingFile[]): FrictionOutboxStatus {
  const activeFiles = files.filter((file) => !file.quarantined);
  const validDates = activeFiles
    .map((file) => file.entry?.enqueuedAt)
    .filter((value): value is string => typeof value === "string")
    .sort();
  return {
    pendingCount: activeFiles.length,
    pendingBytes: activeFiles.reduce((total, file) => total + file.size, 0),
    oldestAt: validDates[0] ?? null,
    quarantinedCount: files.filter((file) => file.quarantined).length,
  };
}

function positiveBound(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : fallback;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isCreatedResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null || !("status" in result)) return false;
  if (result.status !== "created") return false;
  return !("ok" in result) || result.ok === true;
}

function isAlreadyPresent(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "conflictReason" in error
    && error.conflictReason === "already_exists";
}

function sameTags(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((tag, index) => tag === sortedRight[index]);
}

function sameClassification(actual: string | undefined, expected: string): boolean {
  // MuninEntry.classification is optional for legacy/default entries. The
  // outbox currently writes only internal events, so an absent classification
  // is compatible with that default but an explicit mismatch is not.
  return actual === undefined ? expected === "internal" : actual === expected;
}

export function redactFrictionDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactCredentialTokens(raw
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, (match) => `${match.split(/\s+/, 1)[0]} [redacted]`)
    .replace(/(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .trim()
  ).slice(0, 512) || "unknown error";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
