# Hugin workload contract v1

This is Hugin's owner-side requirement declaration for [Hugin #289](https://github.com/Magnus-Gille/hugin/issues/289). It uses the byte-exact shared Grimnir node/substrate v1 artifacts recorded in [workload-requirement-v1.provenance.json](workload-requirement-v1.provenance.json). It is a dry-run planning boundary, not authorization to move production Hugin.

`workload-requirement-v1.json` is the complete v1 record. The contract preserves the shared schema's meaning: Hugin validates the schema and fixtures directly; it does not add a Hugin-only schema, hidden fields, or decision-driving overlay.

## Genuine Hugin requirements

- Node.js must run the built dispatcher on either declared architecture. The public contract deliberately does not claim a current Node version or package manager as a node capability; the deployment overlay must provide the repository's supported runtime.
- Hugin requires durable, owner-controlled state: its accepted deployment marker, service-local durable output, and recoverable Munin task/result state. `backup_restore: required` means a move cannot promote without a component-owned restore and verification result.
- Hugin requires the public health port 3032, the dispatcher service plus its daily-exam and experiment-cadence units/timers, owner-only secrets, and reachable Munin. Mimir/NAS delivery and the M5 gateway are separately named external dependencies because artifact delivery and M5-backed work must not be assumed locally available.
- Preflight and verification are read-only. Drain is mutating and must stop new claims, reconcile owned work to a bounded safe state without dropping it, and compensate back to the verified baseline on timeout, failure, or partial completion. Verify covers service health, polling, queue state, Codex sandbox/tool availability, both timers, durable paths, and the accepted deployment marker. Compensation restores that marker and persistent state before any later attempt.

The existing dispatcher/recovery and deployment gates implement parts of these checks today; this document does not claim that a generic Brokkr hook runner or production relocation exists.

## Control-node locality is not a workload requirement

The current Pi control deployment is systemd-based, uses private owner-overlay paths and credentials, and presently performs deployment from its established checkout. Those are control-node/local-overlay facts, not portable requirements to encode as hostnames, paths, Wi-Fi names, service-manager identity, or credentials in this public record. A target may translate the named units/timers into its owner-controlled service manager; that translation needs fresh target evidence and owner review.

Similarly, Hugin currently makes claim decisions on its deployed control node. This is a locality assumption of the current topology, not evidence that every Hugin requirement is Pi-only. A target may host the same control process only after the declared drain, persistence, dependency, verification, and rollback requirements are satisfied. No production task-routing or execution relocation is enabled by this contract.

## M5 dry-run compatibility

The shared synthetic `fixture-m5` record is intentionally public-safe test data, not a current M5 observation. It demonstrates that an arm64, 10-core, 16-GiB, launchd-managed target can be schema-compatible with Hugin's declared arm64 requirement; its evidence expired on 2026-07-23 and cannot support a current placement decision.

Therefore this dry run is **not promoted**. It has no live host observation, mount/transport result, secret overlay, deployment translation, drain result, service verification, restore evidence, or production approval. A future planner must bind a fresh Brokkr `node-capability` record and a Grimnir placement intent to the exact Hugin revision before any mutating lifecycle attempt.

| Remaining incompatibility or evidence gap | Owning repo |
| --- | --- |
| Fresh M5 architecture, resources, service-manager, network/storage and realization evidence | Brokkr |
| Desired Hugin→M5 placement intent and bound revision | Grimnir |
| Owner-only service-manager/deployment overlay, drain/compensation execution, health/polling/queue/sandbox/timer/durable-path verification, and marker/state restore | Hugin |
| NAS/Mimir artifact-delivery reachability, storage and restore evidence | Mimir and Brokkr |
| M5 gateway admission/capability evidence for M5-backed task execution | gille-inference |

This table is a dependency map, not a claim that any owner has failed or that live evidence was inspected. It deliberately names no private locators or credentials.
