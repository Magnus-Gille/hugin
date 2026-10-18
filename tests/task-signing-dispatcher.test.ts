import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTaskSignature, signTask } from "../src/task-signing.js";

const KEY_ID = "Codex-desktop";
const SECRET = "c".repeat(64); // synthetic test key
const TASK_ID = "20261017-120000-a1b2";
const SUBMITTED_AT = new Date().toISOString();

function body(runtime: string): string {
  return `## Task: Dispatcher signing test

- **Runtime:** ${runtime}
- **Submitted by:** ${KEY_ID}
- **Submitted at:** ${SUBMITTED_AT}
- **Context:** scratch
- **Permission profile:** read-only
- **Capabilities:** tools

### Prompt
Run a harmless verification task.
`;
}

function signedTask(taskBody: string, signature: string): string {
  return setTaskSignature(taskBody, signature);
}

function relocationBody(field: "Context" | "Timeout" | "Permission profile"): string {
  const value = field === "Context"
    ? "scratch"
    : field === "Timeout"
      ? "1"
      : "trusted-code";
  const taskBody = `## Task: Dispatcher signing relocation test

- **Runtime:** claude
- **Submitted by:** ${KEY_ID}
- **Submitted at:** ${SUBMITTED_AT}
- **${field}:**
${value}
- **Capabilities:** tools, code
${field === "Permission profile" ? "" : "- **Permission profile:** trusted-code\n"}

### Prompt
Run a harmless verification task.
`;
  if (field === "Permission profile") {
    const placeholder = `v2:${KEY_ID}:${"f".repeat(64)}`;
    return taskBody.replace(
      "- **Permission profile:**\ntrusted-code",
      `- **Permission profile:**\n- **Signature:** ${placeholder}\ntrusted-code`,
    );
  }
  return taskBody;
}

function signatureLine(taskBody: string): string {
  const line = taskBody.match(/^- \*\*Signature:\*\* [^\r\n]+\r?\n/m)?.[0];
  if (!line) throw new Error("expected standalone signature line");
  return line;
}

function moveSignatureAfterFieldLabel(
  taskBody: string,
  field: "Context" | "Timeout",
): string {
  const line = signatureLine(taskBody);
  const withoutSignature = taskBody.replace(line, "");
  const fieldHeading = `- **${field}:**\n`;
  if (!withoutSignature.includes(fieldHeading)) throw new Error(`missing ${field} field`);
  return withoutSignature.replace(fieldHeading, `${fieldHeading}${line}`);
}

function moveSignatureToCanonicalSlot(taskBody: string): string {
  const line = signatureLine(taskBody);
  const signature = line.trim().match(/^- \*\*Signature:\*\* (\S+)$/)?.[1];
  if (!signature) throw new Error("expected signature value");
  return setTaskSignature(taskBody.replace(line, ""), signature);
}

describe("dispatcher task-signature require policy", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("rejects v1, rejects a changed v2 body, and accepts a valid v2 auto task", async () => {
    vi.resetModules();
    vi.stubEnv("HUGIN_SIGNING_POLICY", "require");
    vi.stubEnv("HUGIN_SIGNING_MAX_AGE_S", "0");
    vi.stubEnv("HUGIN_SUBMITTER_KEYS", JSON.stringify({ [KEY_ID]: SECRET }));
    vi.stubEnv("HUGIN_ALLOWED_SUBMITTERS", KEY_ID);

    const { __test__ } = await import("../src/index.js");
    const assess = __test__.assessTaskEntrySignature;

    const oldBody = body("claude");
    const oldV1 = signedTask(oldBody, `v1:${KEY_ID}:${"0".repeat(64)}`);
    const oldVerdict = assess(`tasks/${TASK_ID}`, oldV1, __test__.parseTask(oldV1), KEY_ID, false);
    expect(oldVerdict.result.status).toBe("unsupported-version");
    expect(oldVerdict.reject).toBe(true);
    expect(oldVerdict.provenance.verifiedSubmitter).toBeNull();

    const changedBody = body("claude");
    const changedSignature = signTask({
      taskId: TASK_ID,
      submitter: KEY_ID,
      submittedAt: SUBMITTED_AT,
      taskBody: changedBody,
    }, KEY_ID, SECRET);
    const changedSigned = signedTask(changedBody, changedSignature)
      .replace("Permission profile:** read-only", "Permission profile:** trusted-code");
    const changedVerdict = assess(
      `tasks/${TASK_ID}`,
      changedSigned,
      __test__.parseTask(changedSigned),
      KEY_ID,
      false,
    );
    expect(changedVerdict.result.status).toBe("invalid");
    expect(changedVerdict.reject).toBe(true);

    const autoBody = body("auto");
    const autoSignature = signTask({
      taskId: TASK_ID,
      submitter: KEY_ID,
      submittedAt: SUBMITTED_AT,
      taskBody: autoBody,
    }, KEY_ID, SECRET);
    const autoSigned = signedTask(autoBody, autoSignature);
    const parsedAuto = __test__.parseTask(autoSigned);
    expect(parsedAuto?.autoRouted).toBe(true);
    const autoVerdict = assess(
      `tasks/${TASK_ID}`,
      autoSigned,
      parsedAuto,
      KEY_ID,
      false,
    );
    expect(autoVerdict.result.status).toBe("valid");
    expect(autoVerdict.reject).toBe(false);
    expect(autoVerdict.provenance.verifiedSubmitter).toBe(KEY_ID);
  });
});

