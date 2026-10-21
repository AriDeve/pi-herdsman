# `ask_owner` API

[Documentation index](../README.md)

`ask_owner` is mandatory managed agent infrastructure for one direct-owner
decision required to continue the current assignment.

It is not a generic messaging channel.
Routine completion is the Agent's final response, delivered as its assignment
result. Generic OMP `agent://` messaging is a separate mechanism, not a managed
child's owner channel; a Lead role is not a registered destination named `lead`.

## Availability

Every valid managed agent receives the `ask_owner` tool at launch.

Normal definition `tools`, `excludeTools`, and `noTools` policy cannot remove
this infrastructure capability.

## Request

```json
{
  "question": "Should I use option A or option B?",
  "files": ["options.md", "diagram.png", "result:researcher#1"]
}
```

`question` must contain non-whitespace text.
`files` supplies supporting evidence using the same rules as `agent`: ordinary
paths, exact reusable direct-agent refs such as `result:researcher#1`, and
canonical `result:<request-id>` refs already supplied as evidence are accepted.
Complete strict UTF-8 text may be embedded, while other files are canonical
local references and are not copied or snapshotted. A direct-result ref is
resolved against the calling managed agent's current Pi branch and remains
reusable by the owner through a hidden binding. Relative paths use the agent's
working directory. This does not weaken the sole-final-tool-call rule.

## Turn rule

`ask_owner` must be:

- the agent's only tool call in the turn;
- the final tool call of the turn.

The agent then stops and waits.

A call made alongside another tool call is rejected.

## Eligibility

An agent can ask only while it has a valid active assignment and:

- has no outstanding ask;
- has no completed/final result pending;
- has no pending state transition;
- has no unacknowledged owner request;
- has no ordinary unresolved direct-agent work.

For a delegation-enabled agent, direct-agent state adds one gate:

- no unresolved direct-agent work leaves normal `ask_owner` eligibility unchanged;
- if unresolved direct agents exist, every unresolved child must have a valid pending `ask_owner`;
- ordinary active children, pending results, result errors, or unverifiable child asks block escalation.

## Durable effect

On acceptance, Pi Herdsman creates one correlated ask record and sets
`pendingAskId` while preserving the original active assignment request ID.

The tool result tells the agent that the assignment is blocked and returns
details containing:

```text
askId
assignmentRequestId
```

The agent public state projects as `blocked` after the turn settles.

Final assignment settlement is disabled while the ask remains pending.

## Owner delivery

The exact direct owner receives the question through the existing owner-session
delivery path.

The system does not automatically forward an agent question through an ownership
chain.

If a delegating agent needs a lead decision, it independently calls `ask_owner`
on its own direct ownership edge.

Use `list_agents` to discover a bounded `pending_question` summary without
reading the child's transcript. Only the exact direct owner receives it.
Automatic question delivery waits for the owner session to be idle; an Agent
can already be blocked during that interval. A deferred question is not
evidence of lost delivery. `steer_agent` and `interrupt_agent` do not replace an
owner answer; their blocked-control errors direct the owner to `reply_agent`.

### Correlated delivery diagnostics

Persisted owner and child sessions contain custom entries with
`customType: "pi-herdsman-ask-delivery"`. Filter their `data` by the same
`askId` to trace delivery without logging question text or attachment bodies.

| `stage`                   | Session | Meaning                                                                                        |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `created`                 | Child   | The ask record and pending state were durably written.                                         |
| `waiting_for_owner_idle`  | Owner   | Delivery is deferred while the exact owner is busy.                                            |
| `queued_for_owner_input`  | Owner   | The owner-session send accepted the correlated ask; this alone does not prove input inclusion. |
| `included_in_owner_input` | Owner   | The context hook observed the exact correlated ask in model-input messages.                    |
| `delivery_failed`         | Owner   | Delivery encountered an error; category and retry delay identify the failed attempt.           |
| `reply_accepted`          | Child   | The correlated reply was accepted and the pending ask cleared.                                 |
| `reply_acknowledged`      | Owner   | The owner observed successful acknowledgement of the reply request.                            |

Entries include assignment, run, owner, workspace, Agent, pane and Pi-session
identifiers, observation time/session, and reply request ID when applicable.
Failure metadata records a stable error category, not arbitrary error contents.
Repeated observations of the same stage and correlation are coalesced.
Diagnostics are best-effort observations, not delivery or authorization state:
an absent entry does not establish failure, and a diagnostic write failure
does not undo an accepted ask or reply.

## Reply

The direct owner answers through `reply_agent`:

```json
{
  "agent": "<exact agent>",
  "message": "Use option B."
}
```

The reply is correlated to:

- ask ID;
- original assignment request ID;
- run ID;
- owner session;
- workspace;
- agent label;
- pane;
- Pi session.

A mismatched or stale reply fails closed.

The agent clears the pending ask, acknowledges the reply request, and resumes
the same assignment with the owner answer.

## One outstanding question

Only one `ask_owner` question may be outstanding per assignment at a time.

There is no ask timeout.

The agent must not guess the owner answer and complete while blocked.

Rejected calls identify the known eligibility reason, such as no active
assignment, an existing owner question, settling state, a pending control
request, or active direct-agent work.

## Close

Closing the agent abandons the pending question as part of agent teardown.

## See also

- [`reply_agent`](agent.md#reply_agent)
- [Lifecycle](../concepts/lifecycle.md)
- [Delegation](../concepts/delegation.md)
