import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  codeHealthAppendRequestSchema,
  validateCodeHealthAppendReceipt,
  type CodeHealthAppendRequest,
  type CodeHealthAppendReceipt,
  type FrictionOutbox,
  type FrictionOutboxWriter,
} from "./friction/outbox.js";

export type {
  CodeHealthAppendRequest,
  CodeHealthAppendReceipt,
  CodeHealthClassification,
} from "./friction/outbox.js";

export const CODE_HEALTH_CONTRACT_SOURCE_REVISION = "7df005ce952a52816597d9888da977d689a631fd";
const EXPECTED_PROVENANCE_SHA256 = "6c4715431ebc578b239390c87ba0c37a41f7a872bdf1320b8b0cef3d48de554b";
const CONTRACT_FILES = [
  {
    path: "docs/code-health-agent-v1.schema.json",
    sha256: "c329c167c9537382613dbc93950ecb7c82e8b4e42b66562a5821abc9d76e3bea",
    source_git_blob: "fad784b1337266147d8a6eb030b8e463e216ceeb",
  },
  {
    path: "scripts/lib/code-health-agent.mjs",
    sha256: "9d887baea538e9801785122448b098e37a803ead244fea3f167a338d79ccb258",
    source_git_blob: "e343dfb0b0b4e9029370738883e991d429539a5c",
  },
  {
    path: "scripts/lib/code-health-schema.mjs",
    sha256: "0bf6801120221ea0a21b64b8a0d15efe96e6f51a8858f4be042878f36885eb59",
    source_git_blob: "225af390d3e4c5ac62615ef0dc56104f9f02a34a",
  },
] as const;

interface FrozenValidator {
  canonical(value: unknown): string;
  validateRecord(record: unknown): unknown;
}

export interface CodeHealthDeliveryResult {
  status: "acknowledged" | "queued" | "unsaved";
  recordId: string;
  receipt?: CodeHealthAppendReceipt;
  reason?: string;
}

export interface CodeHealthDeliveryDependencies {
  outbox: Pick<FrictionOutbox, "enqueueCodeHealth" | "sendCodeHealthOnce" | "acknowledgeCodeHealth">;
  writer: Pick<FrictionOutboxWriter, "codeHealthAppend">;
}

let frozenValidatorPromise: Promise<FrozenValidator> | undefined;

async function loadFrozenValidator(): Promise<FrozenValidator> {
  if (!frozenValidatorPromise) {
    frozenValidatorPromise = (async () => {
      const contractRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../contracts/code-health");
      const provenancePath = path.join(contractRoot, "provenance.json");
      let provenanceBytes: Buffer;
      try {
        provenanceBytes = await fs.readFile(provenancePath);
      } catch {
        throw new Error("Frozen code-health contract is unavailable.");
      }
      if (sha256(provenanceBytes) !== EXPECTED_PROVENANCE_SHA256) {
        throw new Error("Frozen code-health provenance does not match its pinned hash.");
      }
      let provenance: unknown;
      try {
        provenance = JSON.parse(provenanceBytes.toString("utf8"));
      } catch {
        throw new Error("Frozen code-health provenance is malformed.");
      }
      if (!isPinnedProvenance(provenance)) {
        throw new Error("Frozen code-health provenance does not match the pinned source revision.");
      }
      for (const file of CONTRACT_FILES) {
        let bytes: Buffer;
        try {
          const filePath = path.resolve(contractRoot, file.path);
          if (!filePath.startsWith(`${contractRoot}${path.sep}`)) throw new Error("unsafe contract path");
          bytes = await fs.readFile(filePath);
        } catch {
          throw new Error("A frozen code-health contract file is unavailable.");
        }
        if (sha256(bytes) !== file.sha256) {
          throw new Error("A frozen code-health contract file does not match its pinned hash.");
        }
      }
      const agentModulePath = path.join(contractRoot, "scripts/lib/code-health-agent.mjs");
      const schemaModulePath = path.join(contractRoot, "scripts/lib/code-health-schema.mjs");
      try {
        const [agentModule, schemaModule] = await Promise.all([
          import(pathToFileURL(agentModulePath).href) as Promise<Pick<FrozenValidator, "validateRecord">>,
          import(pathToFileURL(schemaModulePath).href) as Promise<Pick<FrozenValidator, "canonical">>,
        ]);
        const validator: FrozenValidator = {
          canonical: schemaModule.canonical,
          validateRecord: agentModule.validateRecord,
        };
        if (typeof validator.canonical !== "function" || typeof validator.validateRecord !== "function") {
          throw new Error("validator exports unavailable");
        }
        return validator;
      } catch {
        throw new Error("Frozen code-health validator could not be loaded.");
      }
    })();
  }
  return frozenValidatorPromise;
}

