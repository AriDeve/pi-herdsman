# Configuration

[Documentation index](../README.md)

Pi Herdsman keeps its defaults and general configuration in one flat,
user-wide file:

```text
<Pi agent directory>/pi-herdsman/config.json
```

The default location is `~/.omp/agent/pi-herdsman/config.json`. OMP's native
`getAgentDir()` determines the agent directory, so setting
`PI_CODING_AGENT_DIR` relocates the file to
`$PI_CODING_AGENT_DIR/pi-herdsman/config.json`.

Two preferences can be overridden for a trusted project in Pi's
`<project>/.omp/settings.json`:

```json
{
  "piHerdsman": {
    "autoActivateManager": true,
    "contextRetirement": false
  }
}
```

Only `autoActivateManager` and `contextRetirement` are project-overridable;
`desktopNotifications` and `worktreeRemovalPreapprovedRepos` are user-only.
Built-in defaults are overlaid by the global configuration, then by explicitly
set project values. An omitted project property inherits the global value;
explicit `false` overrides global `true`. Project overrides apply only when Pi
considers the current project trusted. An untrusted project or an absent
project override inherits the global value; malformed trusted project settings
raise a configuration error instead of falling back. The rest of
`.omp/settings.json` remains OMP-owned. Agent definitions are separate and
continue to use the bundled, project-local, and user agent-definition
locations described in the
[agent-definition guide](../guides/agent-definitions.md).

## Schema and defaults

The file contains only explicitly configured overrides. The accepted flat
schema is:

```json
{
  "defaultLeadExecution": "flexible",
  "spawnPlacement": "subtree",
  "contextRetirement": true,
  "autoActivateManager": false,
  "desktopNotifications": false,
  "inlineAttachmentLimitBytes": 131072,
  "mailboxPayloadLimitBytes": 131072,
  "worktreeRemovalPreapprovedRepos": []
}
```

An absent file means these defaults:

| Field                             |            Default | Allowed values                                    |
| --------------------------------- | -----------------: | ------------------------------------------------- |
| `defaultLeadExecution`            |         `flexible` | `flexible`, `orchestrate`                         |
| `spawnPlacement`                  |          `subtree` | `tab`, `subtree`, `split`                         |
| `contextRetirement`               |               true | boolean                                           |
| `autoActivateManager`             |              false | boolean                                           |
| `desktopNotifications`            |              false | boolean                                           |
| `inlineAttachmentLimitBytes`      | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB) |
| `mailboxPayloadLimitBytes`        | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB) |
| `worktreeRemovalPreapprovedRepos` |               `[]` | array of absolute repository keys                 |

Malformed JSON, a non-object root, unknown fields, and invalid known values
are errors. Reads do not create the directory or file. Herdsman's human
configuration controls update this single file atomically.

`defaultLeadExecution` selects the initial profile only for a future ordinary
Lead session that has no persisted execution choice. Its values select
`flexible-lead` or `orchestrator-lead`; it does not change a running session,
and an existing session choice takes precedence. Manager-created assigned Leads
use `managed-lead` instead.

`inlineAttachmentLimitBytes` applies per file. Eligible complete strict UTF-8
files are embedded only when the complete durable payload fits; other files
remain canonical references. `mailboxPayloadLimitBytes` limits new managed-Agent
request and ask payloads and new Manager project assignments. Ordinary
coordination records remain subject to this configured limit and their fixed
8 KiB ceiling. Project assignments are persisted separately from their compact
inbox notification, so that coordination ceiling does not reduce the evidence
capacity of a Manager-to-Lead assignment.

When the effective `contextRetirement` preference is enabled, automatic
context pressure retires a managed-agent session. Herdsman suppresses
preventive threshold compaction while the assignment finalizes and leaves Pi's
overflow recovery available. The session receives a finalization instruction,
and its result requires a fresh agent for follow-up. Disabling the preference
bypasses retirement, including enforcement of existing retirement markers,
and leaves Pi's native compaction and session reuse behavior untouched. The
preference is evaluated at retirement and continuation checks, so a trusted
project setting can change how an existing marker is enforced. The policy is
applied in the applicable project context; a caller's project override cannot
bypass a retired marker for an Agent from another project when that target
project's applicable opt-out cannot be verified. In that case, continue from
the original trusted project context or create a fresh Agent.

When the effective `autoActivateManager` preference is enabled, a session
without a persisted `pi-herdsman-role` entry attempts Manager startup only from
its Herdr primary workspace. Linked workspaces, unavailable eligibility
evidence, or an existing Manager leave it as an ordinary Lead. The preference
does not persist Manager role intent and changing it does not affect the current
session.

The Settings menu edits global defaults and, in the `Project overrides…` submenu,
trusted-project values for these two preferences. Choose `Inherit global`, `On
for this project`, or `Off for this project`; inheritance removes the stored
project property. Global controls remain independent, and an explicit project
value takes precedence over the global value. Untrusted projects cannot be read
or edited through this menu. Changes follow the existing preference evaluation
lifecycle and do not retroactively change an already-running role or operation.
Project override writes preserve unrelated JSON keys. OMP's ordinary settings
edits target `config.yml`; Herdsman's project preferences use `.omp/settings.json`.

