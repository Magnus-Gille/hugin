/** Offline-verifiable Grimnir ADR-008/W0.1 authority contract. */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { canonicalizeJcs } from "../jcs.js";

export const W0_CONSTITUTION_DIGEST = "sha256:51efdb78c4524780919649f285862543db8b38a6a3a07894f0fad8bdab40fc6c" as const;
export const W0_JOURNAL_PHASES = ["prepare", "apply", "verify", "watch", "commit", "unknown", "revert", "recover", "quarantine", "disarm", "terminally-blocked"] as const;
export const HUGIN_R_EXACT_DOMAINS = ["macro-routing", "prompt", "harness", "tool-policy"] as const;
export type HuginRExactDomain = typeof HUGIN_R_EXACT_DOMAINS[number];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const idPattern = /^[a-z][a-z0-9-]{2,62}$/;

export function w0Digest(value: unknown, omit?: string): string {
  const copy = structuredClone(value) as Record<string, unknown>;
  if (omit) delete copy[omit];
  return `sha256:${createHash("sha256").update(canonicalizeJcs(copy)).digest("hex")}`;
}
function exactKeys(value: unknown, keys: string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function reject(reason: string): never { throw new Error(`w0-authority-rejected:${reason}`); }

export interface W0AuthorityBundle {
  constitution: any; coverageIntent: any; ownerAttestations: any; recoveryWorkerRegistry: any;
  ownerAuthorization: any; pinnedOwnerPublicKeyPem: string; authorizationCheckpoint: any;
  runtimeNarrowing: any; narrowingCheckpoint: any;
}
export interface VerifiedW0Binding {
  authorizationDigest: string; coverageDigest: string; domain: HuginRExactDomain;
  targetScopeDigest: string; state: "armed-canary" | "armed-fleet";
  effectiveState: "armed-canary" | "armed-fleet" | "shadow";
  identities: { owner: string; controller: string; watchdog: string; kill_switch: string; recovery_worker: string };
  ownerAuthorityRef: string; ownerAuthorityDigest: string; configurationOwnerAuthorityRef: string; configurationOwnerAuthorityDigest: string;
}

/** Verify owner Ed25519 authority, exact artifact bindings and current narrowing. */
export function verifyW0Authority(bundle: W0AuthorityBundle, domain: HuginRExactDomain, targetScopeDigest: string, allowNarrowed = false): VerifiedW0Binding {
  const { constitution:c, coverageIntent:cov, ownerAttestations:att, recoveryWorkerRegistry:rr, ownerAuthorization:a, authorizationCheckpoint:cp, runtimeNarrowing:n, narrowingCheckpoint:ncp } = bundle;
  if (!HUGIN_R_EXACT_DOMAINS.includes(domain) || !digestPattern.test(targetScopeDigest)) reject("invalid-target");
  if (c.kind!=="autonomy-constitution" || c.schema_version!=="v1" || c.constitution_digest !== W0_CONSTITUTION_DIGEST) reject("constitution-digest");
  for (const [artifact, field] of [[cov,"registry_digest"],[att,"registry_digest"],[rr,"registry_digest"]] as const) if (!artifact || artifact[field] !== w0Digest(artifact,field)) reject(`artifact-digest:${field}`);
  if (!exactKeys(a,["kind","schema_version","authorization_id","authorization_sequence","previous_authorization_digest","issued_at","authority","bindings","signature"]) || !exactKeys(a.authority,["key_id","algorithm","public_key_pem","public_key_fingerprint"]) || !exactKeys(a.bindings,["constitution_digest","coverage_intent_digest","owner_attestation_registry_digest","recovery_worker_registry_digest"]) || !exactKeys(a.signature,["algorithm","value_base64"]) || a.kind!=="autonomy-owner-authorization" || a.schema_version!=="v1") reject("authorization-shape");
  if(!idPattern.test(a.authorization_id)||!idPattern.test(a.authority.key_id)||!Number.isSafeInteger(a.authorization_sequence)||a.authorization_sequence<1||(a.authorization_sequence===1)!==(a.previous_authorization_digest===null)||!Number.isFinite(Date.parse(a.issued_at)))reject("authorization-metadata");
  const pinned=createPublicKey(bundle.pinnedOwnerPublicKeyPem), embedded=createPublicKey(a.authority.public_key_pem);
  if (pinned.asymmetricKeyType!=="ed25519" || embedded.asymmetricKeyType!=="ed25519" || !pinned.export({type:"spki",format:"der"}).equals(embedded.export({type:"spki",format:"der"}))) reject("owner-key-pin");
  const fingerprint=`sha256:${createHash("sha256").update(embedded.export({type:"spki",format:"der"})).digest("hex")}`;
  if (fingerprint!==a.authority.public_key_fingerprint || a.authority.algorithm!=="Ed25519" || a.signature.algorithm!=="Ed25519") reject("owner-key-fingerprint");
  const unsigned=structuredClone(a); delete unsigned.signature;
  if (!verifySignature(null,Buffer.from(canonicalizeJcs(unsigned)),embedded,Buffer.from(a.signature.value_base64,"base64"))) reject("owner-signature");
  const authDigest=w0Digest(a);
  if (!exactKeys(cp,["kind","schema_version","authorization_digest","minimum_sequence"]) || cp.kind!=="autonomy-owner-authorization-checkpoint"||cp.schema_version!=="v1"||!Number.isSafeInteger(cp.minimum_sequence)||cp.authorization_digest!==authDigest || a.authorization_sequence<cp.minimum_sequence) reject("authorization-checkpoint");
  const bindings={constitution_digest:W0_CONSTITUTION_DIGEST,coverage_intent_digest:w0Digest(cov,"registry_digest"),owner_attestation_registry_digest:w0Digest(att,"registry_digest"),recovery_worker_registry_digest:w0Digest(rr,"registry_digest")};
  if (canonicalizeJcs(a.bindings)!==canonicalizeJcs(bindings)) reject("authorization-bindings");
  if (!exactKeys(cov,["kind","schema_version","registry_id","issued_at","constitution_digest","mutation_policy","global_state","domains","registry_digest","extensions"])||cov.kind!=="autonomy-coverage-registry"||cov.schema_version!=="v1"||cov.constitution_digest!==W0_CONSTITUTION_DIGEST||cov.mutation_policy!=="owner-widen-recovery-worker-narrow"||!Array.isArray(cov.domains)||!Array.isArray(cov.extensions)||cov.extensions.length||!Number.isFinite(Date.parse(cov.issued_at))) reject("coverage-shape");
  if (!exactKeys(att,["kind","schema_version","registry_id","issued_at","issuer_identity","mutation_policy","attestations","registry_digest","extensions"])||att.kind!=="autonomy-owner-attestation-registry"||att.schema_version!=="v1"||att.mutation_policy!=="owner-controlled-protected-lane"||!Array.isArray(att.attestations)||!Array.isArray(att.extensions)||att.extensions.length||!Number.isFinite(Date.parse(att.issued_at))) reject("attestation-shape");
  if (cov.global_state!=="armed") reject("global-disarmed");
  const matchingRows=cov.domains.filter((x:any)=>x.domain===domain); const row=matchingRows[0]; const matchingBindings=row?.bindings?.filter((x:any)=>x.target_scope_digest===targetScopeDigest)??[]; const binding=matchingBindings[0];
  if (matchingRows.length!==1 || matchingBindings.length!==1 || !exactKeys(row,["domain","required_for_levels","owner_scope","owner","recovery_class","coverage","target_state","bindings"]) || !exactKeys(binding,["writer_owner","owner_authority_ref","owner_authority_digest","configuration_owner","configuration_owner_authority_ref","configuration_owner_authority_digest","target_scope_digest","state","identities"]) || !["armed-canary","armed-fleet"].includes(row.coverage) || binding.state!==row.coverage || binding.writer_owner!=="hugin" || binding.configuration_owner!=="hugin") reject("coverage-binding");
  const ids=binding.identities; if (!exactKeys(ids,["owner","controller","watchdog","kill_switch","recovery_worker"]) || new Set(Object.values(ids)).size!==5 || !Object.values(ids).every((x)=>typeof x==="string"&&idPattern.test(x))) reject("five-identities");
  const matchingAttestations=att.attestations.filter((x:any)=>x.attestation_id===binding.configuration_owner_authority_ref?.slice(4)); const ownerAtt=matchingAttestations[0];
  if (matchingAttestations.length!==1 || !exactKeys(ownerAtt,["attestation_id","domain","target_scope_digest","configuration_owner","issued_at","attestation_digest"]) || ownerAtt.domain!==domain || ownerAtt.target_scope_digest!==targetScopeDigest || ownerAtt.configuration_owner!=="hugin" || ownerAtt.attestation_digest!==binding.configuration_owner_authority_digest || !Number.isFinite(Date.parse(ownerAtt.issued_at))) reject("owner-attestation");
  if(!exactKeys(rr,["kind","schema_version","registry_id","entries","registry_digest","extensions"])||rr.kind!=="autonomy-recovery-worker-registry"||rr.schema_version!=="v1"||!Array.isArray(rr.entries)||!Array.isArray(rr.extensions)||rr.extensions.length)reject("recovery-registry-shape");
  const recoveryBindings=new Map<string,any>(), recoveryFingerprints=new Set<string>();for(const x of rr.entries){if(!exactKeys(x,["domain","target_scope_digest","recovery_worker_identity","public_key_pem","public_key_fingerprint"])||!idPattern.test(x.recovery_worker_identity)||!digestPattern.test(x.target_scope_digest))reject("recovery-binding-shape");const k=createPublicKey(x.public_key_pem);const fp=`sha256:${createHash("sha256").update(k.export({type:"spki",format:"der"})).digest("hex")}`;if(k.asymmetricKeyType!=="ed25519"||fp!==x.public_key_fingerprint||recoveryFingerprints.has(fp))reject("recovery-key");const identity=`${x.domain}:${x.target_scope_digest}:${x.recovery_worker_identity}`;if(recoveryBindings.has(identity))reject("ambiguous-recovery-binding");recoveryBindings.set(identity,{...x,key:k});recoveryFingerprints.add(fp);}
  if (!exactKeys(n,["kind","schema_version","ledger_id","owner_authorization_digest","entries","extensions"])||n.kind!=="autonomy-runtime-narrowing"||n.schema_version!=="v1"||!Array.isArray(n.entries)||!Array.isArray(n.extensions)||n.extensions.length||n.owner_authorization_digest!==authDigest || !exactKeys(ncp,["kind","schema_version","owner_authorization_digest","ledger_tail_digest","minimum_entries"])||ncp.kind!=="autonomy-runtime-narrowing-checkpoint"||ncp.schema_version!=="v1"||ncp.owner_authorization_digest!==authDigest) reject("narrowing-authorization");
  let previous:null|string=null, effective:"armed-canary"|"armed-fleet"|"shadow"=binding.state;
  const usedNarrowingBindings = new Set<string>();
  for (const [index,e] of n.entries.entries()) { if(!exactKeys(e,["sequence","recorded_at","domain","target_scope_digest","from_state","to_state","recovery_worker_identity","journal_receipt_digest","previous_entry_digest","entry_digest","signature"])||!exactKeys(e.signature,["algorithm","value_base64"])||e.signature.algorithm!=="Ed25519"||!Number.isFinite(Date.parse(e.recorded_at))||!HUGIN_R_EXACT_DOMAINS.includes(e.domain)||!digestPattern.test(e.target_scope_digest)||!digestPattern.test(e.journal_receipt_digest)||!digestPattern.test(e.entry_digest)||!idPattern.test(e.recovery_worker_identity)||!["armed-canary","armed-fleet"].includes(e.from_state)||e.to_state!=="shadow")reject("narrowing-entry-shape");if (e.sequence!==index+1 || e.previous_entry_digest!==previous || e.entry_digest!==w0Digest((()=>{const q=structuredClone(e);delete q.entry_digest;delete q.signature;return q;})())) reject("narrowing-chain");const exactBinding=`${e.domain}:${e.target_scope_digest}:${e.recovery_worker_identity}`;if(usedNarrowingBindings.has(exactBinding))reject("duplicate-narrowing-binding");usedNarrowingBindings.add(exactBinding);const rb=recoveryBindings.get(exactBinding);if(!rb)reject("unbound-recovery-worker");const unsigned=structuredClone(e);delete unsigned.signature;if(!verifySignature(null,Buffer.from(canonicalizeJcs(unsigned)),rb.key,Buffer.from(e.signature.value_base64,"base64")))reject("narrowing-signature"); previous=e.entry_digest; if(e.domain===domain&&e.target_scope_digest===targetScopeDigest){if(e.from_state!==effective||e.to_state!=="shadow")reject("narrowing-transition");effective="shadow";} }
  if (!Number.isSafeInteger(ncp.minimum_entries) || ncp.minimum_entries < 0 || ncp.minimum_entries>n.entries.length || ncp.ledger_tail_digest!==previous) reject("narrowing-checkpoint");
  if (effective==="shadow" && !allowNarrowed) reject("binding-narrowed");
  const recovery=recoveryBindings.get(`${domain}:${targetScopeDigest}:${ids.recovery_worker}`); if(!recovery)reject("recovery-worker-binding");
  return { authorizationDigest:authDigest,coverageDigest:bindings.coverage_intent_digest,domain,targetScopeDigest,state:binding.state,effectiveState:effective,identities:ids,ownerAuthorityRef:binding.owner_authority_ref,ownerAuthorityDigest:binding.owner_authority_digest,configurationOwnerAuthorityRef:binding.configuration_owner_authority_ref,configurationOwnerAuthorityDigest:binding.configuration_owner_authority_digest };
}

/** Prove that a separately signed recovery append narrowed this exact journal/target. */
export function verifyW0NarrowingApplied(bundle: W0AuthorityBundle, prior: VerifiedW0Binding, journalReceiptDigest: string): void {
  const current = verifyW0Authority(bundle, prior.domain, prior.targetScopeDigest, true);
  if (current.effectiveState !== "shadow" || current.authorizationDigest !== prior.authorizationDigest || current.coverageDigest !== prior.coverageDigest) reject("narrowing-did-not-demote");
  const entry = bundle.runtimeNarrowing.entries.at(-1);
  if (!entry || entry.domain !== prior.domain || entry.target_scope_digest !== prior.targetScopeDigest || entry.from_state !== prior.state || entry.to_state !== "shadow" || entry.recovery_worker_identity !== prior.identities.recovery_worker || entry.journal_receipt_digest !== journalReceiptDigest) reject("narrowing-receipt-binding");
}

/** Shared fixtures exported for owning adapters; values are deliberately non-authorizing. */
export const R_EXACT_CONFORMANCE = Object.freeze({ constitutionDigest:W0_CONSTITUTION_DIGEST, phases:W0_JOURNAL_PHASES, domains:HUGIN_R_EXACT_DOMAINS, disarmedByDefault:true });
