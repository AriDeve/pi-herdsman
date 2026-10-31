# 0ZE9BDB: Outcome persistence and control-state investigation

Investigation date: 2026-10-31. Source baseline:
`ed25adc315d0889887f1e31d5d0a75446edb9271`.

This is a historical investigation record, not a new runtime contract or an
implementation of the proposed changes. The ticket requests independent diagnosis
of five reported symptoms. No historical assignment was resumed or modified.
Private session transcripts are not included in the repository.

**Disposition:** no common persistence root cause is established. The strongest
confirmed symptom is delayed interrupt replacement while older queued input
continues running, accompanied by misleading available controls. The adapter
reproduction demonstrates a sufficient mechanism, not a uniquely attributed
historical cause. The managed-Agent empty-result incident is real, but its exact
event-order cause remains unresolved. Lead restoration and manual-close
continuation preserve uncertainty rather than inventing successful outcomes or
ownership. The background result was delivered.

The investigation delivers executable boundary reproductions and a bounded
contract proposal. It does not repair production behavior or justify closing the
unresolved runtime issue.

## Background-job completion

**Finding:** the incident used the wrong completion API. The background job's
result was not lost. OMP owns this boundary, not Herdsman.

The native Bash tool returned a process-local job ID. The caller passed that
string to Eval Python's `wait(handles)` helper, which accepts Eval agent or
completion handles. That helper is distinct from the top-level `wait` tool.

Evidence comes from verifier session
`01a18f98-8bee-750b-9832-4ce4dd860774`, assignment request
`5472d8f1-3c32-4056-95a8-970368dcb40b`, under integration Lead
`8a816e85-a41b-4300-93a3-732072b54565`. Its session entries identify OMP 18.14.0.

| UTC timestamp           | Session entry | Observed transition                                                                                            |
| ----------------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| 2026-10-31 01:35:21.633 | `b166b7c6`    | Bash returned `bg_2`, `state: running`, no deadline, and automatic-delivery instructions.                      |
| 2026-10-31 01:36:07.042 | `935e379f`    | Eval Python called `wait(['bg_2'])`.                                                                           |
| 2026-10-31 01:36:07.048 | `130c8dba`    | `TypeError: wait() expects agent or completion handles`.                                                       |
| 2026-10-31 01:47:40.041 | `90026e81`    | `async-result` delivered `Background job bg_2 has completed`, `Gate exit: 0`, and elapsed time 738.41 seconds. |
| 2026-10-31 01:47:49.031 | `23430abc`    | The verifier reported the successful completed gate.                                                           |

The rejected wait did not cancel or lose the job. Its completion was delivered
approximately 12 minutes after launch, without a replacement job.

### Actual-surface check

On OMP 18.14.1, the Bash tool executed:

```text
command: printf '0ZE9BDB-background-completed\n'
async: true
timeout: 30
```

It returned `bg_1`; a subsequent automatic notification delivered the exact marker
`0ZE9BDB-background-completed`. No polling or Eval wait call was used.

Live Python kernel inspection reported:

```text
wait signature: (handles, timeout=None, *, raise_errors=True)
docstring: Wait for agent/completion handles in input order.
error literal: wait() expects agent or completion handles
```

`inspect.getsource(wait)` could not recover source for the injected prelude;
code-object inspection supplied the signature and type-boundary evidence instead.
The historical erroneous call was not repeated. The current top-level `wait`
tool accepts optional intent, not a job selector. The host's `xd://eval/agents`
reference also distinguishes the top-level tool from the kernel barrier.

### Contract proposal

No Herdsman background-job persistence or completion API is justified by this
incident. Preserve automatic delivery and the distinct, scoped handle types.
An optional host usability improvement would make the kernel's rejection identify
a Bash job ID as the wrong handle family and point to automatic delivery or the
top-level wait tool. Do not silently accept a process-local string as an
assignment or completion authority.

## Continuation after manual close

