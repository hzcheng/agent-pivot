# Change Log

All notable changes to the "Agent Pivot" extension will be documented in this file. It follows the [Keep a Changelog](http://keepachangelog.com/) recommendations.

## [Unreleased]

### Added

- New `Agent Pivot: Sponsor` command and a heart button in the dashboard
  toolbar row (between the search box and the collapse-all button) open a
  picker with a GitHub star link and the project's sponsorship pages (Ko-fi
  for PayPal/card, Afdian for WeChat Pay/Alipay); the repository now carries
  `.github/FUNDING.yml` and README sponsor badges.
- Marketplace discoverability metadata: the description now also names the
  project manager, prompt library, and todo surfaces, and the keyword list
  covers the agent/AI provider search terms (`codex cli`, `claude code`,
  `kimi cli`, `ai sessions`, `session manager`, `project manager`, `todo`,
  `prompts`, and more).

- AI Conversation Comments now open with a Workspace section above the
  Session list: quick-capture notes with free-form tags, tag filtering, and
  one-click dispatch into the current Session's input. Project notes are
  shared by every Session of the project, keep their dispatch history, and
  stay open until you mark them done; selected conversation text can be
  saved straight into a project note as a source snapshot.
- AI Conversation telemetry bar now leads with the provider's brand icon
  (the same Simple Icons logos used by the dashboard Session cards) in front
  of the model and worktree chips, and it follows cross-provider Session
  switches live.
- New `agentPivot.aiSessionRunningCardCustomImage` and
  `agentPivot.aiSessionRunningIconCustomImage` settings plus a `custom`
  choice in both running-animation settings: display your own local image
  (SVG, PNG, GIF, WebP, or JPEG up to 256 KB) as the rotating running
  indicator. The file is read locally and never uploaded.

### Fixed

- The Comments panel's Workspace and Session group headers now render as
  full-width background bands, so the two groups are easy to tell apart at
  a glance.
- Workspace note status messages are now prefixed (`Workspace: ...`), so a
  note operation and a Session comment operation running at the same time
  no longer overwrite each other's status text.
- Upgraded the bundled Mermaid diagram renderer from 11.16.0 to 11.16.1 and
  DOMPurify from 3.4.12 to 3.4.13 to pick up upstream security fixes
  (GHSA-6x64-9x62-f2gx, GHSA-3rrr-jr9j-h3q3, GHSA-55q2-fjhq-7xh7).

### Removed

- Removed the bundled anime artwork running-animation options (third-party
  intellectual property) from the running-animation settings. Configurations
  that still reference them fall back to the default `current` animation;
  use the new `custom` slots with your own image instead.

## [1.0.4] - 2026-08-06

### Added

- New `Agent Pivot: Switch to Open Window` command lists the other open VS
  Code windows in a Quick Pick and switches to the selected window, so window
  switching is available from the keyboard without opening the dashboard.
- OPEN WINDOWS cards and the Switch to Open Window Quick Pick now display the
  saved project name when the window matches a saved project (falling back to
  the workspace name otherwise), with the project group shown as the Quick
  Pick description.

### Changed

- AI Conversation comment cards were redesigned around two states: `open`
  (unsent, the only sendable state) and `done` (sent). Cards render comments
  in full in a read-only view with uniform rounded icon buttons; open cards
  offer send/locate/edit/delete, done cards collapse to a dimmed single line
  by default (freshly sent cards stay expanded once) and can be edited, which
  flips them back to open for resending. An explicit edit mode uses an
  autosized textarea (Ctrl+Enter saves, Esc cancels), a per-card send button
  stages only that comment (with its quoted source) into the active Session
  input, and the resolve/reopen review states were removed.
- AI Conversation comments panel: an All/Open/Done icon filter plus a one-row
  icon toolbar (filter, send with open count, clear done, confirmed clear
  all), relative created/sent timestamps on cards, a clickable count marker on
  messages with comments that jumps to and flashes the matching card, and the
  telemetry pill now reports open/total (e.g. `Comments 2/5`). Existing stored
  comments migrate automatically (sent and resolved become done).

### Fixed

- Cleared AI-session attention no longer returns after 24 hours when an old
  completion is replayed by a restarted Extension Host; the UI Bridge retains
  stable event acknowledgements until bounded capacity eviction.
- Window reloads no longer stall tmux session restoration on windows with many
  terminals: attach restore now resolves terminal process IDs concurrently
  (previously serial with a per-terminal timeout, which multiplied the delay
  by the terminal count while the pty host was still reconnecting) and shares
  a single live-client list across all terminals instead of one tmux
  invocation per terminal.

## [1.0.3] - 2026-08-04

### Added

- AI Conversation now shows user-facing progress updates by default across
  Codex, Claude, and Kimi, including tool preambles and Kimi plans, while
  keeping private Thinking independently hidden unless enabled.
