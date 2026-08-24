# Change Log

All notable changes to the "Agent Pivot" extension will be documented in this file. It follows the [Keep a Changelog](http://keepachangelog.com/) recommendations.

## [Unreleased]

### Fixed

- Keep AI Conversation, session dots, status-bar attention, and Next Attention
  navigation on one mutually-exclusive running/attention lifecycle view across
  windows. The companion UI bridge is now 1.0.3; update it and reload every
  participating VS Code window to activate the v5 open-workspace protocol.

## [1.1.3] - 2026-08-24

### Added

- Add `Next Active Chat in This Window` and `Next Attention Chat in This Window`
  commands for cycling only the current window's running and attention chats.

### Changed

- Order the AI Conversation bottom Session status badges as Attention, Running,
  and Idle.

## [1.1.2] - 2026-08-23

### Added

- Worktree group Sessions gain a Changes view in the AI Conversation
  sidebar: a per-repository two-row header with ‹ › cycling between member
  worktrees, the branch name with its tracking state (ahead/behind against
  the upstream, or an explicit "No tracking branch"), a task-result summary
  with a one-click Review multi-diff (untracked files included), collapsible
  Source-Control-style change groups with a complete keyboard tree, and a
  focusable tooltip overlay for every truncated label. New installations get
  a one-time 320px panel width recommendation.
- The Changes view carries a Files | Commits sub-tab. Commits lists the
  history since the task started with frozen-head pagination, per-commit
  tracking badges, inline file expansion with +/- counts, per-commit Review
  and file diff actions, a baseline boundary row, and an optional full
  branch history continuation. Refresh, Source Control, and a single
  collapse/expand toggle live in one shared action row across both tabs.

### Changed

- The OPEN tab now keeps a fixed WINDOWS switcher above the current window's
  sessions. CHATS shows active sessions (Tree or List view), while ALL keeps
  the complete session history and its management tools. Existing Worktree
  view users land in CHATS Tree view; a one-time in-product mapping explains
  the change.
- Removed the global TODO Dashboard tab, its search results, and its
  synchronized data setting. Existing TODO data is left untouched in VS Code
  storage/settings but is no longer read or displayed.
- The AI Conversation bottom corner rails now switch between open WINDOWS
  instead of adjacent Sessions: Previous/Next Window walk one shared,
  identity-sorted ring of every open window — each window anchors on its own
  identity, so the cycle continues naturally as focus moves. With no other
  window open the rails explain themselves instead of switching. The
  Previous/Next Active Session commands remain available in the Command
  Palette, and per-state Session cycling lives on the status dots.
- The AI Conversation status indicators moved from the header into the bottom
  session-navigation row — alongside Previous/Next Active Session — and are
  now clickable badges that count this window's Sessions by lifecycle —
  running (green), needing attention (red), and idle (gray) — with the count
  inside the badge instead of the previous local/global pair. Clicking a
  badge cycles to the next Session of that kind in the current window,
  focusing its terminal and conversation; a badge dims and disables while its
  count is zero, running and attention badges keep their reduced-motion-aware
  pulse while non-zero, and every badge explains itself in a tooltip.

## [1.1.1] - 2026-08-13

### Added

- AI SESSIONS now has a keyboard-accessible split create button: one click
  starts a new Session without opening any picker, using the provider last
  started in that workspace and the default Codex profile when applicable.
  The adjacent menu can quickly choose Codex, Claude, or Kimi, or open the
  full customized creation flow; its caption always shows what the next
  one-click launch will use.
- Codex configuration profiles are now first-class Session options. Creation
  discovers profile overlays, remembers the chosen profile with the Session,
  resumes with the same configuration, marks missing profiles, and shows the
  profile on Session rows. Older Codex CLIs keep the existing profile-free
  flow and receive a one-time upgrade hint.
- New `Agent Pivot: Seek to Latest Conversation Interaction` command exposes
  the AI Conversation viewer's Latest action to the Command Palette and
  custom keybindings.
- The AI Conversation header carries a pair of global Session status dots
  between the title and the navigation buttons: a green dot pulses while AI
  Sessions are running in any open window and a red dot pulses while
  Sessions need attention, both counted across every window through the
  open-workspaces aggregate and the attention bridge. Each dot dims when its
  count is zero, explains itself in a tooltip, and honors reduced motion.

### Changed

- Large Codex conversations now open behind an outline-complete summary
  window and load older content on demand. Subsequent refreshes validate and
  incrementally update bounded caches, cutting cold starts and switch-back
  waits without loading the entire conversation into the Webview at once.
- Switching back to a recently viewed conversation restores its retained
  frame, reading position, and expanded work entries when the content is
  unchanged. While a different Session is loading, the previous conversation
  remains visible in a dimmed busy state instead of appearing frozen.
- Clicking the active Outline, Comments, or Subagents telemetry pill now
  closes the AI Conversation sidebar; clicking a different pill switches tabs
  while keeping the sidebar open, and the pressed state is exposed to
  assistive technology.
- On the OPEN tab, expanding the CURRENT WINDOW card now fits the card to
  its window region (half the pane by default, or the dragged separator
  share): the visible AI session panel fills the remaining card height and
  the session list becomes the only inner scroll surface, instead of the
  list being capped at a fixed row count. While the card is expanded, the
  separator's minimum size rises so the AI session controls and at least one
  session row always stay reachable.
- The OPEN tab splits CURRENT WINDOW and OPEN WINDOWS into two independent
  regions that scroll on their own below their pinned headers, with a
  separator between them that resizes the CURRENT WINDOW share by mouse drag
  or arrow keys (the share persists across reloads); each region keeps its
  scroll position when open windows refresh.
- The AI tab's SKILLS subtab is reworked into a quiet list surface: Global
  and Project sections sit in independently scrolling panes with a draggable
  (and keyboard-accessible) separator whose share persists across reloads;
  skill rows show actions only on hover/focus; folder headers pin while
  their lists scroll; and scope headers render as full-width section bars so
  pane boundaries read at a glance.
- Skills panel folder trees compact single-child chains into one row (like
  `google/skills/skills`) and keep deeply nested empty folders out of view,
  so vendored skill repositories no longer flood the panel with structural
  noise; skills bundled inside another skill's directory (sub-skills) are
  now discovered as well.

### Deprecated

- `agentPivot.maxVisibleAiSessions` no longer has any effect: the expanded
  CURRENT WINDOW card fits its window region on the OPEN tab, and project
  cards elsewhere keep the default three-row session list height.

### Fixed

- Oversized conversation turns with hundreds of tool events are now reduced
  deterministically while preserving the user request, latest answer, key
  identifiers, and an explicit omission notice, so one very large turn no
  longer prevents the entire conversation from opening.
- Rapid Session switches no longer leave Kimi or Claude conversations showing
  stale content, and failed frame restores now request a fresh document only
  for the Session generation that still owns the viewer.
- Codex telemetry now honors a selected profile's declared context window,
  including Sessions started outside Agent Pivot when their rollout model
  matches one unambiguous profile.
- Cross-window running/attention rotation, focus handoff, and acknowledgement
  recovery are more reliable under concurrent refreshes; background worker
  completion no longer leaves the Extension Host waiting indefinitely.
- SKILL.md frontmatter parsing understands YAML block scalars
  (`description: >-` folded and `|` literal) and a UTF-8 BOM, so vendored
  skills with multi-line descriptions show their real summary instead of
  the raw `>-` indicator.

## [1.1.0] - 2026-08-09

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
