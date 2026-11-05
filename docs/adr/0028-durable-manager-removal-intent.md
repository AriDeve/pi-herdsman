# Persist Manager removal review intent on the session branch

## Status

Accepted. Supersedes the prohibition on durable pending-removal records in
[ADR 0020](0020-authorize-confirmed-manager-worktree-removal.md).

## Context

[ADR 0020](0020-authorize-confirmed-manager-worktree-removal.md) returned a
confirmation-required result that left no record, so a request made by the
model was lost once the user did not act on it immediately or the session
reloaded. The upstream policy ([ADR 0031](https://github.com/boadij/pi-herdsman/blob/283511764f88195aa94b25958a5949201ec468f5/docs/adr/0031-durable-manager-worktree-removal-approval.md),
commit `283511764f88195aa94b25958a5949201ec468f5`) makes the pending request
durable on the active session branch without granting deletion authority. The
maintainer approved adopting it together with
[ADR 0027](0027-repository-scoped-manager-removal-approval.md).

## Decision

A valid model removal request in a repository without preauthorization records
actionable review intent as strictly parsed, versioned custom entries on the
active Pi session branch. The tool result is `ok: false`,
`confirmation_required: true`, `pending: true`, with a correlated `request_id`.
Human command and menu review, and native status guidance, expose the pending
request.

- **Not authority.** Intent is not deletion authority, a deletion transaction,
  or an automatic cleanup queue. It never removes anything by itself and never
  stops execution. Each review and execution revalidates freshly under the
  existing locks, and no lock is held while a request awaits review.
- **Binding.** A request binds the exact assignment, session provenance, and
  physical checkout. Reload restores pending review for that branch only; it
  does not restore a former Manager lease as authority, and current Manager
  authority is required again.
- **Identity.** A duplicate for the same current target reuses the existing
  request identity. A changed assignment or checkout replaces it with a new
  identity.
- **Exact IDs.** Approval, cancellation, and dismissal name a request ID, so a
  stale action cannot consume a replacement.
- **Consumption.** Dismissal, cancelled confirmation, and an explicit Manager
  leave consume the corresponding intent. The consuming resolution is recorded
  and verified before destructive work, so consumed intent cannot replay into
  deletion after a crash.
- **Fresh targets.** Review of a recorded request stays bound to that exact
  target and rejects a stale one. A fresh, independently authorized request for
  the valid current target is neither vetoed nor authorized by a stale request
  for the same branch; the stale request is dismissed first.
- **Leave.** Before the leave commit point (persisted Lead role and
  coordinator state), failure rolls back to Manager and leaves intent pending.
  When the branch holds any valid removal history, the role and the latest
  removal entry must be read back from the native session first, even if a
  failed consuming write already emptied the in-memory pending list. If
  rollback cannot be proven, the role is suspended and the lease kept. After the
  commit point, each distinct pending request is attempted once as left; one
  failure does not skip the rest. If consumption cannot be verified, the role
  exit still completes and the partial state names the affected requests; an
  unconsumed request can be restored for review in a Manager session but never
  carries removal authority. This is not an atomic transaction.
- **Isolation.** Entries are read only from the active native branch and are
  bound to the current session identity. Entries outside that branch cannot
  affect review. Unrelated custom entries are ignored. Malformed or unsupported
  removal entries are ignored: they cannot create or consume intent and cannot
  block status, startup, or leave.

## Persistence assurance

Native `appendEntry` returning is not proof of persistence, because the host may
latch a write failure. After appending, Herdsman reads the persisted session
file through the native parser and requires the exact session header, active
branch ancestry, and custom entry. This proof precedes a pending
acknowledgement (including duplicate reuse), any resolution success, and
destructive execution. If proof is unavailable, the operation fails closed with
a persistence error. The assurance is native local-file crash persistence, not
an fsync or power-loss guarantee.

## Persistence boundary

[ADR 0002](0002-persist-intent-and-derive-runtime-state.md) persists intent and
derives runtime state, and [ADR 0007](0007-store-durable-state-under-pi-agent-data.md)
keeps durable Herdsman state under one root. Review intent is conversation
scoped durable intent, not coordination state: it lives in Pi's native session
entries ([ADR 0008](0008-prefer-native-pi-and-herdr-contracts.md)) so it follows
the session branch it was raised on. This narrow exception does not move
Herdsman root state, add a second store, or persist transient runtime
observations such as placement or liveness. Ownership and assignments remain in
their existing authoritative locations.

## Unchanged decisions

Herdr physical removal without force, branch and conversation preservation,
and retirement ordering and honest partial outcomes remain as stated in
[ADR 0027](0027-repository-scoped-manager-removal-approval.md),
[ADR 0019](0019-retire-project-assignments-when-worktrees-are-absent.md),
[ADR 0022](0022-commit-project-retirement-before-message-cleanup.md), and
[ADR 0023](0023-deliver-worktree-retirement-through-pending-manager-context.md).

## Rejected alternatives

- Storing intent in Herdsman root state: it would outlive and cross sessions
  and branches.
- A general approval or queue framework.
- Treating intent as standing authorization for later removal.

## Consequences

- A request survives reload on its own branch and is never lost to a missed
  prompt.
- Stale clicks, replays, and cross-branch actions cannot delete or consume
  newer intent.
- Runtime behavior is defined by source and tests; this record describes the
  boundary, not an exercised host guarantee.
