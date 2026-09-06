# Save Current Project PRD

> Status: proposal for review
>
> Date: 2026-09-06

## Summary

Agent Pivot will make **Save Current Project** the only way to create a
Project. A Project represents a workspace that the user has already opened
successfully in VS Code; Agent Pivot records its verified location and runtime
context rather than asking the user to pre-register a path.

Machines remain independently creatable because they are reusable, synchronized
remote connection records. A Machine is not, however, a prerequisite the user
must discover before saving a remote Project. When Save Current Project detects
an unregistered remote Machine, it offers a reviewed, explicit operation to add
the Machine and save the Project together.

This replaces the separate `New Project`, `Add Project`, folder/file/manual
path, and standalone SSH-target creation routes. It preserves opening,
editing, removing, searching, tagging, and favoriting Projects that have
already been saved.

## Problem

The current experience has two competing creation models:

1. A legacy generic Project flow allows the user to enter a folder, workspace
   file, manual path, or SSH target before opening it.
2. The Managed Remote flow requires the user to first create a Machine, then
   add a Project beneath a selected Machine and Environment.

Separately, Save Current Project can capture an already-open workspace, but
only saves a remote workspace when it already belongs to a Managed Machine.
An otherwise valid remote workspace fails with an instruction to create a
Machine elsewhere.

These routes make users choose an internal data model before completing their
real task. They can also register paths that have not been successfully opened
or create remote Project records through a second authority.

## Goals

- Make the verified, currently open VS Code workspace the source of truth for
  Project creation.
- Give all local, SSH, and Dev Container workspaces one understandable save
  journey.
- Make a missing remote Machine recoverable in context without silently adding
  a host or connection record.
- Keep Managed Machines useful as a synchronized directory of remote
  connection targets, including Machines that have no saved Projects.
- Ensure each remote Project has exactly one managed catalog authority.

## Non-goals

- Changing VS Code's native folder, workspace, recent-workspace, or remote
  connection flows.
- Storing passwords, private-key paths, passphrases, certificates, or tokens.
- Supporting arbitrary remote Projects that cannot be identified from the
  currently open workspace.
- Moving an existing Project between Machines or Environments. Saving the same
  code in a different location creates a separate Project.
- Migrating or repairing obsolete remote Project settings.

## Product principles

1. **Open first, save second.** A saved Project must originate from a workspace
   the user has actually opened in VS Code.
2. **One project authority per location.** Local Projects are client-local;
   managed remote Projects belong exclusively to the synchronized managed
   catalog.
3. **Machine setup is explicit, not a trap.** A missing Machine can be created
   from the Save flow, but only after the user reviews the non-secret endpoint
   and confirms it.
4. **The product adapts to context.** The same save action classifies the
   current workspace rather than asking users to choose an implementation
   branch upfront.
5. **Project creation never guesses a path.** The recorded path is obtained
   from VS Code's active workspace and, for remote windows, its validated
   remote identity.

## Information architecture

The Projects view has two creation actions:

| Action | Purpose | Availability |
| --- | --- | --- |
| `Save Current Project` | Save the workspace in the active VS Code window. | Primary action; disabled with explanatory text if no workspace is open. |
| `Add Machine…` | Add a reusable managed SSH Machine without creating a Project. | Secondary action in the Projects toolbar and empty state. |

`New Project`, `Add Project`, and `Add Project…` are removed from the toolbar,
empty state, Machine menus, command palette, and context menus. A Machine menu
continues to provide actions that operate on that Machine: Open, Edit, Open SSH
Terminal, Copy SSH Command, and Remove.

The project hierarchy remains:

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

`This Computer`, local WSL, and local Dev Container are display groupings; they
are not persisted Managed Machines and users never create them.

## Primary user journeys

### Save a local Project

1. The user opens a folder or workspace in VS Code.
2. The user chooses `Save Current Project` from the Projects view, an open
   window card, its context menu, or the command palette.
3. Agent Pivot derives the current workspace path and identifies it as local,
   local WSL, or local Dev Container.
4. Agent Pivot asks only for Project metadata that cannot be derived (initially
   name; optional description, tags, color, and favorite state may follow the
   existing metadata interaction).
5. The Project is saved in client-local storage and appears under its local
   grouping.

### Save a Project on an existing Managed Machine

1. The user opens a remote workspace through the exact managed SSH identity,
   or opens a Dev Container whose host Machine is managed.
2. The user chooses `Save Current Project`.
3. Agent Pivot resolves the current Machine and Environment from the workspace
   identity and records the Project in the managed catalog.
4. For a new Dev Container Environment, Agent Pivot creates the validated
   environment and the Project in one catalog mutation.

No Machine selection or path-entry screen is shown: both are already known from
the open workspace.

### Save a Project on a new remote Machine

1. The user opens a remote SSH workspace not yet represented in the managed
   catalog.
2. The user chooses `Save Current Project`.
3. Agent Pivot identifies a stable, non-secret SSH endpoint and current remote
   project path.
4. It presents a review step:

   ```text
   Save remote project

   This Machine is not yet in Agent Pivot.
   Machine name       [suggested name]
   Host               [detected host]
   User               [detected user]
   Port               [detected port]
   Project path       [detected path]

   [Cancel]  [Add Machine and Save Project]
   ```

5. On confirmation, Agent Pivot atomically creates `Machine → Host
   Environment → Project` in the managed catalog.
6. On cancellation, validation failure, or a failed mutation, it writes
   nothing.

If Agent Pivot cannot resolve a stable endpoint, the review explains which
connection detail is missing and lets the user supply it. It must not silently
create a Machine from an ambiguous or hand-written alias.

### Add a Machine before it has Projects