- AI Conversation can show provider thinking blocks, including safe Codex
  reasoning summaries, as collapsed entries interleaved
  with assistant text and tool calls for Kimi, Claude, and Codex sessions.
  Thinking is hidden by default and can be enabled for main sessions and
  subagent transcripts with `agentPivot.aiConversation.showThinking`.
- AI Conversation Markdown code fences now render with syntax highlighting,
  while mermaid fences keep their diagram rendering.

### Fixed

- AI Conversation now contains scrolling within the message viewport, keeping
  its header and session telemetry visible during Latest navigation, and
  preventing blank overscroll beyond the content.
- AI Conversation now follows live response content automatically while the
  reader is at the end, without requiring a New response content button;
  scrolling up still preserves the historical reading position.
- AI Conversation shows an animated Working status below the latest response
  while the provider is still processing, including active Codex turns read as
  interrupted by a detached reader and lifecycle-only transitions without new
  provider content, then removes it on completion.

## [1.0.2] - 2026-08-03

### Added

- AI Conversation viewers now list a session's subagents in a dedicated
  Subagents tab for Kimi, Claude, and Codex sessions, with status badges,
  running entries pinned to the top, a persisted Running only filter, and an
  Agents quick-entry pill in the usage bar. Selecting a subagent reads its
  transcript in place and a banner returns to the main conversation; nested
  subagents stay visible inside their parent's transcript.
- AI Conversation renders provider tool calls as collapsible entries
  interleaved with the assistant output, in main sessions and subagent
  transcripts alike: shell commands, file reads and edits, and searches pair
  input with output under a one-line summary, so agent work stays auditable.
- Kimi plan-mode updates now render inline in the AI Conversation assistant
  stream.
- The AI Conversation usage bar now covers Kimi and Claude sessions: Kimi
  reports context-window usage from its wire-protocol status updates, and
  Claude reports the current model and context-window usage from assistant
  usage records.
- The AI Conversation usage bar now shows a worktree chip for the Session's
  current operating worktree (resolved from Claude event directories, Codex
  exec workdirs, and Kimi shell paths, falling back to the launch directory).
  Clicking the chip mounts the worktree in Source Control and focuses the
  view; deleted worktrees degrade to a struck-through label.

### Changed

- The focused window's workspace card and the focused session row now pick
  up a subtle accent veil with a solid Current pill, so the active context
  reads at a glance; attention state still wins with a red veil.
- The Comments and Agents usage-bar pills now stay visible at zero count, so
  the quick entries into the side panel are always available.
- Clicking an already-focused Active Session now opens its AI Conversation at
  the latest input instead of expanding an inline outline; the inline
  conversation outline rail was removed in favor of the richer outline built
  into the AI Conversation viewer.
- The AI Conversation side panel now starts closed, and the former Outline and
  Comments header buttons were merged into a single Sidebar toggle that reopens
  the panel on the last active tab.

### Fixed

- The AI Conversation Latest button now stays available whenever the
  conversation has inputs, re-locating the latest input even when it is
  already selected instead of being disabled.

## [1.0.1] - 2026-07-31

### Added

- Added an AI Skills workspace with global and project stores, folder
  organization, scoped per-agent switches, migration, diagnostics, and a
  configurable global store location.
- Added a rich AI Conversation review workflow with Mermaid rendering,
  persistent multi-comment batches, bulk actions, a resizable review panel,
  current-session input navigation, and Active Session following.
- Added model, context-window usage, and rate-limit telemetry to AI
  Conversation.
- Added pinning and stable ordering for other open workspace cards.

### Changed

- Kept AI Conversation reading position stable across live refreshes and large
  Mermaid diagrams, while preserving focus, expanded content, and comment
  drafts.
- Improved provider discovery, session branding, tmux bootstrap diagnostics,
  and bounded startup recovery across local and nested-container environments.

### Fixed

- Prevented AI Conversation loading starvation, repeated scroll jumps, hidden
  Mermaid labels, obscured new-comment editors, and stale-session content after
  switching Active Sessions.
- Serialized Skills store mutations and hardened folder-name rendering,
  filesystem containment, stale-lock recovery, and project-scope inheritance.

## [1.0.0] - 2026-07-26

### Added

- Established the Agent Pivot identity and original Pure Axis icon system.
- Added a cross-workspace command center for Codex, Claude, and Kimi sessions.
- Added active-session monitoring, user-input conversation outlines, and
  in-editor conversation navigation.
- Added project, prompt, todo, and workspace switching workflows.

### Changed

- Reset the unpublished extension identity, commands, settings, state, managed
  runtime names, and companion bridge for the first Agent Pivot release.

---

Pre-release development history (internal identities that were never
published to the Marketplace) is archived in
[docs/development-history.md](https://github.com/hzcheng/agent-pivot/blob/main/docs/development-history.md).