**Finding:** closing an unfinished generation before a terminal result is
delivered leaves no continuation-recognized ownership edge. The observed denial
is fail-closed behavior under the current resolver, not deletion of an existing
terminal-result edge. Whether this recovery path should be supported is a
separate lifecycle-contract decision.

The exact owner is `bbfd33fe-07e7-427f-9f34-0fde77be0258`; target reviewer
`claude-final` is session `01a18f45-4470-7328-838e-16bdbb5c9bc6`. Its accepted
request is `5d6ee4dc-32f1-41ad-a18b-8f8488a00a1d`, run
`27fa15f6-1f26-47d9-baa9-f3d35aad9709`, workspace/pane `wV` / `wV:p8`.
The child header, saved definition identity, and accepted required-evidence
metadata match those identities.

| UTC time on 2026-10-31 | Journal / entry               | Observed transition                                                       |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| 00:04:06.149           | Child `73925005`              | Accepted request/run/owner and evidence identity persist.                 |
| 00:04:06.408           | Owner `bf59e6e0`              | Successful delegation receipt identifies the exact child.                 |
| 00:05:29.270           | Owner `173f8bcd`              | Interrupt acknowledged; original assignment remains assigned.             |
| 00:05:29.269–29.293    | Child `5c36ad27` → `6e84518a` | Aborted assistant entry followed by replacement user input, 24 ms apart.  |
| 00:05:50.788           | Owner `1117ba62`              | Explicit close requested.                                                 |
| 00:05:50.833           | Child `6ac6a9da`              | `sighup` session exit.                                                    |
| 00:05:50.913           | Owner `77e9cea0`              | Close succeeds without cleanup warning.                                   |
| 00:05:58.617           | Owner `1d81fd6c`              | Exact-session continuation rejected as outside the proven ownership tree. |

The one-millisecond cross-process difference around interrupt acknowledgement
does not establish stronger ordering than the child's persisted parent chain.
The delegation receipt is on the denial's owner-entry ancestry. No terminal
result for this target appears before close or later in the inspected owner
journal. Inspection and a zero-response recovery result do not supply a
continuation ownership edge.

### Resolver replay

The actual `resolveAssignmentSession` replay against the pre-denial owner history
found matching target identity, zero default target edges, and one
receipt-inclusive target edge. It returned the exact reported denial. A
synthetic native-Pi-session replay then varied only the available ownership proof:

| Input                                 | Observed result                                                           |
| ------------------------------------- | ------------------------------------------------------------------------- |
| Successful delegation receipt only    | `Assignment source is outside the caller's proven session ownership tree` |
| Receipt plus valid owned-result edge  | Target session resolved                                                   |
| Same result edge with a foreign owner | Same ownership denial                                                     |

The injected failed-result edge is an experimental input, not a proposed way to
fabricate an outcome on close. The replay used the actual resolver and a saved
synthetic identity, not a replacement authorization implementation.

The retained, self-cleaning reproduction uses synthetic identities and temporary
storage only:

```sh
bun investigations/0ZE9BDB/ownership.ts
```

Observed exit 0:

```text
REPRODUCED: receipt-only continuation denied; owned result resolves; foreign result denied.
The synthetic result is a differential probe input, not a proposal to fabricate an outcome on close.
```

Exit 0 means the diagnostic assertions reproduced the current boundary, not that
continuation after manual close was repaired.

An initial attempt to feed the OMP title-slot journal directly to the imported Pi
session reader failed with `Invalid persisted session header`. The final
historical replay extracted the target's identity directly and the synthetic
positive control used native Pi format. This parser-boundary failure is not
assigned as the incident cause: receipt-only exclusion occurs before opening the
target. No historical activation or parser modification occurred.

Relevant source at the investigation baseline:

- `extension/agent-controller.ts`: `ownedAssignmentChildren`,
  `resolveAssignmentSession`, `closeAction`, `closeCascade`, `closeSnapshot`.
- `docs/reference/agent.md`: documented post-cleanup continuation relies on an
  owner-delivered result.
