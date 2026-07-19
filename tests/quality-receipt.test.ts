import { describe, expect, it } from "vitest";
import { buildStructuredTaskResult } from "../src/task-result-schema.js";
import {
  QualityReceiptConflictError,
  QualityReceiptInvalidLedgerError,
  buildQualityBinding,
  buildQualityCorrectionReceipt,
  buildQualityReceipt,
  foldQualityReceipt,
  qualityReceiptLedgerSchema,
  summarizeQualityReceipts,
} from "../src/quality-receipt.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const DIFF = "c".repeat(64);

function resultContent(): string {
  return JSON.stringify(buildStructuredTaskResult({
    schemaVersion: 1,
    taskId: "task-1",
    taskNamespace: "tasks/task-1",
    lifecycle: "completed",
    outcome: "completed",
    runtime: "codex",
    executor: "codex-spawn",
    resultSource: "stdout",
    exitCode: 0,
    completedAt: "2026-07-15T10:00:00.000Z",
    bodyKind: "response",
    bodyText: "ok",
    prUrl: "https://github.com/Magnus-Gille/demo/pull/1",
    repositoryOutcome: {
      state: "changes-present",
      baseBranch: "main",
      baseCommit: BASE,
    },
    repositoryChange: {
      baseBranch: "main",
      baseCommit: BASE,
      headCommit: HEAD,
      changedFiles: ["src/demo.ts"],
      diffSha256: DIFF,
    },
  }));
}

function receipt(overrides: Partial<Parameters<typeof buildQualityReceipt>[0]> = {}) {
  const statusContent = "## Task: demo\n\n### Prompt\nFix it.";
  const structuredResultContent = resultContent();
  return buildQualityReceipt({
    taskId: "task-1",
    reviewerPrincipal: "claude-code",
    reviewerIndependence: "independent",
    rating: "pass",
    ratingReason: "Reviewed the exact diff and green checks.",
    verificationOutcome: "accepted_unchanged",
    ratedAt: "2026-07-15T10:05:00.000Z",
    binding: buildQualityBinding({ statusContent, structuredResultContent }),
    bindingAttestation: "reviewer-confirmed",
    ...overrides,
  });
}

