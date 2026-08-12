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

The Claude Agent SDK, generic Pi-harness, and auto lanes are explicitly rejected
before execution. The only permitted executor is an explicit `Runtime: research`
task. It launches the pinned Pi CLI on Hugin's Pi behind Bubblewrap, binds only
the two pre-created artifact files writable, disables all built-in/ambient tools,
and loads the Hugin-owned extension with exactly `web_search`, `fetch_content`,
and `write_artifact`. Search/fetch use configured absolute helpers; fetched URLs
are checked against the public-host SSRF policy before helper invocation. The
model provider is the local M5 OpenAI-compatible gateway (`m5-local`) and its
API key is referenced through the child environment, never persisted in config.
Hugin still performs delivery verification and all three Munin writes.

If Pi, Bubblewrap, the M5 gateway, or either helper is unavailable, Hugin fails
before model spend. There is no fallback to Claude, OpenRouter, or Pi Ollama.

The Pi deploy installs the exact-pinned `@earendil-works/pi-coding-agent@0.84.1`
package and verifies `bwrap` before restarting Hugin. Deployments must provide
an M5 gateway through the existing `HOMESERVER_GATEWAY_URL` and
`HOMESERVER_GATEWAY_API_KEY` settings (dedicated `HUGIN_RESEARCH_M5_URL` and
`HUGIN_RESEARCH_M5_API_KEY` overrides are optional), plus reviewed absolute
`HUGIN_RESEARCH_SEARCH_HELPER` and `HUGIN_RESEARCH_FETCH_HELPER` commands. The runtime
defaults to `/home/magnus/repos/hugin/scripts/research-web-search.mjs` and
`/home/magnus/repos/hugin/scripts/research-web-fetch.mjs` when those files are
present. Helpers must accept one JSON object on stdin, return one JSON object on
stdout, enforce public-host SSRF policy including redirect/DNS checks, and bound
response size and time. No helper may receive the dispatcher environment or
write anything except its stdout.

Use Hugin's canonical `public`, `internal`, or `private` sensitivity values.
`restricted` is accepted only as a legacy alias and is normalized to `private`.
