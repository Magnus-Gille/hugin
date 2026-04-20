import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildCanonicalPayload,
  extractSignatureField,
  loadKeyStoreFromEnv,
  parseSignature,
  parseSigningPolicy,
  signTask,
  verifyTaskSignature,
  type SigningParams,
} from "../src/task-signing.js";

const SECRET_HEX = "a".repeat(64); // 32 bytes of 0xaa
const KEY_ID = "Codex-desktop";
const KEYS = { [KEY_ID]: SECRET_HEX };

function makeParams(overrides: Partial<SigningParams> = {}): SigningParams {
  return {
    taskId: "20260420-120000-a1b2",
    submitter: KEY_ID,
    submittedAt: "2026-04-20T12:00:00Z",
    runtime: "claude",
    prompt: "Do the thing.",
    ...overrides,
  };
}

describe("buildCanonicalPayload", () => {
  it("produces a stable, sorted, newline-terminated representation", () => {
    const payload = buildCanonicalPayload(makeParams());
    expect(payload.endsWith("\n")).toBe(true);
    const lines = payload.trimEnd().split("\n");
    const sorted = [...lines].sort();
    expect(lines).toEqual(sorted);
  });

  it("hashes the prompt rather than including it verbatim", () => {
    const payload = buildCanonicalPayload(makeParams({ prompt: "secret" }));
    expect(payload).not.toContain("secret");
    expect(payload).toMatch(/prompt-sha256=[0-9a-f]{64}/);
  });

  it("hashes context-refs when present and omits otherwise", () => {
    const without = buildCanonicalPayload(makeParams());
    expect(without).toContain("context-refs-sha256=\n");

    const withRefs = buildCanonicalPayload(
      makeParams({ contextRefs: ["meta/a", "meta/b"] }),
    );
    expect(withRefs).toMatch(/context-refs-sha256=[0-9a-f]{64}/);
  });

  it("is order-independent for context-refs", () => {
    const a = buildCanonicalPayload(makeParams({ contextRefs: ["meta/a", "meta/b"] }));
    const b = buildCanonicalPayload(makeParams({ contextRefs: ["meta/b", "meta/a"] }));
    expect(a).toEqual(b);
  });

  it("differs when any signed field changes", () => {
    const base = buildCanonicalPayload(makeParams());
    expect(buildCanonicalPayload(makeParams({ submitter: "hugin" }))).not.toEqual(base);
    expect(buildCanonicalPayload(makeParams({ runtime: "codex" }))).not.toEqual(base);
    expect(buildCanonicalPayload(makeParams({ prompt: "Different" }))).not.toEqual(base);
    expect(buildCanonicalPayload(makeParams({ taskId: "other" }))).not.toEqual(base);
    expect(
      buildCanonicalPayload(makeParams({ submittedAt: "2026-04-20T12:00:01Z" })),
    ).not.toEqual(base);
  });

  it("strips embedded newlines in values (defense against canonicalisation attacks)", () => {
    const payload = buildCanonicalPayload(
      makeParams({ submitter: "Codex-desktop\nsubmitter=hugin" }),
    );
    // Must not produce two submitter lines.
    const submitterLines = payload.split("\n").filter((l) => l.startsWith("submitter="));
    expect(submitterLines).toHaveLength(1);
  });
});

describe("signTask + verifyTaskSignature round-trip", () => {
  it("verifies a valid signature", () => {
    const sig = signTask(makeParams(), KEY_ID, SECRET_HEX);
    const result = verifyTaskSignature(makeParams(), sig, KEYS);
    expect(result.status).toBe("valid");
    expect(result.keyId).toBe(KEY_ID);
  });

  it("rejects a tampered prompt", () => {
    const sig = signTask(makeParams(), KEY_ID, SECRET_HEX);
    const result = verifyTaskSignature(
      makeParams({ prompt: "Do a different thing." }),
      sig,
      KEYS,
    );
    expect(result.status).toBe("invalid");
  });

  it("rejects a swapped submitter", () => {
    const sig = signTask(makeParams(), KEY_ID, SECRET_HEX);
    const result = verifyTaskSignature(
      makeParams({ submitter: "hugin" }),
      sig,
      KEYS,
    );
    expect(result.status).toBe("invalid");
  });

  it("rejects a swapped runtime (cloud → ollama escalation)", () => {
    const sig = signTask(makeParams({ runtime: "ollama" }), KEY_ID, SECRET_HEX);
    const result = verifyTaskSignature(
      makeParams({ runtime: "claude" }),
      sig,
      KEYS,
    );
    expect(result.status).toBe("invalid");
  });

  it("returns missing when no signature is provided", () => {
    const result = verifyTaskSignature(makeParams(), null, KEYS);
    expect(result.status).toBe("missing");
  });

  it("returns unknown-signer when the keyId has no key", () => {
    const sig = signTask(makeParams(), "rogue", SECRET_HEX);
    const result = verifyTaskSignature(makeParams(), sig, KEYS);
    expect(result.status).toBe("unknown-signer");
    expect(result.keyId).toBe("rogue");
  });

  it("returns malformed for garbage input", () => {
    expect(verifyTaskSignature(makeParams(), "not-a-signature", KEYS).status).toBe(
      "malformed",
    );
    expect(verifyTaskSignature(makeParams(), "v1:missing-hex", KEYS).status).toBe(
      "malformed",
    );
  });

  it("returns unsupported-version for future versions", () => {
    const result = verifyTaskSignature(makeParams(), `v9:${KEY_ID}:${"0".repeat(64)}`, KEYS);
    expect(result.status).toBe("unsupported-version");
  });

  it("accepts either hex case for the signature portion", () => {
    const sig = signTask(makeParams(), KEY_ID, SECRET_HEX);
    const [version, keyId, hex] = sig.split(":");
    const upperHex = `${version}:${keyId}:${hex.toUpperCase()}`;
    expect(verifyTaskSignature(makeParams(), upperHex, KEYS).status).toBe("valid");
  });
});

