import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildCanonicalPayload,
  buildTaskSubmissionProvenance,
  extractSignatureField,
  extractTaskSigningMetadata,
  inspectSignatureField,
  loadKeyStoreFromEnv,
  parseNonNegativeIntEnv,
  parseSignature,
  parseSigningPolicy,
  signTask,
  setTaskSignature,
  signingPolicyRejects,
  verifyTaskSignature,
  type SigningParams,
} from "../src/task-signing.js";

const SECRET_HEX = "a".repeat(64); // synthetic 32-byte test key
const KEY_ID = "Codex-desktop";
const KEYS = { [KEY_ID]: SECRET_HEX };
const TASK_ID = "20260420-120000-a1b2";
const SUBMITTED_AT = "2026-04-20T12:00:00Z";

function makeTaskBody(runtime = "claude"): string {
  return `## Task: Example

- **Runtime:** ${runtime}
- **Context:** repo:hugin
- **Timeout:** 60000
- **Max output tokens:** 4096
- **Submitted by:** ${KEY_ID}
- **Submitted at:** ${SUBMITTED_AT}
- **Sensitivity:** internal
- **Capabilities:** tools, code
- **Permission profile:** trusted-code
- **Context-refs:** projects/hugin/status
- **Context-budget:** 8000
- **Base branch:** main
- **Reply-to:** ratatoskr
- **Reply-format:** markdown
- **Group:** example-group
- **Sequence:** 1
- **Model:** claude-sonnet
- **Reasoning:** true
- **Fallback:** none
- **Ollama-host:** orin
- **Future task field:** future-value

- **Delivery target:** report.txt

### Prompt
Do the thing.
`;
}

function makeParams(overrides: Partial<SigningParams> = {}): SigningParams {
  return {
    taskId: TASK_ID,
    submitter: KEY_ID,
    submittedAt: SUBMITTED_AT,
    taskBody: makeTaskBody(),
    ...overrides,
  };
}

function paramsForTime(submittedAt: string): SigningParams {
  const taskBody = makeTaskBody().replace(SUBMITTED_AT, submittedAt);
  return makeParams({ submittedAt, taskBody });
}

function insertSignature(taskBody: string, signature: string): string {
  return setTaskSignature(taskBody, signature);
}

function signedBody(params = makeParams(), keyId = KEY_ID, secret = SECRET_HEX): SigningParams {
  return { ...params, taskBody: insertSignature(params.taskBody, signTask(params, keyId, secret)) };
}