- [ADR 0003](../docs/adr/0003-use-durable-ownership-for-agent-scope.md) and
  [ADR 0004](../docs/adr/0004-separate-delegation-from-continuation.md):
  proven durable ownership and identity-preserving continuation.

### Contract proposal

If manually closed, unfinished sessions must remain continuable, preserve a
dedicated durable accepted-assignment ownership proof before destructive cleanup.
Bind the exact owner, saved session, definition, label, accepted request/run, and
applicable project/evidence identity. Reuse the existing accepted-evidence checks.
Keep ownership proof separate from execution outcome and owner acceptance.

Do not enable receipt-only continuation, manufacture a terminal result, infer
ownership from physical visibility, or loosen foreign/ambiguous identity checks.
No such change is implemented by this investigation.

## Lead restoration

**Finding:** the retained history shows an unfinished herd run, an independent
successful supervisor-message save, session disposal, and an aborted final
assistant response. It does not establish deletion of a completed execution
outcome or a previously persisted herd-run handoff.

Lead/project assignment: `8a816e85-a41b-4300-93a3-732072b54565`.
Manager: `01a18dcc-a41b-73df-a962-38571616d2d9`.
Herd-run report: `99b315cf-02e4-41c6-a75b-f19fa93503ab`.

| UTC timestamp       | Lead entry              | Observed transition                                                                                   |
| ------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Oct 30 23:45:30.782 | `95d32e9c`              | Persisted `started` for the herd-run report.                                                          |
| Oct 31 01:18:29.846 | `c7b8c521`              | `message_supervisor` acknowledges independent project message `b9ddba0b-36cb-40ae-893f-ca028d770354`. |
| 01:18:34.364        | `52231d14`              | Session exits: reason `dispose`, kind `normal`.                                                       |
| 01:18:34.390        | `48e69516`              | Final assistant text remains saved, 1,223 characters, but `stopReason: aborted`.                      |
| 01:33:54.078        | `68712d96`              | First matching pending herd-run report contains the restoration fallback, `kind: execution_failure`.  |
| 01:33:54.121–54.122 | `28e08564` → `2e8af2d4` | Matching `report_sent`, then `finished`.                                                              |

The manual project message and herd-run report are different identities.
`message_supervisor` publishes a project message without settling the herd run.
The successful save acknowledgement is not proof of Manager acceptance, final
execution completion, or a matching `report_pending` record.

At baseline, `createLeadHerdRunRuntime` in `extension/lead-runtime.ts` keeps
`lastSettledRun` in memory, replays durable pending reports on restoration, and
clears transient observations on shutdown. The recorded state contains an
aborted response and no matching pending/sent herd-run handoff before restoration.
The fallback is then persisted and delivered correctly.

[INFERENCE] Disposal before terminal Herdsman settlement is consistent with this
history. The journal cannot establish whether native settlement was never
emitted, filtered, delayed, or emitted after shutdown. It does not prove a
completed observation existed in memory before disposal.

### Contract proposal

Preserve explicit unresolved restoration and replay of actual pending handoffs.
Do not reinterpret independent evidence publication or aborted prose as
completion. Before proposing durable cancellation at process disposal, capture
the native shutdown/settlement sequence at that boundary. No new outcome store
is justified by the retained Lead evidence alone.

## Managed-Agent empty result despite saved text

**Finding:** the final visible response survived. The owner nevertheless received
`empty_result` for the same assignment. The exact runtime-evidence failure is not
uniquely determined by the retained history.

Child `watch-seams`: `01a18f35-8a8e-72b7-946f-0f9d01a68b2d`.
Owner: `bbfd33fe-07e7-427f-9f34-0fde77be0258`.
Request: `7df27f2a-b217-4730-bf7d-4c6c8a8766bd`.
Run: `150342aa-d80b-4965-a31c-0bf319d7bfdf`. Workspace/pane: `wV` / `wV:p2`.