1. The user chooses `Add Machine…`.
2. The user enters and reviews a unique display name, host, user, and port.
3. Agent Pivot creates the Machine and its fixed Host Environment.
4. The Machine appears in the directory with no Projects.

The user can open it, navigate to a project in VS Code, and later use Save
Current Project. Adding a Machine does not show an `Add Project` follow-up
form.

## Interaction requirements

- Every former save affordance routes to the same Save Current Project
  application flow: toolbar action, current-window card action, context-menu
  action, and `Agent Pivot: Save Project` command.
- If there is no open workspace, the command and visible actions provide the
  same explanation: “Open a folder or workspace, then save it to Agent Pivot.”
- Saving an already-recorded Project never creates another Project or Machine;
  it identifies the existing Project and tells the user it is already saved.
- The confirmation for a new Machine clearly states that its endpoint is
  synchronized across the user's machines and that credentials are not saved.
- Machine creation must validate a unique name, host, user, and port before it
  writes. Project names and paths follow the existing catalog validation rules.
- The resulting Project is shown in the Projects tree, dashboard search, and
  saved-state detection immediately after a successful mutation.
- Keyboard, pointer, command-palette, and accessible-name behavior must be
  equivalent for all save affordances.

## Functional requirements

### Classification and routing

The shared Save Current Project service must classify the active workspace in
this order:

1. A local folder/workspace, local WSL workspace, or local Dev Container:
   write a local Project.
2. A remote workspace that exactly matches a managed Host or Environment:
   write a managed Project under that existing Environment.
3. A Dev Container with a resolvable managed host but no recorded Environment:
   create the Environment and Project under the existing Machine.
4. A remote SSH workspace with a resolvable but unregistered endpoint: request
   confirmation, then create Machine, Host Environment, and Project atomically.
5. A remote workspace whose identity or endpoint cannot be resolved: show a
   recoverable explanation and collect only the missing endpoint fields; do not
   create a project-only remote record.

### Data ownership

| Workspace type | Project authority | Machine behavior |
| --- | --- | --- |
| Local filesystem | client-local Project store | No managed Machine. |
| Local WSL | client-local Project store | No managed Machine. |
| Local Dev Container | client-local Project store | No managed Machine. |
| Managed SSH Host | managed remote catalog | Reuse exact Machine and Host Environment. |
| Managed Dev Container | managed remote catalog | Reuse Machine; create/reuse validated Environment. |
| Unregistered SSH Host | managed remote catalog after confirmation | Atomically create Machine, Host Environment, and Project. |

### Removal of obsolete creation paths

- Remove the generic Project type picker and its folder, file/workspace,
  manual-path, SSH-target, and save-current options.
- Remove Machine-level `Add Project…` and any managed operation that begins
  from a manually supplied Project path.
- Remove public legacy commands, webview messages, and empty-state controls
  that create a Project without an active workspace.
- Preserve editing, deletion, ordering where applicable, favorites, tags, and
  navigation for existing Projects.

## Error and recovery behavior

| Situation | Required behavior |
| --- | --- |
| No workspace is open | Do not open a creation form; explain that a folder or workspace must be opened first. |
| Current workspace is already saved | Do not mutate; identify the saved Project and offer to reveal it. |
| Remote URI cannot be resolved | Explain that the workspace must have a resolvable remote identity; offer the necessary endpoint fields only when safe. |
| Endpoint matches multiple Machines | Do not choose arbitrarily; show the conflicting Machines and require explicit resolution. |
| Machine/project mutation conflicts | Keep the current workspace open, refresh the catalog, and ask the user to retry; never create a partial hierarchy. |
| User cancels metadata or machine confirmation | Make no persistent change. |

## Success measures

- At least 95% of new Projects are created through Save Current Project without
  a manual path-entry form.
- No remote Project can be created outside the managed catalog.
- A user with an already-open but unregistered SSH workspace can finish saving
  it, including Machine setup, in one uninterrupted flow.
- The number of visible project-creation entry points is one; Machine creation
  remains the sole independent setup entry point.
- Duplicate Project and duplicate Machine creation failures do not increase
  after rollout.

## Acceptance criteria

- [ ] The Projects toolbar and empty state expose `Save Current Project` as the
  only Project-creation action, with `Add Machine…` as a separate secondary
  action.
- [ ] Every existing save affordance and the command-palette command invoke one
  shared save flow.
- [ ] No UI, command, or protocol lets users create a Project from a manually
  entered path or an arbitrary SSH target.
- [ ] A local workspace saves without creating a Managed Machine.
- [ ] A workspace on an existing Managed Machine saves beneath its resolved
  Environment without prompting for Machine selection.
- [ ] An unregistered but resolvable remote SSH workspace offers a reviewable
  `Add Machine and Save Project` action and writes the full hierarchy
  atomically only after confirmation.
- [ ] An ambiguous or unresolvable remote workspace never creates a Machine or
  Project silently.
- [ ] A new Dev Container Environment can be saved under an existing Managed
  Machine without a separate Add Project form.
- [ ] A saved Project is immediately reflected in the tree, search, and
  current-window saved state.
- [ ] Existing saved Projects remain openable, editable, removable, searchable,
  and accessible.

## Open decisions

1. Should the first save prompt only for a Project name, or should description,
   tags, color, and favorite state be collected in the same modal step?
2. When a remote SSH endpoint is resolvable but has no suitable display name,
   should the suggested Machine name be `user@host`, `host`, or a user-provided
   required value?
3. When the current project path is already stored under a different Machine,
   should the UI reveal the existing Project only, or allow an explicit
   “Save as a separate location” confirmation?
4. What migration message, if any, should users see for existing legacy local
   projects created through manual path entry? Remote legacy entries remain
   outside the managed authority and should not be rendered or migrated.
