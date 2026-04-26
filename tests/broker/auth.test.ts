import { describe, expect, it } from "vitest";
import {
  brokerAuthMiddleware,
  loadBrokerKeysFromEnv,
  principalForToken,
  type AuthenticatedRequest,
} from "../../src/broker/auth.js";
import type { Response } from "express";

const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);

describe("loadBrokerKeysFromEnv", () => {
  it("returns empty store when neither env var is set", () => {
    expect(loadBrokerKeysFromEnv({})).toEqual({});
  });

  it("parses inline JSON", () => {
    const store = loadBrokerKeysFromEnv({
      HUGIN_BROKER_KEYS: JSON.stringify({ "claude-code": SECRET_A }),
    });
    expect(store).toEqual({ "claude-code": SECRET_A });
  });

  it("rejects non-object JSON", () => {
    expect(() =>
      loadBrokerKeysFromEnv({ HUGIN_BROKER_KEYS: JSON.stringify(["a", "b"]) }),
    ).toThrow(/object/);
  });

  it("rejects non-string token values", () => {
    expect(() =>
      loadBrokerKeysFromEnv({
        HUGIN_BROKER_KEYS: JSON.stringify({ p: 42 as unknown as string }),
      }),
    ).toThrow(/non-empty string/);
  });

  it("rejects malformed JSON", () => {
    expect(() =>
      loadBrokerKeysFromEnv({ HUGIN_BROKER_KEYS: "{not-json" }),
    ).toThrow(/Failed to parse/);
  });
});

describe("principalForToken", () => {
  const store = { alpha: SECRET_A, beta: SECRET_B };

  it("matches the correct principal", () => {
    expect(principalForToken(store, SECRET_A)).toBe("alpha");
    expect(principalForToken(store, SECRET_B)).toBe("beta");
  });

  it("returns null for unknown tokens", () => {
    expect(principalForToken(store, "c".repeat(64))).toBeNull();
  });

  it("returns null for tokens of mismatched length", () => {
    expect(principalForToken(store, "short")).toBeNull();
  });
});

interface MockResponse {
  statusCode: number | null;
  body: unknown;
  status: (code: number) => MockResponse;
  json: (b: unknown) => MockResponse;
}

function mockRes(): MockResponse {
  const res: MockResponse = {
    statusCode: null,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
  };
  return res;
}

function mockReq(headers: Record<string, string> = {}): AuthenticatedRequest {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as AuthenticatedRequest;
}

describe("brokerAuthMiddleware", () => {
  const store = { "claude-code": SECRET_A };
  const middleware = brokerAuthMiddleware(store);

  it("rejects missing authorization", () => {
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "missing_authorization" });
    expect(nextCalled).toBe(false);
  });

  it("rejects malformed header", () => {
    const req = mockReq({ authorization: "BasicAuth abc" });
    const res = mockRes();
    middleware(req, res as unknown as Response, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "malformed_authorization" });
  });

  it("rejects unknown token", () => {
    const req = mockReq({ authorization: `Bearer ${"c".repeat(64)}` });
    const res = mockRes();
    middleware(req, res as unknown as Response, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "unknown_token" });
  });

  it("populates principal and calls next on valid token", () => {
    const req = mockReq({ authorization: `Bearer ${SECRET_A}` });
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res as unknown as Response, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(req.brokerPrincipal).toBe("claude-code");
    expect(res.statusCode).toBeNull();
  });
});