| UTC time on Oct 30 | Journal / entry  | Observed transition                                                                          |
| ------------------ | ---------------- | -------------------------------------------------------------------------------------------- |
| 23:46:55.447       | Child `19dd52e3` | Accepted-request/evidence identity persists.                                                 |
| 23:48:22.494       | Child `2ce9bc2d` | Aborted assistant entry: `Interrupted by user`, no visible text.                             |
| 23:48:22.497       | Owner `4618a050` | Interrupt `130306f6-3e2e-46ec-b729-6c0c1a9a1fc6` accepted on the same assignment.            |
| 23:48:47.336       | Child `42b99955` | Final response saved: 980 visible characters, `stopReason: stop`.                            |
| 23:48:47.350       | Owner `83bc6dfd` | Same child/run/request delivers `failed / empty_result`, without selected `responseEntryId`. |
| 23:48:47.353       | Child `527bba38` | Queued interrupt replacement reaches saved history.                                          |
| 23:48:50.413       | Child `8c64c1fa` | SIGHUP exit.                                                                                 |
| 23:48:50.432       | Child `c558d166` | Later response aborted during exit.                                                          |

The failed result precedes replacement delivery and SIGHUP cleanup. The later
aborted response cannot explain an error already delivered. Matching identities
exclude a different request/run; direct recovery excludes deletion of
`42b99955`.

Existing `sessionResponses` and `assignmentResponses` helpers recovered all 980
characters and verified the parent chain from marker `19dd52e3`. This was a
read-only helper check, not tool-level authorization or proof of successful
execution. The investigation supplied the candidate response ID; the failed
result did not contain selected-response provenance. Do not backfill it as a
successful assignment result.

### Event-boundary reproduction

Run the retained differential replay:

```sh
node --experimental-test-module-mocks investigations/0ZE9BDB/outcomes.mjs
```

It uses the actual OMP event translator and registered managed-runtime handlers,
with the repository's isolated transport/context fixtures. Lead cases invoke
the actual `createLeadHerdRunRuntime`. No model or Herdr process is launched.
Each row below was observed with explicit assertions, exit 0:

| Single changed condition                                        | Observed result                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| Response saved after `turn_end`, before settlement              | `failed / empty_result` despite saved text                 |
| Same response saved before `turn_end`                           | `completed`, selected response identity and text preserved |
| Saved entry retained; omit `turn_end`                           | Same `empty_result`                                        |
| Add `agent_start` after final capture                           | Same `empty_result`                                        |
| Change settlement's last assistant to `toolUse`                 | Same `empty_result`                                        |
| Lead restoration has start and aborted prose, no pending report | Restoration fallback                                       |
| Add matching durable pending report                             | Original handoff replayed, no fallback                     |
| Lead shutdown before aborted settlement                         | Restoration fallback                                       |
| Same aborted settlement delivered before shutdown               | Durable cancellation handoff, no fallback                  |

The replay proves several sufficient mechanisms, not which occurred
historically. `agent_start` resets the observation; `turn_end` captures final
identity/text; `agent_before_settle` updates outcome. The OMP adapter resolves
entry identity from branch visibility and derives settlement status from the
native `agent_end` payload. Missing or conflicting evidence can all reach the
same diagnostic.

The script's test-support import prints a zero-test summary and experimental
module-mocking/deprecated `namedExports` warnings. These are standalone
diagnostic assertions, not a passing regression suite or a production fix.

### Contract proposal

The message “Agent produced no assistant text” is broader than literal absence of
saved text. “No verified final response was captured” would describe this
boundary more accurately, but wording alone would not fix it.

Preserve the distinction between recoverable visible responses and verified
terminal outcomes. If late response persistence is confirmed, repair the exact
observed-response identity contract at the host adapter boundary. If observation
reset or stale settlement is confirmed, fix that event ordering at its owner.
Do not scan arbitrary history for text and infer completion, add automatic
retries, or create a second transcript store.

## Delayed interrupt replacement

