# Harness² round 2 protocol contract

`src/learning/harness2-round2-schema.ts` defines a content-blind preregistration
validator and deterministic schedule for the bounded Harness² round-2 pilot.
The protocol contains three fresh tasks and two held-out tasks, each bound to a
repository, base SHA, task SHA, and verifier SHA. It fixes three repetitions,
the four arms (`PiFresh`, `HarnessFresh`, `PiLearned`, and `HarnessLearned`),
and one shared per-task allowance for input tokens, output tokens, wall time,
and attempts. The derived schedule has 18 fresh cells and 24 transfer cells.

Drafts may leave the learned artifact pending while task and evaluator fixtures
are prepared. A frozen `fresh` admission may also prepare that artifact; a
frozen `transfer` admission requires its SHA-256 hash, sourced only from fresh
task IDs, and requires that hash to equal both learned prompt hashes. Every
primary criterion must be frozen, every arm must use the same OpenAI
subscription model at high effort, total reported tokens must include input,
output, cache-read, and cache-write components, and the canonical protocol hash
must match. Mutable version markers, non-owner/repository task bindings, task
collisions (repository, base SHA, and task SHA define identity even when
verifier SHAs differ), holdout overlap, unequal caps, and one-axis contrast
failures are rejected. All nested version bindings are checked for mutable
branch aliases. Existing one-axis configuration validation remains the
authority for the linked Pi/Harness and fresh/learned contrasts.

Schema validation is a preregistration gate only. It does not qualify the host,
provider, model, authentication route, evaluator, or execution reliability and
does not make any adoption or promotion decision. Before launch, an external
host/provider qualifier must supply a sanitized, hash-bound receipt for the
actual execution profile, and independent receipts must cover raw candidate
acceptance, blinded review, resource accounting, and infrastructure failures.
No runner, store, promotion, production-routing, or automatic-promotion action
is performed by this contract.
