import { describe, expect, it } from "vitest";
import { buildStructuredTaskResult } from "../src/task-result-schema.js";
import {
  QualityReceiptConflictError,
  QualityReceiptInvalidLedgerError,
  buildQualityBinding,
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