**Finding:** cancellation of the native tool was prompt, but the accepted
interrupt replacement did not precede older queued owner input. Work resumed for
27 minutes before the replacement was delivered. Freshly advertised controls
were rejected while this replacement remained pending.

The initial public-seams journal cited by the retrospective contained a different
`settling` rejection. Searching the exact error across the workload's saved
sessions located the actual incident in owner-recovery:

- Owner `d58cb418-d3b7-4a8d-82f9-3b500558db1c`.
- Child `reply-isolation`, `01a18eb7-2b26-75ed-859b-9cec0a163bac`.
- Assignment `1d790f63-5247-4486-9b5c-753c9945af8e`.
- Run `f88983b4-3770-4f34-9463-eb1854b7430a`; workspace/pane `wT` / `wT:pG`.
- Interrupt request `f8e3d339-e8c9-479e-aa50-c78eeaa03106`.

| UTC time on Oct 30 | Journal / entry  | Observed transition                                                          |
| ------------------ | ---------------- | ---------------------------------------------------------------------------- |
| 22:29:50.972       | Child `3080bab6` | Earlier owner reply accepted for ask `1e7ceda3-6176-4cf9-b406-8a93cc36199a`. |
| 22:29:51.717       | Child `e1135714` | Eval begins a requested 60-second wait.                                      |
| 22:30:12.274       | Owner `edce2cfc` | Interrupt requests pausing the affected work.                                |
| 22:30:12.290       | Child `0b9ba475` | Eval returns `Command aborted` after 20,571 ms.                              |
| 22:30:12.297       | Owner `0bb4f395` | Interrupt acknowledged, assignment unchanged.                                |
| 22:30:12.312       | Child `da36b5ba` | Assistant aborted.                                                           |
| 22:30:12.346       | Child `d826d2bd` | Older `Owner reply:` resumes, not the interrupt replacement.                 |
| 22:31:53.905       | Owner `7bc88661` | Steering rejected: `Agent interrupt is still settling`.                      |
| 22:32:10.503       | Owner `a519049e` | Exact-session snapshot says working and advertises steer/interrupt.          |
| 22:32:17.911       | Owner `815410b0` | Steering rejected with the same child-local busy error.                      |
| 22:57:48.143       | Child `b602143c` | Natural assistant stop.                                                      |
| 22:57:48.203       | Child `29383ed9` | Original interrupt replacement finally delivered.                            |
| 23:01:25.662       | Owner `614028d2` | Same assignment delivers completed result selecting `c6c83033`.              |

The two rejections occurred 101.608 and 125.614 seconds after acknowledgement.
Replacement delivery took 1,655.906 seconds; 83 further tool calls occurred
between the resumed older reply and replacement delivery. The original tool had
already aborted. This is not explained by a non-cooperative canceled tool.
The delayed replacement eventually arrived; later rejected steers were neither
accepted nor queued.

The snapshot and rejection were 7.408 seconds apart, not simultaneous. Their
combination with both exact guard rejections and the delayed matching replacement
establishes sustained disagreement. Continuous in-memory guard state between
unobserved points remains an inference.

### Adapter gate reproduction

```sh
bun investigations/0ZE9BDB/interrupt.mjs
```

The actual OMP adapter and managed settlement handler reproduced these cases,
exit 0:

1. Aborted `agent_end` plus `hasPendingMessages: true` retains replacement.
   Changing only pending messages to false delivers it.
2. `willContinue: true` independently retains replacement. Clearing that flag
   delivers it.
3. An aborted event with pending input followed by natural stop with an empty
   queue delivers replacement only at the latter boundary.

`extension/omp-runtime.ts:92–108` gates both managed settlement callbacks on
whole-run continuation predicates. The pending interrupt's normal delivery path
is `agent_settled` in `extension/managed-agent-runtime.ts:2111–2119`. Thus ordinary
run continuation can suppress dispatch of an already accepted replacement.
The earlier isolated input/projection probe also advertised steer/interrupt while
the child rejected both, then accepted steering on the unchanged assignment after
injected settlement.