describe("quality receipt v1", () => {
  it("keeps the shipped native v1 artifact byte-for-field compatible", () => {
    const native = receipt();
    expect(Object.keys(native)).toEqual([
      "schemaVersion",
      "receiptId",
      "taskId",
      "rating",
      "ratingReason",
      "verificationOutcome",
      "ratedAt",
      "reviewer",
      "bindingAttestation",
      "binding",
    ]);
    expect(native).toEqual({
      schemaVersion: 1,
      receiptId: "qr-294eff66629b38102d0648d5",
      taskId: "task-1",
      rating: "pass",
      ratingReason: "Reviewed the exact diff and green checks.",
      verificationOutcome: "accepted_unchanged",
      ratedAt: "2026-07-15T10:05:00.000Z",
      reviewer: {
        principal: "claude-code",
        independence: "independent",
      },
      bindingAttestation: "reviewer-confirmed",
      binding: {
        taskDocumentSha256: "7f6d21c234402c8c91133e2e31e1ab3e9e4fc662ebd882ebaa7c9e2b34b555c5",
        structuredResultSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        repository: {
          state: "changes-present",
          baseBranch: "main",
          baseCommit: BASE,
          headCommit: HEAD,
          diffSha256: DIFF,
        },
      },
    });
  });

  it("binds the exact task document, structured result, and repository diff", () => {
    const binding = buildQualityBinding({
      statusContent: "task bytes",
      structuredResultContent: resultContent(),
    });

    expect(binding.taskDocumentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(binding.structuredResultSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(binding.repository).toEqual({
      state: "changes-present",
      baseBranch: "main",
      baseCommit: BASE,
      headCommit: HEAD,
      diffSha256: DIFF,
    });
  });

  it("folds identical retries idempotently and rejects a changed verdict from the same reviewer", () => {
    const first = receipt();
    const initial = foldQualityReceipt(null, first);
    expect(initial.changed).toBe(true);
    expect(initial.ledger.receipts).toHaveLength(1);

    const replay = foldQualityReceipt(initial.ledger, receipt({
      ratedAt: "2026-07-15T10:06:00.000Z",
    }));
    expect(replay.changed).toBe(false);
    expect(replay.ledger).toEqual(initial.ledger);

    expect(() => foldQualityReceipt(initial.ledger, receipt({
      rating: "wrong",
      ratingReason: "Changed my mind.",
      verificationOutcome: "discarded",
    }))).toThrow(QualityReceiptConflictError);
  });

  it("keeps independent reviewers append-only and summarizes only exact-binding receipts", () => {
    const first = foldQualityReceipt(null, receipt()).ledger;
    const second = foldQualityReceipt(first, receipt({
      reviewerPrincipal: "codex-review",
      ratedAt: "2026-07-15T10:07:00.000Z",
    })).ledger;
    expect(qualityReceiptLedgerSchema.parse(second).receipts).toHaveLength(2);

    const binding = receipt().binding;
    expect(summarizeQualityReceipts(JSON.stringify(second), binding)).toMatchObject({
      state: "accepted",
      receiptIds: expect.arrayContaining([
        first.receipts[0]!.receiptId,
        second.receipts[1]!.receiptId,
      ]),
      independentAccepted: true,
    });

    const stale = { ...binding, structuredResultSha256: "d".repeat(64) };
    expect(summarizeQualityReceipts(JSON.stringify(second), stale).state).toBe("invalid");
  });

  it("treats disagreement in the full rating/disposition tuple as conflicted", () => {
    const first = foldQualityReceipt(null, receipt({
      rating: "partial",
      verificationOutcome: "minor_edit",
    })).ledger;
    const second = foldQualityReceipt(first, receipt({
      reviewerPrincipal: "codex-review",
      rating: "partial",
      verificationOutcome: "major_rewrite",
      ratedAt: "2026-07-15T10:07:00.000Z",
    })).ledger;

    expect(summarizeQualityReceipts(
      JSON.stringify(second),
      receipt().binding,
    ).state).toBe("conflicted");
  });

  it("never upgrades legacy unbound feedback into accepted quality evidence", () => {
    const summary = summarizeQualityReceipts(
      JSON.stringify({
        rating: "pass",
        rating_reason: "looked right",
        verification_outcome: "accepted_unchanged",
      }),
      receipt().binding,
    );
    expect(summary).toMatchObject({ state: "legacy-unbound", independentAccepted: false });
  });

  it("rejects a receipt whose semantic verdict no longer matches its identity", () => {
    const original = receipt();
    const tampered = {
      schemaVersion: 1,
      taskId: "task-1",
      receipts: [{ ...original, rating: "wrong", verificationOutcome: "discarded" }],
    };
    expect(summarizeQualityReceipts(JSON.stringify(tampered), original.binding).state).toBe("invalid");
    expect(() => foldQualityReceipt(tampered, receipt({
      reviewerPrincipal: "another-reviewer",
    }))).toThrow(QualityReceiptInvalidLedgerError);
  });
});

describe("quality receipt v2 corrections", () => {
  function correction(
    correctsReceiptId: string,
    overrides: Partial<Parameters<typeof buildQualityCorrectionReceipt>[0]> = {},
  ) {
    const original = receipt();
    return buildQualityCorrectionReceipt({
      taskId: original.taskId,
      attemptId: original.taskId,
      correctsReceiptId,
      reviewerPrincipal: original.reviewer.principal,
      reviewerIndependence: original.reviewer.independence,
      rating: "wrong",
      ratingReason: "The accepted patch still fails the Unicode case.",
      verificationOutcome: "discarded",
      ratedAt: "2026-07-15T10:15:00.000Z",
      bindingAttestation: original.bindingAttestation,
      binding: original.binding,
      rubric: {
        id: "code-review",
        version: "2.1.0",
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: "source-doc:rubric/code-review-2.1.0",
          source_type: "rubric-config",
          source_version: "rubric-source-2.1.0",
          digest: "d".repeat(64),
        },
      },
      verifier: { id: "claude-opus", version: "2026-07-15" },
      failure: {
        taxonomy: { id: "hugin-quality-failure", version: "1" },
        code: "incorrect-answer",
      },
      producingConfiguration: {
        prompt: { id: "task-envelope", version: "4", sha256: "e".repeat(64) },
        harness: { id: "claude-code", version: "1.0", sha256: "f".repeat(64) },
        model: { id: "claude-opus", configurationSha256: "1".repeat(64) },
        toolPolicy: { id: "trusted-code", version: "3", sha256: "2".repeat(64) },
      },
      references: {
        correctedSuccessor: {
          taskId: "task-1-fix",
          structuredResultSha256: "3".repeat(64),
        },
        followUpTaskId: "task-1-fix",
        pullRequestUrl: "https://github.com/Magnus-Gille/demo/pull/2",
        replacementCommit: "4".repeat(40),
      },
      ...overrides,
    });
  }

  it("appends a distinct correction that names v1 and retains a stable correction group", () => {
    const original = receipt();
    const first = correction(original.receiptId);
    const correctionAtAnotherClock = correction(original.receiptId, {
      ratedAt: "2026-07-15T10:16:00.000Z",
    });

    expect(first).toMatchObject({
      schemaVersion: 2,
      receiptId: expect.stringMatching(/^qr-[0-9a-f]{24}$/),
      correctsReceiptId: original.receiptId,
      attemptId: "task-1",
      correctionGroup: {
        algorithm: "sha256",
        version: "quality-correction-group-jcs-v1",
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      verifier: { id: "claude-opus", version: "2026-07-15" },
    });
    expect(first.receiptId).not.toBe(original.receiptId);
    expect(first).not.toHaveProperty("predecessorReceiptId");
    expect(correctionAtAnotherClock.receiptId).not.toBe(first.receiptId);
    expect(correctionAtAnotherClock.correctionGroup).toEqual(first.correctionGroup);

    const ledger = foldQualityReceipt(
      foldQualityReceipt(null, original).ledger,
      first,
    ).ledger;
    expect(ledger.schemaVersion).toBe(2);
    expect(ledger.receipts).toEqual([original, first]);
    expect(foldQualityReceipt(ledger, structuredClone(first))).toEqual({
      ledger,
      changed: false,
    });

    const correctedSuccess = correction(first.receiptId, {
      rating: "pass",
      ratingReason: "The successor now passes the same rubric.",
      verificationOutcome: "accepted_unchanged",
      failure: {
        taxonomy: { id: "hugin-quality-failure", version: "1" },
        code: "none",
      },
      ratedAt: "2026-07-15T10:30:00.000Z",
    });
    expect(correctedSuccess.correctionGroup).toEqual(first.correctionGroup);
    expect(foldQualityReceipt(ledger, correctedSuccess).ledger.receipts).toEqual([
      original,
      first,
      correctedSuccess,
    ]);
  });

  it("rejects same-id v2 replays unless the complete canonical artifact is identical", () => {
    const original = receipt();
    const first = correction(original.receiptId);
    const ledger = foldQualityReceipt(
      foldQualityReceipt(null, original).ledger,
      first,
    ).ledger;

    expect(() => foldQualityReceipt(ledger, {
      ...first,
      ratedAt: "2026-07-15T10:16:00.000Z",
    })).toThrow(/identity collision/);
    expect(() => foldQualityReceipt(ledger, {
      ...first,
      verifier: { ...first.verifier, version: "2026-07-16" },
    })).toThrow(/identity collision/);
  });

  it("rejects correction forks and changed correction replays", () => {
    const original = receipt();
    const first = correction(original.receiptId);
    const originalLedger = foldQualityReceipt(null, original).ledger;
    const ledger = foldQualityReceipt(originalLedger, first).ledger;

    expect(() => foldQualityReceipt(originalLedger, correction(original.receiptId, {
      reviewerIndependence: "self",
    }))).toThrow(QualityReceiptConflictError);

    expect(() => foldQualityReceipt(ledger, correction(original.receiptId, {
      ratingReason: "A different attempted fork.",
    }))).toThrow(QualityReceiptConflictError);
    expect(() => foldQualityReceipt(ledger, correction(first.receiptId, {
      rubric: {
        id: "another-rubric",
        version: "1",
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: "source-doc:rubric/another-1",
          source_type: "rubric-config",
          source_version: "rubric-source-1",
          digest: "5".repeat(64),
        },
      },
    }))).toThrow(QualityReceiptConflictError);
  });

  it("harvests only the correction leaf with rubric, failure, config, and successor provenance", () => {
    const original = receipt();
    const corrected = correction(original.receiptId);
    const ledger = foldQualityReceipt(
      foldQualityReceipt(null, original).ledger,
      corrected,
    ).ledger;

    const summary = summarizeQualityReceipts(JSON.stringify(ledger), original.binding);
    expect(summary).toMatchObject({
      state: "rejected",
      receiptIds: [corrected.receiptId],
      effectiveReceipts: [{
        nativeSchemaVersion: 2,
        receiptId: corrected.receiptId,
        correctsReceiptId: original.receiptId,
        attemptId: "task-1",
        rubric: corrected.rubric,
        verifier: corrected.verifier,
        failure: corrected.failure,
        producingConfiguration: corrected.producingConfiguration,
        references: corrected.references,
      }],
    });
    expect(JSON.stringify(summary)).not.toContain(corrected.ratingReason);
  });

  it("requires failure code none exactly for pass plus accepted unchanged", () => {
    const original = receipt();
    expect(() => correction(original.receiptId, {
      failure: {
        taxonomy: { id: "hugin-quality-failure", version: "1" },
        code: "none",
      },
    })).toThrow(/non-accepted correction/);
    expect(() => correction(original.receiptId, {
      rating: "pass",
      verificationOutcome: "accepted_unchanged",
      failure: {
        taxonomy: { id: "hugin-quality-failure", version: "1" },
        code: "verification-failure",
      },
    })).toThrow(/accepted unchanged correction must use failure code none/);
  });

  it("accepts only Grimnir v1 timestamps with zero to three fractional digits", () => {
    const original = receipt();
    expect(correction(original.receiptId, {
      ratedAt: "2026-07-15T10:15:00Z",
    }).ratedAt).toBe("2026-07-15T10:15:00Z");
    expect(() => correction(original.receiptId, {
      ratedAt: "2026-07-15T10:15:00.1234Z",
    })).toThrow();
    expect(() => correction(original.receiptId, {
      ratedAt: "2026-07-15T12:15:00+02:00",
    })).toThrow();
  });
});
