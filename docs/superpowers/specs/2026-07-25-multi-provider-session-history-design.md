# Multi-Provider Session History Design

## Goal

Allow the Sessions tab to select more than one AI provider and show the
selected providers' session histories at the same time.

The result must preserve the compact sidebar presentation:

- pinned sessions appear together before every unpinned session;
- pinned and unpinned partitions both keep sessions from the same provider
  adjacent;
- provider adjacency is expressed by ordering, not by separate provider panels
  or provider section headings; and
- the current provider remains the primary provider and sorts first.

The Active tab, running-icon animation, card animation, launch behavior, and
provider session readers remain unchanged.

## Current behavior

Each workspace persists one `activeProvider`. The Sessions tab renders only
that provider's history, using a native single-selection `<select>`. The same
provider also scopes batch-management selection and archive requests.

This design retains the existing provider as the primary provider while adding
an ordered, validated selection of visible providers.

## State model and migration

Each workspace has:

- a primary provider, represented by the existing `activeProvider` state for
  compatibility; and
- `selectedProviders`, an ordered, duplicate-free array of registered provider
  IDs with at least one entry.

Persist selected providers in a new workspace-state record keyed by workspace
scope identity. Do not destructively rewrite the existing
`workspaceActiveAiSessionProvider.v2` record.

When no valid multi-provider record exists, normalize the workspace to:

```text
primaryProvider = existing activeProvider
selectedProviders = [primaryProvider]
```

This preserves the exact provider visible before upgrade. If the existing
primary provider is invalid or absent, choose the first provider with history;
if none has history, choose the first registered provider.

Normalization:

1. discard unknown and duplicate provider IDs;
2. retain only registered providers;
3. if the result is empty, insert the normalized primary provider;
4. keep the primary provider first;
5. append other selected providers in registry order; and
6. if the primary provider is deselected, promote the first remaining provider
   to primary.

The host owns this state. The Webview renders and submits it but does not keep a
second persistent source of truth.

## Multi-select control

Replace the native provider `<select>` with a compact menu button and a
checkbox-style popup.

The closed button shows:

- the provider names when one or two providers are selected, for example
  `Codex + Claude`; or
- `<n> providers` when three or more providers are selected.

Each menu item shows its checked state, provider label, session count, and
`Unavailable` when the provider cannot supply history in the current
environment.

Interaction requirements:

- selecting or deselecting an item submits the complete intended provider set
  atomically;
- the last selected provider cannot be deselected;
- state is disabled while a selection update or batch archive is pending;
- clicking outside and pressing Escape close the popup;
- focus returns to the trigger after Escape;
- Arrow Up and Arrow Down move between items;
- Space and Enter toggle the focused item; and
- the trigger and items expose appropriate expanded, checked, disabled, and
  descriptive accessibility state.

The host validates every submitted provider ID, normalizes the set, persists
the primary and selected providers, and refreshes the workspace card. Full and
incremental rendering read the same normalized model.

## Session list projection

Build one history projection from every selected provider. Do not render one
panel per provider and do not move provider-specific DOM after rendering.

Split selected history into two partitions:

1. pinned; and
2. unpinned.

Within both partitions, order provider runs as follows:

1. the primary provider;
2. other selected providers in registry order.

Within each provider run, preserve the existing prepared session order. This
keeps the current recency and deterministic tie-breaking behavior.

Render one subtle `PINNED` heading for the pinned partition when it is nonempty.
The unpinned partition is a continuous list and does not render provider
headings or provider containers. A light divider may separate pinned and
unpinned content, but provider transitions do not receive structural
separators.

Each row retains the circular terminal icon, existing metadata, attention,
active state, pin state, and actions. Provider identity is communicated only
through the existing provider accent color and a lightweight inline provider
label.

Providers with zero sessions contribute no empty block. If all selected
providers have no sessions, render one unified empty state. If one or more
selected providers are unavailable, show one compact availability summary
without creating provider sections.

## Cross-provider batch management

Batch management becomes workspace-scoped instead of provider-scoped.

Represent selected rows with a composite identity:

```text
{ provider, sessionId }
```

Never use `sessionId` alone across providers.

The `All` action selects every visible session that is:

- unpinned;
- inactive; and
- owned by a currently selected provider.

Pinned sessions are not selected by `All`, but remain manually selectable.
Active sessions are always disabled and cannot be archived.

Submit one aggregate archive request containing the project ID and composite
items. The host:

1. resolves the authoritative workspace target;
2. validates that every provider is registered and currently selected;
3. bounds and deduplicates composite items;
4. resolves each item against that provider's authoritative history;
5. asks for one aggregate confirmation;
6. groups valid items by provider;
7. reuses the existing provider archive primitive for each group; and
8. refreshes the Dashboard once after all groups settle.

The aggregate completion result reports archived, running, missing, rejected,
and failed items with composite identity. Partial success is explicit:
successful items disappear after refresh, while failures are summarized to the
user and logged without exposing full session identifiers.

While an aggregate archive is pending, provider selection, row selection, and
batch-management controls are locked so the visible scope cannot change.

## Rendering and message boundaries

Extend the workspace AI-session view model with normalized
`selectedProviders`. Keep the existing primary-provider field during the
migration to avoid changing unrelated creation, resume, and hydration flows.

Add one validated provider-selection message carrying:

```text
projectId
selectedProviders
```

The host derives primary-provider promotion from the submitted set and the
current normalized state.

Replace the provider-scoped batch archive request with an aggregate request
whose items carry both provider and session ID. Keep the completion message
bounded and versioned so stale or malformed Webview input fails closed.

Incremental AI-session refreshes continue to replace the authoritative current
workspace card HTML. The Webview restores transient focus and popup state only
when the refreshed control still exists and its pending operation permits it.

## Error and empty behavior

- Unknown, duplicate, malformed, or out-of-scope providers are rejected or
  normalized before persistence.
- A submitted empty provider set is rejected and leaves the prior state
  unchanged.
- A selected unavailable provider remains selected and is marked unavailable.
- A provider with no sessions adds no empty subgroup.
- If every selected provider has no history, render one unified empty state.
- Malformed composite batch items are rejected without affecting valid items.
- Provider-specific archive failures do not prevent other valid provider groups
  from settling.
- Refresh or delivery failure clears pending UI state through the existing
  authoritative refresh fallback rather than leaving controls locked.

## Accessibility

- The multi-select trigger exposes its popup relationship and expanded state.
- Each provider option exposes checked and disabled state.
- Keyboard navigation never requires pointer input.
- Provider identity is not communicated by color alone; every session row keeps
  a textual provider label.
- Focus-visible styling uses VS Code theme colors.
- Reduced-motion behavior is unchanged because this feature adds no motion.
- Forced-colors mode retains visible popup, row, focus, and selection
  boundaries.
- Status and partial-failure summaries use the existing polite live region.

## Verification

Add mutation-sensitive automated coverage for:

- legacy single-provider migration;
- selected-provider normalization, primary promotion, and persistence;
- full and incremental view-model propagation;
- closed-control summaries and menu counts;
- at-least-one-provider enforcement;
- mouse, keyboard, focus, and outside-click interaction;
- unavailable and empty states;
- pinned-first projection;
- provider adjacency in both pinned and unpinned partitions;
- primary-provider-first and registry-order behavior;
- absence of provider section panels and headings;
- provider text labels in every row;
- composite batch identities and cross-provider ID collisions;
- `All` excluding pinned and active sessions;
- aggregate validation, confirmation, per-provider execution, partial failure,
  bounded logging, and one final refresh;
- stale and malformed Webview messages;
- narrow-sidebar and forced-colors presentation;
- SCSS-to-generated-CSS parity;
- complete Linux CI; and
- release packaging and local VSIX installation.

## Out of scope

- Changing the Active tab.
- Changing AI-session creation or resume provider selection.
- Changing running icon or card animations.
- Adding provider-specific columns, accordion panels, or visible section
  headers.
- Persisting custom provider order beyond primary-provider priority.
- Adding a select-all-providers shortcut.