This proves a sufficient current-source mechanism. The historical journal omits
native `agent_end` emissions and both predicate values, so it cannot distinguish
an adapter-filtered event from a host event emitted only after the continued run.
It also does not authenticate the loaded extension bundle.

### Contract proposal

Separate operation cancellation/replacement dispatch from whole-run terminal
settlement. An accepted interrupt replacement should supersede earlier queued
steering/reply input before that input resumes. Preserve ordinary pending-message
guards against premature terminal-result publication; simply deleting the
adapter filter is unsafe.

Use a supported native queue/cancellation boundary, verifying that contract with
the host owner before implementation. While replacement awaits dispatch, expose
the transient control reason and suppress controls already known to be rejected.
Do not clear the guard on elapsed time, invent success, add retries, or persist
live process state as authority.

## Evidence limits and next decision

- Historical entries identify OMP 18.14.0. Current executable checks returned
  OMP 18.14.1, Herdr 0.9.5, Node v26.7.0, and Bun 1.4.4.
- Baseline commit time, 2026-10-30 16:55:59 UTC, precedes these incidents. That
  does not prove the running extension loaded that revision. Package declarations
  (Herdsman 0.31.0, Pi 1.3.0, OMP peer `^18.12.3`) are not build provenance.
- Neither the obsolete global OMP 17.4.0 package nor repository dependency
  18.12.3 is treated as authoritative source for incident host behavior.
- Exact historical watch mailbox/result and Lead report-message artifacts were
  unavailable in the inspected current durable-store paths. Saved owner handoffs
  remain available. Current absence does not establish deletion timing or cause.
- The missing evidence is the native event sequence, response-entry visibility,
  settlement payloads, queue predicates, and loaded bundle fingerprint at the
  incident boundaries. These cannot be reconstructed from the saved conversation
  alone. No historical workloads were restarted to manufacture that evidence.

Priority follow-up: verify the native cancellation/queue contract and implement
the independently scoped interrupt-ordering/projection repair. Separately decide
whether close-before-result continuation is a supported recovery path. Keep the
managed empty-result cause open pending the missing lifecycle evidence or a
native-host reproduction that distinguishes the demonstrated mechanisms.

These proposals preserve [durable intent versus transient state](../docs/adr/0002-persist-intent-and-derive-runtime-state.md)
and [native integration ownership](../docs/adr/0008-prefer-native-pi-and-herdr-contracts.md).
They are not active ADR replacements or shipped behavior.

## Verification and retained artifacts

The three retained scripts under `investigations/0ZE9BDB/` use temporary runtime
roots and clean them on exit. They do not access the incident sessions, activate
Agents, or call external models. Run them from the repository root with installed
development dependencies. Exit 0 means the diagnostic expectations held, not that
a defect was fixed.

Review caught an isolation error in earlier outcome replays: an imported module
cached the default Pi mailbox root before the fixture changed the environment.
Those runs left five synthetic mailboxes in that default root. Their exact file
lists, state, and results were matched against the recorded diagnostic identities
before removing only those five directories. The retained script now sets
`PI_CODING_AGENT_DIR` before imports and asserts mailbox containment before fixture
initialization or writes. Its corrected nine-case replay passed; before/after
hashes showed unchanged default mailbox contents and no new temporary roots.

The investigation also exercised existing response-recovery helpers against the
actual saved watch history and actual Bash automatic completion. Focused checks
passed: `extension/controller-api.test.ts` 129/129 and
`extension/agent-runtime.test.ts` 83/83.
No standalone typecheck is configured in this repository; Node's type stripping
and these runtime probes are not claimed as TypeScript typechecking.

Private raw evidence and selected extraction/probe outputs remain local under
`.local/0ZE9BDB/`; the report retains exact session/entry identifiers without
committing private transcript bodies. Epiq `0ZE9BDB` records the investigation.
The required ignored `.backlog/` repository is absent from this canonical
worktree, so no Backlog CLI record could be made here; none was fabricated or
manually mirrored.
