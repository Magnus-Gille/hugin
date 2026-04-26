/**
 * Bearer-token authentication for the broker.
 *
 * Keys are loaded from `HUGIN_BROKER_KEYS` (inline JSON) or
 * `HUGIN_BROKER_KEYS_FILE` (path to a JSON file). The shape is
 *   { "<principal>": "<token>" }
 * where principal is a stable identity string (e.g. "claude-code-mcp") and
 * token is a 64-char hex secret.
 *
 * Tokens are compared in constant time. Unknown tokens, malformed
 * Authorization headers, and disabled brokers all return 401.
 */

import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export type BrokerKeyStore = Record<string, string>;

export function loadBrokerKeysFromEnv(env: NodeJS.ProcessEnv): BrokerKeyStore {
  const filePath = env.HUGIN_BROKER_KEYS_FILE?.trim();
  const inline = env.HUGIN_BROKER_KEYS?.trim();

  let raw: string | undefined;
  if (filePath) {
    raw = readFileSync(filePath, "utf-8");
  } else if (inline) {
    raw = inline;
  }
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse broker keys: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Broker keys must be a JSON object of { principal: token }");
  }

  const store: BrokerKeyStore = {};
  for (const [principal, token] of Object.entries(parsed)) {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(
        `Broker key for principal "${principal}" must be a non-empty string`,
      );
    }
    store[principal] = token;
  }
  return store;
}

/**
 * Look up the principal for a presented bearer token in constant time.
 * Returns null when no key matches.
 */
export function principalForToken(
  store: BrokerKeyStore,
  token: string,
): string | null {
  const presented = Buffer.from(token, "utf-8");
  let match: string | null = null;
  for (const [principal, secret] of Object.entries(store)) {
    const expected = Buffer.from(secret, "utf-8");
    if (
      expected.length === presented.length &&
      timingSafeEqual(expected, presented)
    ) {
      match = principal;
    }
  }
  return match;
}

export interface AuthenticatedRequest extends Request {
  brokerPrincipal?: string;
}

export function brokerAuthMiddleware(store: BrokerKeyStore) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? req.header("Authorization");
    if (!header) {
      res.status(401).json({ error: "missing_authorization" });
      return;
    }
    const match = /^Bearer\s+(.+)$/.exec(header.trim());
    if (!match) {
      res.status(401).json({ error: "malformed_authorization" });
      return;
    }
    const principal = principalForToken(store, match[1]!.trim());
    if (!principal) {
      res.status(401).json({ error: "unknown_token" });
      return;
    }
    req.brokerPrincipal = principal;
    next();
  };
}
