import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildHuginTaskIdentity,
  HUGIN_TASK_IDENTITY_SCHEMA_VERSION,
  RENDERED_PROMPT_FINGERPRINT_VERSION,
  TASK_EXPOSURE_FINGERPRINT_VERSION,
} from "../src/task-identity.js";
import {
  buildHomeserverRequestBody,
  renderHomeserverUserMessage,
  type HomeserverTaskConfig,
} from "../src/homeserver-executor.js";
import { taskTextFingerprint } from "../src/learning/m5-task-exposure.js";

interface FixtureCase {
  name: string;
  taskId: string;
  rawTaskText: string;
  canonicalRawUtf8Hex: string;
  canonicalRawUtf8Bytes: number;
  expectedRawSha256: string;
  injectedContext?: string;
  renderedWithoutContext?: string;
  renderedWithoutContextUtf8Bytes?: number;
  renderedWithoutContextSha256?: string;
  currentGilleLegacyWithoutContextSha256?: string;
  renderedWithContext?: string;
  renderedWithContextUtf8Bytes?: number;
  renderedWithContextSha256?: string;
  currentGilleLegacyWithContextSha256?: string;
  expectedRawLookupRequest?: {
    fingerprint_version: string;
    fingerprints: string[];
  };
}

interface Fixture {
  schemaVersion: number;
  producer: string;
  normativeRawVectorSource: string;
  rawFingerprintVersion: string;
  renderedFingerprintVersion: string;
  cases: FixtureCase[];
}

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/hugin-gille-task-identity-v1.json", import.meta.url),
  "utf8",
)) as Fixture;

function taskConfig(overrides: Partial<HomeserverTaskConfig> = {}): HomeserverTaskConfig {
  return {
    prompt: "fixture",
    gatewayBaseUrl: "https://m5.test",
    apiKey: "owner-key",
    path: "delegate",
    taskType: "summarize",
    timeoutMs: 30_000,
    maxOutputChars: 4_096,
    ...overrides,
  };
}

describe("canonical Hugin task identity", () => {
  it("recomputes the shared exact UTF-8 vectors without Unicode normalization", () => {
    expect(fixture.schemaVersion).toBe(HUGIN_TASK_IDENTITY_SCHEMA_VERSION);
    expect(fixture.producer).toBe("hugin");
    expect(fixture.normativeRawVectorSource).toBe(
      "grimnir/tests/fixtures/learning-task-contract/raw-fingerprint-vectors.json",
    );
    expect(fixture.rawFingerprintVersion).toBe(TASK_EXPOSURE_FINGERPRINT_VERSION);
    expect(fixture.renderedFingerprintVersion).toBe(RENDERED_PROMPT_FINGERPRINT_VERSION);

    for (const vector of fixture.cases) {
      const canonicalBytes = Buffer.from(vector.rawTaskText.trim(), "utf8");
      expect(canonicalBytes.toString("hex"), vector.name).toBe(vector.canonicalRawUtf8Hex);
      expect(canonicalBytes.byteLength, vector.name).toBe(vector.canonicalRawUtf8Bytes);
      expect(createHash("sha256").update(canonicalBytes).digest("hex"), vector.name)
        .toBe(vector.expectedRawSha256);
    }
  });

  it("keeps raw identity stable across context rendering and preserves each rendered identity", () => {
    const vector = fixture.cases[0]!;
    const withoutContext = renderHomeserverUserMessage(taskConfig({ prompt: vector.rawTaskText }));
    const withContext = renderHomeserverUserMessage(taskConfig({
      prompt: vector.rawTaskText,
      injectedContext: vector.injectedContext,
    }));

    expect(withoutContext).toBe(vector.renderedWithoutContext);
    expect(withContext).toBe(vector.renderedWithContext);

    const bareIdentity = buildHuginTaskIdentity({
      taskId: vector.taskId,
      rawTaskText: vector.rawTaskText,
      renderedPrompt: withoutContext,
    });
    const contextIdentity = buildHuginTaskIdentity({
      taskId: vector.taskId,
      rawTaskText: vector.rawTaskText,
      renderedPrompt: withContext,
    });

    expect(bareIdentity.rawTaskFingerprint.digest).toBe(vector.expectedRawSha256);
    expect(contextIdentity.rawTaskFingerprint).toEqual(bareIdentity.rawTaskFingerprint);
    expect(bareIdentity.renderedPromptFingerprint).toEqual({
      algorithm: "sha256",
      version: RENDERED_PROMPT_FINGERPRINT_VERSION,
      digest: vector.renderedWithoutContextSha256,
      utf8Bytes: vector.renderedWithoutContextUtf8Bytes,
    });
    expect(contextIdentity.renderedPromptFingerprint).toEqual({
      algorithm: "sha256",
      version: RENDERED_PROMPT_FINGERPRINT_VERSION,
      digest: vector.renderedWithContextSha256,
      utf8Bytes: vector.renderedWithContextUtf8Bytes,
    });

    // Current public Gille v1 records taskTextFingerprint(/delegate.prompt).
    // Keep this executable mismatch visible until Gille #4 consumes the raw
    // identity: the legacy digests vary with context and neither equals raw.
    expect(taskTextFingerprint(withoutContext)).toBe(
      vector.currentGilleLegacyWithoutContextSha256,
    );
    expect(taskTextFingerprint(withContext)).toBe(
      vector.currentGilleLegacyWithContextSha256,
    );
    expect(taskTextFingerprint(withContext)).not.toBe(vector.expectedRawSha256);
    expect(vector.expectedRawLookupRequest).toEqual({
      fingerprint_version: TASK_EXPOSURE_FINGERPRINT_VERSION,
      fingerprints: [vector.expectedRawSha256],
    });
  });

  it("uses the real delegate serializer and offers no caller-supplied identity override", () => {
    const vector = fixture.cases[0]!;
    const configWithSpoofedExtraField = {
      ...taskConfig({
        prompt: vector.rawTaskText,
        injectedContext: vector.injectedContext,
      }),
      huginTaskIdentity: {
        schemaVersion: 999,
        producer: "attacker",
        taskId: "substituted",
      },
    } as HomeserverTaskConfig;
    const body = buildHomeserverRequestBody(configWithSpoofedExtraField, vector.taskId);

    expect(body.prompt).toBe(vector.renderedWithContext);
    expect(body.huginTaskIdentity).toEqual({
      schemaVersion: HUGIN_TASK_IDENTITY_SCHEMA_VERSION,
      producer: "hugin",
      taskId: vector.taskId,
      rawTaskFingerprint: {
        algorithm: "sha256",
        version: TASK_EXPOSURE_FINGERPRINT_VERSION,
        digest: vector.expectedRawSha256,
      },
      renderedPromptFingerprint: {
        algorithm: "sha256",
        version: RENDERED_PROMPT_FINGERPRINT_VERSION,
        digest: vector.renderedWithContextSha256,
        utf8Bytes: vector.renderedWithContextUtf8Bytes,
      },
    });
    expect(JSON.stringify(body.huginTaskIdentity)).not.toContain(vector.rawTaskText.trim());
  });

  it("fails closed rather than emitting a missing or ambiguous identity", () => {
    expect(() => buildHomeserverRequestBody(taskConfig({ prompt: " \n\t" }), "task-1"))
      .toThrow("non-empty logical task");
    expect(() => buildHomeserverRequestBody(taskConfig({ prompt: "valid" }), " task-1"))
      .toThrow("non-whitespace-padded task id");
  });
});
