---
title: "Orchestrator Sweep: Adopt vs DIY for Multi-Host Placement in Hugin"
slug: orchestrator-sweep
project: hugin
date: 2026-04-24
task_id: 20260424-210931-orchestrator-sweep
sensitivity: internal
tags:
  - research
  - orchestration
  - multi-host
  - placement
  - decision
summary_link: ~/mimir/reading/2026-04-24-orchestrator-sweep.md
reading_time_min: 25
---

# Orchestrator Sweep: Adopt vs DIY for Multi-Host Placement in Hugin

## Executive Summary

- **Recommendation: Stay DIY.** The next sprint is dominated by Grimnir-specific policy (sensitivity lattice, trust tiers, cost-ranked routing, capability filters) that no orchestrator expresses natively. The generic primitives needed (heartbeat, lease, peer-claim, failover) total approximately 400--600 LOC on top of the existing Hugin+Munin stack. ([Section: Recommendations](#recommendations))
- **Nomad is the best external candidate** if the fleet grows beyond 3--4 hosts or if generic scheduling primitives dominate future work. It scores highest on placement expressiveness, ARM64 support, and raw-process execution. But it brings BSL licensing risk and ~150 MB of binary weight for a problem that currently needs ~500 LOC. ([Section: Top-3 Shortlist](#top-3-shortlist))
- **Every durable-execution engine (Temporal, Cadence, Restate) is overweight** for this use case. They solve workflow-level durability, not host-level placement. Their server footprints (4+ GB RAM for Temporal) dwarf the Pi's budget. ([Section: Durable Execution Engines](#durable-execution-engines))
- **Task queues (BullMQ, Asynq, Celery, River, Faktory) solve the wrong layer.** They distribute work items to homogeneous workers. Grimnir needs heterogeneous placement with policy constraints. ([Section: Task Queues](#task-queues))
- **The DIY path is low-risk because 80% is already built.** The router (140 LOC) already implements sensitivity/trust/cost/capability filtering. What remains: `Host:` tag on tasks, peer-claim query, heartbeat interval, lease renewal, and failover promotion. ([Section: DIY Sketch](#diy-sketch))

---

## Background

### The Grimnir Fleet

Grimnir is a personal AI system running across owned hardware on a Tailscale mesh:

| Host | Arch | Role | Availability |
|------|------|------|-------------|
| Raspberry Pi 5 (huginmunin) | ARM64 Linux | Coordinator + execution | Always-on |
| MacBook Air M4 | ARM64 macOS (Apple Silicon) | Peer execution | Intermittent |
| Future Mac Studio | ARM64 macOS (Apple Silicon) | Peer execution | Always-on (planned) |

No cloud. No Kubernetes cluster. No containers required (runtimes are raw process spawns: Claude Code SDK, codex exec, ollama HTTP).

### What Is Already Built

Hugin is a Node/TypeScript task dispatcher (~10,000 LOC across 27 modules). Munin is an HTTP JSON-RPC state store serving as both source of truth and message bus. Tasks live at `tasks/<id>` in Munin with lifecycle tags (`pending`, `running`, `completed`, `failed`).

The **router** ([src/router.ts](https://github.com/magnusriga/hugin/blob/main/src/router.ts), 140 LOC) already implements the full policy chain:
1. Filter by trust tier (sensitivity ceiling)
2. Filter by availability
3. Filter by capabilities
4. Model affinity boost
5. Rank by cost > trust > model size

The **sensitivity module** ([src/sensitivity.ts](https://github.com/magnusriga/hugin/blob/main/src/sensitivity.ts)) classifies tasks into `public | internal | private` tiers.

### The Specific Question

Architecture shape is agreed: coordinator-for-decisions + peers-for-execution. Pi Hugin assigns `Host:` on each task; peer Hugins claim tasks with matching `Host:`. The open question is the **placement layer** underneath: adopt an existing orchestrator, or build the missing ~20% DIY on Munin?

### Policy Requirements

The placement layer MUST express:
- **Sensitivity tiers:** `public | internal | private` lattice. `private` runs only on trusted local hosts.
- **Trust tiers per runtime:** trusted, semi-trusted, cloud.
- **Cost-ranked routing:** free local > subscription > paid API.
- **Capability filters:** tools, code, structured-output.

---

## Findings

### Nomad (HashiCorp)

**Version:** 2.0.0 (latest as of April 2026)
**License:** [Business Source License 1.1](https://www.hashicorp.com/en/license-faq) (source-available, not open source)

**ARM64 story:** Excellent. Official binaries for [linux_arm64 and darwin_arm64](https://releases.hashicorp.com/nomad/2.0.0/). Single Go binary, ~150 MB.

**Execution model:** First-class [raw_exec driver](https://developer.hashicorp.com/nomad/docs/drivers/raw_exec) runs processes without any container isolation. Also supports Docker, exec (with cgroups), and Java drivers. raw_exec is disabled by default for security but trivially enabled in agent config.

**Deployment footprint:** Single binary. Server mode and client mode in the same binary. A 3-node server cluster is recommended for HA, but a single server works for development/small deployments. Embedded Raft consensus for leader election. No external database required (state is Raft-replicated).

**State store:** Built-in Raft-replicated state. Cannot defer to an external store. Nomad is authoritative over its own allocation state. This means Munin would be a **second** state store, not the primary one.

**Policy/placement model:** Rich. [Constraints](https://developer.hashicorp.com/nomad/docs/job-specification/constraint) (hard requirements) and [affinities](https://developer.hashicorp.com/nomad/docs/job-specification/affinity) (soft preferences with -100 to +100 weights). Node metadata, node classes, datacenter filtering, and [spread scheduling](https://www.hashicorp.com/en/blog/spreads-and-affinites-in-nomad). Could express sensitivity/trust/cost as node metadata with constraint expressions.

**Leader election:** Built-in via [Raft consensus](https://developer.hashicorp.com/nomad/docs/concepts/scheduling/how-scheduling-works). Automatic failover if server quorum is maintained.

**Governance health:** Nomad moved from MPL 2.0 to BSL 1.1 in August 2023. Now owned by IBM (post-HashiCorp acquisition). Active development continues but the BSL license means it is [not open source](https://infisical.com/blog/hashicorp-new-bsl-license). Community forks (OpenTofu for Terraform) exist but no Nomad fork has gained traction. Corporate capture risk is real.

### Durable Execution Engines

#### Temporal

**Version:** 1.30.4 (April 2026)
**License:** MIT (server), Apache 2.0 (SDKs)

**ARM64 story:** [CLI available for darwin_arm64 and linux_arm64](https://docs.temporal.io/cli/setup-cli). Server Docker images support multi-arch. However, running the server natively (non-Docker) on ARM64 Linux requires building from source.

**Execution model:** Workers are user processes that poll for tasks. [Activities can spawn subprocesses](https://docs.temporal.io/activity-execution), including raw process execution. Workers are NOT containers -- they are plain processes. However, the Temporal *server* itself is a heavy multi-service deployment.

**Deployment footprint:** The server requires [4 services](https://docs.temporal.io/self-hosted-guide/deployment): Frontend (2 CPU, 4 GB), History (4 CPU, 6 GB), Matching (1 CPU, 2 GB), Worker (0.5 CPU, 1 GB). Plus a database backend (PostgreSQL minimum). [Total recommended: ~8 CPU, 13 GB RAM](https://temporal.io/blog/tips-for-running-temporal-on-kubernetes). This is a non-starter on a Raspberry Pi 5 with 8 GB total.

**State store:** Requires [PostgreSQL, MySQL, or Cassandra](https://docs.temporal.io/self-hosted-guide/deployment). Cannot use Munin. Forces a parallel state store.

**Policy model:** Task queues with worker-side polling. No built-in placement constraints, affinities, or sensitivity-aware routing. All policy would need to be implemented in application code.

#### Cadence

**Version:** CNCF Sandbox (accepted May 2025)
**License:** MIT

Cadence is Temporal's predecessor (created at Uber, Temporal forked from it). Same architecture, same weight problem. Requires [Cassandra or PostgreSQL](https://cadenceworkflow.io/docs/get-started). Same multi-service deployment. Same resource requirements. ARM64 story is less clear -- no official ARM64 binaries found; Docker images may support multi-arch. Not evaluated further due to being strictly dominated by Temporal.

#### Restate

**Version:** [1.6.2](https://github.com/restatedev/restate/releases) (February 2026)
**License:** [Business Source License 1.1](https://github.com/restatedev/restate) (converts to Apache 2.0 after 4 years)

**ARM64 story:** Excellent. Official binaries for [aarch64-unknown-linux-musl and aarch64-apple-darwin](https://github.com/restatedev/restate/releases). Single Rust binary.

**Execution model:** [Services run as processes, containers, or serverless functions](https://docs.restate.dev/references/architecture). Restate server calls into your service handlers via HTTP. Your service is a plain process listening on a port. This is genuinely raw-process friendly.

**Deployment footprint:** Single binary server (~50 MB). Lightweight -- designed as a sidecar/coordinator, not a cluster. Embedded RocksDB for state. Reasonable for a Pi.

**State store:** Embedded RocksDB. Cannot defer to Munin as authoritative store. Restate manages its own journal and state. Dual state store problem.

**Policy model:** None. Restate is about durable execution (retry, exactly-once), not placement. No constraints, affinities, or sensitivity-aware routing. All policy logic would live in application code.

**Leader election:** Single-server mode only in OSS. No built-in multi-node leader election.

### Task Queues

#### BullMQ

**License:** MIT
**Language:** Node.js / TypeScript

**ARM64 story:** Pure JavaScript/TypeScript library. Runs anywhere Node runs, including ARM64 Linux and macOS. No native binaries.

**Execution model:** [Workers process jobs in-process or via sandboxed child processes](https://docs.bullmq.io/guide/workers). Can spawn subprocesses. Raw-process friendly.

**Deployment footprint:** Requires Redis. BullMQ itself is a library, not a server. Redis on ARM64 is well-supported.

**State store:** Redis is authoritative. Cannot use Munin. Dual store.

**Policy model:** [Priority queues](https://docs.bullmq.io/guide/queues), named queues, but no placement constraints, node affinity, or sensitivity-aware routing. Workers self-select which queues to process. All policy in application code.

**Leader election:** None built-in. Redis can be used for distributed locking, but no turnkey solution.

**Fit assessment:** BullMQ solves job distribution to homogeneous workers. Grimnir needs heterogeneous placement (Pi vs Mac, trusted vs semi-trusted, free vs paid). Wrong abstraction layer.

#### Celery

**License:** BSD
**Language:** Python

**ARM64 story:** Pure Python. Runs on ARM64 Linux and macOS wherever Python runs.

**Execution model:** Workers are Python processes. Can execute arbitrary callables. Supports [multiprocessing, eventlet, gevent](https://docs.celeryq.dev/en/stable/userguide/optimizing.html).

**Deployment footprint:** Requires a broker (RabbitMQ or Redis) and optionally a result backend. Not a single binary.

**State store:** Broker (RabbitMQ/Redis) is authoritative. Dual store.

**Policy model:** Named queues and routing keys. No placement constraints. Workers choose their queues. All placement logic in application code.

**Fit assessment:** Python-only. Hugin is TypeScript. Wrong language, wrong abstraction layer.

#### Asynq

**License:** MIT
**Language:** Go (library)

**ARM64 story:** Go library. Compiles to ARM64 natively. [13.2k stars on GitHub](https://github.com/hibiken/asynq).

**Execution model:** Go library -- task handlers run in-process. Can spawn subprocesses from handlers.

**Deployment footprint:** Requires [Redis 4.0+](https://github.com/hibiken/asynq). Library only, no standalone server.

**State store:** Redis. Dual store.

**Policy model:** Priority queues, task deduplication, but no placement/affinity primitives.

**Fit assessment:** Go library. Hugin is TypeScript. Would require rewriting the dispatcher in Go or running a sidecar. Wrong language.

#### River

**License:** MIT
**Language:** Go

**ARM64 story:** Go library. Compiles to ARM64. Uses PostgreSQL ([not Redis](https://riverqueue.com/)).

**Deployment footprint:** Requires PostgreSQL. Library only.

**State store:** PostgreSQL. Dual store.

**Fit assessment:** Go-only. Would require Go wrapper or full rewrite. Interesting architectural parallel (Postgres-as-queue mirrors Munin-as-queue) but wrong language.

#### Faktory

**License:** [Dual licensed](https://github.com/contribsys/faktory) (open-source + commercial)
**Language:** Go server, polyglot workers (Go, Ruby, Node, Python, Rust, Elixir)

**ARM64 story:** [Native arm64 builds available](https://github.com/contribsys/faktory/blob/main/Changes.md). Single Go binary server.

**Execution model:** Language-agnostic job server. Workers fetch and execute jobs as raw processes. [Node.js worker library available](https://github.com/jbielick/faktory_worker_node).

**Deployment footprint:** Single binary server with embedded RocksDB. Lightweight.

**State store:** Embedded RocksDB. Dual store.

**Policy model:** Named queues with priorities. No placement constraints or affinity.

**Fit assessment:** Closest task queue to being useful -- polyglot, single binary, lightweight. But still no placement model. Would be a dumb pipe that Hugin has to do all the routing for anyway.

### Workflow/Pipeline Orchestrators

#### Prefect

**License:** Apache 2.0
**Language:** Python

**ARM64 story:** Pure Python. [Self-hosted server available](https://docs.prefect.io/v3/advanced/self-hosted). ARM64 supported via Python.

**Deployment footprint:** Python server + PostgreSQL/SQLite. Web UI included. Moderate weight.

**Fit assessment:** Data pipeline orchestrator. DAG-oriented, Python-only. Wrong domain, wrong language.

#### Dagster

**License:** Apache 2.0
**Language:** Python

**ARM64 story:** Problematic. [Open GitHub issues requesting ARM64 Docker images](https://github.com/dagster-io/dagster/issues/17167). Native Python runs fine but the operational stack (dagster-daemon, dagster-webserver) has unresolved ARM64 container issues.

**Deployment footprint:** Multiple long-running services (webserver, daemon). PostgreSQL required.

**Fit assessment:** Asset-oriented data pipeline tool. Wrong domain entirely.

#### Airflow

**License:** Apache 2.0
**Language:** Python

**ARM64 story:** [Runs on Raspberry Pi 4](https://medium.com/@phutidus/apache-airflow-raspberry-pi-os-systemd-90ef3ed20a87) with some effort. [ARM64 Docker images available](https://hub.docker.com/r/apache/airflow).

**Deployment footprint:** Scheduler, webserver, metadata database, executor. Heavy for a Pi (recommended 4+ GB RAM for Airflow alone).

**Fit assessment:** DAG scheduler for batch data pipelines. No real-time task placement. Wrong domain.

#### Windmill

**License:** AGPLv3 (core), commercial (enterprise)
**Language:** Rust (server), polyglot workers

**ARM64 story:** [ARM64 supported for AWS/self-hosted deployments](https://www.windmill.dev/docs/advanced/self_host). Binary available.

**Deployment footprint:** Server + workers + PostgreSQL. [Rule of thumb: 1 worker per vCPU, 1-2 GB RAM](https://www.windmill.dev/docs/advanced/self_host).

**Fit assessment:** Internal tool builder / script runner. Interesting but overkill. AGPLv3 license is restrictive. No placement model.

#### n8n

**License:** [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md) (source-available)
**Language:** TypeScript

**ARM64 story:** Excellent. [Well-documented Raspberry Pi 5 deployment](https://medium.com/@sean.spaniel/hosting-n8n-on-a-raspberry-pi-5-d1f5da8cca82). ARM64 Docker images available.

**Deployment footprint:** Node.js server + PostgreSQL/SQLite.

**Fit assessment:** Visual workflow automation (Zapier alternative). Wrong domain entirely -- n8n orchestrates API integrations, not AI task dispatch.

### Cloud-Native / Developer Platforms

#### Inngest

**Version:** 1.18.0 (April 2025)
**License:** Apache 2.0

**ARM64 story:** Go binary. Self-hosting docs reference [single-command deployment](https://www.inngest.com/docs/self-hosting). ARM64 binary availability unclear from releases page (assets failed to load). Go cross-compilation makes it likely but unconfirmed.

**Execution model:** Event-driven. Inngest server pushes step executions to your service endpoints via HTTP. Services are plain processes.

**Deployment footprint:** [Single binary with embedded SQLite](https://www.inngest.com/docs/self-hosting). Zero dependencies for development. PostgreSQL + Redis for production.

**Policy model:** None for placement. Event-based routing only.

**Fit assessment:** Interesting architecture (event-driven, HTTP push to handlers) but no placement/scheduling primitives. Would be a less-capable version of what Munin+Hugin already do.

#### Hatchet

**Version:** 0.83.x (April 2026)
**License:** MIT

**ARM64 story:** [ARM64 binaries for Linux and Darwin](https://github.com/hatchet-dev/hatchet/releases).

**Execution model:** Workers connect to the Hatchet engine and process tasks. [DAG-based orchestration](https://docs.hatchet.run/home/orchestration).

**Deployment footprint:** Engine + PostgreSQL. Workers are separate processes.

**Policy model:** Task routing via worker labels and queue filtering. Basic affinity support.

**Fit assessment:** Closest to useful among the newer platforms. But pre-1.0, fast-moving API, and the placement model is worker-pull (workers choose their queues) not coordinator-push (coordinator assigns hosts). Wrong direction for Grimnir's coordinator model.

#### Trigger.dev

**Version:** v4 (2026)
**License:** Apache 2.0

**ARM64 story:** [Docker-based self-hosting](https://trigger.dev/blog/self-hosting-trigger-dev-v4-docker). ARM64 Docker support unclear.

**Execution model:** Container-centric. Tasks run in isolated containers on the Trigger.dev platform or self-hosted Docker.

**Fit assessment:** Container-required execution model. Dealbreaker for Grimnir.

### Infrastructure Schedulers

#### Kubernetes / K3s

**ARM64 story:** K3s is excellent on ARM64. [Single binary <85 MB, runs in 512 MB RAM](https://docs.k3s.io/reference/resource-profiling).

**Execution model:** Container-only. Pods are the unit of execution. No raw-process support without containerizing everything.

**Fit assessment:** Dealbreaker. Container-required. Also massive conceptual overhead for a 3-node personal system.

#### Docker Swarm

**ARM64 story:** [Works on Raspberry Pi ARM64](https://rpi4cluster.com/docker-swarm/docker-swarm-deploy/).

**Execution model:** Container-only. Services are Docker containers.

**Fit assessment:** Dealbreaker. Container-required. Also effectively deprecated (Docker is steering toward Kubernetes).

#### Apache Mesos

**ARM64 story:** Unclear. Mesos is [effectively defunct](https://mesos.apache.org/) -- moved to Apache Attic in 2024.

**Fit assessment:** Dead project. Not evaluated.

#### Ray

**License:** Apache 2.0
**Language:** Python

**ARM64 story:** [Problematic on Raspberry Pi](https://discuss.ray.io/t/unable-to-install-ray-on-arm64-on-prem-bare-metal-raspberry-pi-cluster-of-10-pis/13335). ARM64 wheels exist on PyPI but Pi deployment has documented failures and is unsupported.

**Deployment footprint:** Head node + worker nodes. Python-heavy. Designed for ML workloads with large memory requirements.

**Fit assessment:** ML compute framework. Wrong domain. Broken on Pi. Dealbreaker.

### Message Brokers (Build-Your-Own Layer)

#### NATS JetStream

**License:** Apache 2.0

**ARM64 story:** [Supported on ARM64 Linux](https://docs.nats.io/nats-concepts/jetstream). Single Go binary, ~20 MB.

**Execution model:** Message broker only. No execution model -- you build your own.

**Deployment footprint:** [Single binary, ~20 MB, sub-millisecond latency](https://onidel.com/blog/nats-jetstream-rabbitmq-kafka-2025-benchmarks). Extremely lightweight.

**State store:** Built-in JetStream persistence. Could coexist with Munin but would be a second store for queue state.

**Policy model:** Subject-based routing, queue groups, consumer filters. Expressive for message routing but no host-level placement primitives.

**Leader election:** Built-in Raft for JetStream cluster consensus.

**Fit assessment:** If we were building the placement layer from scratch without Munin, NATS JetStream would be the ideal message substrate. But we already have Munin as message bus (query-based claim pattern). Adding NATS would mean two message buses. The value-add over Munin's query API is: persistent work queues with exactly-once delivery, consumer groups, and built-in backpressure. These are real features but achievable in ~200 LOC of lease semantics on Munin.

#### RabbitMQ

**License:** MPL 2.0

**ARM64 story:** [Available on ARM64](https://www.rabbitmq.com/docs/platforms). Erlang runtime required.

**Deployment footprint:** Erlang VM + RabbitMQ server. Moderate weight.

**Fit assessment:** Message broker. Same analysis as NATS but heavier and with Erlang dependency. No advantage over Munin-as-bus.

### Configuration Management / Ad-Hoc

#### SaltStack

**License:** Apache 2.0

**ARM64 story:** Python-based, runs on ARM64.

**Execution model:** [Remote execution via ZeroMQ](https://docs.saltproject.io/en/latest/). Can run arbitrary commands on minions. Raw-process friendly.

**Deployment footprint:** Salt master + salt minion per host. Moderate.

**Fit assessment:** Configuration management tool with remote execution bolted on. Could dispatch tasks to hosts but has no scheduling, queuing, retry, or placement model. Wrong tool for the job.

#### Ansible AWX / Tower

**License:** Apache 2.0 (AWX)

**ARM64 story:** [ARM64 Docker images in progress](https://github.com/ansible/awx/issues/14643). Not reliably available.

**Execution model:** SSH-based remote execution. Playbooks, not task queues.

**Fit assessment:** Configuration management automation UI. Wrong domain.

#### Rundeck

**License:** Apache 2.0

**ARM64 story:** Java-based, runs on ARM64 JVM.

**Execution model:** SSH-based remote execution. Job scheduling UI.

**Fit assessment:** Operations runbook tool. Closer to the right shape but too focused on human-triggered operations, not automated task dispatch.

#### Sidekiq / Oban

**Sidekiq:** Ruby-only. Wrong language. **Oban:** Elixir-only. Wrong language. Both are excellent task queues in their respective ecosystems but require full runtime adoption. Not evaluated further.

#### systemd Transient Units

**ARM64 story:** Native on every Linux system. Not available on macOS.

**Execution model:** `systemd-run` creates transient service units. Can run arbitrary processes with resource limits, logging, and restart policies.

**Fit assessment:** Interesting for the Linux-only execution layer (Pi side). Could be used as the local process supervisor underneath Hugin. But no cross-host coordination, no macOS support for peer Macs. A useful implementation detail, not a placement layer.

---

## Comparison / Analysis

### Scoring Matrix

Criteria scored 0--3: 0 = dealbreaker, 1 = poor, 2 = adequate, 3 = excellent.

| Candidate | 1. ARM64 | 2. Raw-proc | 3. Pi weight | 4. Munin compat | 5. Policy model | 6. Leader/placement | 7. Ops complexity | 8. License | 9. Integration effort | **Total** |
|-----------|----------|-------------|-------------|-----------------|----------------|--------------------|--------------------|-----------|----------------------|-----------|
| **Nomad** | 3 | 3 | 2 | 1 | 3 | 3 | 2 | 1 | 1 (high LOC to bridge) | **19** |
| **Restate** | 3 | 3 | 3 | 1 | 0 | 1 | 3 | 1 | 2 | **17** |
| **NATS JetStream** | 3 | 3 | 3 | 1 | 1 | 2 | 2 | 3 | 2 | **20** |
| **Faktory** | 2 | 3 | 3 | 1 | 0 | 0 | 2 | 2 | 2 | **15** |
| **BullMQ** | 3 | 2 | 2 | 1 | 0 | 0 | 2 | 3 | 2 | **15** |
| **Inngest** | 2 | 3 | 3 | 1 | 0 | 0 | 2 | 3 | 2 | **16** |
| **Hatchet** | 3 | 2 | 2 | 1 | 1 | 1 | 2 | 3 | 2 | **17** |
| **Temporal** | 2 | 3 | 0 | 0 | 1 | 2 | 1 | 3 | 1 | **13** |
| **Cadence** | 1 | 3 | 0 | 0 | 1 | 2 | 1 | 3 | 1 | **12** |
| **Celery** | 3 | 2 | 2 | 1 | 0 | 0 | 2 | 3 | 1 | **14** |
| **Asynq** | 3 | 2 | 2 | 1 | 0 | 0 | 2 | 3 | 1 | **14** |
| **River** | 3 | 2 | 2 | 1 | 0 | 0 | 2 | 3 | 1 | **14** |
| **Prefect** | 3 | 2 | 1 | 0 | 0 | 1 | 1 | 3 | 1 | **12** |
| **Dagster** | 1 | 2 | 1 | 0 | 0 | 1 | 1 | 3 | 1 | **10** |
| **Airflow** | 2 | 1 | 1 | 0 | 0 | 1 | 1 | 3 | 1 | **10** |
| **Windmill** | 2 | 2 | 2 | 1 | 0 | 1 | 2 | 1 | 2 | **13** |
| **n8n** | 3 | 1 | 2 | 0 | 0 | 0 | 2 | 1 | 1 | **10** |
| **K3s** | 3 | 0 | 2 | 0 | 2 | 3 | 1 | 3 | 0 | **14** |
| **Docker Swarm** | 3 | 0 | 2 | 0 | 1 | 2 | 2 | 3 | 0 | **13** |
| **Ray** | 1 | 2 | 0 | 0 | 0 | 1 | 1 | 3 | 0 | **8** |
| **Trigger.dev** | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 3 | 1 | **7** |
| **SaltStack** | 3 | 3 | 2 | 1 | 0 | 0 | 2 | 3 | 2 | **16** |
| **Ansible AWX** | 1 | 2 | 1 | 0 | 0 | 0 | 1 | 3 | 1 | **9** |
| **Rundeck** | 2 | 2 | 1 | 0 | 0 | 1 | 2 | 3 | 1 | **12** |
| **systemd ad-hoc** | 3 | 3 | 3 | 2 | 0 | 0 | 2 | 3 | 2 | **18** |
| **DIY on Munin** | 3 | 3 | 3 | 3 | 3 | 2 | 3 | 3 | 3 | **26** |

### Dealbreaker Eliminations

Candidates scoring 0 on criteria 1 (ARM64) or 2 (raw-process execution) are eliminated:

- **K3s / Kubernetes:** Container-required (criterion 2 = 0)
- **Docker Swarm:** Container-required (criterion 2 = 0)
- **Trigger.dev:** Container-required (criterion 2 = 0), ARM64 unclear (criterion 1 = 1)
- **Ray:** ARM64 broken on Pi (criterion 1 effectively 0 for the primary host)

### Pattern Analysis

Three patterns emerge from the matrix:

**1. The placement-model gap.** No candidate except Nomad has a real placement model (constraints, affinities, node metadata). Every task queue and durable execution engine treats workers as homogeneous consumers pulling from queues. Grimnir's model is the opposite: a coordinator pushes tasks to specific heterogeneous hosts based on policy. This is the fundamental mismatch.

**2. The dual-store tax.** Every external system brings its own state store (Redis, PostgreSQL, Raft, RocksDB). Munin is already the source of truth. Adding a second authoritative store creates sync complexity, split-brain risk, and operational burden. The only candidate that avoids this is DIY (Munin stays authoritative) or systemd ad-hoc (stateless execution layer).

**3. The weight mismatch.** Temporal/Cadence need 13+ GB RAM. Even Nomad at 150 MB binary + Raft state is heavy for a system that currently needs ~500 LOC of additional logic. The Pi has 8 GB RAM shared between Hugin, Munin, ollama, and the OS.

---

## Recommendations

### Top-3 Shortlist

| Rank | Candidate | Score | Effort | Risk | When to choose |
|------|-----------|-------|--------|------|---------------|
| 1 | **DIY on Munin** | 26 | S (~500 LOC) | Low | Default recommendation. Policy layer is 80% done. |
| 2 | **Nomad** | 19 | L (~2000 LOC bridge + ops) | Medium | If fleet grows to 4+ hosts or generic scheduling dominates. |
| 3 | **NATS JetStream** | 20 | M (~800 LOC + new dependency) | Low | If Munin's query-based claim pattern hits performance limits at scale. |

#### Side-by-Side

| Dimension | DIY on Munin | Nomad | NATS JetStream |
|-----------|-------------|-------|----------------|
| Policy expressiveness | Full (you write it) | Constraints/affinities (close but needs mapping) | Subject-based routing (partial) |
| State authority | Munin (single store) | Nomad Raft (dual store) | JetStream (dual store) |
| Binary weight | 0 (already running) | ~150 MB | ~20 MB |
| Leader election | DIY or none (coordinator is fixed) | Built-in Raft | Built-in Raft |
| License | N/A (your code) | BSL 1.1 (risk) | Apache 2.0 |
| Operational complexity | Lowest | Moderate (agent per host) | Low-moderate |
| Time to first task dispatch | Days | Weeks | Week |

### Not a Fit

| Candidate | One-line reason |
|-----------|----------------|
| Temporal | Server requires 13+ GB RAM; non-starter on Pi 5. |
| Cadence | Same as Temporal but less mature and less supported. |
| Restate | Solves durable execution, not placement. No policy model. |
| BullMQ | Homogeneous worker queue. No placement or affinity. |
| Celery | Python-only. Wrong language for TypeScript codebase. |
| Asynq | Go library. Wrong language. |
| River | Go library. Wrong language. |
| Prefect | Python data pipeline tool. Wrong domain. |
| Dagster | Python data pipeline tool. ARM64 issues. |
| Airflow | Heavy batch scheduler. Wrong domain. |
| Windmill | Internal tool builder. AGPLv3. Overkill. |
| n8n | Visual workflow automation (Zapier clone). Wrong domain. |
| Trigger.dev | Container-required execution. Dealbreaker. |
| K3s | Container-required execution. Dealbreaker. |
| Docker Swarm | Container-required. Effectively deprecated. |
| Ray | Broken on Pi ARM64. ML-focused. |
| SaltStack | Config management. No scheduling/queuing/retry. |
| Ansible AWX | Config management UI. ARM64 unreliable. |
| Rundeck | Operations runbook tool. SSH-based. |
| Faktory | No placement model. No leader election. |
| Inngest | No placement model. ARM64 unconfirmed. |
| Hatchet | Worker-pull model (opposite of coordinator-push). Pre-1.0. |
| Sidekiq/Oban | Ruby/Elixir only. Wrong language. |

### Adopt vs DIY Recommendation

**Recommendation: Stay DIY.**

The trigger criterion was: *adopt if the next sprint is dominated by generic primitives (heartbeats, leader election, placement, backpressure, work-stealing); stay DIY if dominated by Grimnir-specific policy.*

Analysis of what the next sprint actually needs:

| Primitive | Generic or Grimnir-specific? | Already built? |
|-----------|------------------------------|---------------|
| Sensitivity-tier filtering | Grimnir-specific | Yes (sensitivity.ts) |
| Trust-tier ceiling | Grimnir-specific | Yes (router.ts) |
| Cost-ranked routing | Grimnir-specific | Yes (router.ts) |
| Capability filtering | Grimnir-specific | Yes (router.ts) |
| Host assignment | Grimnir-specific (policy-driven) | No (~50 LOC) |
| Peer claim query | Grimnir-specific (Munin query pattern) | No (~30 LOC) |
| Heartbeat/liveness | Generic | No (~100 LOC) |
| Lease renewal/expiry | Generic | No (~100 LOC) |
| Failover promotion | Semi-generic | No (~80 LOC) |
| Backpressure | Generic | No (~50 LOC) |
| Work-stealing | Generic | Not needed yet |
| Leader election | Generic | Not needed (fixed coordinator) |

The Grimnir-specific policy work is **already done** (router.ts, sensitivity.ts, runtime-registry.ts). The remaining generic primitives total ~360 LOC and are simple enough that adopting an orchestrator to avoid writing them would cost more in integration, operational complexity, and dual-store management.

The ratio is approximately 80% Grimnir-specific (done) / 20% generic (trivial). The trigger criterion clearly points to DIY.

### DIY Sketch

What the missing ~20% on top of Munin looks like:

#### 1. Host Assignment (~50 LOC)

The router already selects a runtime. Extend to also select a host:

```typescript
// In router.ts, after selecting runtime:
function assignHost(task: Task, runtime: RuntimeCandidate): string {
  // private tasks -> only huginmunin (Pi)
  if (task.sensitivity === 'private') return 'huginmunin';
  // Match runtime to host where it's available
  return runtime.host; // host field on RuntimeCandidate
}
```

Write `Host:<hostname>` tag to the task in Munin.

#### 2. Peer Claim Query (~30 LOC)

Each peer Hugin polls Munin for tasks assigned to it:

```typescript
async function claimTasks(myHost: string): Promise<Task[]> {
  const pending = await munin.query({
    tags: ['pending', `Host:${myHost}`],
    limit: 1,
  });
  if (pending.length > 0) {
    await munin.write(pending[0].namespace, 'status', {
      tags: ['running', `Host:${myHost}`, `claimed-by:${myHost}`],
    });
  }
  return pending;
}
```

#### 3. Heartbeat / Liveness (~100 LOC)

Each peer Hugin writes a heartbeat entry to Munin on a fixed cadence (every 30s):

```typescript
// peers/<hostname>/heartbeat
await munin.write('peers/' + hostname, 'heartbeat', {
  content: JSON.stringify({ timestamp: Date.now(), load: os.loadavg() }),
  valid_until: new Date(Date.now() + 90_000).toISOString(), // 3x interval
});
```

Coordinator reads heartbeats before assigning tasks. Stale heartbeat (>90s) = host considered offline.

#### 4. Lease Renewal / Expiry (~100 LOC)

Tasks in `running` state carry a lease expiry (Munin `valid_until`). Worker renews lease every 60s while executing. If lease expires without renewal, coordinator can re-assign:

```typescript
async function renewLease(taskId: string) {
  await munin.write(`tasks/${taskId}`, 'lease', {
    content: JSON.stringify({ renewed: Date.now() }),
    valid_until: new Date(Date.now() + 180_000).toISOString(),
  });
}
```

#### 5. Failover Promotion (~80 LOC)

Coordinator sweeps for tasks with expired leases and no recent heartbeat from assigned host:

```typescript
async function failoverSweep() {
  const running = await munin.query({ tags: ['running'], include_expired: true });
  for (const task of running) {
    const host = extractHostTag(task);
    const heartbeat = await munin.read(`peers/${host}`, 'heartbeat');
    if (isExpired(heartbeat)) {
      await munin.write(task.namespace, 'status', {
        tags: ['pending'], // Re-queue for reassignment
      });
      await munin.log(task.namespace, `Failover: ${host} unresponsive, re-queuing`);
    }
  }
}
```

#### 6. Backpressure (~50 LOC)

Simple concurrency limit per host. Before assigning, count running tasks for target host. If at limit, defer:

```typescript
const running = await munin.query({ tags: ['running', `Host:${host}`] });
if (running.length >= MAX_CONCURRENT[host]) {
  return null; // defer assignment
}
```

#### Total: ~410 LOC

All in TypeScript. All using Munin APIs that already exist. No new dependencies. No new binaries. No dual state store. Ships in 2-3 days.

### Decision-Reversal Checkpoints

Signals that would flip the call from DIY to adopting Nomad or NATS:

1. **Fleet grows beyond 4 hosts.** At 5+ nodes, the heartbeat/lease/failover logic starts looking like a poorly-reimplemented consensus protocol. Nomad's Raft becomes worth its weight.

2. **Work-stealing becomes necessary.** If idle hosts should proactively steal tasks from overloaded hosts, the coordination complexity jumps. Nomad's evaluation/allocation model handles this natively.

3. **Container execution becomes a requirement.** If future runtimes need isolation (e.g., running untrusted code), Nomad's exec/Docker drivers provide this without building a container layer.

4. **Munin query latency becomes a bottleneck.** If peer polling at 5s intervals with 10+ concurrent tasks causes unacceptable latency, NATS JetStream's push-based delivery model with persistent work queues would be a better substrate than polling.

5. **Multi-operator scenario.** If Grimnir ever has multiple human operators who need RBAC on task dispatch, Nomad's ACL system provides this. DIY on Munin does not.

6. **Nomad relicenses to Apache 2.0 or a credible fork emerges.** The BSL license is the main risk factor. If this resolves, the adoption case strengthens significantly.

---

## Uncertainty and Gaps

| Item | Nature of uncertainty | Impact |
|------|----------------------|--------|
| **Inngest ARM64 binaries** | GitHub releases page failed to load assets. Go binary likely cross-compiles to ARM64 but unconfirmed from primary sources. | Low (not a top candidate anyway). |
| **Cadence ARM64** | No official ARM64 binaries found. Docker multi-arch status unclear. | Low (eliminated on weight grounds). |
| **Trigger.dev ARM64** | Self-hosting is Docker-based. ARM64 Docker image availability unclear. | Low (eliminated: container-required). |
| **Dagster ARM64** | Open GitHub issues for ARM64 Docker images. Native Python works but operational stack untested. | Low (eliminated: wrong domain). |
| **Nomad 2.0 breaking changes** | Version 2.0 just released. Breaking changes from 1.x not fully assessed. raw_exec cgroup enforcement changes may affect unprivileged execution on Pi. | Medium (relevant if Nomad is adopted later). |
| **Hatchet stability** | Pre-1.0, fast-moving. API may change significantly. | Medium (relevant if re-evaluated). |
| **Munin query performance at scale** | Untested with 50+ concurrent tasks and 5s polling from 4+ peers. | Medium (would trigger NATS checkpoint). |

---

## Sources

- [HashiCorp Nomad raw_exec driver documentation](https://developer.hashicorp.com/nomad/docs/drivers/raw_exec) -- raw process execution without isolation
- [HashiCorp Nomad releases (v2.0.0)](https://releases.hashicorp.com/nomad/2.0.0/) -- ARM64 binary availability
- [HashiCorp Nomad constraint specification](https://developer.hashicorp.com/nomad/docs/job-specification/constraint) -- placement constraints
- [HashiCorp Nomad affinity specification](https://developer.hashicorp.com/nomad/docs/job-specification/affinity) -- soft placement preferences
- [HashiCorp Nomad scheduling placement](https://developer.hashicorp.com/nomad/docs/concepts/scheduling/placement) -- scheduling architecture
- [HashiCorp BSL license FAQ](https://www.hashicorp.com/en/license-faq) -- BSL 1.1 license terms
- [HashiCorp BSL license change analysis (Infisical)](https://infisical.com/blog/hashicorp-new-bsl-license) -- community impact assessment
- [Temporal self-hosted deployment guide](https://docs.temporal.io/self-hosted-guide/deployment) -- resource requirements
- [Temporal Kubernetes deployment tips](https://temporal.io/blog/tips-for-running-temporal-on-kubernetes) -- production resource sizing
- [Temporal CLI setup](https://docs.temporal.io/cli/setup-cli) -- ARM64 CLI availability
- [Temporal activity execution](https://docs.temporal.io/activity-execution) -- activity worker process model
- [Temporal worker documentation](https://docs.temporal.io/workers) -- worker architecture
- [Restate GitHub releases (v1.6.2)](https://github.com/restatedev/restate/releases) -- ARM64 binary availability
- [Restate architecture documentation](https://docs.restate.dev/references/architecture) -- service/handler execution model
- [Restate durable execution primer](https://www.restate.dev/blog/building-a-modern-durable-execution-engine-from-first-principles) -- design philosophy
- [BullMQ documentation](https://docs.bullmq.io) -- worker and queue architecture
- [BullMQ workers guide](https://docs.bullmq.io/guide/workers) -- execution model
- [Celery documentation](https://docs.celeryq.dev/) -- task execution architecture
- [Asynq GitHub repository](https://github.com/hibiken/asynq) -- project status, features, Redis dependency
- [River queue homepage](https://riverqueue.com/) -- Postgres-based Go job queue
- [Faktory GitHub repository](https://github.com/contribsys/faktory) -- language-agnostic job server
- [Faktory changelog](https://github.com/contribsys/faktory/blob/main/Changes.md) -- ARM64 support addition
- [Prefect self-hosting documentation](https://docs.prefect.io/v3/advanced/self-hosted) -- deployment architecture
- [Dagster ARM64 Docker image request](https://github.com/dagster-io/dagster/issues/17167) -- ARM64 support status
- [Airflow on Raspberry Pi (systemd guide)](https://medium.com/@phutidus/apache-airflow-raspberry-pi-os-systemd-90ef3ed20a87) -- ARM64 deployment
- [Airflow Docker Hub](https://hub.docker.com/r/apache/airflow) -- ARM64 image availability
- [Windmill self-hosting documentation](https://www.windmill.dev/docs/advanced/self_host) -- ARM64 deployment
- [n8n on Raspberry Pi 5](https://medium.com/@sean.spaniel/hosting-n8n-on-a-raspberry-pi-5-d1f5da8cca82) -- ARM64 deployment guide
- [Inngest self-hosting documentation](https://www.inngest.com/docs/self-hosting) -- single-binary deployment
- [Hatchet documentation](https://docs.hatchet.run/v1) -- task orchestration architecture
- [Hatchet GitHub releases](https://github.com/hatchet-dev/hatchet/releases) -- ARM64 binary availability
- [Trigger.dev v4 self-hosting](https://trigger.dev/blog/self-hosting-trigger-dev-v4-docker) -- Docker-based deployment
- [K3s resource profiling](https://docs.k3s.io/reference/resource-profiling) -- memory footprint on ARM64
- [K3s requirements](https://docs.k3s.io/installation/requirements) -- minimum resource requirements
- [Ray ARM64 Pi cluster discussion](https://discuss.ray.io/t/unable-to-install-ray-on-arm64-on-prem-bare-metal-raspberry-pi-cluster-of-10-pis/13335) -- deployment failures
- [NATS JetStream documentation](https://docs.nats.io/nats-concepts/jetstream) -- persistent streaming
- [NATS JetStream work-queue pattern](https://natsbyexample.com/examples/jetstream/workqueue-stream/go) -- queue semantics
- [NATS JetStream 2025 benchmarks](https://onidel.com/blog/nats-jetstream-rabbitmq-kafka-2025-benchmarks) -- performance data
- [Cadence workflow homepage](https://cadenceworkflow.io/) -- architecture overview
- [Cadence CNCF Sandbox acceptance](https://www.cncf.io/projects/cadence-workflow/) -- governance status
- [Docker Swarm Raspberry Pi deployment](https://rpi4cluster.com/docker-swarm/docker-swarm-deploy/) -- ARM64 support
- [Ansible AWX ARM64 images issue](https://github.com/ansible/awx/issues/14643) -- ARM64 status
- [Faktory Node.js worker](https://github.com/jbielick/faktory_worker_node) -- polyglot worker support
