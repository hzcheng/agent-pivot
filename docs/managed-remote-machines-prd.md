# Managed Remote Machines PRD

> Status: active design
>
> Date: 2026-09-04

## Summary

Agent Pivot owns a synchronized directory of remote development Machines and
Projects. A Machine stores a display name and a non-secret SSH endpoint
(`host`, `user`, and `port`). Projects and Dev Container environments reference
the Machine by stable ID instead of inferring identity from a saved URI.

The catalog is the only authority for managed remote Projects. Agent Pivot does
not migrate, merge, render, open, or restore legacy remote Project settings.
A clean installation starts with an empty catalog; the first successful Machine
creation activates it immediately.

## Product principles

1. **One remote authority.** Managed Machines, Environments, Projects, layout,
   tags, colors, and Favorites live in the managed catalog.
2. **Automatic local projection.** Every client materializes the current catalog
   into an Agent Pivot-owned SSH fragment and maintains one exact marked
   `Include` in the config used by Remote - SSH.
3. **No setup or migration flow.** There is no Enable, Disable, Setup, Assign,
   migration, cleanup, rollback, or legacy fallback action.
4. **Authentication stays with SSH.** Passwords, private keys, passphrases,
   certificates, and tokens are never stored or synchronized by Agent Pivot.
5. **Stable identity.** Renaming a Machine or editing its endpoint preserves its
   ID and all Environment/Project relationships.
6. **Local stays local.** Local filesystem Projects, WSL reached through this
   computer, and local Dev Containers stay in client-local extension state.

## Data ownership

| Concept | Authority | Synced |
| --- | --- | --- |
| Managed Machine and SSH endpoint | managed remote catalog | Yes |
| Host or Dev Container Environment | managed remote catalog | Yes |
| Managed remote Project | managed remote catalog | Yes |
| Local, local WSL, or local-container Project | client extension state | No |
| Generated SSH fragment and marked Include | local filesystem cache | No |
| Authentication material | SSH / Remote - SSH | No |
| Legacy remote Project settings | none; ignored | No |

## Primary journeys

### Add or edit a Machine

`Add Machine` collects a required unique name, host, user, and port. Port defaults
to 22 and must be between 1 and 65535. Review states that endpoint changes affect
the next connection on every synced computer and that credentials are not saved.

Saving a new Machine creates its fixed Host Environment and activates the catalog
atomically. A Machine remains visible when it has no Projects. Editing preserves
its stable ID. An empty Machine may be removed; a Machine with Projects or Dev
Container Environments must have those children removed first.

### Add, edit, save, and open a Project

A Machine row provides `Add Project`. Placement is selected once and remains
immutable; moving code to another Environment creates a separate Project. A
Project stores name, absolute POSIX path, optional description, tags, color, and
Favorite state.

`Save Project` recognizes a Host window opened through the exact managed alias. In
a Dev Container window it also records the validated launch anchor and creates the
Environment plus Project in one catalog mutation. A container launched through a
hand-written or name-only SSH alias is not adopted. Local windows save only to the
client-local catalog.

Opening a Machine targets its Host Environment. Opening a Project targets its
current Environment and path. Legal path characters such as `#`, `?`, and `%` are
preserved structurally when the VS Code URI is created.

### Use another computer

VS Code Settings Sync delivers the non-secret catalog. The local UI Bridge
automatically reconciles the generated SSH projection. Navigation verifies that
the exact current projection matches the requested revision and endpoint; a stale
alias is never accepted merely because a `Host` line exists.

## Information architecture and interaction

```text
Favorites
Machines
  This Computer
    Project
  WSL on this computer
    Project
  Local Dev Container
    Project
  Managed Machine
    Host
      Project
    Dev Container
      Project
```

The Projects toolbar contains Tags and `Add Machine`. Tags use AND matching.
Machine and Environment rows disclose children with Enter/Space; row actions are
available through buttons and Shift+F10. Disabled rows do not navigate by pointer,
keyboard, or middle-click. Refresh, filtering, edit, and removal restore focus by
stable identity, with `Add Machine` as the final fallback.

Dashboard search indexes both local and managed Projects. Managed results carry
Project identity plus the expected catalog revision and route through the managed
navigation protocol; they never fall back to the legacy selected-project path.

## Conflict and failure behavior

- Different-entity concurrent edits merge; same-entity divergent edits remain
  explicit conflicts.
- A conflicted Machine and its descendants remain visible but cannot open until
  the endpoint conflict is resolved.
- Mutations are revision-bound and serialized across the whole reconcile → stage
  → activate transaction so stale concurrent writes cannot replace newer work.
- SSH projection writes are serialized across VS Code windows. Stale-lock recovery
  rechecks lock identity before removal.
- Missing OpenSSH, unsafe config files, or invalid Remote - SSH settings fail only
  the requested managed operation; they do not prevent the UI Bridge from
  activating unrelated attention and window-navigation features.

## Validation and privacy

- Host and user reject control characters and SSH-config injection.
- Port is an integer from 1 through 65535.
- Project paths are absolute POSIX paths; launch anchors are versioned and bounded.
- Diagnostics do not contain credentials, SSH config contents, or private key
  paths/content.
- Generated files are labeled `DO NOT EDIT` and can be rebuilt from the catalog.

## Acceptance criteria

- [ ] The first Add Machine operation produces an active catalog and a Host
  Environment without any activation or migration step.
- [ ] Managed Machines and remote Projects synchronize; local filesystem, local
  WSL, and local-container Projects do not.
- [ ] No public legacy Add/Edit/Remove/Group command can write a second remote
  Project authority.
- [ ] Dashboard rendering, search, saved-state detection, Favorites, and opening
  use the managed catalog for remote Projects.
- [ ] Host and Dev Container save/open flows use exact managed identity and preserve
  `#`, `?`, and `%` in paths.
- [ ] Projection is automatic, revision-exact, race-safe, and isolated from
  unrelated UI Bridge activation.
- [ ] There is no migration, rollback, Setup, Enable, Disable, Assign, or legacy
  remote fallback UI or protocol operation.
- [ ] Pointer and keyboard behavior remain equivalent, accessible names include
  full identity/reason, and focus remains predictable after updates.
- [ ] The 50-Machine / 500-Project catalog stays within the payload and latency
  budgets enforced by tests.
