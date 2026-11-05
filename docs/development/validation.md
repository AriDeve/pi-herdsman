# Development validation

[Documentation index](../README.md)

Repository handoff is not complete until the current validation gates have been
run or a concrete environment blocker is recorded.

For the OMP port, `bun run test:omp` checks native lifecycle adaptation, child
capability policies, status/title presentation, project settings, and read-only
native session inspection. The session inspection check runs through OMP's
real import adapter under Bun, including physical title slots and blob references.
The command also builds the installed bundle and runs
`scripts/omp-tool-execution-check.ts` against the real OMP CLI. A loopback
HTTP/SSE provider exercises OMP's native OpenAI-compatible request serializer
and response parser, checking provider-visible schemas and capability guidance
alongside actual tool execution. Cases cover `generalist` Bash, `scout` reads
and denied Bash, an empty-tool policy, and permitted/denied indirect MCP device
calls over real stdio transport. The MCP server records calls so denied
targets must remain unexecuted. Deferred MCP discovery must not reintroduce
forbidden provider schemas after startup policy selection. These checks use
temporary state, not an external model API; they do not establish real-model
instruction adherence or external Codex Lite conversion behavior.
`bun run package:audit` checks the bundled native entry point and packaged skills.
It requires npm as the package-format inspection tool and runs
`npm pack --dry-run --json --ignore-scripts` locally; this neither publishes
the package nor installs dependencies. Bun remains the package-script
entrypoint and dependency preparation tool.
`bun scripts/omp-response-recovery-check.ts` (after `bun run build`) runs real
OMP and Herdsman in an owned, named Herdr session against a scripted loopback
provider. A managed Agent produces a full report and a later addendum; the check
verifies result delivery, automatic cleanup, post-cleanup `read_agent_responses`
recovery of both responses, session continuation for a second assignment, and
assignment isolation, with no further child model request during recovery.
`bun scripts/omp-response-recovery-check.ts --interrupt` (after `bun run build`)
exercises actual owner controls and a managed Agent with a cancellable native
tool. The scripted provider verifies accepted-versus-applied guidance, one
deliberately rejected pending control with unavailable-tool evidence, replacement
delivery before natural whole-run settlement, absence of premature results,
selected-response provenance, and cleanup. Fixture readiness uses native Herdr
observations without additional model/status tool calls. It does not establish
strict native queue supersession or real-model adherence.
`bun scripts/omp-response-recovery-check.ts --project-continuation` (after
`bun run build`) has a restored Manager delegate a project whose Lead delegates a
worker, waits for its delivered result, pane and mailbox cleanup, continues the
exact worker session, and verifies the second result and cleanup.
The same native harness has a bounded managed-Lead policy scenario:
`bun scripts/omp-response-recovery-check.ts --manager-handoff` (after
`bun run build`). A restored Manager delegates a project Lead, pauses and
resumes the same assigned session twice, and sends a new coordination message
after each resume. The strict scenario requires default-active late tools:
`list_agents` calls and probe executions check reconciliation with a saved empty
ordinary baseline, while the loopback provider checks the restricted Lead
surface and Manager isolation. It currently fails on excluded late tools
appearing in native provider schemas. Completion requires a native
provider-agnostic request-tool projection boundary; making the excluded probe
inactive does not satisfy this check.

`bun scripts/omp-manager-removal-check.ts` (after `bun run build`) runs real
OMP and Herdr against a scripted loopback provider in a newly created,
disposable Git repository. It checks nonblocking pending removal requests,
duplicate IDs, native status, same-session reload, visible typed confirmations,
cancellation, dismissal, Manager leave/re-entry, Settings and command-based
repository preauthorization/revocation, then explicitly requested non-forced
removal. It verifies assignment/workspace retirement and branch/conversation
preservation before cleaning its owned server and temporary root. Its isolated
configuration never changes existing repository permission. This scenario does
not establish real-model adherence or native sibling-branch/new-session
isolation; focused tests cover the latter intent-replay boundaries.

The upstream Pi smoke scripts remain Pi-targeted; OMP delegation requires a
separate named Herdr session with OMP's integration loaded.

The local OMP port was exercised with OMP 18.12.3 in an isolated Herdr session:
the installed bundle delegated to a real OMP child, accepted its mailbox request,
and delivered its completed result back to the parent. A deterministic local
provider verified the child identity, merged prompt, `ask_owner`-only tool
surface, explicit skill discovery with relative resources, and denied project
context. Manager activation/return-to-Lead and Chief activation/prompt assembly
were also exercised in a Git-rooted Herdr workspace. No external model API was used.

Herdsman registers one runtime per OMP session bus, including when a linked
plugin path and an explicit realpath load separate copies of its factory.
The duplicate-loading regression in `extension/agent-runtime.test.ts` checks
that first-assignment acceptance is not overwritten, overlapping assignments
remain rejected, and shutdown permits rebinding on the same session bus.
An isolated native RPC smoke also loaded both installed bundle aliases,
accepted the first mailbox task, rejected an overlapping task, and published
the first task's completed result using a deterministic local provider.

## Validation order

Focused tests, smoke testing, review, and all intermediate checks happen first.
Do not format during those phases. Once implementation and review are
complete, run the following as the final pre-commit sequence:

```sh
# Final pre-commit mutation; run once only.
bun run format

# Read-only verification before staging or committing.
bun run format:check
bun run check
git diff --check
```

Do not run formatting again between these verification commands and staging or
committing.

