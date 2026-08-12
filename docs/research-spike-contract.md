# Research-spike execution contract

Research work is fail-closed. A task tagged `type:research` is not a normal
text response: `completed` requires Hugin to have verified delivery of two
declared required artefacts and to have committed its three discovery records
to Munin.

The task envelope must declare, before `### Prompt`:

````markdown
- **Project:** grimnir
- **Research slug:** two-to-four-words
- **Sensitivity:** internal

### Artifacts

```json
[
  {"id":"detailed","local":"/home/magnus/scratch/two-to-four-words-detailed.md","remote":"magnus@100.99.119.52:/home/magnus/mimir-inbox/research/grimnir/2026-08-12-two-to-four-words.md","required":true},
  {"id":"popular","local":"/home/magnus/scratch/two-to-four-words-popular.md","remote":"magnus@100.99.119.52:/home/magnus/mimir-inbox/reading/2026-08-12-two-to-four-words.md","required":true}
]
```
````

The agent may write only the declared local staging files. It must not use
SSH/rsync or write Munin discovery records. After delivery succeeds, Hugin
writes `documents/<slug>/index`, `reading/<slug>/entry`, and
`projects/<project>/research-<slug>`. A rejected write fails the task.

The current Claude Agent SDK lane is explicitly read-only and does not provide
the required web/fetch/staging capability set. Hugin rejects research tasks on
that lane before execution. A future verified research executor is tracked in
issue #363; it must not bypass this contract.

Use Hugin's canonical `public`, `internal`, or `private` sensitivity values.
`restricted` is accepted only as a legacy alias and is normalized to `private`.
