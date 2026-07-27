/** Byte-exact, hash-pinned Grimnir ADR-008/W0.1 schema boundary. */
import { fileURLToPath } from "node:url";
import {
  checkSchemaSupported,
  isPlainObject,
  loadVendoredJson,
  schemaErrors,
  type JsonValue,
} from "../node-substrate.js";
import type { RExactJournal } from "./r-exact-types.js";
import type { W0AuthorityBundle } from "./w0-authority.js";

export const GRIMNIR_W0_SOURCE_REPOSITORY = "Magnus-Gille/grimnir";
export const GRIMNIR_W0_SOURCE_REVISION =
  "ddf1cfa3d86d1a72e47b7d19fe16aab8d12db528";

const schemaSpecs = {
  journal: [
    "autonomous-mutation-journal-v1.schema.json",
    "237eb4336a84645b88319b4cbd5112b6dd0c3a3a97e7343e0fdc73869b1cac3b",
  ],
  constitution: [
    "autonomy-constitution-v1.schema.json",
    "647aacbc963dd5ce620ca6240ce6bd11fd2275e0eb01c861468b10e156d1e707",
  ],
  coverage: [
    "autonomy-coverage-registry-v1.schema.json",
    "9c9a7936350b18300e2b488ac525276b8c91fbf3a2d795fb4d842c5ebbd024b7",
  ],
  attestations: [
    "autonomy-owner-attestation-registry-v1.schema.json",
    "80099e3d2f871ff89d98facff49ce9f4e8ca7c791ba7e40357ca812d556ecb59",
  ],
  authorization: [
    "autonomy-owner-authorization-v1.schema.json",
    "94d685bf863ab6c1f6782374a4f292896aa861ff631545ab765fc9018b1f5225",
  ],
  recoveryRegistry: [
    "autonomy-recovery-worker-registry-v1.schema.json",
    "24c51aefbf5511be5ae4d478dc8801f2387b3e8d83274d90c4a3be7b5ee52e48",
  ],
  narrowing: [
    "autonomy-runtime-narrowing-v1.schema.json",
    "d4ec31f156b31efd70584ebc2cb9c22033602fa1275c168cc31686c7631b80e9",
  ],
} as const;

type SchemaName = keyof typeof schemaSpecs;
const schemas = new Map<SchemaName, Record<string, JsonValue>>();

function schema(name: SchemaName): Record<string, JsonValue> {
  const cached = schemas.get(name);
  if (cached) return cached;
  const [file, digest] = schemaSpecs[name];
  const path = fileURLToPath(
    new URL(`../../docs/vendor/grimnir/autonomy/${file}`, import.meta.url),
  );
  const loaded = loadVendoredJson(path, digest);
  if (!isPlainObject(loaded)) {
    throw new Error(`grimnir-w0-schema-not-object:${name}`);
  }
  checkSchemaSupported(loaded);
  schemas.set(name, loaded);
  return loaded;
}

function errors(name: SchemaName, value: unknown): string[] {
  const root = schema(name);
  return schemaErrors(root, root, value as JsonValue);
}

export function canonicalW0AuthoritySchemaErrors(
  bundle: W0AuthorityBundle,
): string[] {
  return [
    ...errors("constitution", bundle.constitution),
    ...errors("coverage", bundle.coverageIntent),
    ...errors("attestations", bundle.ownerAttestations),
    ...errors("authorization", bundle.ownerAuthorization),
    ...errors("recoveryRegistry", bundle.recoveryWorkerRegistry),
    ...errors("narrowing", bundle.runtimeNarrowing),
  ];
}

export function canonicalJournalSchemaErrors(
  journal: RExactJournal,
): string[] {
  return errors("journal", journal);
}