function isPinnedProvenance(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const provenance = value as Record<string, unknown>;
  if (
    provenance.source_repository !== "Magnus-Gille/grimnir"
    || provenance.source_revision !== CODE_HEALTH_CONTRACT_SOURCE_REVISION
    || provenance.source_tree !== "768d661f090a9db5e96e2e1b8f2975a9490936bc"
    || provenance.contract_version !== "1.0"
    || !Array.isArray(provenance.files)
    || provenance.files.length !== CONTRACT_FILES.length
  ) return false;
  const files = provenance.files as unknown[];
  return CONTRACT_FILES.every((expected, index) => {
    const item = files[index];
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const candidate = item as Record<string, unknown>;
    return candidate.path === expected.path
      && candidate.sha256 === expected.sha256
      && candidate.source_git_blob === expected.source_git_blob;
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function validateCodeHealthRecord(
  record: unknown,
): Promise<{ valid: boolean; errors: string[] }> {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { valid: false, errors: ["record must be a JSON object"] };
  }
  try {
    const validator = await loadFrozenValidator();
    const canonical = validator.canonical(record);
    if (Buffer.byteLength(canonical, "utf8") > 16 * 1024) {
      return { valid: false, errors: ["record exceeds the 16 KiB code-health evidence limit"] };
    }
    validator.validateRecord(record);
    return { valid: true, errors: [] };
  } catch {
    return { valid: false, errors: ["record failed frozen code-health contract validation"] };
  }
}

export async function deliverCodeHealth(
  request: CodeHealthAppendRequest,
  { outbox, writer }: CodeHealthDeliveryDependencies,
): Promise<CodeHealthDeliveryResult> {
  let rawRecordId = "";
  if (typeof request === "object" && request !== null) {
    const maybeRecord = (request as { record?: unknown }).record;
    if (typeof maybeRecord === "object" && maybeRecord !== null && !Array.isArray(maybeRecord)) {
      const candidate = (maybeRecord as Record<string, unknown>).record_id;
      if (typeof candidate === "string") rawRecordId = candidate;
    }
  }
  const parsed = codeHealthAppendRequestSchema.safeParse(request);
  if (!parsed.success) return { status: "unsaved", recordId: rawRecordId, reason: "invalid_request" };
  const input = parsed.data as CodeHealthAppendRequest;
  const recordId = typeof input.record.record_id === "string" ? input.record.record_id : "";
  const validation = await validateCodeHealthRecord(input.record);
  if (!validation.valid) return { status: "unsaved", recordId, reason: "invalid_record" };
  const isCorrection = input.record.supersedes_record_id !== null;
  if (isCorrection !== (input.expected_updated_at !== undefined)) {
    return { status: "unsaved", recordId, reason: "correction_requires_exact_cas" };
  }

  const stored = await outbox.enqueueCodeHealth(input);
  if (!stored.stored) {
    return { status: "unsaved", recordId, reason: stored.reason };
  }
  const attempt = await outbox.sendCodeHealthOnce(input, writer);
  if (attempt.kind === "expired") return { status: "unsaved", recordId, reason: "expired" };
  if (attempt.kind === "permanent_refusal") {
    return { status: "unsaved", recordId, reason: "permanent_refusal" };
  }
  if (attempt.kind === "queued") return { status: "queued", recordId, reason: "delivery_ambiguous" };

  const receipt = validateCodeHealthAppendReceipt(input, attempt.response);
  if (!receipt) {
    return { status: "queued", recordId, reason: "receipt_unverified" };
  }
  if (!(await outbox.acknowledgeCodeHealth(input))) {
    return { status: "queued", recordId, reason: "acknowledged_cleanup_pending" };
  }
  return { status: "acknowledged", recordId, receipt };
}
