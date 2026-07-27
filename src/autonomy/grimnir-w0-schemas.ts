/** Byte-exact, hash-pinned Grimnir ADR-008/W0.2 schema boundary. */
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
  "16edee0a5a0111f0142569f5b0cf2f90e807060c";

const schemaSpecs = {
  journal: [
    "autonomous-mutation-journal-v2.schema.json",
    "fc0d87d815c6fda3b14116e0e8840e8ecbe8e3df77bbeaf74b2064184ad036f4",
  ],
  constitution: [
    "autonomy-constitution-v2.schema.json",
    "0c0d2bbbe9129b9a692220afc6e7ce53f7415e2eb96cfb06aedcda1f77de170b",
  ],
  coverage: [
    "autonomy-coverage-registry-v2.schema.json",
    "fd2eec3b99fcaccceefe7ea4f432b0ce07d36bf1b66763c719cb1c9752fffdc9",
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