`bun run format` applies formatting; `bun run format:check` verifies it without
changing files. Both use the locally installed Prettier version pinned by the
lockfile. `bun run check` runs the bounded behavioral test suite,
`bun run validate` composes formatting verification, tests, build, and package
audit, and `git diff --check` checks Git whitespace.

When reviewing staged work, also run as appropriate:

```sh
git diff HEAD --check
```

## What `bun run check` does

The repository check command runs the complete Node test set in one isolated
process tree with a bounded suite deadline. Node's native TypeScript support
strips types while loading the source, and the test runner discovers the
`.test.ts` files automatically.

The test runner uses:

```text
--experimental-test-module-mocks
--test
```

## Process containment

On POSIX systems the test runner runs in a detached process group. On Windows
it runs as a normal child process and uses the native `taskkill.exe /PID <pid>
/T /F` process-tree operation for timeout cleanup.

On POSIX suite deadline, the runner attempts:

1. `SIGTERM`;
2. a bounded grace period;
3. `SIGKILL` when required;
4. bounded proof that the process tree disappeared.

On Windows, the runner invokes `taskkill.exe /PID <pid> /T /F` and waits for
the runner process to disappear.

A test runner that leaks descendants after normal exit is reported as a failure
on POSIX and cleaned through the same process-group boundary. Windows timeout
cleanup covers the runner tree; post-parent descendant leak accounting would
require a Job Object and is not implemented.

## Focused tests

During implementation, invoke the configured Node test runner through Bun:

```sh
# all tests
bun run test

# one test file
bun run test -- extension/<area>.test.ts

# one test name within a selected file
bun run test -- --test-name-pattern="<pattern>" extension/<area>.test.ts
```

For supervision changes, useful focused examples are:

```sh
bun run test -- extension/supervision.test.ts
bun run test -- --test-name-pattern="lease" extension/supervision.test.ts
bun run test -- --test-name-pattern="inspect" extension/controller-api.test.ts
```

These are command examples, not recorded results. Live Pi/herdr acceptance is
tracked separately in [Smoke testing](smoke-testing.md).

File selection is the primary focusing mechanism. A name pattern narrows the
tests within the selected file; it does not select which files Node loads.

After focused tests, smoke testing, review, and intermediate checks are
complete, run the final pre-commit sequence above. The full repository check is
the read-only verification step:

```sh
bun run check
```

`bun run check` remains the bounded full check, including platform-appropriate
process-tree cleanup when the test runner times out or leaks descendants.

## Dependency availability

Use Bun to invoke package scripts, preserving each script's configured runtime;
`bun run test` and `bun run build` still execute their configured Node commands.
The verified dependency preparation command is:

```sh
bun install --frozen-lockfile --no-save --ignore-scripts
```

Bun imports the existing `package-lock.json` without saving a Bun lockfile or
changing the package manifest or npm lockfile. This route was verified with
Bun 1.4.4 both in a fresh worktree without `node_modules` and in an
already-installed worktree against native OMP 18.12.3. Fresh preparation
installed 246 packages with lifecycle scripts disabled; native session
inspection and the configured build passed. Exact path-for-path dependency
graph equivalence has not been verified. Installation requires explicit
authorization.

The optional repository `post-checkout` hook still invokes npm; it is not the
Bun preparation path. Prepare dependencies explicitly rather than enabling
that hook for this workflow. A failed worktree creation may leave its checkout
in place; inspect it before retrying delegation on the existing branch.

## Failed or non-converging check

Record:

- exact command;
- exit/result classification;
- process evidence when relevant;
- cleanup result;
- whether failure is source-related or environment-related.

Do not claim a passing full check from a partial focused run.

## CI runtime smoke

GitHub Actions runs all supported simulated Pi/Herdr smoke scenarios for
changes affecting the runtime, its dependencies, build, smoke harness, or
validation workflow. The existing required `CI` check fails when required
smoke does not succeed. Documentation-only and test-only changes normally skip
it.

Simulated acceptance uses real Pi, Herdsman, and Herdr processes without model
credentials. It does not verify real-model decisions. The supported simulated
scenarios are `core`, `continuation`, `chief-tree`, `supervisor-agent`, and
`terminal-failure`.

`bun run validate` remains unchanged and does not run smoke. Manual/live smoke
remains separate and opt-in. For cross-process Pi/Herdr behavior outside the CI
acceptance, choose an isolated smoke scenario according to the change:

```sh
bun run smoke
bun run smoke -- core
bun run smoke -- continuation
bun run smoke -- chief-tree
bun run smoke -- supervisor-agent
bun run smoke -- manager-recovery
bun run smoke -- terminal-failure
```

The opt-in `--simulated` mode uses Pi's native faux provider without remote
inference credentials. It retains the real Pi/Herdr runtime checks and does not
replace live-model acceptance. `manager-recovery` remains live-only and rejects
`--simulated`. Asynchronous Agent results are delivered as user messages to the
real Pi transcript; the simulated scenarios require those delivered results
and correlated tool evidence. Without that flag, smoke remains live-model
acceptance and uses the configured `pi-herdsman.smoke-model` or a one-run
`--model` override.
`bun run smoke` defaults to live `core`. The runner creates its own isolated
Herdr server and workspace, so smoke can run from an ordinary repository
shell, including one already inside Herdr. See [Smoke testing](smoke-testing.md)
for setup, scope, and isolation. Smoke is opt-in and not part of
`bun run validate`.
