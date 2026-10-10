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
export const CODE_HEALTH_OUTBOX_SCHEMA_VERSION = 2 as const;
export const DEFAULT_FRICTION_OUTBOX_MAX_ENTRIES = 256;
export const DEFAULT_FRICTION_OUTBOX_MAX_BYTES = 1_048_576;
export const DEFAULT_FRICTION_OUTBOX_REPLAY_TIMEOUT_MS = 2_000;
export const CODE_HEALTH_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_HEALTH_DELIVERY_TIMEOUT_MS = 2_000;
const MAX_CODE_HEALTH_RECORD_BYTES = 16 * 1024;
const MAX_CODE_HEALTH_TERMINAL_MARKERS = 256;
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

export type CodeHealthClassification = "public" | "internal" | "client-confidential" | "client-restricted";

export interface CodeHealthAppendRequest {
  action: "append";
  namespace: string;
  idempotency_key: string;
  record: Record<string, unknown>;
  classification?: CodeHealthClassification;
  expected_updated_at?: string;
}

export interface CodeHealthAppendReceipt {
  record_id: string;
  collected_at: string;
  expires_at: string;
  updated_at: string;
  classification: CodeHealthClassification;
}

export const codeHealthAppendRequestSchema = z.object({
  action: z.literal("append"),
  namespace: z.string().min(1).max(MAX_NAMESPACE_CHARS),
  idempotency_key: z.string().uuid(),
  record: z.record(z.string(), z.unknown()),
  classification: z.enum(["public", "internal", "client-confidential", "client-restricted"]).optional(),
  expected_updated_at: z.string().datetime().optional(),
}).strict();

const codeHealthOutboxEntrySchema = z.object({
  version: z.literal(CODE_HEALTH_OUTBOX_SCHEMA_VERSION),
  enqueuedAt: z.string().datetime(),
  request: codeHealthAppendRequestSchema,
}).strict();
const terminalMarkerSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["expired", "permanent_refusal"]),
  at: z.string().datetime(),
}).strict();

export type CodeHealthOutboxEntry = z.infer<typeof codeHealthOutboxEntrySchema>;
type StoredOutboxEntry = FrictionOutboxEntry | CodeHealthOutboxEntry;
const storedOutboxEntrySchema = z.union([frictionOutboxEntrySchema, codeHealthOutboxEntrySchema]);

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
  codeHealthAppend?: (request: CodeHealthAppendRequest) => Promise<unknown>;
}

export interface FrictionOutboxConfig {
  /** Directory containing mode-0600 JSON event files. */
  directory: string;
  maxEntries?: number;
  maxBytes?: number;
  replayTimeoutMs?: number;
  /** Optional test/host bound; code-health attempts are always capped at two seconds. */
  codeHealthTimeoutMs?: number;
  now?: () => Date;
  stderr?: (line: string) => void;
}

export interface FrictionOutboxStatus {
  pendingCount: number;
  pendingBytes: number;
  oldestAt: string | null;
  quarantinedCount: number;
  codeHealthExpiredCount: number;
  codeHealthPermanentRefusalCount: number;
}

export type FrictionOutboxEnqueueResult =
  | (FrictionOutboxStatus & { stored: true; duplicate: boolean })
  | (FrictionOutboxStatus & { stored: false; reason: "outbox_full" | "outbox_error" });

export type CodeHealthOutboxEnqueueResult =
  | (FrictionOutboxStatus & { stored: true; duplicate: boolean })
  | (FrictionOutboxStatus & {
      stored: false;
      reason: "outbox_full" | "outbox_error" | "invalid_request" | "expired";
    });

export type CodeHealthOneAttemptResult =
  | { kind: "response"; response: unknown }
  | { kind: "queued" }
  | { kind: "permanent_refusal" }
  | { kind: "expired" };

export interface FrictionOutboxReplayResult extends FrictionOutboxStatus {
  replayed: number;
  failed: number;
  malformed: number;
}

