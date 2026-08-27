# Agent Pivot

Switch, monitor, and resume Codex, Claude, and Kimi sessions across VS Code
workspaces.

Agent Pivot is a workspace-level command center for seeing which AI coding
sessions are active, switching to them, reviewing user-input conversation
outlines, and returning to projects without losing context.

[![Ko-fi](https://img.shields.io/badge/Ko--fi-buy%20me%20a%20coffee-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/hongzecheng)
[![爱发电](https://img.shields.io/badge/%E7%88%B1%E5%8F%91%E7%94%B5-%E8%B5%9E%E5%8A%A9-946ce6)](https://afdian.com/a/hzcheng)

## What Agent Pivot does

- Shows the current workspace, other open workspaces, and saved projects in one
  Activity Bar view.
- Finds active and historical Codex, Claude, and Kimi sessions across every
  folder in a workspace.
- Discovers Kimi, Claude, and Codex skills in the AI tab's SKILLS subtab, with per-agent
  effectiveness, shadowing diagnostics, and one-click enable/disable.
- Focuses a running session or resumes an inactive one in a VS Code terminal
  or a managed tmux runtime.
- Shows bounded user-input conversation outlines and opens provider transcripts
  in a read-only editor viewer.
- Searches sessions, open workspaces, and saved projects from one place,
  with a separate library for reusable prompts.
- Organizes projects with groups, favorites, descriptions, colors, and
  drag-and-drop ordering.

Agent Pivot supports local folders, `.code-workspace` files, Remote SSH, WSL,
and Dev Containers. Other-window navigation falls back to VS Code's native
window picker when a direct workspace target cannot be established safely.

## Agent sessions

The OPEN tab keeps `WINDOWS` visible for switching among VS Code windows.
Below it, `CHATS` shows active sessions and `ALL` shows the complete session
history. CHATS defaults to Tree view, which keeps every ready worktree visible
for management even when it has no active session; its menu can switch to a
recent-activity List view with branch chips. Active rows focus an existing
terminal or attach to an existing managed tmux runtime; selecting the
already-focused active row opens its AI Conversation at the latest input.
Inactive history rows resume the selected provider session. For multi-root
workspaces, Agent Pivot uses the provider's native additional-directory option
so the session can work with all workspace folders.

The Worktree tab lists the Git worktrees of every repository in the workspace
with their live sessions. Use the branch icon beside the tabs to create a
dedicated worktree and branch under `<repository>/.worktrees/` (configurable
via `agentPivot.worktreeDirectory`), or branch a new worktree from any row's
menu. Creating a worktree never starts a session; each row's menu starts a
session in that worktree with the remembered or any chosen provider. Set
`agentPivot.worktreeSetupCommand` to an executable-and-arguments array such as
`["npm", "ci"]` when every new worktree needs setup; Agent Pivot runs it
directly without a shell. Provisioning progress survives extension reloads,
and an interrupted row can be retried without recreating a completed worktree
or rerunning a completed setup step.

Managed worktrees offer removal from their row menu. Removal is confirmed and
revalidated against Git immediately before execution; worktrees that are
dirty, active, currently open, or still provisioning are refused with the
reason. Removing a worktree keeps its local branch.

Direct VS Code terminals are the default. The optional tmux mode keeps a
provider process available while its execution host remains awake and running;
closing or detaching the VS Code terminal does not stop that tmux process.
Agent Pivot does not provide a force-kill action for managed tmux runtimes.

Conversation outlines contain bounded previews of user input. Selecting an
outline item opens the matching provider transcript in a read-only editor and
navigates to that input. Agent Pivot reads the provider-local session metadata
and transcript only when needed for its session and conversation views.

The AI tab's SKILLS subtab splits Global and Project skills into two panes
that scroll independently; drag the separator between them (or focus it and
use the arrow keys) to resize the Project pane. Skills render as a quiet
list — icon, name, one-line summary, per-agent state dots — with actions
appearing on hover or in the row's ⋯ menu, and an expandable detail panel
per skill. Folder headers stay pinned while their lists scroll, stacking by
depth in deep trees. Skills are organized as the
on-disk folder tree of the
shared stores (`~/.skills` globally by default, configurable from Settings or the
Global section menu; `<project>/.skills` per project) —
folders are real directories you can also manage with shell or git, never
extension state. Single-child folder chains collapse into one compact row
(`google/skills/skills`), deeply nested empty folders stay hidden, and
skills bundled inside another skill's directory are discovered as their own
entries. Scope is positional: skills in the global store are enabled
into the user-level agent directories (`~/.kimi/skills` and friends), skills
in a project's store into that project's agent directories. Each skill is
enabled per agent (Kimi, Claude, Codex) through iOS-style switches that
create top-level symlinks in the agent's skills directory. Folder headers
show per-agent state dots and a dropdown of per-agent batch switches that
enable or disable every skill inside for that agent (with an indeterminate
state for partial folders); folders can be created from the section "+" and
empty folders deleted from their "×". Cards can be filed by drag-and-drop
or a "Move to folder…" editor — both perform real `mv` operations and keep
existing links pointed at the skill. Skills still living in agent
directories appear in a "Not in the shared store" section and can be centralized card by
card or in one shot with the "Agent Pivot: Migrate Skills to Central Store"
command, and unmanaged rows can also be deleted outright from their ⋯ menu (with
confirmation). Centralizing or migrating picks the
kimi > claude > codex copy as the winner and deletes the other duplicate
copies. Duplicate copies are
fingerprinted so drift is visible and resolvable in one click; skills can
also be copied between agents, repaired with one-click diagnostic fixes,
filed from collection suggestions, and found through the dashboard's global
search.

Agent Pivot does not provide, proxy, or resell access to Codex, Claude, or
Kimi. Install each provider tool you want to use and authenticate it separately
with that provider.

## Projects and prompts

The `OPEN` view shows the current workspace and lightweight navigation cards
for other VS Code windows. The `PROJECTS` view is the saved-project catalog.
Save a local or remote project, group related work, mark favorites, and reopen
the target in the current or a new window.

The prompt library stores reusable text and can insert a selected prompt into
the active terminal without appending Enter. Do not store passwords, tokens,
private keys, or other secrets in prompts.

Projects can be kept in VS Code extension state or in user settings for
Settings Sync. Prompts use synchronized VS Code extension state.

## Notifications

Agent Pivot can push a message to your IM app or phone when an AI session
stops and waits for you: completed, needs input, or failed. **This is the
only outbound network request the extension ever makes, and it is off by
default.** Nothing leaves the machine until you set
`agentPivot.notify.enabled` to `true` and configure at least one sink.

The first time notifications are enabled, a modal dialog explains what will
be sent and asks for confirmation. Declining it turns
`agentPivot.notify.enabled` back off; accepting is remembered in extension
state and never asked again.

A notification contains only:

- the project name (just the folder name by default;
  `agentPivot.notify.projectPathMode` can switch to the full path),
- the session name (can be hidden with
  `agentPivot.notify.includeSessionLabel`),
- the provider, the stop reason, and how long the session ran,
- the machine hostname and a short `#` correlation code.

It never contains code, conversation content, or full paths (in the default
`basename` mode).

**Channels.** Nine channels are supported. Run
`Agent Pivot: Set Notification Webhook` and pick one: the command asks for a
sink id and the channel fields, stores the credentials in VS Code
SecretStorage, writes the non-secret skeleton into `agentPivot.notify.sinks`
for you, and offers to enable notifications if they are off. Re-running it
with an existing id rotates that sink's credentials without touching its
skeleton; picking a different channel for an existing id is refused so the
two halves cannot drift apart. You never have to hand-edit JSON — except for
the `custom` channel, whose `method`, `headers` and `bodyTemplate` are
free-form and therefore completed manually.

Each sink is configured in two
halves: the non-secret skeleton in `agentPivot.notify.sinks` (machine-scoped)
and the credentials entered through `Agent Pivot: Set Notification Webhook`,
which stores them in VS Code SecretStorage keyed by the sink `id`. A sink
only becomes active when both halves exist with the same `id`. The per-channel
reference below shows what the command writes (or what to write by hand for
`custom`).

- `ntfy` — skeleton:
  ```json
  { "id": "s1", "channel": "ntfy", "baseUrl": "https://ntfy.sh", "priority": 4, "proxy": null }
  ```
  Webhook fields: `topic`, `token` (leave `token` empty for an
  unauthenticated public topic). `priority` is required by the schema; the
  sent priority is derived from the stop reason. On a public ntfy instance
  the topic name is the only secret — anyone who guesses it can subscribe —
  so generate one with `openssl rand -hex 16`.
- `telegram` — skeleton:
  ```json
  { "id": "s2", "channel": "telegram", "proxy": null }
  ```
  Webhook fields: `botToken`, `chatId`.
- `bark` — skeleton:
  ```json
  { "id": "s3", "channel": "bark", "proxy": null }
  ```
  Webhook fields: `serverUrl`, `deviceKey`.
- `feishu`, `wecom`, `slack`, `discord` — skeleton (shown for `feishu`):
  ```json
  { "id": "s4", "channel": "feishu", "proxy": null }
  ```
  Webhook field: `url` (the bot or app webhook URL).
- `dingtalk` — skeleton:
  ```json
  { "id": "s8", "channel": "dingtalk", "proxy": null }
  ```
  Webhook fields: `url`, `secret` (the signing secret of the robot).
- `custom` — skeleton:
  ```json
  { "id": "s9", "channel": "custom", "method": "POST", "headers": { "Content-Type": "application/json" }, "bodyTemplate": "{\"text\": \"${title}\\n${body}\"}", "proxy": null }
  ```
  Webhook field: `url`. `bodyTemplate` supports the placeholders `${title}`,
  `${body}`, `${project}`, `${session}`, `${provider}`, `${reason}`,
  `${host}`, and `${correlationId}`.

Some channels could also deliver your reply back to the session in a future
release; with several machines running Agent Pivot, replies do not always
reach the machine that sent the notification:

| Channel | Replies in v2 | Multi-machine replies |
| --- | --- | --- |
| ntfy | ✅ SSE / long-poll | ✅ pub/sub broadcast |
| telegram | ✅ getUpdates long-poll | ❌ competing consumers |
| slack | ✅ Socket Mode | ❌ load-balanced |
| discord | ✅ Gateway WebSocket | ❌ load-balanced |
| dingtalk | ✅ Stream mode | ⚠️ unclear |
| feishu | ✅ long connection | ❌ documented random delivery |
| wecom | ❌ public callback only | — |
| bark | ❌ strictly one-way | — |
| custom | user-defined | user-defined |

**Credentials.** Webhook secrets live in VS Code SecretStorage, never in
settings.json, because settings can be synchronized by Settings Sync or
committed to a dotfiles repository. Manage them only through `Agent Pivot:
Set Notification Webhook`.

**Proxy.** Set `agentPivot.notify.proxy` (machine-scoped), for example
`http://127.0.0.1:7890`. When it is empty, the `HTTPS_PROXY` / `ALL_PROXY`
environment variables are used (`NO_PROXY` is honored). A sink's own `proxy`
field takes precedence over both.

**Troubleshooting.** Run `Agent Pivot: Send Test Notification` first — it
logs a `status=...` line per sink — then inspect the delivery log with
`Agent Pivot: Show Notification Log`.

**When a notification is sent.** Four gates decide:

- the stop reason must be listed in `agentPivot.notify.reasons` (`failed` is
  only produced by Claude sessions),
- sessions shorter than `agentPivot.notify.minRunDurationMs` (default one
  minute) never notify,
- `agentPivot.notify.debounceMs` batches rapid stops, and once more than
  `agentPivot.notify.rateLimitPerMin` notifications would go out in a minute,
  the overflow merges into one summary message,
- dismissing the attention red dot in the Agent Pivot view cancels the pending
  notification for that event, and an already-sent event never repeats.

## Requirements

- A current VS Code release in a trusted workspace is required to start or
  resume provider processes. Restricted Mode keeps project and session history
  readable but blocks launches.
- The Agent Pivot Attention UI Bridge is a required local UI-host dependency
  and companion. It enables bounded
  other-window/attention coordination for local, SSH, WSL, and Dev Container
  workspaces.
- Install and authenticate the Codex, Claude, or Kimi command-line tools you
  intend to use. Provider accounts and access are not included with Agent
  Pivot.
- tmux is optional. To use it, install tmux on the extension host: locally for
  a local window, on the SSH host, inside WSL, or inside the Dev Container.
  Native Windows extension hosts can use Direct Terminal mode; the tmux
  backend requires a POSIX extension host.

## Getting started

1. Install Agent Pivot and confirm its required Agent Pivot Attention UI Bridge
   dependency is installed on the local UI host.
2. Open the Agent Pivot icon in the Activity Bar.
3. Open a project and run `Agent Pivot: Save Project` from the Command Palette.
4. Expand the current workspace card to inspect active or historical sessions.
5. Select `NEW`, choose an installed provider, and start a session.

Useful commands include:

- `Agent Pivot: Open`
- `Agent Pivot: Save Project`
- `Agent Pivot: Add Project`
- `Agent Pivot: Add Projects from Folder`
- `Agent Pivot: Add Group`
- `Agent Pivot: Edit Projects`
- `Agent Pivot: Insert Prompt into Active Terminal`

## Configuration

Configure Agent Pivot in VS Code settings. Common settings include:

- `agentPivot.storeProjectsInSettings`: store projects in user
  settings so VS Code Settings Sync can synchronize them.
- `agentPivot.aiSessionTerminalMode`: use `vscode` (default) or `tmux` when
  creating a runtime.
- `agentPivot.aiSessionTmuxLayout`: use one managed tmux session per project or
  one per AI session.
- `agentPivot.aiSessionTmuxPath`: set one tmux executable name or absolute
  executable path, without arguments or shell syntax.
- `agentPivot.aiSessionYoloMode`: opt in to provider approval and sandbox
  bypass for newly created and resumed provider processes. It is off by
  default and does not change an already-running process.
- `agentPivot.worktreeDirectory`: directory that holds isolated worktrees,
  relative to the repository root. Defaults to `.worktrees`. Absolute paths
  and `..` segments fall back to the default.
- `agentPivot.worktreeSetupCommand`: optional executable-and-arguments array
  run in each newly created worktree. No shell syntax is interpreted; leave it
  empty to skip setup.
- `agentPivot.codexDefaultProfile`: default Codex configuration profile
  (`-p <name>`, layered from `<name>.config.toml` in the Codex home) for
  newly created Codex sessions. When at least one profile file exists, the
  new-session flow also asks which profile to use. Resuming always reuses the
  profile recorded at creation; Agent Pivot stores the profile name, not a
  configuration snapshot, so editing or deleting the profile file changes
  later resume behavior. Known limitations: a shell rc that overrides
  `CODEX_HOME` inside terminals is not supported (the extension discovers
  profiles in the extension host's `CODEX_HOME`), and the profile store is
  last-writer-wins across concurrent VS Code windows.
- `agentPivot.aiSessionAttention.enabled`: show attention indicators when a
  managed provider session finishes or may need input.
- `agentPivot.maxVisibleProjectsPerGroup`: bound the scrollable project list.
- `agentPivot.applyProjectColorToWindow`: opt in to writing workspace
  `workbench.colorCustomizations` values from a saved project color.
- `agentPivot.customCss`: inject user-supplied CSS into the Agent Pivot
  Webview. The setting is intentionally not sanitized.

> Enabling approval or sandbox bypass can allow provider commands to act
> without their normal confirmation boundary. Enable it only in workspaces
> and environments you trust.

## Privacy and local data

Agent Pivot has no product telemetry service and does not upload conversation content to an Agent Pivot service.

Agent Pivot uses these local data sources and stores:

- VS Code settings and extension state for project, prompt, view, and
  workspace preferences. Enabling `agentPivot.storeProjectsInSettings` writes
  project data to user settings, where the user's VS Code Settings
  Sync configuration may synchronize it.
- Provider-local session metadata and transcript reads for session discovery,
  user-input outlines, and the read-only conversation viewer.
- Local extension state for managed terminal and tmux metadata used to find and
  reattach known runtimes.
- The local companion bridge directory in the UI host's VS Code extension
  storage. The bridge records workspace and root URIs locally for bounded attention and open-workspace coordination. Those URIs can include absolute local paths or remote-authority identifiers. It does not record conversation content, prompts, or responses.

Provider tools are installed and authenticated separately and may have their
own network, telemetry, retention, and account behavior. VS Code, Settings
Sync, GitHub, remote hosts, tmux, and commands or CSS chosen by the user also
operate under their own configuration and terms.

## Custom running animation artwork

Agent Pivot does not bundle third-party artwork. The `custom` running
animation slots display an image you supply from your own machine: point
`agentPivot.aiSessionRunningCardCustomImage` and/or
`agentPivot.aiSessionRunningIconCustomImage` at a local SVG, PNG, GIF, WebP,
or JPEG file (up to 256 KB). The file is read locally and never leaves your
machine, and you are responsible for having the rights to use the image you
choose.

## Support Agent Pivot

Agent Pivot is free and open source, with no telemetry and no paywalled core
features. If it saves you time, you can buy the author a coffee — sponsorships
fund upcoming Pro features such as one-click phone push and remote session
reply.

- [Star on GitHub](https://github.com/hzcheng/agent-pivot) — free, and it helps others discover the project
- [Ko-fi](https://ko-fi.com/hongzecheng) — PayPal / card, from anywhere
- [爱发电 (Afdian)](https://afdian.com/a/hzcheng) — 微信 / 支付宝

## Attribution

Agent Pivot began as a fork of Kruemelkatze/vscode-dashboard and retains the upstream MIT attribution.

Agent Pivot is an independent open-source project and is not affiliated with,
endorsed by, or sponsored by OpenAI, Anthropic, Moonshot AI, or Microsoft.

The upstream copyright and MIT license terms remain in [LICENSE](LICENSE).
Notices for bundled JavaScript libraries are in
[Third-Party Notices](THIRD_PARTY_NOTICES.md).

## License

Agent Pivot source code is available under the [MIT License](LICENSE).

- [Source repository](https://github.com/hzcheng/agent-pivot)
- [Issue tracker](https://github.com/hzcheng/agent-pivot/issues)
- [Changelog](CHANGELOG.md)
- [Third-Party Notices](THIRD_PARTY_NOTICES.md)