Placement affects future starts, not existing agents. `tab` uses one lead-owned
agents tab, `subtree` gives each lead-direct agent its own tab, and `split`
splits from the caller's pane. Nested delegation always splits in its owner's
current tab.

## Desktop notifications

When `desktopNotifications` is `true`, an interactive session running inside
Herdr raises its own desktop notification when a session you manage directly
finishes work or newly needs input. It is off by default. Toggle it in
`/herdsman → Settings → Desktop notifications`; the change applies to the
current session without a reload and never replays earlier events. The setting
is user-wide and has no project override.

This feature does not change Herdr's own popup or sound settings. Herdr's global
delivery switches silence every session, so to hear only these notifications,
turn Herdr's off yourself in its `config.toml`:

```toml
[ui.toast]
delivery = "off"

[ui.sound]
enabled = false
```

Herdsman reports state to Herdr exactly as before; the sidebar, asks, results,
and coordination are unaffected.

### Which sessions notify

Only a verified Manager, Chief, or standalone Lead notifies. Assigned Managed
Leads and delegated Agents stay silent, including when they need input.
Eligibility comes from the session's exact verified identity, its durable Agent
ownership, and its project assignment, not from the directory, worktree, label,
or launch profile. A session whose identity cannot be verified or is ambiguous
stays silent. A manually continued managed session stays managed. When a session
becomes eligible by a confirmed takeover, or ceases to be eligible, only later
events are affected; earlier ones are not replayed.

### When it notifies

- **Completion:** work ended successfully and Herdr's fresh state for that
  session is idle. Startup, restored idle sessions, duplicate Herdr events, and
  scheduled continuations do not count.
- **Needs input:** the session newly becomes blocked on a question or approval.

An eligible event waits one second, then is checked against current state before
it is sent. It is dropped if work resumed, the input was resolved, the session
was replaced or shut down, the feature was disabled, or ownership changed.
Selecting the session's tab does not suppress a notification. Each notification
is titled `Herdsman · <role>` and names the session and event; transcript
content is not included.

This relies on Herdr's event subscription and does not raise the supported
Herdr or runtime minimum. Sessions outside Herdr or without a UI do not notify.

### Platform prerequisites

Delivery uses the operating system's own notifier and the default appearance,
sound, and click behavior. Clicking does not focus the session. Operating
system notification permissions, Do Not Disturb, and sound settings remain
authoritative, so a notification can be accepted yet not shown or heard. Each
platform needs its tool and permissions in place before you opt in:

| Platform | Used                              | Prerequisites                                                                                                                 |
| -------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Linux    | `notify-send` (libnotify)         | `notify-send` on `PATH` and a running desktop notification service on the session D-Bus. Requests the standard message sound. |
| macOS    | `osascript` notification, `Glass` | Allow notifications for the script host in System Settings.                                                                   |
| Windows  | Windows PowerShell toast          | Windows PowerShell's Start-menu shortcut registered (`Get-StartApps`), and its notifications enabled in Windows settings.     |

On Windows, restore the PowerShell Start-menu shortcut if it is missing.
Herdsman checks that the entry exists and that notifications are enabled, but
that does not guarantee a toast is presented. Availability on a given system
is not guaranteed on any platform.

A delivery attempt that fails or takes longer than five seconds produces one
bounded warning in the session UI naming the missing prerequisite. It never
blocks or alters coordination, and no fallback delivery is attempted.

macOS and Windows delivery have not been run against real systems, so treat
their prerequisites as documented expectations until you confirm them on your
machine.

## Worktree removal preauthorization

By default every Manager checkout removal needs a human to type `remove`.
`worktreeRemovalPreapprovedRepos` lists exact repository keys (the Git common
directory of a Manager's verified repository) for which the `remove_worktree`
tool may run the guarded removal without that extra prompt. It is read only from
this user-wide file; project settings and repository content cannot set or
inherit it, and project settings reject the field. Use `/manager
remove-preapproval on|off` or the Manager `Settings` menu: enabling names the
repository and requires typing `enable`, revoking takes effect immediately, and
other repositories' entries are preserved. The list is read fresh before each
removal, so revocation also stops an operation that has not yet reached Herdr.
Preauthorization does not relax authority, identity, occupancy, cleanliness, or
lock checks and never triggers removal by itself.

## Reset

Stop active Pi and Herdsman processes first; running processes may recreate
runtime state. Then delete the complete Herdsman directory at this canonical
location:

```text
<resolved Pi agent directory>/pi-herdsman/
```

`<resolved Pi agent directory>` means the result of Pi's native
`getAgentDir()`. With a custom `PI_CODING_AGENT_DIR`, Pi resolves that value
(including values such as `~`) before appending `pi-herdsman`; do not construct
the path by concatenating the raw environment variable yourself. Use the
native file-management operation for the current platform to delete that
directory.

The next process starts with the defaults and recreates only the runtime state
it needs.

## See also

- [`/agents` commands](commands.md)
- [Getting started](../getting-started.md)
