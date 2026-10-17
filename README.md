# Hugin

Task dispatcher for the [Grimnir](https://github.com/Magnus-Gille/grimnir) personal AI system. Named after Odin's raven of thought.

Polls [Munin](https://github.com/magnusgille/munin-memory) for pending tasks, spawns AI runtimes to execute them, and writes results back. Submit tasks from any Claude environment (Desktop, Web, Mobile, Code) — Hugin picks them up and runs them on the Pi.

## Quick start

```bash
npm install
npm run build
MUNIN_API_KEY=<key> npm run dev
```

## Submitting a task

From any environment with Munin access:

```
memory_write(
  namespace: "tasks/my-task-id",
  key: "status",
  content: "## Task: Hello world\n\n- **Runtime:** claude\n- **Timeout:** 60000\n\n### Prompt\nEcho hello world",
  tags: ["pending", "runtime:claude"]
)
```

## Checking results

```
memory_read("tasks/my-task-id", "result")
```

## Task workspaces

On the Pi, `repo:<name>` uses `/home/magnus/hugin-workspace/<name>`. The default,
`scratch`, and `files` contexts use `_default`, `_scratch`, and `_files` beneath
`/home/magnus/hugin-workspace`. The deploy script creates these directories without
moving or deleting existing paths. `HUGIN_REPOS_ROOT`, `HUGIN_WORKSPACE`,
`HUGIN_SCRATCH`, and `HUGIN_FILES` can configure the roots.

Absolute legacy working directories must be inside a configured task root and disjoint
from Hugin's source, live repository, deployment, and service-configuration paths.
Unsafe declarations are rejected before checkout or executor dispatch. This admission
check does not confine the runtimes' wider filesystem permissions or prevent a same-UID
path swap after validation.

## Deploy to Pi

```bash
./scripts/deploy-pi.sh
```

## License

MIT