interface PendingFile {
  name: string;
  size: number;
  entry: StoredOutboxEntry | null;
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
  private readonly codeHealthTimeoutMs: number;
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
    this.codeHealthTimeoutMs = Math.min(
      positiveBound(config.codeHealthTimeoutMs, CODE_HEALTH_DELIVERY_TIMEOUT_MS),
      CODE_HEALTH_DELIVERY_TIMEOUT_MS,
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
          || (file.entry !== null && `${storedIdentityDigest(file.entry)}.json` === reservedName)));
      if (existing) {
        if (existing.kind === "event") {
          return { stored: true, duplicate: true, ...(await this.statusSnapshot(current)) };
        }
        throw new Error("outbox contains an unsafe event-name collision");
      }
      const matchingTemp = current.some((file) => file.kind === "orphan-temp"
        && tempEventIdentity(file.name) === fileName);
      if (matchingTemp && await waitForStoredEvent(finalPath, normalized)) {
        return { stored: true, duplicate: true, ...(await this.statusSnapshot(await this.listPending())) };
      }
      if (
        activeIdentityNames.size + unmaterializedAdmissions.length >= this.maxEntries
        || activeCurrent.reduce((total, file) => total + file.size, 0)
          + unmaterializedAdmissions.reduce((total, [, size]) => total + size, 0)
          + Buffer.byteLength(encoded) > this.maxBytes
      ) {
        return { stored: false, reason: "outbox_full", ...(await this.statusSnapshot(current)) };
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
      return { stored: true, duplicate, ...(await this.statusSnapshot(after)) };
    } catch (error) {
      this.log(`friction-mcp: unable to spool event: ${redactFrictionDiagnostic(error)}\n`);
      return { stored: false, reason: "outbox_error", ...(await this.safeStatus()) };
    } finally {
      if (reserved && reservedFileName) this.activeAdmissions.delete(reservedFileName);
    }
  }

  async enqueueCodeHealth(request: CodeHealthAppendRequest): Promise<CodeHealthOutboxEnqueueResult> {
    let reserved = false;
    let reservedFileName: string | undefined;
    try {
      const parsedRequest = codeHealthAppendRequestSchema.parse(request);
      const recordBytes = Buffer.byteLength(JSON.stringify(parsedRequest.record), "utf8");
      if (recordBytes > MAX_CODE_HEALTH_RECORD_BYTES) {
        return { stored: false, reason: "invalid_request", ...(await this.statusSnapshot(await this.listPending())) };
      }
      const observedAt = parsedRequest.record.observed_at;
      if (
        typeof observedAt !== "string"
        || !Number.isFinite(Date.parse(observedAt))
        || Date.parse(observedAt) > this.now().getTime()
      ) {
        return { stored: false, reason: "invalid_request", ...(await this.statusSnapshot(await this.listPending())) };
      }
      const normalized: CodeHealthOutboxEntry = codeHealthOutboxEntrySchema.parse({
        version: CODE_HEALTH_OUTBOX_SCHEMA_VERSION,
        enqueuedAt: this.now().toISOString(),
        request: parsedRequest,
      });
      const encoded = `${JSON.stringify(normalized)}\n`;
      if (Buffer.byteLength(encoded, "utf8") > MAX_ENTRY_FILE_BYTES) {
        return { stored: false, reason: "invalid_request", ...(await this.statusSnapshot(await this.listPending())) };
      }
      await this.ensureDirectory();
      await this.runMaintenance(false);
      if (isCodeHealthExpired(normalized, this.now())) {
        await this.recordCodeHealthTerminal(normalized, "expired");
        return { stored: false, reason: "expired", ...(await this.statusSnapshot(await this.listPending())) };
      }
      const fileName = `${storedIdentityDigest(normalized)}.json`;
      const finalPath = path.join(this.directory, fileName);
      const current = await this.listPending();
      const existingAtPath = current.find((file) => file.name === fileName);
      if (existingAtPath && pendingIdentityName(existingAtPath) !== fileName) {
        throw new Error("outbox contains an unsafe code-health event-name collision");
      }
      const existing = existingAtPath ?? current.find((file) => pendingIdentityName(file) === fileName);
      const activeCurrent = current.filter((file) => !file.quarantined);
      const activeIdentityNames = new Set(activeCurrent.map(pendingIdentityName));
      const unmaterializedAdmissions = [...this.activeAdmissions.entries()]
        .filter(([reservedName]) => !activeIdentityNames.has(reservedName)
          && !current.some((file) => file.name === reservedName
          || (file.entry !== null && `${storedIdentityDigest(file.entry)}.json` === reservedName)));
      if (existing) {
        if (existing.kind === "event") {
          return { stored: true, duplicate: true, ...(await this.statusSnapshot(current)) };
        }
        throw new Error("outbox contains an unsafe code-health event-name collision");
      }
      const matchingTemp = current.some((file) => file.kind === "orphan-temp"
        && tempEventIdentity(file.name) === fileName);
      if (matchingTemp && await waitForStoredEvent(finalPath, normalized)) {
        return { stored: true, duplicate: true, ...(await this.statusSnapshot(await this.listPending())) };
      }
      if (
        activeIdentityNames.size + unmaterializedAdmissions.length >= this.maxEntries
        || activeCurrent.reduce((total, file) => total + file.size, 0)
          + unmaterializedAdmissions.reduce((total, [, size]) => total + size, 0)
          + Buffer.byteLength(encoded) > this.maxBytes
      ) {
        return { stored: false, reason: "outbox_full", ...(await this.statusSnapshot(current)) };
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
        await fs.link(tempPath, finalPath);
      } catch (error) {
        if (isErrno(error, "EEXIST")) duplicate = true;
        else if (isErrno(error, "ENOENT") && await waitForStoredEvent(finalPath, normalized)) duplicate = true;
        else throw error;
      } finally {
        await fs.unlink(tempPath).catch(() => undefined);
      }
      await this.runMaintenance(true, fileName);
      return { stored: true, duplicate, ...(await this.statusSnapshot(await this.listPending())) };
    } catch (error) {
      void error;
      this.log("hugin: unable to spool code-health event; request was not sent\n");
      return { stored: false, reason: "outbox_error", ...(await this.statusSnapshot(await this.safeListPending())) };
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
    return await this.statusSnapshot(await this.listPending());
  }

  /** Attempt only the durably spooled request, with one bounded fixed-API call. */
  async sendCodeHealthOnce(
    request: CodeHealthAppendRequest,
    writer: Pick<FrictionOutboxWriter, "codeHealthAppend">,
  ): Promise<CodeHealthOneAttemptResult> {
    await this.ensureDirectory();
    await this.runMaintenance(true);
    const parsed = codeHealthAppendRequestSchema.safeParse(request);
    if (!parsed.success) return { kind: "queued" };
    const expectedName = `${codeHealthRequestDigest(parsed.data)}.json`;
    const pending = (await this.listPending()).find((file) =>
      file.kind === "event" && file.entry?.version === CODE_HEALTH_OUTBOX_SCHEMA_VERSION
      && pendingIdentityName(file) === expectedName,
    );
    if (!pending?.entry || pending.entry.version !== CODE_HEALTH_OUTBOX_SCHEMA_VERSION) {
      if (isCodeHealthExpiredRequest(parsed.data, this.now())) {
        await this.recordCodeHealthTerminal({ version: 2, enqueuedAt: this.now().toISOString(), request: parsed.data }, "expired");
        return { kind: "expired" };
      }
      return { kind: "queued" };
    }
    if (isCodeHealthExpired(pending.entry, this.now())) {
      await this.recordCodeHealthTerminal(pending.entry, "expired");
      return { kind: "expired" };
    }
    if (!writer.codeHealthAppend) return { kind: "queued" };
    try {
      const response = await withTimeout(
        writer.codeHealthAppend(pending.entry.request),
        this.codeHealthTimeoutMs,
      );
      if (isExplicitCodeHealthRefusal(response)) {
        await this.recordCodeHealthTerminal(pending.entry, "permanent_refusal");
        return { kind: "permanent_refusal" };
      }
      return { kind: "response", response };
    } catch (error) {
      if (isCodeHealthPermanentRefusal(error)) {
        await this.recordCodeHealthTerminal(pending.entry, "permanent_refusal");
        return { kind: "permanent_refusal" };
      }
      this.log("hugin: code-health delivery was ambiguous; exact request retained for retry\n");
      return { kind: "queued" };
    }
  }

  async acknowledgeCodeHealth(request: CodeHealthAppendRequest): Promise<boolean> {
    const parsed = codeHealthAppendRequestSchema.safeParse(request);
    if (!parsed.success) return false;
    const name = `${codeHealthRequestDigest(parsed.data)}.json`;
    const file = (await this.listPending()).find((candidate) =>
      candidate.entry?.version === CODE_HEALTH_OUTBOX_SCHEMA_VERSION
      && pendingIdentityName(candidate) === name,
    );
    if (!file) return true;
    try {
      await this.removePendingFile(file.name);
      return true;
    } catch {
      this.log("hugin: acknowledged code-health request remains queued for idempotent cleanup\n");
      return false;
    }
  }

  async refuseCodeHealth(request: CodeHealthAppendRequest): Promise<void> {
    const parsed = codeHealthAppendRequestSchema.safeParse(request);
    if (!parsed.success) return;
    const entry: CodeHealthOutboxEntry = {
      version: CODE_HEALTH_OUTBOX_SCHEMA_VERSION,
      enqueuedAt: this.now().toISOString(),
      request: parsed.data,
    };
    await this.recordCodeHealthTerminal(entry, "permanent_refusal");
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
      if (file.entry.version === CODE_HEALTH_OUTBOX_SCHEMA_VERSION) {
        if (isCodeHealthExpired(file.entry, this.now())) {
          await this.recordCodeHealthTerminal(file.entry, "expired");
          continue;
        }
        if (!writer.codeHealthAppend) {
          failed++;
          this.log("friction-mcp: code-health replay unavailable; exact request retained\n");
          continue;
        }
        try {
          const response = await withTimeout(
            writer.codeHealthAppend(file.entry.request),
            this.codeHealthTimeoutMs,
          );
          if (isExplicitCodeHealthRefusal(response)) {
            await this.recordCodeHealthTerminal(file.entry, "permanent_refusal");
            continue;
          }
          if (!validateCodeHealthAppendReceipt(file.entry.request, response)) {
            throw new Error("code-health receipt did not match request");
          }
          await this.removePendingFile(file.name);
          replayed++;
        } catch (error) {
          if (isCodeHealthPermanentRefusal(error)) {
            await this.recordCodeHealthTerminal(file.entry, "permanent_refusal");
            continue;
          }
          failed++;
          this.log("friction-mcp: code-health replay ambiguous; exact request retained\n");
        }
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
      await this.expireCodeHealthEntries(files);
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

  private async expireCodeHealthEntries(files: PendingFile[]): Promise<void> {
    for (const file of files) {
      if (file.entry?.version !== CODE_HEALTH_OUTBOX_SCHEMA_VERSION) continue;
      if (isCodeHealthExpired(file.entry, this.now())) {
        await this.recordCodeHealthTerminal(file.entry, "expired");
      }
    }
  }

  private async recordCodeHealthTerminal(
    entry: CodeHealthOutboxEntry,
    kind: "expired" | "permanent_refusal",
  ): Promise<void> {
    const terminalDirectory = path.join(this.directory, "terminal");
    const markerId = createHash("sha256")
      .update(`${kind}\0${storedIdentityDigest(entry)}`)
      .digest("hex");
    const markerPath = path.join(terminalDirectory, `${markerId}.json`);
    try {
      await fs.mkdir(terminalDirectory, { recursive: true, mode: 0o700 });
      await fs.chmod(terminalDirectory, 0o700);
      const marker = `${JSON.stringify({ version: 1, kind, at: this.now().toISOString() })}\n`;
      const tempPath = path.join(terminalDirectory, `.${markerId}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await fs.open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(marker, "utf8");
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(tempPath, markerPath);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      } finally {
        await fs.unlink(tempPath).catch(() => undefined);
      }
      await this.removeMatchingCodeHealthFile(entry);
      await this.trimCodeHealthTerminalMarkers();
    } catch {
      this.log("hugin: unable to record bounded code-health terminal outcome; request retained\n");
    }
  }

  private async removeMatchingCodeHealthFile(entry: CodeHealthOutboxEntry): Promise<void> {
    const digest = `${storedIdentityDigest(entry)}.json`;
    const pending = (await this.listPending()).find((file) =>
      file.entry?.version === CODE_HEALTH_OUTBOX_SCHEMA_VERSION && pendingIdentityName(file) === digest,
    );
    if (pending) await this.removePendingFile(pending.name);
  }

  private async trimCodeHealthTerminalMarkers(): Promise<void> {
    const terminalDirectory = path.join(this.directory, "terminal");
    let names: string[];
    try {
      names = await fs.readdir(terminalDirectory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    const markers: Array<{ name: string; size: number; at: string }> = [];
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      try {
        const filePath = path.join(terminalDirectory, name);
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const marker = terminalMarkerSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
        markers.push({ name, size: stat.size, at: marker.at });
      } catch {
        continue;
      }
    }
    let totalBytes = markers.reduce((total, marker) => total + marker.size, 0);
    const maxMarkerCount = Math.min(this.maxEntries, MAX_CODE_HEALTH_TERMINAL_MARKERS);
    markers.sort((left, right) => left.at.localeCompare(right.at) || left.name.localeCompare(right.name));
    while (markers.length > maxMarkerCount || totalBytes > this.maxBytes) {
      const oldest = markers.shift();
      if (!oldest) break;
      await fs.unlink(path.join(terminalDirectory, oldest.name)).catch(() => undefined);
      totalBytes -= oldest.size;
    }
  }

  private async codeHealthTerminalCounts(): Promise<Pick<FrictionOutboxStatus, "codeHealthExpiredCount" | "codeHealthPermanentRefusalCount">> {
    const counts = { codeHealthExpiredCount: 0, codeHealthPermanentRefusalCount: 0 };
    const terminalDirectory = path.join(this.directory, "terminal");
    let names: string[];
    try {
      names = await fs.readdir(terminalDirectory);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return counts;
      throw error;
    }
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      try {
        const filePath = path.join(terminalDirectory, name);
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const marker = terminalMarkerSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
        if (marker.kind === "expired") counts.codeHealthExpiredCount++;
        else counts.codeHealthPermanentRefusalCount++;
      } catch {
        continue;
      }
    }
    return counts;
  }

  private async statusSnapshot(files: PendingFile[]): Promise<FrictionOutboxStatus> {
    return { ...statusFromFiles(files), ...(await this.codeHealthTerminalCounts()) };
  }

  private async safeListPending(): Promise<PendingFile[]> {
    try {
      return await this.listPending();
    } catch {
      return [];
    }
  }

  private async recoverOrphanTemps(files: PendingFile[]): Promise<void> {
    for (const file of files) {
      if (file.kind !== "orphan-temp" || !file.completeTemp || !file.entry) continue;
      const claimPath = await this.claimRootFile(
        path.join(this.directory, file.name),
        file.name,
        "recovery",
        `${storedIdentityDigest(file.entry)}.json`,
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
          let parsed: StoredOutboxEntry | null = null;
          if (tempIdentity && stat.size <= MAX_ENTRY_FILE_BYTES) {
            try {
              parsed = storedOutboxEntrySchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
            } catch {
              parsed = null;
            }
          }
          const completeTemp = parsed !== null && `${storedIdentityDigest(parsed)}.json` === tempIdentity;
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
          const parsed = storedOutboxEntrySchema.parse(JSON.parse(raw));
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
            const parsed = storedOutboxEntrySchema.parse(JSON.parse(raw));
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
      ? `${storedIdentityDigest(file.entry)}.json`
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
    let parsed: StoredOutboxEntry;
    try {
      const raw = await fs.readFile(claimPath, "utf8");
      parsed = storedOutboxEntrySchema.parse(JSON.parse(raw));
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        this.log(
          `friction-mcp: retained non-replayable outbox claim ${outboxFileLabel(claimName)}: `
          + `${redactFrictionDiagnostic(error)}\n`,
        );
      }
      return false;
    }
    if (`${storedIdentityDigest(parsed)}.json` !== claim.safeBase) return false;
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
      return await this.statusSnapshot(await this.listPending());
    } catch {
      return {
        pendingCount: 0,
        pendingBytes: 0,
        oldestAt: null,
        quarantinedCount: 0,
        codeHealthExpiredCount: 0,
        codeHealthPermanentRefusalCount: 0,
      };
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
    ? `${storedIdentityDigest(file.entry)}.json`
    : tempEventIdentity(file.name) ?? file.name;
}

function claimInfo(fileName: string): { safeBase: string; reason: ClaimReason } | null {
  const match = OUTBOX_CLAIM_PATTERN.exec(fileName);
  if (!match) return null;
  return { safeBase: match[1]!, reason: match[2] as ClaimReason };
}

async function sameStoredEvent(
  filePath: string,
  expected: StoredOutboxEntry,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const parsed = storedOutboxEntrySchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
    return storedIdentityDigest(parsed) === storedIdentityDigest(expected);
  } catch {
    return false;
  }
}

async function waitForStoredEvent(
  filePath: string,
  expected: StoredOutboxEntry,
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

function storedIdentityDigest(entry: StoredOutboxEntry): string {
  return entry.version === FRICTION_OUTBOX_SCHEMA_VERSION
    ? identityDigest(entry)
    : codeHealthRequestDigest(entry.request);
}

function codeHealthRequestDigest(request: CodeHealthAppendRequest): string {
  return createHash("sha256")
    .update(stableJson({ version: CODE_HEALTH_OUTBOX_SCHEMA_VERSION, request }))
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isCodeHealthExpired(entry: CodeHealthOutboxEntry, now: Date): boolean {
  const enqueuedAt = Date.parse(entry.enqueuedAt);
  return isCodeHealthExpiredRequest(entry.request, now)
    || Number.isFinite(enqueuedAt) && now.getTime() - enqueuedAt > CODE_HEALTH_PENDING_TTL_MS;
}

function isCodeHealthExpiredRequest(request: CodeHealthAppendRequest, now: Date): boolean {
  const observedAt = request.record.observed_at;
  return typeof observedAt === "string"
    && Number.isFinite(Date.parse(observedAt))
    && now.getTime() - Date.parse(observedAt) > CODE_HEALTH_PENDING_TTL_MS;
}

const TERMINAL_CODE_HEALTH_ERRORS = new Set([
  "access_denied",
  "conflict",
  "idempotency_conflict",
  "not_found",
  "record_deleted",
  "validation_error",
]);

function isCodeHealthPermanentRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error ? error.name : undefined;
  const code = "errorCode" in error ? error.errorCode : undefined;
  return name === "MuninCodeHealthRejectedError"
    && typeof code === "string"
    && TERMINAL_CODE_HEALTH_ERRORS.has(code);
}

function isExplicitCodeHealthRefusal(response: unknown): boolean {
  if (typeof response !== "object" || response === null || !("ok" in response)) return false;
  if (response.ok !== false || !("error" in response) || typeof response.error !== "string") return false;
  return TERMINAL_CODE_HEALTH_ERRORS.has(response.error);
}

export function validateCodeHealthAppendReceipt(
  request: CodeHealthAppendRequest,
  response: unknown,
): CodeHealthAppendReceipt | null {
  if (typeof response !== "object" || response === null || Array.isArray(response)) return null;
  const value = response as Record<string, unknown>;
  const classifications: CodeHealthClassification[] = ["public", "internal", "client-confidential", "client-restricted"];
  if (
    value.ok !== true
    || value.action !== "code_health"
    || value.status !== "stored" && value.status !== "replayed" && value.status !== "corrected"
    || typeof value.id !== "string" || value.id.length === 0
    || value.record_id !== request.record.record_id
    || value.namespace !== request.namespace
    || typeof value.idempotency_key !== "string"
    || value.idempotency_key.toLowerCase() !== request.idempotency_key.toLowerCase()
    || !isCanonicalIsoTimestamp(value.collected_at)
    || !isCanonicalIsoTimestamp(value.expires_at)
    || !isCanonicalIsoTimestamp(value.updated_at)
    || typeof value.classification !== "string"
    || !classifications.includes(value.classification as CodeHealthClassification)
    || request.classification !== undefined && value.classification !== request.classification
    || value.idempotency_replayed !== undefined && typeof value.idempotency_replayed !== "boolean"
  ) return null;
  const collectedAt = Date.parse(value.collected_at as string);
  const expiresAt = Date.parse(value.expires_at as string);
  if (expiresAt <= collectedAt || expiresAt > addUtcCalendarMonths(collectedAt, 6)) return null;
  return {
    record_id: value.record_id as string,
    collected_at: value.collected_at as string,
    expires_at: value.expires_at as string,
    updated_at: value.updated_at as string,
    classification: value.classification as CodeHealthClassification,
  };
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const normalized = new Date(parsed).toISOString();
  return normalized === value || normalized.replace(/\.000Z$/, "Z") === value;
}

function addUtcCalendarMonths(timestamp: number, months: number): number {
  const source = new Date(timestamp);
  const day = source.getUTCDate();
  const target = new Date(timestamp);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
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
    codeHealthExpiredCount: 0,
    codeHealthPermanentRefusalCount: 0,
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