describe("buildCanonicalPayload", () => {
  it("produces a stable, sorted, newline-terminated representation", () => {
    const payload = buildCanonicalPayload(makeParams());
    expect(payload.endsWith("\n")).toBe(true);
    const lines = payload.trimEnd().split("\n");
    expect(lines).toEqual([...lines].sort());
  });

  it("binds a hash of the complete task document", () => {
    const payload = buildCanonicalPayload(makeParams());
    expect(payload).toMatch(/task-body-sha256=[0-9a-f]{64}/);
    expect(payload).not.toContain("Do the thing.");
  });

  it("binds task ID, submitter, and submitted-at in addition to the document", () => {
    const base = buildCanonicalPayload(makeParams());
    expect(buildCanonicalPayload(makeParams({ taskId: "other" }))).not.toBe(base);
    expect(buildCanonicalPayload(makeParams({ submitter: "hugin" }))).not.toBe(base);
    expect(buildCanonicalPayload(makeParams({ submittedAt: "2026-04-20T12:00:01Z" }))).not.toBe(base);
  });

  it("prevents newline-smuggling from creating a second canonical field", () => {
    const payload = buildCanonicalPayload(
      makeParams({ submitter: `${KEY_ID}\nsubmitter=hugin` }),
    );
    const submitterLines = payload.split("\n").filter((line) => line.startsWith("submitter="));
    expect(submitterLines).toHaveLength(1);
    expect(submitterLines[0]).toBe(`submitter=${KEY_ID} submitter=hugin`);
    expect(payload).not.toContain("\nsubmitter=hugin\n");
  });

  it.each([
    ["runtime", "- **Runtime:** claude", "- **Runtime:** codex"],
    ["permissions", "- **Permission profile:** trusted-code", "- **Permission profile:** read-only"],
    ["context", "- **Context:** repo:hugin", "- **Context:** scratch"],
    ["context refs", "- **Context-refs:** projects/hugin/status", "- **Context-refs:** clients/private/status"],
    ["delivery manifest", "report.txt", "other.txt"],
    ["model", "- **Model:** claude-sonnet", "- **Model:** another-model"],
    ["fallback", "- **Fallback:** none", "- **Fallback:** claude"],
    ["capabilities", "- **Capabilities:** tools, code", "- **Capabilities:** tools"],
    ["sensitivity", "- **Sensitivity:** internal", "- **Sensitivity:** private"],
    ["timeout", "- **Timeout:** 60000", "- **Timeout:** 120000"],
    ["unknown future field", "- **Future task field:** future-value", "- **Future task field:** changed-value"],
    ["prompt", "Do the thing.", "Do another thing."],
  ])("invalidates a signature when %s changes", (_name, from, to) => {
    const original = signedBody();
    const altered = { ...original, taskBody: original.taskBody.replace(from, to) };
    expect(verifyTaskSignature(altered, KEYS).status).toBe("invalid");
  });

  it("preserves body whitespace while normalizing CRLF to LF", () => {
    const body = makeTaskBody();
    expect(buildCanonicalPayload(makeParams({ taskBody: body.replace(/\n/g, "\r\n") })))
      .toBe(buildCanonicalPayload(makeParams({ taskBody: body })));
    expect(buildCanonicalPayload(makeParams({ taskBody: ` ${body}` })))
      .not.toBe(buildCanonicalPayload(makeParams({ taskBody: body })));
    expect(buildCanonicalPayload(makeParams({ taskBody: `${body}\n` })))
      .not.toBe(buildCanonicalPayload(makeParams({ taskBody: body })));
  });

  it("removes one metadata signature line and only that line", () => {
    const params = makeParams();
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    expect(buildCanonicalPayload({
      ...params,
      taskBody: insertSignature(params.taskBody, signature),
    })).toBe(buildCanonicalPayload(params));
  });

  it("inserts a new signature immediately before the separating blank line", () => {
    const params = makeParams();
    const signature = `v2:${KEY_ID}:${"a".repeat(64)}`;
    expect(setTaskSignature(params.taskBody, signature)).toBe(
      params.taskBody.replace(
        "\n\n### Prompt",
        `\n- **Signature:** ${signature}\n\n### Prompt`,
      ),
    );
  });

  it("binds the signature line position and spelling", () => {
    const params = makeParams();
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    const canonicalSlot = insertSignature(params.taskBody, signature);
    const moved = canonicalSlot
      .replace(`- **Signature:** ${signature}\n`, "")
      .replace("- **Context:** repo:hugin\n", `- **Context:** repo:hugin\n- **Signature:** ${signature}\n`);
    const respelled = canonicalSlot.replace("- **Signature:**", "**Signature:**");
    const expected = buildCanonicalPayload(params);
    expect(buildCanonicalPayload({ ...params, taskBody: moved })).not.toBe(expected);
    expect(buildCanonicalPayload({ ...params, taskBody: respelled })).not.toBe(expected);
  });

  it("replaces an existing signature value in place without changing its spelling", () => {
    const original = `**signature:** v2:${KEY_ID}:${"a".repeat(64)}`;
    const taskBody = makeTaskBody().replace(
      "- **Context:** repo:hugin",
      `- **Context:** repo:hugin\n${original}`,
    );
    const replacement = `v2:${KEY_ID}:${"b".repeat(64)}`;
    const updated = setTaskSignature(taskBody, replacement);
    expect(updated.indexOf("**signature:**")).toBe(taskBody.indexOf("**signature:**"));
    expect(updated).toContain(`**signature:** ${replacement}`);
  });

  it("fails explicitly when the task has no supported section boundary", () => {
    const taskBody = "## Task: incomplete\n- **Submitted by:** Codex-desktop\n";
    expect(() => setTaskSignature(taskBody, `v2:${KEY_ID}:${"a".repeat(64)}`))
      .toThrow(/missing a ### Prompt or ### Pipeline section/);
    expect(() => buildCanonicalPayload(makeParams({ taskBody })))
      .toThrow(/missing a ### Prompt or ### Pipeline section/);
  });

  it("keeps signature-looking prompt text in the signed document", () => {
    const promptLine = `- **Signature:** v2:${KEY_ID}:${"b".repeat(64)}`;
    const params = makeParams({ taskBody: `${makeTaskBody()}${promptLine}\n` });
    expect(inspectSignatureField(params.taskBody)).toEqual({ status: "missing" });
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    const signed = { ...params, taskBody: insertSignature(params.taskBody, signature) };
    expect(verifyTaskSignature(signed, KEYS).status).toBe("valid");
    expect(verifyTaskSignature({ ...signed, taskBody: signed.taskBody.replace(promptLine, `${promptLine} altered`) }, KEYS).status)
      .toBe("invalid");
  });

  it("rejects duplicate and malformed metadata signature lines", () => {
    const params = makeParams();
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    const one = insertSignature(params.taskBody, signature);
    const duplicate = one.replace("\n\n### Prompt", `\n- **Signature:** ${signature}\n\n### Prompt`);
    for (const taskBody of [duplicate, params.taskBody.replace("\n\n### Prompt", "\n- **Signature:**\n\n### Prompt")]) {
      expect(inspectSignatureField(taskBody).status).toBe("malformed");
      expect(verifyTaskSignature({ ...params, taskBody }, KEYS).status).toBe("malformed");
      expect(() => buildCanonicalPayload({ ...params, taskBody })).toThrow(/signature/i);
    }
  });
});

describe("signTask + verifyTaskSignature round-trip", () => {
  it("verifies a valid v2 signature", () => {
    const signed = signedBody();
    const result = verifyTaskSignature(signed, KEYS);
    expect(result.status).toBe("valid");
    expect(result.keyId).toBe(KEY_ID);
  });

  it("binds the key to the claimed submitter", () => {
    const params = makeParams({
      submitter: "hugin",
      taskBody: makeTaskBody().replace(`- **Submitted by:** ${KEY_ID}`, "- **Submitted by:** hugin"),
    });
    const signature = signTask(params, "ratatoskr", "b".repeat(64));
    const signed = { ...params, taskBody: insertSignature(params.taskBody, signature) };
    const result = verifyTaskSignature(signed, { ratatoskr: "b".repeat(64), [KEY_ID]: SECRET_HEX });
    expect(result.status).toBe("submitter-mismatch");
  });

  it("rejects a swapped submitter field even when the original HMAC is retained", () => {
    const originallySigned = signedBody();
    const submitter = "hugin";
    const taskBody = originallySigned.taskBody.replace(
      `- **Submitted by:** ${KEY_ID}`,
      `- **Submitted by:** ${submitter}`,
    );
    expect(verifyTaskSignature({
      ...originallySigned,
      submitter,
      taskBody,
    }, KEYS).status).toBe("submitter-mismatch");
  });

  it("rejects a signature whose key does not match the body submitter", () => {
    const claimedSubmitter = "hugin";
    const taskBody = makeTaskBody().replace(
      `- **Submitted by:** ${KEY_ID}`,
      `- **Submitted by:** ${claimedSubmitter}`,
    );
    const params = makeParams({ submitter: claimedSubmitter, taskBody });
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    const signed = { ...params, taskBody: insertSignature(taskBody, signature) };
    expect(verifyTaskSignature(signed, KEYS).status).toBe("submitter-mismatch");
  });

  it("blocks cross-submitter spoofing even when the other submitter made a valid HMAC", () => {
    const ratatoskrSecret = "b".repeat(64);
    const params = makeParams(); // body claims Codex-desktop
    const signature = signTask(params, "ratatoskr", ratatoskrSecret);
    const signed = { ...params, taskBody: insertSignature(params.taskBody, signature) };
    const result = verifyTaskSignature(signed, { ...KEYS, ratatoskr: ratatoskrSecret });
    expect(result.status).toBe("submitter-mismatch");
    expect(result.keyId).toBe("ratatoskr");
  });

  it("accepts rotation aliases of the form <submitter>-<rotation>", () => {
    const rotationKeyId = `${KEY_ID}-2026q2`;
    const params = makeParams();
    const signature = signTask(params, rotationKeyId, SECRET_HEX);
    const signed = { ...params, taskBody: insertSignature(params.taskBody, signature) };
    expect(verifyTaskSignature(signed, { [rotationKeyId]: SECRET_HEX })).toMatchObject({
      status: "valid",
      keyId: rotationKeyId,
    });
  });

  it("returns missing and unknown-signer statuses", () => {
    expect(verifyTaskSignature(makeParams(), KEYS).status).toBe("missing");
    const params = makeParams();
    const signature = signTask(params, "rogue", SECRET_HEX);
    expect(verifyTaskSignature({ ...params, taskBody: insertSignature(params.taskBody, signature) }, KEYS).status)
      .toBe("unknown-signer");
  });

  it("returns unknown-signer for a valid signature with no configured key", () => {
    const params = makeParams();
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    const signed = { ...params, taskBody: insertSignature(params.taskBody, signature) };
    expect(verifyTaskSignature(signed, {}).status).toBe("unknown-signer");
  });

  it("returns malformed for a malformed standalone signature line", () => {
    const params = makeParams();
    const taskBody = params.taskBody.replace(
      "\n\n### Prompt",
      "\n- **Signature:** not-a-signature\n\n### Prompt",
    );
    expect(verifyTaskSignature({ ...params, taskBody }, KEYS).status).toBe("malformed");
  });

  it("rejects a hexadecimal signature with the wrong digest length", () => {
    const signed = signedBody();
    const taskBody = signed.taskBody.replace(
      /([0-9a-f]{63})[0-9a-f](?=\n\n### Prompt)/,
      "$1",
    );
    expect(verifyTaskSignature({ ...signed, taskBody }, KEYS)).toMatchObject({
      status: "invalid",
      reason: "signature length mismatch",
    });
  });

  it("returns unsupported-version for a future signature version", () => {
    const params = makeParams();
    const future = insertSignature(params.taskBody, `v9:${KEY_ID}:${"0".repeat(64)}`);
    expect(verifyTaskSignature({ ...params, taskBody: future }, KEYS).status)
      .toBe("unsupported-version");
  });

  it("accepts a valid lowercase hexadecimal signature", () => {
    expect(verifyTaskSignature(signedBody(), KEYS).status).toBe("valid");
  });

  it("accepts a valid uppercase hexadecimal signature", () => {
    const signed = signedBody();
    const taskBody = signed.taskBody.replace(
      /([0-9a-f]{64})(?=\n\n### Prompt)/,
      (hex) => hex.toUpperCase(),
    );
    expect(verifyTaskSignature({ ...signed, taskBody }, KEYS).status).toBe("valid");
  });

  it("rejects a tampered prompt", () => {
    const signed = signedBody();
    const taskBody = signed.taskBody.replace("Do the thing.", "Do a different thing.");
    expect(verifyTaskSignature({ ...signed, taskBody }, KEYS).status).toBe("invalid");
  });

  it("rejects a tampered runtime that could escalate execution", () => {
    const signed = signedBody();
    const taskBody = signed.taskBody.replace(
      "- **Runtime:** claude",
      "- **Runtime:** ollama",
    );
    expect(verifyTaskSignature({ ...signed, taskBody }, KEYS).status).toBe("invalid");
  });

  it("does not accept v1 as authenticated identity", () => {
    const params = makeParams();
    const v1 = `v1:${KEY_ID}:${"0".repeat(64)}`;
    expect(verifyTaskSignature({ ...params, taskBody: insertSignature(params.taskBody, v1) }, KEYS).status)
      .toBe("unsupported-version");
    expect(signingPolicyRejects("require", "unsupported-version")).toBe(true);
  });

  it("checks freshness after authenticating the full document", () => {
    const fresh = new Date(Date.now() - 10_000).toISOString();
    const stale = new Date(Date.now() - 600_000).toISOString();
    const withTime = (submittedAt: string) => {
      const taskBody = makeTaskBody().replace(SUBMITTED_AT, submittedAt);
      return makeParams({ submittedAt, taskBody });
    };
    const freshParams = withTime(fresh);
    const freshSig = signTask(freshParams, KEY_ID, SECRET_HEX);
    expect(verifyTaskSignature({ ...freshParams, taskBody: insertSignature(freshParams.taskBody, freshSig) }, KEYS, { maxAgeS: 300 }).status)
      .toBe("valid");
    const staleParams = withTime(stale);
    const staleSig = signTask(staleParams, KEY_ID, SECRET_HEX);
    expect(verifyTaskSignature({ ...staleParams, taskBody: insertSignature(staleParams.taskBody, staleSig) }, KEYS, { maxAgeS: 300 }).status)
      .toBe("expired");
  });

  it("rejects a future timestamp outside the clock-skew tolerance", () => {
    const submittedAt = new Date(Date.now() + 120_000).toISOString();
    const params = makeParams({
      submittedAt,
      taskBody: makeTaskBody().replace(SUBMITTED_AT, submittedAt),
    });
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    expect(verifyTaskSignature({ ...params, taskBody: insertSignature(params.taskBody, signature) }, KEYS, {
      maxAgeS: 300,
      futureToleranceS: 60,
    }).status).toBe("future-skew");
  });
});

describe("task metadata and signature extraction", () => {
  it("derives submitter and timestamp from the metadata prefix", () => {
    expect(extractTaskSigningMetadata(makeTaskBody())).toEqual({
      submitter: KEY_ID,
      submittedAt: SUBMITTED_AT,
    });
  });

  it("extracts one standalone metadata signature line", () => {
    const raw = `v2:${KEY_ID}:${"a".repeat(64)}`;
    const body = insertSignature(makeTaskBody(), raw);
    expect(inspectSignatureField(body)).toEqual({ status: "valid", raw });
    expect(extractSignatureField(body)).toBe(raw);
    expect(inspectSignatureField(`### Prompt\n- **Signature:** ${raw}`).status).toBe("missing");
  });

  it("extracts a bare metadata signature line", () => {
    const raw = `v2:${KEY_ID}:${"a".repeat(64)}`;
    expect(extractSignatureField(`**Signature:** ${raw}\n\n### Prompt\nhello`)).toBe(raw);
  });

  it("returns null when the metadata signature is absent", () => {
    expect(extractSignatureField(makeTaskBody())).toBeNull();
  });

  it("treats malformed standalone lines and duplicates as malformed", () => {
    const body = makeTaskBody();
    const malformed = body.replace("\n\n### Prompt", "\n- **Signature:** v2:not-valid\n\n### Prompt");
    expect(inspectSignatureField(malformed).status).toBe("malformed");
    const first = insertSignature(body, `v2:${KEY_ID}:${"a".repeat(64)}`);
    const duplicate = first.replace(
      "\n\n### Prompt",
      `\n- **Signature:** v2:${KEY_ID}:${"b".repeat(64)}\n\n### Prompt`,
    );
    expect(inspectSignatureField(duplicate).status)
      .toBe("malformed");
  });
});

describe("parseSignature and signing policy", () => {
  it("rejects non-hex signature digests", () => {
    expect(parseSignature("v2:k:zzzz")).toBeNull();
  });

  it("requires exactly three colon-separated signature parts", () => {
    expect(parseSignature("v2:k:abcd:extra")).toBeNull();
    expect(parseSignature("v2k:abcd")).toBeNull();
  });

  it("preserves a future version for unsupported-version detection", () => {
    expect(parseSignature(`v1:${KEY_ID}:${"0".repeat(64)}`)?.version).toBe("v1");
  });

  it("accepts off|warn|require and throws on typos", () => {
    expect(parseSigningPolicy("off")).toBe("off");
    expect(parseSigningPolicy("WARN")).toBe("warn");
    expect(parseSigningPolicy("require")).toBe("require");
    expect(parseSigningPolicy(undefined)).toBe("off");
    expect(() => parseSigningPolicy("requrie")).toThrow(/invalid HUGIN_SIGNING_POLICY/);
  });
});

describe("structured task submission provenance", () => {
  it("records off as explicitly unverified and only marks verified identity for valid", () => {
    expect(buildTaskSubmissionProvenance("codex-cli", "off", {
      status: "unverified",
      keyId: "codex-cli",
    })).toEqual({
      claimedSubmitter: "codex-cli",
      verifiedSubmitter: null,
      policy: "off",
      signatureStatus: "unverified",
      keyId: "codex-cli",
    });
    expect(buildTaskSubmissionProvenance("codex-cli", "require", {
      status: "valid",
      keyId: "codex-cli",
    }).verifiedSubmitter).toBe("codex-cli");
  });

  it.each(["missing", "invalid", "expired", "future-skew", "submitter-mismatch", "unsupported-version"] as const)(
    "require rejects %s and never authenticates it",
    (status) => {
      expect(signingPolicyRejects("require", status)).toBe(true);
      expect(signingPolicyRejects("warn", status)).toBe(false);
      expect(signingPolicyRejects("off", status)).toBe(false);
      expect(buildTaskSubmissionProvenance("codex-cli", "require", { status }).verifiedSubmitter).toBeNull();
    },
  );

  it("sets verified submitter only for a valid signature", () => {
    expect(
      buildTaskSubmissionProvenance("codex-cli", "require", {
        status: "valid",
        keyId: "codex-cli",
      }),
    ).toEqual({
      claimedSubmitter: "codex-cli",
      verifiedSubmitter: "codex-cli",
      policy: "require",
      signatureStatus: "valid",
      keyId: "codex-cli",
    });
  });

  it.each([
    "missing",
    "invalid",
    "expired",
    "future-skew",
    "submitter-mismatch",
    "unverifiable",
  ] as const)("require rejects %s", (status) => {
    expect(signingPolicyRejects("require", status)).toBe(true);
    expect(signingPolicyRejects("warn", status)).toBe(false);
    expect(signingPolicyRejects("off", status)).toBe(false);
  });

  it("require accepts only valid signatures, including for the hugin submitter", () => {
    expect(signingPolicyRejects("require", "valid")).toBe(false);
    expect(signingPolicyRejects("require", "internal-exempt")).toBe(true);
  });
});

describe("scripts/sign-task.mjs (cross-language drift guard)", () => {
  it("produces the same v2 signature from a complete task file", async () => {
    const { execFileSync } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-sign-"));
    try {
      const taskFile = path.join(tmp, "task.md");
      fs.writeFileSync(taskFile, makeTaskBody().replace(/\n/g, "\r\n"));
      const stdout = execFileSync("node", [
        "scripts/sign-task.mjs",
        "--task-file", taskFile,
        "--task-id", TASK_ID,
      ], {
        env: { PATH: process.env.PATH, HUGIN_SIGNING_SECRET: SECRET_HEX },
        encoding: "utf8",
      }).trim();
      expect(stdout).toBe(signTask(makeParams(), KEY_ID, SECRET_HEX));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("matches canonicalization when a complete file already has its metadata signature", async () => {
    const { execFileSync } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-sign-existing-field-"));
    try {
      const taskFile = path.join(tmp, "task.md");
      const params = makeParams();
      const withExistingSignature = insertSignature(
        params.taskBody,
        `v2:${KEY_ID}:${"f".repeat(64)}`,
      ).replace(/\n/g, "\r\n");
      fs.writeFileSync(taskFile, withExistingSignature);
      const stdout = execFileSync("node", [
        "scripts/sign-task.mjs",
        "--task-file", taskFile,
        "--task-id", TASK_ID,
      ], {
        env: { PATH: process.env.PATH, HUGIN_SIGNING_SECRET: SECRET_HEX },
        encoding: "utf8",
      }).trim();
      expect(stdout).toBe(signTask({ ...params, taskBody: withExistingSignature }, KEY_ID, SECRET_HEX));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("mirrors position-preserving canonicalization for an existing signature line", async () => {
    const { execFileSync } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-sign-position-") );
    try {
      const taskFile = path.join(tmp, "task.md");
      const params = makeParams();
      const atCanonicalSlot = insertSignature(
        params.taskBody,
        `v2:${KEY_ID}:${"f".repeat(64)}`,
      );
      const moved = atCanonicalSlot
        .replace(`- **Signature:** v2:${KEY_ID}:${"f".repeat(64)}\n`, "")
        .replace("- **Context:** repo:hugin\n", `- **Context:** repo:hugin\n**signature:** v2:${KEY_ID}:${"f".repeat(64)}\n`);
      fs.writeFileSync(taskFile, moved.replace(/\n/g, "\r\n"));
      const stdout = execFileSync("node", [
        "scripts/sign-task.mjs",
        "--task-file", taskFile,
        "--task-id", TASK_ID,
      ], {
        env: { PATH: process.env.PATH, HUGIN_SIGNING_SECRET: SECRET_HEX },
        encoding: "utf8",
      }).trim();
      expect(stdout).toBe(signTask({ ...params, taskBody: moved }, KEY_ID, SECRET_HEX));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("requires task-file and task-id before checking for a signing secret", async () => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("node", [
      "scripts/sign-task.mjs",
      "--submitter", KEY_ID,
      "--submitted-at", SUBMITTED_AT,
      "--runtime", "claude",
      "--prompt-file", "/nonexistent/prompt.md",
    ], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing --task-file");
    expect(result.stderr).not.toContain("HUGIN_SIGNING_SECRET");
  });

  it("does not invent a submitted-at value for an incomplete signed task", async () => {
    const { spawnSync } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-sign-missing-time-"));
    try {
      const taskFile = path.join(tmp, "task.md");
      fs.writeFileSync(taskFile, makeTaskBody().replace(`- **Submitted at:** ${SUBMITTED_AT}\n`, ""));
      const result = spawnSync("node", [
        "scripts/sign-task.mjs",
        "--task-file", taskFile,
        "--task-id", TASK_ID,
      ], {
        env: { PATH: process.env.PATH, HUGIN_SIGNING_SECRET: SECRET_HEX },
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("missing Submitted at metadata");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails explicitly when the task has no Prompt or Pipeline section", async () => {
    const { spawnSync } = await import("node:child_process");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-sign-no-section-"));
    try {
      const taskFile = path.join(tmp, "task.md");
      fs.writeFileSync(taskFile, `## Task: Incomplete\n- **Submitted by:** ${KEY_ID}\n- **Submitted at:** ${SUBMITTED_AT}\n`);
      const result = spawnSync("node", [
        "scripts/sign-task.mjs",
        "--task-file", taskFile,
        "--task-id", TASK_ID,
      ], {
        env: { PATH: process.env.PATH, HUGIN_SIGNING_SECRET: SECRET_HEX },
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("missing a ### Prompt or ### Pipeline section");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("verifyTaskSignature replay-window", () => {
  function isoAt(offsetSeconds: number): string {
    return new Date(Date.now() + offsetSeconds * 1000).toISOString();
  }

  it("expires a signature older than the configured maximum age", () => {
    const params = paramsForTime(isoAt(-600));
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    const signed = { ...params, taskBody: insertSignature(params.taskBody, signature) };
    expect(verifyTaskSignature(signed, KEYS, { maxAgeS: 300 })).toMatchObject({
      status: "expired",
      keyId: KEY_ID,
    });
  });

  it("disables the stale check when maxAgeS is zero", () => {
    const params = paramsForTime(isoAt(-600));
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    const signed = { ...params, taskBody: insertSignature(params.taskBody, signature) };
    expect(verifyTaskSignature(signed, KEYS, { maxAgeS: 0 }).status).toBe("valid");
  });

  it("accepts a fresh signature within the configured maximum age", () => {
    const params = paramsForTime(isoAt(-10));
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    const signed = { ...params, taskBody: insertSignature(params.taskBody, signature) };
    expect(verifyTaskSignature(signed, KEYS, { maxAgeS: 300 }).status).toBe("valid");
  });

  it("rejects a timestamp beyond the future tolerance", () => {
    const params = paramsForTime(isoAt(120));
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    const signed = { ...params, taskBody: insertSignature(params.taskBody, signature) };
    expect(verifyTaskSignature(signed, KEYS, {
      maxAgeS: 300,
      futureToleranceS: 60,
    })).toMatchObject({ status: "future-skew", keyId: KEY_ID });
  });

  it("accepts signatures within future tolerance", () => {
    const submittedAt = new Date(Date.now() + 30_000).toISOString();
    const params = makeParams({ submittedAt, taskBody: makeTaskBody().replace(SUBMITTED_AT, submittedAt) });
    const signature = signTask(params, KEY_ID, SECRET_HEX);
    expect(verifyTaskSignature({ ...params, taskBody: insertSignature(params.taskBody, signature) }, KEYS, {
      maxAgeS: 300,
      futureToleranceS: 60,
    }).status).toBe("valid");
  });

  it("accepts a timestamp exactly at the future-tolerance boundary", () => {
    const now = new Date("2026-04-20T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const params = paramsForTime(new Date(now.getTime() + 60_000).toISOString());
      const signature = signTask(params, KEY_ID, SECRET_HEX);
      const signed = { ...params, taskBody: insertSignature(params.taskBody, signature) };
      expect(verifyTaskSignature(signed, KEYS, {
        maxAgeS: 300,
        futureToleranceS: 60,
      }).status).toBe("valid");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadKeyStoreFromEnv", () => {
  it("loads an inline JSON keystore", () => {
    const store = loadKeyStoreFromEnv({
      HUGIN_SUBMITTER_KEYS: JSON.stringify({
        [KEY_ID]: SECRET_HEX,
        ratatoskr: "b".repeat(64),
      }),
    } as NodeJS.ProcessEnv);
    expect(store[KEY_ID]).toBe(SECRET_HEX);
    expect(store.ratatoskr).toBe("b".repeat(64));
  });

  it("gives the key file precedence over inline JSON", () => {
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
    expect(loadKeyStoreFromEnv({ HUGIN_SUBMITTER_KEYS: "{not json" } as NodeJS.ProcessEnv)).toEqual({});
  });

  it("returns an empty store when neither source is configured", () => {
    expect(loadKeyStoreFromEnv({} as NodeJS.ProcessEnv)).toEqual({});
  });
});

describe("parseNonNegativeIntEnv", () => {
  it("returns the fallback when the value is undefined", () => {
    expect(parseNonNegativeIntEnv(undefined, 900)).toBe(900);
  });

  it("accepts zero", () => {
    expect(parseNonNegativeIntEnv("0", 900)).toBe(0);
  });

  it("accepts 900", () => {
    expect(parseNonNegativeIntEnv("900", 300)).toBe(900);
  });

  it("returns the fallback for a negative value", () => {
    expect(parseNonNegativeIntEnv("-1", 900)).toBe(900);
  });

  it("rejects partial numeric input", () => {
    expect(parseNonNegativeIntEnv("30s", 900)).toBe(900);
  });

  it("returns the fallback for an empty value", () => {
    expect(parseNonNegativeIntEnv("", 900)).toBe(900);
  });
});
