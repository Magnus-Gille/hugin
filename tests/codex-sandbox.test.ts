import { readFileSync } from "node:fs";
import type { execFile, ExecFileException } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexSandboxFrictionEvent,
  CODEX_SANDBOX_FAILURE_KIND,
  CODEX_SANDBOX_FAILURE_TAG,
  codexSandboxFailureClassification,
  probeCodexSandbox,
} from "../src/codex-sandbox.js";

type ExecCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

function fakeExec(
  implementation: (callback: ExecCallback) => void,
): typeof execFile {
  return vi.fn((
    _command: string,
    _args: string[],
    _options: unknown,
    callback: ExecCallback,
  ) => {
    implementation(callback);
    return {};
  }) as unknown as typeof execFile;
}

describe("probeCodexSandbox", () => {
  it("runs Codex's zero-token sandbox command", async () => {
    const execFileImpl = fakeExec((callback) => callback(null, "", ""));
    const result = await probeCodexSandbox({
      execFileImpl,
      now: () => new Date("2026-07-15T09:00:00.000Z"),
    });

    expect(execFileImpl).toHaveBeenCalledWith(
      "codex",
      ["sandbox", "--", "/bin/true"],
      expect.objectContaining({ timeout: 10_000, encoding: "utf8" }),
      expect.any(Function),
    );
    expect(result).toEqual({
      available: true,
      checkedAt: "2026-07-15T09:00:00.000Z",
      command: "codex sandbox -- /bin/true",
    });
  });

  it("fails closed on the real AF_NETLINK sandbox signature", async () => {
    const error = Object.assign(new Error("command failed"), {
      code: 1,
      killed: false,
      signal: null,
      cmd: "codex sandbox -- /bin/true",
    }) as ExecFileException;
    const execFileImpl = fakeExec((callback) => callback(
      error,
      "",
      "bwrap: loopback: Failed to create NETLINK_ROUTE socket: Address family not supported by protocol",
    ));

    const result = await probeCodexSandbox({ execFileImpl });

    expect(result.available).toBe(false);
    expect(result.failureKind).toBe(CODEX_SANDBOX_FAILURE_KIND);
    expect(result.reason).toContain("NETLINK_ROUTE");
  });

  it("treats an inconclusive timeout as unavailable", async () => {
    const error = Object.assign(new Error("timed out"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
      cmd: "codex sandbox -- /bin/true",
    }) as ExecFileException;
    const result = await probeCodexSandbox({
      timeoutMs: 123,
      execFileImpl: fakeExec((callback) => callback(error, "", "")),
    });

    expect(result).toMatchObject({
      available: false,
      failureKind: CODEX_SANDBOX_FAILURE_KIND,
    });
    expect(result.reason).toContain("timed out after 123ms");
  });
});

describe("Codex sandbox failure evidence", () => {
  it("classifies a trusted preflight refusal as infrastructure", () => {
    const classification = codexSandboxFailureClassification("AF_NETLINK blocked");
    expect(classification).toEqual({
      kind: CODEX_SANDBOX_FAILURE_KIND,
      tag: CODEX_SANDBOX_FAILURE_TAG,
      reason: "AF_NETLINK blocked",
    });
  });

  it("builds a blocking shared friction event with Hugin provenance", () => {
    const event = buildCodexSandboxFrictionEvent({
      taskId: "task-218",
      modelId: "gpt-5.4-codex",
      reason: "bwrap could not create NETLINK_ROUTE socket",
      recordedAt: new Date("2026-07-15T09:00:00.000Z"),
    });

    expect(event.namespace).toBe("signals/friction");
    expect(event.tags).toEqual(expect.arrayContaining([
      "friction:tool_failure",
      "friction-category:env",
      "severity:blocking",
      "model:gpt-5.4-codex",
      "task:task-218",
      "tool:codex-sandbox",
      "source:hugin-preflight",
      `failure-kind:${CODEX_SANDBOX_FAILURE_KIND}`,
    ]));
    expect(event.tags).not.toContain("source:model-self-report");
    expect(JSON.parse(event.content)).toMatchObject({
      event_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      friction_category: "environment",
      severity: "blocking",
      reporter: "hugin-preflight",
      failure_kind: CODEX_SANDBOX_FAILURE_KIND,
    });
  });
});

describe("hugin.service Codex sandbox allowance", () => {
  it("allows AF_NETLINK with a load-bearing rationale", () => {
    const unit = readFileSync(new URL("../hugin.service", import.meta.url), "utf8");
    expect(unit).toMatch(/RestrictAddressFamilies=.*\bAF_NETLINK\b/);
    expect(unit).toMatch(/bubblewrap sandbox[\s\S]*loopback/i);
  });
});
