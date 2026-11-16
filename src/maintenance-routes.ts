/**
 * Owner-invoked maintenance-drain HTTP surface (HUGIN-417).
 *
 * Contract: docs/maintenance-drain.md. Disabled (404) unless
 * HUGIN_MAINTENANCE_TOKEN is set to a >=32 character secret. Requests must
 * come from the loopback interface and carry the bearer token. The surface only
 * opens/closes the dispatcher's admission gate; it cannot cancel, replay or
 * submit work and does not touch autonomy state.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import {
  DEFAULT_HOLD_MS,
  MAX_HOLD_MS,
  MAX_WAIT_MS,
  type MaintenanceDrain,
} from "./maintenance-drain.js";

export const MAINTENANCE_TOKEN_MIN_LENGTH = 32;
export const MAINTENANCE_BASE_PATH = "/admin/maintenance";

export interface MaintenanceRouteOptions {
  drain: MaintenanceDrain;
  /** Value of HUGIN_MAINTENANCE_TOKEN (undefined/empty => surface disabled). */
  token: string | undefined;
  getProcessInstanceId: () => string;
  isShuttingDown: () => boolean;
  /** Content-blind audit sink; defaults to console.log. */
  audit?: (line: string) => void;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return LOOPBACK.has(address ?? "");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

function intField(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number | string {
  if (!(key in body)) return fallback;
  const v = body[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    return `${key} must be an integer in [${min}, ${max}]`;
  }
  return v;
}

export function maintenanceSurfaceEnabled(token: string | undefined): boolean {
  return (
    typeof token === "string" &&
    token.length >= MAINTENANCE_TOKEN_MIN_LENGTH &&
    /^\S+$/.test(token)
  );
}

export function registerMaintenanceRoutes(app: Application, opts: MaintenanceRouteOptions): void {
  const audit = opts.audit ?? ((line: string) => console.log(line));
  const enabled = maintenanceSurfaceEnabled(opts.token);
  if (opts.token && !enabled) {
    console.warn(
      `[maintenance] HUGIN_MAINTENANCE_TOKEN must be at least ${MAINTENANCE_TOKEN_MIN_LENGTH} characters without whitespace; maintenance drain surface disabled`,
    );
  }
  const expected = opts.token ?? "";
  const router = express.Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!enabled) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (opts.isShuttingDown()) {
      res.status(503).json({ error: "shutting_down" });
      return;
    }
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "loopback_only" });
      return;
    }
    const header = req.headers.authorization ?? "";
    const match = /^Bearer (\S+)$/.exec(header);
    if (!match || !tokenMatches(match[1], expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  const withInstance = (snapshot: object) => ({
    ...snapshot,
    process_instance_id: opts.getProcessInstanceId(),
  });

  router.get("/", (_req, res) => {
    res.json(withInstance(opts.drain.snapshot()));
  });

  router.post("/drain", express.json({ limit: "1kb" }), async (req, res) => {
    const body: Record<string, unknown> =
      req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const unknown = Object.keys(body).filter((k) => k !== "timeout_ms" && k !== "hold_ms");
    if (unknown.length > 0) {
      res.status(400).json({ error: "invalid_request", detail: "unknown field(s)" });
      return;
    }
    const timeoutMs = intField(body, "timeout_ms", 0, MAX_WAIT_MS, 0);
    const holdMs = intField(body, "hold_ms", 1000, MAX_HOLD_MS, DEFAULT_HOLD_MS);
    if (typeof timeoutMs === "string" || typeof holdMs === "string") {
      res.status(400).json({ error: "invalid_request", detail: typeof timeoutMs === "string" ? timeoutMs : holdMs });
      return;
    }
    if (holdMs <= timeoutMs) {
      res.status(400).json({ error: "invalid_request", detail: "hold_ms must exceed timeout_ms" });
      return;
    }
    // Admission closes synchronously here; a client disconnect while waiting
    // does not undo it (the hold lease bounds it).
    const accepted = opts.drain.requestDrain(holdMs);
    audit(
      `[maintenance] drain requested (hold_ms=${holdMs}, timeout_ms=${timeoutMs}, work_in_flight=${accepted.work_in_flight}); reversal: POST ${MAINTENANCE_BASE_PATH}/resume or restart`,
    );
    const final = timeoutMs > 0 ? await opts.drain.waitUntilReady(timeoutMs) : accepted;
    if (opts.isShuttingDown()) {
      res.status(503).json({ error: "shutting_down" });
      return;
    }
    if (final.ready) {
      res.status(200).json(withInstance(final));
    } else {
      res.status(409).json({ ...withInstance(final), busy: true });
    }
  });

  // Malformed JSON etc. after auth: JSON error, never Express's HTML page.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(400).json({ error: "invalid_request", detail: "malformed body" });
  });

  router.post("/resume", (_req, res) => {
    const snap = opts.drain.resume();
    audit(`[maintenance] admission resumed`);
    res.json(withInstance(snap));
  });

  app.use(MAINTENANCE_BASE_PATH, router);
}
