# Pi Herdsman for OMP

![Pi Herdsman: asynchronous Pi subagents and agent fleet orchestration](docs/assets/banner.webp)

[![npm](https://img.shields.io/npm/v/pi-herdsman)](https://www.npmjs.com/package/pi-herdsman)
[![Validate](https://github.com/boadij/pi-herdsman/actions/workflows/validate.yml/badge.svg?branch=main)](https://github.com/boadij/pi-herdsman/actions/workflows/validate.yml)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-blue)](https://github.com/boadij/pi-herdsman/actions/workflows/validate.yml)
[![License](https://img.shields.io/npm/l/pi-herdsman)](LICENSE)

**The orchestration layer between [oh-my-pi](https://github.com/can1357/oh-my-pi) and [herdr](https://github.com/herdrdev/herdr).**

This checkout runs OMP sessions, including delegated Agents and managed Leads.
OMP owns each coding-agent conversation; herdr owns processes, panes, workspaces, and worktree
placement; Herdsman connects them through delegation, ownership, supervision,
and project orchestration.

## Demo

_Realtime live demo of a manager > lead > agent workflow._

[![Live demo](https://github.com/user-attachments/assets/e1355ace-aaba-418e-a1d0-1246f1840fc6)](https://github.com/user-attachments/assets/d6ee6687-a96d-493e-ae75-429f586be393)

## What Pi Herdsman gives you

- **Background Agents.** Delegate bounded work without blocking the Lead conversation.
- **Parallel and nested delegation.** Run independent work concurrently and let explicitly enabled Agents delegate their own bounded subtasks.
- **Project orchestration.** A Manager coordinates durable branch-based work across independent Leads and their Agent trees.
- **Direct supervision.** Chief, Manager, Lead, and Agent responsibilities stay explicit instead of collapsing into one global controller.
- **Owned usage visibility.** Inspect Pi-native token usage and cost for the current session and its transitively owned managed Agents. An active Manager also sees the Leads in its current durable project assignments and their owned Agent trees.
- **Your workflow stays yours.** Bring your own Agent definitions, models, tools, skills, extensions, and development process.

## Quick start

Requires OMP 18.12.3 or newer and Herdr 0.9.1 or newer. Install this checkout:

```sh
npm ci --ignore-scripts
npm run build
omp plugin link .
herdr integration install omp
```

The `omp.extensions` manifest loads the bundle so parent and child build fingerprints cover the complete runtime.
The upstream `install.sh` and Docker recipes install Pi, not this OMP checkout.

Start Herdr in your project, then start OMP inside its pane:

```sh
herdr
omp
```

Delegate naturally:

```text
Use scout to inspect the authentication flow.
```

The Agent runs asynchronously while the Lead conversation stays available.
Open the human Agent-management surface at any time with:

```text
/agents
```

It also exposes `Session stats` for the current Pi session and its owned Agent sessions; in active Manager mode, it includes current assigned project Leads and their owned Agent trees.

See [Getting started](docs/getting-started.md) for prerequisites, configuration,
observability, and the complete first-use path.

## From one Agent to a project

A normal Pi session is a **Lead**. It owns the Agents it delegates:

```text
You ↔ Lead
      ├─ Agent
      │  └─ Agent
      └─ Agent
```

For independent project work, an eligible Lead can enter **Manager** mode.
Managers coordinate Leads instead of implementing through Agents themselves:

```text
You ↔ Manager
      ├─ Lead → Agents
      └─ Lead → Agents
```

A **Chief** is an optional runtime-wide supervisor above Managers. Without an
active Manager for a project, Chief can directly supervise its ordinary Leads.

The important boundaries are:

```text
supervision: Chief → Manager → Lead
ownership: Lead → Agent → Agent
```

Project work is durable by Git branch. It does not belong to the Manager session
that happened to start it, so assignments can be paused, resumed, or retired
across Manager turnover.

See [Coordination](docs/concepts/coordination.md) for the mental model and
[Project orchestration](docs/guides/project-orchestration.md) for the Manager
workflow.

## Choose your next step

| Goal                                       | Start here                                                    |
| ------------------------------------------ | ------------------------------------------------------------- |
| Install and delegate your first task       | [Getting started](docs/getting-started.md)                    |
| Run independent branch-based project work  | [Project orchestration](docs/guides/project-orchestration.md) |
| Understand roles, ownership, and authority | [Coordination](docs/concepts/coordination.md)                 |
| Customize Agents                           | [Agent definitions](docs/guides/agent-definitions.md)         |
| Build against the model-facing tools       | [Coordination API](docs/coordination-api.md)                  |
| Deploy an SSH-ready environment            | [Container deployment](docs/guides/container-deployment.md)   |
| Contribute to Pi Herdsman                  | [Contributing](CONTRIBUTING.md)                               |

## Community

Questions, workflows, examples, and ideas are welcome in
[GitHub Discussions](https://github.com/boadij/pi-herdsman/discussions).

For reproducible bugs and concrete actionable work, use
[GitHub Issues](https://github.com/boadij/pi-herdsman/issues).

## License

[Apache License 2.0](LICENSE)
