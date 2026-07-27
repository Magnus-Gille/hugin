/** Authentication boundary for controller, watchdog, and recovery services. */
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { canonicalizeJcs } from "../jcs.js";
import type { VerifiedW0Binding } from "./w0-authority.js";
import { latestEntry } from "./r-exact-journal.js";
import type {
  JournalRole,
  ProtectedRoleServicePins,
  RExactRoleService,
  RoleWriteReceipt,
  RoleWriteResult,
  W0RuntimeGate,
} from "./r-exact-types.js";
import { w0Digest } from "./w0-authority.js";

const exactKeys = (value: unknown, keys: string[]): boolean =>
  !!value
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export interface VerifiedRoleServiceKey {
  readonly role: JournalRole;
  readonly identity: string;
  readonly publicKeyPem: string;
  readonly publicKeyFingerprint: string;
}

export type VerifiedRoleServiceKeys = Readonly<
  Record<JournalRole, VerifiedRoleServiceKey>
>;

function serviceKey(service: RExactRoleService): {
  publicKeyPem: string;
  publicKeyFingerprint: string;
} {
  const key = createPublicKey(service.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("r-exact-role-service-key");
  }
  return {
    publicKeyPem: key.export({ type: "spki", format: "pem" }).toString(),
    publicKeyFingerprint: `sha256:${createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex")}`,
  };
}

export function validateRoleServices(
  gate: W0RuntimeGate,
  binding: VerifiedW0Binding,
  pins: ProtectedRoleServicePins = gate.roleServicePins,
  ownerPublicKeyPem: string = gate.authority.pinnedOwnerPublicKeyPem,
): VerifiedRoleServiceKeys {
  const expected = [
    [gate.controller, "controller", binding.identities.controller],
    [gate.watchdog, "watchdog", binding.identities.watchdog],
    [
      gate.recoveryJournal,
      "recovery-worker",
      binding.identities.recovery_worker,
    ],
  ] as const;
  const fingerprints = new Set<string>();
  const verified = {} as Record<JournalRole, VerifiedRoleServiceKey>;
  if (
    !exactKeys(pins, [
      "kind", "schema_version", "owner_authorization_digest", "entries",
      "pins_digest", "signature",
    ])
    || !exactKeys(pins.signature, ["algorithm", "value_base64"])
    || pins.kind !== "hugin-r-exact-role-service-pins"
    || pins.schema_version !== "v1"
    || pins.owner_authorization_digest !== binding.authorizationDigest
    || pins.signature.algorithm !== "Ed25519"
    || !Array.isArray(pins.entries)
    || pins.entries.length !== 3
  ) {
    throw new Error("r-exact-role-service-pins");
  }
  if (
    pins.entries.some(
      (entry) => !exactKeys(
        entry,
        ["role", "identity", "public_key_fingerprint"],
      ),
    )
  ) {
    throw new Error("r-exact-role-service-pins-entry");
  }
  if (
    new Set(pins.entries.map((entry) => entry.role)).size !== 3
    || new Set(pins.entries.map((entry) => entry.identity)).size !== 3
    || new Set(
      pins.entries.map((entry) => entry.public_key_fingerprint),
    ).size !== 3
  ) {
    throw new Error("r-exact-role-service-pins-duplicate");
  }
  const pinsBase = {
    kind: pins.kind,
    schema_version: pins.schema_version,
    owner_authorization_digest: pins.owner_authorization_digest,
    entries: pins.entries,
  };
  if (
    pins.pins_digest !== w0Digest(pinsBase)
    || !verifySignature(
      null,
      Buffer.from(canonicalizeJcs({ ...pinsBase, pins_digest: pins.pins_digest })),
      createPublicKey(ownerPublicKeyPem),
      Buffer.from(pins.signature.value_base64, "base64"),
    )
  ) {
    throw new Error("r-exact-role-service-pins-signature");
  }
  for (const [service, role, identity] of expected) {
    if (service.role !== role || service.identity !== identity) {
      throw new Error("r-exact-role-service-binding");
    }
    const key = serviceKey(service);
    if (fingerprints.has(key.publicKeyFingerprint)) {
      throw new Error("r-exact-role-service-key-reuse");
    }
    const pin = pins.entries.find((entry) => entry.role === role);
    if (
      !pin
      || pin.identity !== identity
      || pin.public_key_fingerprint !== key.publicKeyFingerprint
    ) {
      throw new Error("r-exact-role-service-unpinned");
    }
    fingerprints.add(key.publicKeyFingerprint);
    verified[role] = Object.freeze({
      role,
      identity,
      publicKeyPem: key.publicKeyPem,
      publicKeyFingerprint: key.publicKeyFingerprint,
    });
  }
  return Object.freeze(verified);
}

export function verifyRoleWriteReceipt(
  result: RoleWriteResult,
  service: RExactRoleService,
  pinned: VerifiedRoleServiceKey,
  action: "create" | "append",
  previousReceiptDigest: null | string,
): void {
  const receipt = result.receipt;
  const currentKey = serviceKey(service);
  if (
    service.role !== pinned.role
    || service.identity !== pinned.identity
    || currentKey.publicKeyFingerprint !== pinned.publicKeyFingerprint
  ) {
    throw new Error("r-exact-role-service-binding-changed");
  }
  if (
    !exactKeys(receipt, [
      "kind",
      "schema_version",
      "role",
      "identity",
      "action",
      "journal_id",
      "binding_digest",
      "previous_receipt_digest",
      "resulting_receipt_digest",
      "recorded_at",
      "signature",
    ])
    || !exactKeys(receipt.signature, ["algorithm", "value_base64"])
    || receipt.kind !== "hugin-r-exact-role-write-receipt"
    || receipt.schema_version !== "v1"
    || receipt.role !== pinned.role
    || receipt.identity !== pinned.identity
    || receipt.action !== action
    || receipt.journal_id !== result.journal.journal_id
    || receipt.binding_digest !== result.journal.binding_digest
    || receipt.previous_receipt_digest !== previousReceiptDigest
    || receipt.resulting_receipt_digest
      !== latestEntry(result.journal).receipt_digest
    || receipt.recorded_at !== latestEntry(result.journal).recorded_at
    || receipt.signature.algorithm !== "Ed25519"
  ) {
    throw new Error("r-exact-role-receipt-invalid");
  }
  const unsigned = structuredClone(receipt);
  delete (unsigned as Partial<RoleWriteReceipt>).signature;
  if (
    !verifySignature(
      null,
      Buffer.from(canonicalizeJcs(unsigned)),
      createPublicKey(pinned.publicKeyPem),
      Buffer.from(receipt.signature.value_base64, "base64"),
    )
  ) {
    throw new Error("r-exact-role-receipt-signature");
  }
}
