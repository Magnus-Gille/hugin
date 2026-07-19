import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildQualityCorrectionReceipt,
  normalizedQualityBinding,
} from "../src/quality-receipt.js";

interface GrimnirQualityFixture {
  predecessor_receipt_id: string;
  expected_receipt_id: string;
  rated_at: string;
  verifier: { id: string; version: string };
  normalized_group_payload: {
    task_id: string;
    attempt_id: string;
    reviewer: {
      principal: string;
      independence: "independent" | "self" | "unknown";
    };
    rubric: {
      id: string;
      version: string;
      config_digest: {
        algorithm: "sha256";
        canonicalization: "jcs-rfc8785-utf8-v1";
        source_ref: string;
        source_type: "rubric-config";
        source_version: string;
        digest: string;
      };
    };
    binding: {
      task_document_sha256: string;
      structured_result_sha256: string;
      repository: {
        state: "changes-present";
        base_branch: string;
        base_commit: string;
        head_commit: string;
        diff_sha256: {
          algorithm: "sha256";
          version: "git-binary-diff-sha256-v1";
          digest: string;
        };
      };
    };
  };
  expected_correction_group: {
    algorithm: "sha256";
    version: "quality-correction-group-jcs-v1";
    digest: string;
  };
}

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/grimnir-quality-v2-contract.json", import.meta.url),
  "utf8",
)) as GrimnirQualityFixture;

describe("Grimnir learning contract — native Hugin v2 bridge", () => {
  it("matches the accepted normalized rubric, binding, and correction-group digest", () => {
    const expected = fixture.normalized_group_payload;
    const receipt = buildQualityCorrectionReceipt({
      taskId: expected.task_id,
      attemptId: expected.attempt_id,
      correctsReceiptId: fixture.predecessor_receipt_id,
      reviewerPrincipal: expected.reviewer.principal,
      reviewerIndependence: expected.reviewer.independence,
      rating: "pass",
      ratingReason: "Fixture correction accepted unchanged.",
      verificationOutcome: "accepted_unchanged",
      ratedAt: fixture.rated_at,
      rubric: expected.rubric,
      verifier: fixture.verifier,
      failure: {
        taxonomy: { id: "hugin-quality-failure", version: "1" },
        code: "none",
      },
      bindingAttestation: "server-bound",
      binding: {
        taskDocumentSha256: expected.binding.task_document_sha256,
        structuredResultSha256: expected.binding.structured_result_sha256,
        repository: {
          state: expected.binding.repository.state,
          baseBranch: expected.binding.repository.base_branch,
          baseCommit: expected.binding.repository.base_commit,
          headCommit: expected.binding.repository.head_commit,
          diffSha256: expected.binding.repository.diff_sha256.digest,
        },
      },
    });

    expect(receipt.rubric).toEqual(expected.rubric);
    expect(Object.keys(receipt.rubric).sort()).toEqual(["config_digest", "id", "version"]);
    expect(normalizedQualityBinding(receipt.binding)).toEqual(expected.binding);
    expect({
      task_id: receipt.taskId,
      attempt_id: receipt.attemptId,
      reviewer: receipt.reviewer,
      rubric: receipt.rubric,
      binding: normalizedQualityBinding(receipt.binding),
    }).toEqual(expected);
    expect(receipt.correctionGroup).toEqual(fixture.expected_correction_group);
    expect(receipt.receiptId).toBe(fixture.expected_receipt_id);
    expect(receipt.verifier).toEqual(fixture.verifier);
    expect(receipt.rubric).not.toHaveProperty("verifier");
  });
});
