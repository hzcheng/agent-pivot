# Agent Pivot

Switch, monitor, and resume Codex, Claude, and Kimi sessions across VS Code
workspaces.

Agent Pivot is a workspace-level command center for seeing which AI coding
sessions are active, switching to them, reviewing user-input conversation
outlines, and returning to projects without losing context.

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
- Searches sessions, open workspaces, saved projects, and todos from one place,
  with a separate library for reusable prompts.
- Organizes projects with groups, favorites, descriptions, colors, and
  drag-and-drop ordering.

Agent Pivot supports local folders, `.code-workspace` files, Remote SSH, WSL,
and Dev Containers. Other-window navigation falls back to VS Code's native
window picker when a direct workspace target cannot be established safely.

## Agent sessions

Open the current workspace card to see `ACTIVE` and `SESSIONS`. Active rows
focus an existing terminal or attach to an existing managed tmux runtime.
Inactive history rows resume the selected provider session. For multi-root
workspaces, Agent Pivot uses the provider's native additional-directory option
so the session can work with all workspace folders.

Direct VS Code terminals are the default. The optional tmux mode keeps a
provider process available while its execution host remains awake and running;
closing or detaching the VS Code terminal does not stop that tmux process.
Agent Pivot does not provide a force-kill action for managed tmux runtimes.

Conversation outlines contain bounded previews of user input. Selecting an
outline item opens the matching provider transcript in a read-only editor and
navigates to that input. Agent Pivot reads the provider-local session metadata
and transcript only when needed for its session and conversation views.

The AI tab's SKILLS subtab lists Kimi, Claude, and Codex skills from user and project
skill directories in one place. Each skill shows its effectiveness per agent,
including shadowing diagnostics when another skill directory takes
precedence, and can be enabled or disabled with one click. Skills can be
collected into named groups (maintained by the extension, no file changes)
with collapsible folder nodes and one-click group enable/disable. Duplicate
copies across agent directories are fingerprinted, so drift is visible and
resolvable in one click; skills can also be copied between agents, repaired
with one-click diagnostic fixes, organized from collection suggestions, and
found through the dashboard's global search. Skills can be centralized into
a shared store (`~/.skills` or `<project>/.skills`) and enabled per agent
through symlinks, either card by card or in one shot with the
"Agent Pivot: Migrate Skills to Central Store" command (duplicates are
parked reversibly, links stay off until you enable them per card).

Agent Pivot does not provide, proxy, or resell access to Codex, Claude, or
Kimi. Install each provider tool you want to use and authenticate it separately
with that provider.

## Projects, prompts, and todos

The `OPEN` view shows the current workspace and lightweight navigation cards
for other VS Code windows. The `PROJECTS` view is the saved-project catalog.
Save a local or remote project, group related work, mark favorites, and reopen
the target in the current or a new window.

The prompt library stores reusable text and can insert a selected prompt into
the active terminal without appending Enter. Do not store passwords, tokens,
private keys, or other secrets in prompts.

The todo view supports groups, priorities, due dates, notes, completion, manual
ordering, and undo. Projects and todos can be kept in VS Code extension state
or in user settings for Settings Sync. Prompts use synchronized VS Code
extension state.

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

- `agentPivot.storeProjectsInSettings`: store projects and todos in user
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
- `agentPivot.aiSessionAttention.enabled`: show attention indicators when a
  managed provider session finishes or may need input.
- `agentPivot.maxVisibleAiSessions`, `agentPivot.maxVisibleProjectsPerGroup`,
  and `agentPivot.maxVisibleTodosPerGroup`: bound scrollable lists.
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

- VS Code settings and extension state for project, prompt, todo, view, and
  workspace preferences. Enabling `agentPivot.storeProjectsInSettings` writes
  project and todo data to user settings, where the user's VS Code Settings
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

## Optional artwork

Agent Pivot includes optional Mangekyō Sharingan running animations. The
bundled SVG files, creator credit, source links, modification status, and CC
BY-SA 3.0 terms are documented in
[Third-Party Notices](THIRD_PARTY_NOTICES.md). Selecting another animation or
`none` avoids displaying this artwork.

## Attribution

Agent Pivot began as a fork of Kruemelkatze/vscode-dashboard and retains the upstream MIT attribution.

The upstream copyright and MIT license terms remain in [LICENSE](LICENSE).
Notices for bundled JavaScript and optional artwork are in
[Third-Party Notices](THIRD_PARTY_NOTICES.md).

## License

Agent Pivot source code is available under the [MIT License](LICENSE).

- [Source repository](https://github.com/hzcheng/agent-pivot)
- [Issue tracker](https://github.com/hzcheng/agent-pivot/issues)
- [Changelog](CHANGELOG.md)
- [Third-Party Notices](THIRD_PARTY_NOTICES.md)