describe("dispatcher task-signature warn policy", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("continues for v1 without treating it as authenticated", async () => {
    vi.resetModules();
    vi.stubEnv("HUGIN_SIGNING_POLICY", "warn");
    vi.stubEnv("HUGIN_SIGNING_MAX_AGE_S", "0");
    vi.stubEnv("HUGIN_SUBMITTER_KEYS", JSON.stringify({ [KEY_ID]: SECRET }));
    vi.stubEnv("HUGIN_ALLOWED_SUBMITTERS", KEY_ID);

    const { __test__ } = await import("../src/index.js");
    const oldBody = body("claude");
    const oldV1 = signedTask(oldBody, `v1:${KEY_ID}:${"0".repeat(64)}`);
    const verdict = __test__.assessTaskEntrySignature(
      `tasks/${TASK_ID}`,
      oldV1,
      __test__.parseTask(oldV1),
      KEY_ID,
      false,
    );

    expect(verdict.result.status).toBe("unsupported-version");
    expect(verdict.reject).toBe(false);
    expect(verdict.provenance.verifiedSubmitter).toBeNull();
  });
});

describe("dispatcher task-signature line binding", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it.each(["Permission profile", "Context", "Timeout"] as const)(
    "rejects a CLI signature relocation that changes %s parser semantics",
    async (field) => {
      vi.resetModules();
      vi.stubEnv("HUGIN_SIGNING_POLICY", "require");
      vi.stubEnv("HUGIN_SIGNING_MAX_AGE_S", "0");
      vi.stubEnv("HUGIN_SUBMITTER_KEYS", JSON.stringify({ [KEY_ID]: SECRET }));
      vi.stubEnv("HUGIN_ALLOWED_SUBMITTERS", KEY_ID);

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hugin-sign-line-binding-"));
      try {
        const taskFile = path.join(tmp, "task.md");
        const unsignedBody = relocationBody(field);
        fs.writeFileSync(taskFile, unsignedBody);
        const { execFileSync } = await import("node:child_process");
        const signature = execFileSync("node", [
          "scripts/sign-task.mjs",
          "--task-file", taskFile,
          "--task-id", TASK_ID,
        ], {
          env: { PATH: process.env.PATH, HUGIN_SIGNING_SECRET: SECRET },
          encoding: "utf8",
        }).trim();
        const originalBody = signedTask(unsignedBody, signature);
        const { __test__ } = await import("../src/index.js");
        const originalParsed = __test__.parseTask(originalBody);
        const originalVerdict = __test__.assessTaskEntrySignature(
          `tasks/${TASK_ID}`,
          originalBody,
          originalParsed,
          KEY_ID,
          false,
        );
        expect(originalVerdict.result.status).toBe("valid");

        const relocatedBody = field === "Permission profile"
          ? moveSignatureToCanonicalSlot(originalBody)
          : moveSignatureAfterFieldLabel(originalBody, field);
        const relocatedParsed = __test__.parseTask(relocatedBody);
        if (field === "Permission profile") {
          expect(originalParsed?.permissionProfile).toBe("read-only");
          expect(relocatedParsed?.permissionProfile).toBe("trusted-code");
        } else if (field === "Context") {
          expect(relocatedParsed?.context).not.toBe(originalParsed?.context);
        } else {
          expect(relocatedParsed?.timeoutMs).not.toBe(originalParsed?.timeoutMs);
        }
        const relocatedVerdict = __test__.assessTaskEntrySignature(
          `tasks/${TASK_ID}`,
          relocatedBody,
          relocatedParsed,
          KEY_ID,
          false,
        );
        expect(relocatedVerdict.result.status).toBe("invalid");
        expect(relocatedVerdict.reject).toBe(true);

        const respelledBody = originalBody.replace(
          "- **Signature:**",
          "**Signature:**",
        );
        const respelledVerdict = __test__.assessTaskEntrySignature(
          `tasks/${TASK_ID}`,
          respelledBody,
          __test__.parseTask(respelledBody),
          KEY_ID,
          false,
        );
        expect(respelledVerdict.result.status).toBe("invalid");
        expect(respelledVerdict.reject).toBe(true);

        const recasedBody = originalBody.replace(
          "- **Signature:**",
          "- **signature:**",
        );
        const recasedVerdict = __test__.assessTaskEntrySignature(
          `tasks/${TASK_ID}`,
          recasedBody,
          __test__.parseTask(recasedBody),
          KEY_ID,
          false,
        );
        expect(recasedVerdict.result.status).toBe("invalid");
        expect(recasedVerdict.reject).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
