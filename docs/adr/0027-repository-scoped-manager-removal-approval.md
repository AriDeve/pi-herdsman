# Scope Manager worktree-removal approval to a preauthorized repository

## Status

Accepted. Supersedes the per-removal-only approval policy in
[ADR 0020](0020-authorize-confirmed-manager-worktree-removal.md).

## Context

[ADR 0020](0020-authorize-confirmed-manager-worktree-removal.md) required an
independent, interactive human confirmation for every Manager-assigned
checkout removal, even when the user had explicitly asked the Manager to remove
it. The model-facing request could only point the user at a separate command.

The original upstream policy ([ADR 0030](https://github.com/boadij/pi-herdsman/blob/283511764f88195aa94b25958a5949201ec468f5/docs/adr/0030-project-scoped-manager-removal-approval.md),
commit `283511764f88195aa94b25958a5949201ec468f5`) lets a human preauthorize one
verified repository so the Manager can fulfill explicit removal requests
without repeating the prompt. The maintainer approved adopting that policy. This
is a deliberate policy enhancement, not the repair of a regression.

## Decision

Human confirmation remains the default. A human may preauthorize removal for
one exact verified repository; the permission skips only the additional
per-removal prompt.

- **Identity.** The repository is the current Manager repository key (the Git
  common directory), verified independently by the caller. Malformed or
  non-absolute identities are rejected.
- **Storage.** The permission is `worktreeRemovalPreapprovedRepos`, a list of
  exact repository keys in the user-controlled Herdsman global configuration,
  empty by default. There is no global boolean, and project or repository
  content cannot grant, widen, or inherit it.
- **Granting.** Enabling names the repository and requires typed `enable`.
  Manager Settings and `/manager remove-preapproval on|off` are the human
  entry points.
- **Revocation.** Revoking takes effect immediately. Authorization is read fresh
  before destructive execution. Configuration updates hold the existing lock
  and preserve entries for other repositories.
- **Execution.** Preauthorization is not a bypass. Removal still requires an
  active Manager and revalidates the exact repository, assignment, linked
  checkout and session provenance, unrelated execution occupancy, cleanliness,
  primary-checkout exclusion, locks, and final conditions. Herdr remains the
  physical remover without force.
- **No independent trigger.** Completion, review, inactivity, or a pending
  request never causes removal. Removal happens only for an explicit request.

Without preauthorization, a valid model request returns promptly with
`ok: false`, `confirmation_required: true`, `pending: true`, and a correlated
`request_id`, and records review intent as defined in
[ADR 0028](0028-durable-manager-removal-intent.md). The Manager is never blocked
waiting for the human.

## Configuration trust

This follows the pattern of [ADR 0024](0024-support-trusted-project-orchestration-preferences.md)
in staying narrow, but with the opposite trust direction. ADR 0024 lets trusted
project settings override two behavior preferences. Deletion authority is
different: it is a user-only grant in the global configuration under Pi agent
data ([ADR 0007](0007-store-durable-state-under-pi-agent-data.md)), because
repository content is attacker-influenced and must not authorize deletion of its
own checkouts. This does not extend ADR 0024's project-override exception.

## Unchanged decisions

- [ADR 0013](0013-use-herdr-worktree-removal-for-project-retirement.md): Herdr
  owns physical worktree removal; the Git branch and Pi conversation are
  preserved.
- [ADR 0019](0019-retire-project-assignments-when-worktrees-are-absent.md),
  [ADR 0022](0022-commit-project-retirement-before-message-cleanup.md), and
  [ADR 0023](0023-deliver-worktree-retirement-through-pending-manager-context.md):
  assignments and project messages retire only under authoritative removal or
  absence evidence, in the established order, with context delivered through
  pending Manager context. Checkout removal, presence, or uncertainty remains
  distinct from confirmed assignment retirement, and a Lead stopped before a
  later failure is reported honestly.
- Workspace closure, stopping a Lead, and `/takeover` remain separate.

## Rejected alternatives

- A general approval framework or policy engine: out of scope for one
  operation.
- A global or per-project boolean: too broad, and project settings must not
  grant deletion.
- Automatic cleanup after completion or inactivity: removal needs an explicit
  request.
- Compatibility shims for the per-removal-only policy: the old policy is
  superseded, not preserved.

## Consequences

- Default behavior is unchanged for repositories without a grant.
- Revocation and authorization are re-read at execution, so a stale decision
  cannot outlive the grant.
- Preauthorization removes a prompt, not a safety check.
