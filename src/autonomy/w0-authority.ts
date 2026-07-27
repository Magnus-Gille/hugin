/** Offline-verifiable Grimnir ADR-008/W0.1 authority contract. */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { canonicalizeJcs } from "../jcs.js";
import { canonicalW0AuthoritySchemaErrors } from "./grimnir-w0-schemas.js";

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
function bounded(value: unknown): void {
  let nodes = 0;
  const walk = (current: unknown, depth = 0): void => {
    if (++nodes > 10_000 || depth > 64) reject("structural-limits");
    if (current && typeof current === "object") {
      for (const child of Object.values(current)) walk(child, depth + 1);
    }
  };
  walk(value);
  if (Buffer.byteLength(canonicalizeJcs(value)) > 1_000_000) {
    reject("structural-limits");
  }
}
const allDomains = [
  "micro-routing", "macro-routing", "prompt", "harness", "tool-policy",
  "served-model-roster", "no-reboot-security-bugfix-maintenance",
  "credentials-and-auth", "owner-policy", "constitution-and-safety-gates",
  "deployments-and-code", "privacy-retention-and-erasure", "firmware",
  "remote-recovery", "model-weight-training", "irreversible-external-actions",
  "package-downgrade",
] as const;
const protectedDomains = allDomains.slice(7);
const classPolicy: Record<string, { owner: string; recovery: string }> = {
  "micro-routing": { owner: "gille-inference", recovery: "R-exact" },
  "macro-routing": { owner: "hugin", recovery: "R-exact" },
  prompt: { owner: "owning-component", recovery: "R-exact" },
  harness: { owner: "owning-component", recovery: "R-exact" },
  "tool-policy": { owner: "owning-component", recovery: "R-exact" },
  "served-model-roster": { owner: "gille-inference", recovery: "R-exact" },
  "no-reboot-security-bugfix-maintenance": {
    owner: "brokkr",
    recovery: "R-forward",
  },
};
function validateConstitution(value: any): void {
  if (
    !exactKeys(value, [
      "kind", "schema_version", "constitution_id", "issued_at",
      "promotion_mode", "protected_lanes", "safety_floors",
      "autonomous_classes", "constitution_digest", "extensions",
    ])
    || value.kind !== "autonomy-constitution"
    || value.schema_version !== "v1"
    || value.constitution_id !== "grimnir-autonomy-v1"
    || value.promotion_mode !== "mechanical-for-covered-classes-only"
    || !Number.isFinite(Date.parse(value.issued_at))
    || !Array.isArray(value.extensions)
    || value.extensions.length
    || value.constitution_digest !== W0_CONSTITUTION_DIGEST
    || value.constitution_digest !== w0Digest(value, "constitution_digest")
  ) reject("constitution-shape");
  if (
    !Array.isArray(value.protected_lanes)
    || canonicalizeJcs([...value.protected_lanes].sort())
      !== canonicalizeJcs([...protectedDomains].sort())
    || !exactKeys(value.safety_floors, [
      "fail_closed", "kill_switch", "fresh_evidence", "unique_identity",
      "content_blind_journal", "observer_cannot_actuate", "unknown_disarms",
      "success_preserves_arming", "recovery_worker_disarms",
      "coverage_widening_owner_controlled", "recovery_worker_may_only_narrow",
      "protected_lanes_never_promote",
    ])
    || !Object.values(value.safety_floors).every((item) => item === true)
    || !Array.isArray(value.autonomous_classes)
    || value.autonomous_classes.length !== 7
  ) reject("constitution-semantics");
  const seen = new Set<string>();
  for (const row of value.autonomous_classes) {
    if (
      !exactKeys(row, [
        "class", "required_for_levels", "owner_scope", "owner",
        "owner_binding_source", "admission", "recovery_class", "bounds",
        "required_identity_roles", "success_postconditions",
        "recovery_postconditions", "fault_injection_requirements",
      ])
      || !classPolicy[row.class]
      || seen.has(row.class)
      || row.owner !== classPolicy[row.class].owner
      || row.recovery_class !== classPolicy[row.class].recovery
      || row.owner_binding_source !== "owner-controlled-coverage-registry"
      || row.admission !== "mechanical-after-all-predicates"
      || !exactKeys(row.bounds, [
        "max_concurrent_targets", "canary_only_until_armed_fleet",
        "deadline_seconds", "watch_seconds", "max_attempts",
        "min_seconds_between_attempts", "max_attempts_per_window",
        "attempt_window_seconds", "max_silence_seconds",
        "trusted_watchdog_time_required",
      ])
      || row.bounds.max_concurrent_targets !== 1
      || row.bounds.max_attempts !== 1
      || row.bounds.max_attempts_per_window !== 1
      || row.bounds.trusted_watchdog_time_required !== true
      || canonicalizeJcs([...row.required_identity_roles].sort())
        !== canonicalizeJcs([
          "controller", "kill-switch", "owner", "recovery-worker", "watchdog",
        ])
    ) reject("constitution-class");
    seen.add(row.class);
  }
}

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
  if (canonicalW0AuthoritySchemaErrors(bundle).length) reject("schema");
  const { constitution:c, coverageIntent:cov, ownerAttestations:att, recoveryWorkerRegistry:rr, ownerAuthorization:a, authorizationCheckpoint:cp, runtimeNarrowing:n, narrowingCheckpoint:ncp } = bundle;
  for (const artifact of [c, cov, att, rr, a, cp, n, ncp]) bounded(artifact);
  if (!HUGIN_R_EXACT_DOMAINS.includes(domain) || !digestPattern.test(targetScopeDigest)) reject("invalid-target");
  validateConstitution(c);
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
  if (!exactKeys(cov,["kind","schema_version","registry_id","issued_at","constitution_digest","mutation_policy","global_state","domains","registry_digest","extensions"])||cov.kind!=="autonomy-coverage-registry"||cov.schema_version!=="v1"||cov.constitution_digest!==W0_CONSTITUTION_DIGEST||cov.mutation_policy!=="owner-widen-recovery-worker-narrow"||!Array.isArray(cov.domains)||cov.domains.length!==17||new Set(cov.domains.map((x:any)=>x.domain)).size!==17||canonicalizeJcs(cov.domains.map((x:any)=>x.domain).sort())!==canonicalizeJcs([...allDomains].sort())||!Array.isArray(cov.extensions)||cov.extensions.length||!Number.isFinite(Date.parse(cov.issued_at))) reject("coverage-shape");
  for(const domainRow of cov.domains){if(!exactKeys(domainRow,["domain","required_for_levels","owner_scope","owner","recovery_class","coverage","target_state","bindings"])||!Array.isArray(domainRow.required_for_levels)||!Array.isArray(domainRow.bindings)||domainRow.bindings.length>32)reject("coverage-domain-shape");const policy=classPolicy[domainRow.domain];if(policy){if(domainRow.owner!==policy.owner||domainRow.recovery_class!==policy.recovery||domainRow.target_state!=="armed-canary")reject("coverage-domain-semantics");}else if(!protectedDomains.includes(domainRow.domain)){reject("coverage-domain-semantics");}else if(canonicalizeJcs([domainRow.required_for_levels,domainRow.owner_scope,domainRow.owner,domainRow.recovery_class,domainRow.coverage,domainRow.target_state,domainRow.bindings])!==canonicalizeJcs([["permanent"],"owner-only","owner","none","protected","never-mechanical",[]]))reject("protected-domain-semantics");const targetDigests=new Set<string>();for(const coverageBinding of domainRow.bindings){if(!exactKeys(coverageBinding,["writer_owner","owner_authority_ref","owner_authority_digest","configuration_owner","configuration_owner_authority_ref","configuration_owner_authority_digest","target_scope_digest","state","identities"])||!digestPattern.test(coverageBinding.owner_authority_digest)||!digestPattern.test(coverageBinding.configuration_owner_authority_digest)||!digestPattern.test(coverageBinding.target_scope_digest)||coverageBinding.writer_owner!==coverageBinding.configuration_owner||targetDigests.has(coverageBinding.target_scope_digest))reject("coverage-binding-shape");targetDigests.add(coverageBinding.target_scope_digest);}}
  if (!exactKeys(att,["kind","schema_version","registry_id","issued_at","issuer_identity","mutation_policy","attestations","registry_digest","extensions"])||att.kind!=="autonomy-owner-attestation-registry"||att.schema_version!=="v1"||att.issuer_identity!=="grimnir-owner"||att.mutation_policy!=="owner-controlled-protected-lane"||!Array.isArray(att.attestations)||att.attestations.length<4||att.attestations.length>64||!Array.isArray(att.extensions)||att.extensions.length||!Number.isFinite(Date.parse(att.issued_at))) reject("attestation-shape");
  const attestationIds=new Set<string>(),attestationTargets=new Set<string>();for(const item of att.attestations){if(!exactKeys(item,["attestation_id","domain","target_scope_digest","configuration_owner","issued_at","attestation_digest"])||!idPattern.test(item.attestation_id)||!HUGIN_R_EXACT_DOMAINS.concat(["micro-routing","served-model-roster","no-reboot-security-bugfix-maintenance"] as any).includes(item.domain)||!digestPattern.test(item.target_scope_digest)||item.attestation_digest!==w0Digest(item,"attestation_digest")||!Number.isFinite(Date.parse(item.issued_at))||attestationIds.has(item.attestation_id)||attestationTargets.has(`${item.domain}:${item.target_scope_digest}`))reject("attestation-entry");attestationIds.add(item.attestation_id);attestationTargets.add(`${item.domain}:${item.target_scope_digest}`);}
  if (cov.global_state!=="armed") reject("global-disarmed");
  const matchingRows=cov.domains.filter((x:any)=>x.domain===domain); const row=matchingRows[0]; const matchingBindings=row?.bindings?.filter((x:any)=>x.target_scope_digest===targetScopeDigest)??[]; const binding=matchingBindings[0];
  if (matchingRows.length!==1 || matchingBindings.length!==1 || !exactKeys(row,["domain","required_for_levels","owner_scope","owner","recovery_class","coverage","target_state","bindings"]) || !exactKeys(binding,["writer_owner","owner_authority_ref","owner_authority_digest","configuration_owner","configuration_owner_authority_ref","configuration_owner_authority_digest","target_scope_digest","state","identities"]) || !["armed-canary","armed-fleet"].includes(row.coverage) || binding.state!==row.coverage || binding.writer_owner!=="hugin" || binding.configuration_owner!=="hugin") reject("coverage-binding");
  const ids=binding.identities; if (!exactKeys(ids,["owner","controller","watchdog","kill_switch","recovery_worker"]) || new Set(Object.values(ids)).size!==5 || !Object.values(ids).every((x)=>typeof x==="string"&&idPattern.test(x))) reject("five-identities");
  const matchingAttestations=att.attestations.filter((x:any)=>x.attestation_id===binding.configuration_owner_authority_ref?.slice(4)); const ownerAtt=matchingAttestations[0];
  if (matchingAttestations.length!==1 || !exactKeys(ownerAtt,["attestation_id","domain","target_scope_digest","configuration_owner","issued_at","attestation_digest"]) || ownerAtt.domain!==domain || ownerAtt.target_scope_digest!==targetScopeDigest || ownerAtt.configuration_owner!=="hugin" || ownerAtt.attestation_digest!==binding.configuration_owner_authority_digest || !Number.isFinite(Date.parse(ownerAtt.issued_at))) reject("owner-attestation");
  if(!exactKeys(rr,["kind","schema_version","registry_id","entries","registry_digest","extensions"])||rr.kind!=="autonomy-recovery-worker-registry"||rr.schema_version!=="v1"||!idPattern.test(rr.registry_id)||!Array.isArray(rr.entries)||rr.entries.length>256||!Array.isArray(rr.extensions)||rr.extensions.length)reject("recovery-registry-shape");
  const recoveryBindings=new Map<string,any>(), recoveryFingerprints=new Set<string>();for(const x of rr.entries){if(!exactKeys(x,["domain","target_scope_digest","recovery_worker_identity","public_key_pem","public_key_fingerprint"])||!idPattern.test(x.recovery_worker_identity)||!digestPattern.test(x.target_scope_digest))reject("recovery-binding-shape");const k=createPublicKey(x.public_key_pem);const fp=`sha256:${createHash("sha256").update(k.export({type:"spki",format:"der"})).digest("hex")}`;if(k.asymmetricKeyType!=="ed25519"||fp!==x.public_key_fingerprint||recoveryFingerprints.has(fp))reject("recovery-key");const identity=`${x.domain}:${x.target_scope_digest}:${x.recovery_worker_identity}`;if(recoveryBindings.has(identity))reject("ambiguous-recovery-binding");recoveryBindings.set(identity,{...x,key:k});recoveryFingerprints.add(fp);}
  if (!exactKeys(n,["kind","schema_version","ledger_id","owner_authorization_digest","entries","extensions"])||n.kind!=="autonomy-runtime-narrowing"||n.schema_version!=="v1"||!idPattern.test(n.ledger_id)||!Array.isArray(n.entries)||n.entries.length>4096||!Array.isArray(n.extensions)||n.extensions.length||n.owner_authorization_digest!==authDigest || !exactKeys(ncp,["kind","schema_version","owner_authorization_digest","ledger_tail_digest","minimum_entries"])||ncp.kind!=="autonomy-runtime-narrowing-checkpoint"||ncp.schema_version!=="v1"||ncp.owner_authorization_digest!==authDigest) reject("narrowing-authorization");
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
  const entries = bundle.runtimeNarrowing.entries.filter((entry:any) => entry.domain === prior.domain && entry.target_scope_digest === prior.targetScopeDigest && entry.from_state === prior.state && entry.to_state === "shadow" && entry.recovery_worker_identity === prior.identities.recovery_worker && entry.journal_receipt_digest === journalReceiptDigest);
  if (entries.length !== 1) reject("narrowing-receipt-binding");
}

/** Locate one exact authenticated narrowing receipt in any protected epoch. */
export function verifyW0NarrowingReceipt(bundle: W0AuthorityBundle, domain: HuginRExactDomain, targetScopeDigest: string, journalReceiptDigest: string): VerifiedW0Binding {
  const binding = verifyW0Authority(bundle, domain, targetScopeDigest, true);
  verifyW0NarrowingApplied(bundle, binding, journalReceiptDigest);
  return binding;
}

/** Shared fixtures exported for owning adapters; values are deliberately non-authorizing. */
export const R_EXACT_CONFORMANCE = Object.freeze({ constitutionDigest:W0_CONSTITUTION_DIGEST, phases:W0_JOURNAL_PHASES, domains:HUGIN_R_EXACT_DOMAINS, disarmedByDefault:true });
