# Agent Pivot First-Paint Performance Design

## Problem

Agent Pivot currently waits for visible-view preparation before assigning the
Webview HTML. Visible-view preparation includes runtime and tmux discovery that
can cross extension-host boundaries and take several seconds.

The July 27, 2026 remote Extension Host evidence shows:

- Agent Pivot's initial workspace/session model was built in about 125 ms.
- The first `open-workspaces-rendered` acknowledgement arrived about eight
  seconds after extension activation.
- The provider calls `onVisibleChanged(true)` and awaits runtime refresh before
  calling `refresh()`, so a slow enrichment operation blocks the entire first
  paint.

Remote Extension Host disconnects and out-of-memory restarts were also observed.
Those host-wide failures are not owned by this change, but Agent Pivot must
remain responsive when host services are merely slow.

## User-visible behavior

When the Agent Pivot view becomes visible, it must immediately render the best
locally available snapshot. Project cards, cached AI sessions, and controls must
be usable without waiting for runtime discovery or the UI Bridge.

Runtime, tmux, attention, and cross-window state refresh in the background. When
new state is available, the extension sends the existing incremental update
messages. It does not replace the entire Webview document, so scroll position,
expanded cards, focus, and interaction state remain stable.

A background refresh failure must not replace an already rendered dashboard
with the fatal view error page. The extension records the failure through the
existing diagnostics and leaves the cached view usable.

## Component behavior

### View provider

On a visible view generation, the provider:

1. installs Webview options and listeners;
2. assigns the initial HTML synchronously from the cached model;
3. starts visible-view preparation asynchronously;
4. ignores completion belonging to a disposed or superseded view generation.

Hidden-view preparation continues to deactivate watchers and other visibility
scoped work, but does not render.

### Dashboard visibility preparation

The dashboard keeps the current visibility setup: session watchers, active
terminal highlighting, conversation visibility, and runtime refresh.

After a visible runtime refresh settles, it requests an AI-session incremental
update. Existing visibility guards prevent delivery to a hidden or disposed
view.

### Error handling

Initial HTML generation remains a fatal render boundary: if it throws, the
provider displays the sanitized error page.

Background preparation is an enrichment boundary. If it fails after the first
paint, the provider logs the sanitized failure but preserves the existing
dashboard. Runtime-specific failures continue through the existing runtime
diagnostics.

## Testing

Add an automated P0 Webview behavior contract proving that a visible view
receives HTML before an unresolved visibility-preparation promise settles.
The focused provider test must also prove that background completion does not
belong to a superseded view.

Add or extend a focused dashboard visibility test proving that successful
background runtime refresh schedules an incremental AI-session update.

The implementation must pass:

- the focused view-provider and dashboard visibility tests;
- `npm run test:behavior-contracts`;
- the affected integration suite;
- `npm run test:ci:linux`.

## Non-goals

- Diagnosing or fixing host-wide Extension Host out-of-memory failures.
- Changing tmux discovery semantics or timeouts.
- Adding a skeleton screen or a hard startup timeout.
- Replacing the existing incremental Webview protocols.