describe("extractSignatureField", () => {
  it("parses a bullet-style signature line", () => {
    const content = `## Task: x\n\n- **Signature:** v1:Codex-desktop:${"a".repeat(64)}\n\n### Prompt\nhi`;
    expect(extractSignatureField(content)).toBe(`v1:Codex-desktop:${"a".repeat(64)}`);
  });

  it("parses a bare signature line", () => {
    const content = `**Signature:** v1:k:${"b".repeat(64)}`;
    expect(extractSignatureField(content)).toBe(`v1:k:${"b".repeat(64)}`);
  });

  it("returns null when absent", () => {
    expect(extractSignatureField("no signature here")).toBeNull();
  });
});

describe("parseSignature", () => {
  it("rejects non-hex trailing segments", () => {
    expect(parseSignature("v1:k:zzzz")).toBeNull();
  });

  it("requires exactly three colon-separated parts", () => {
    expect(parseSignature("v1:k:abcd:extra")).toBeNull();
    expect(parseSignature("v1k:abcd")).toBeNull();
  });
});

describe("parseSigningPolicy", () => {
  it("accepts off|warn|require and defaults to off", () => {
    expect(parseSigningPolicy("off")).toBe("off");
    expect(parseSigningPolicy("WARN")).toBe("warn");
    expect(parseSigningPolicy("require")).toBe("require");
    expect(parseSigningPolicy("   ")).toBe("off");
    expect(parseSigningPolicy("")).toBe("off");
    expect(parseSigningPolicy("yolo")).toBe("off");
    expect(parseSigningPolicy(undefined)).toBe("off");
  });
});

describe("scripts/sign-task.mjs (cross-language drift guard)", () => {
  it("produces the same signature as the in-process signTask", async () => {
    const { execFileSync } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-sign-"));
    try {
      const promptFile = path.join(tmp, "prompt.md");
      fs.writeFileSync(promptFile, "Do the thing.");
      const stdout = execFileSync(
        "node",
        [
          "scripts/sign-task.mjs",
          "--task-id",
          "20260420-120000-a1b2",
          "--submitter",
          KEY_ID,
          "--submitted-at",
          "2026-04-20T12:00:00Z",
          "--runtime",
          "claude",
          "--prompt-file",
          promptFile,
          "--key-id",
          KEY_ID,
        ],
        {
          env: { ...process.env, HUGIN_SIGNING_SECRET: SECRET_HEX },
          encoding: "utf8",
        },
      ).trim();
      const expected = signTask(makeParams(), KEY_ID, SECRET_HEX);
      expect(stdout).toBe(expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadKeyStoreFromEnv", () => {
  it("loads an inline JSON keystore from HUGIN_SUBMITTER_KEYS", () => {
    const store = loadKeyStoreFromEnv({
      HUGIN_SUBMITTER_KEYS: JSON.stringify({ Codex: SECRET_HEX, ratatoskr: "x".repeat(64) }),
    } as NodeJS.ProcessEnv);
    expect(store.Codex).toBe(SECRET_HEX);
    expect(store.ratatoskr).toBe("x".repeat(64));
  });

  it("loads from HUGIN_SUBMITTER_KEYS_FILE taking precedence over inline", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-keys-"));
    try {
      const filePath = path.join(tmp, "keys.json");
      fs.writeFileSync(filePath, JSON.stringify({ "from-file": SECRET_HEX }));
      const store = loadKeyStoreFromEnv({
        HUGIN_SUBMITTER_KEYS_FILE: filePath,
        HUGIN_SUBMITTER_KEYS: JSON.stringify({ "from-inline": "ignored" }),
      } as NodeJS.ProcessEnv);
      expect(store["from-file"]).toBe(SECRET_HEX);
      expect(store["from-inline"]).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns an empty store for invalid JSON", () => {
    const store = loadKeyStoreFromEnv({
      HUGIN_SUBMITTER_KEYS: "{not json",
    } as NodeJS.ProcessEnv);
    expect(store).toEqual({});
  });

  it("returns an empty store when neither env var is set", () => {
    const store = loadKeyStoreFromEnv({} as NodeJS.ProcessEnv);
    expect(store).toEqual({});
  });
});
