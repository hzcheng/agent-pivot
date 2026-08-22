# OPEN tab migration guide

The OPEN tab now uses one fixed window switcher followed by the current
window's session surface. There is no setting to restore the previous layout.

| Previous control | New location |
| --- | --- |
| `CURRENT WINDOW` card | The current row in `WINDOWS`; its cyan indicator marks this window. |
| `OPEN WINDOWS` cards | The remaining `WINDOWS` rows. Select a row to focus that VS Code window. |
| `WORKTREE` surface | `CHATS` in **Tree** view. It still shows every ready worktree, including empty ones, and retains worktree management. |
| `CHATS` → `ACTIVE` | `CHATS`. This is the active-session set. |
| `CHATS` → `ALL` | `ALL`. It includes active, stopped, and historical sessions. |

## What is preserved

- Existing stored `surface: 'worktree'` and active-session selections open as
  `CHATS` in Tree view.
- Stored all-session selections open as `ALL`.
- The selected `CHATS`/`ALL` tab, Tree/List choice, and collapsed worktree
  groups remain scoped to each VS Code window.
- List view and Tree view represent the same active-session set. List view
  orders rows by recent activity and shows a branch chip.

## Release verification record

This checklist is deliberately unfilled: it is the remaining release gate,
not evidence that testing has already happened. Copy it for each candidate,
record redacted evidence, and replace every `NOT RUN` result.

### OPEN-TAB-USABILITY-001 — five-user multi-window walkthrough

- Prerequisites: five real users who regularly use multiple VS Code windows;
  candidate main and UI Bridge VSIX files installed locally.
- Tasks: find a named window; find the most recently active session; manage an
  empty worktree from CHATS Tree view.
- Naming check: ask each participant what `CHATS` contains before explaining
  it. If a majority interpret it as every session rather than active sessions,
  change the release wording to `ACTIVE / ALL` before publishing.
- Result: `NOT RUN`.
- Evidence: `UNRECORDED` (redacted task timings, task outcomes, and naming
  responses; do not retain window names, paths, or session IDs).

### OPEN-TAB-ACCESSIBILITY-001 — visual and keyboard matrix

- Environments: light, dark, High Contrast, and forced-colors themes; 200%
  zoom; panel widths at least 360px, 280–359px, and below 280px.
- Verify: no clipped essential labels; visible keyboard focus; CHATS/ALL tabs,
  CHATS menu arrows and Escape, worktree tree arrows, and WINDOWS row controls
  remain keyboard-operable; reduced-motion behavior is static.
- Result: `NOT RUN`.
- Evidence: `UNRECORDED` (redacted screenshots or recording).

### OPEN-TAB-TELEMETRY-001 — privacy and aggregate observations

- Verify local diagnostics include only the navigation outcome/duration and
  CHATS menu-open event; they must not contain a window name, path, card ID,
  or session ID.
- Before claiming success metrics, define how task start/completion and a
  suspected wrong selection are collected. The current implementation does
  not infer those outcomes from private identifiers.
- Result: `NOT RUN`.
- Evidence: `UNRECORDED`.
