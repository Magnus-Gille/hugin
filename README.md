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

## Deploy to Pi

```bash
./scripts/deploy-pi.sh
```

## License

MIT
