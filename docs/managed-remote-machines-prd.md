# Managed Remote Machines PRD

> Status: personal catalog cutover active; migration and rollback are not product flows
>
> Date: 2026-09-04
> Related: [Remote Machines Projects PRD](./remote-machines-projects-prd.md)

## 1. Summary

Agent Pivot will own a synchronized directory of remote development Machines and
Projects. A user adds an SSH Machine once with a display name, host, user, and port.
Projects and Dev Container environments reference the Machine by stable ID rather
than inferring identity from an SSH alias embedded in a URI.

Agent Pivot automatically materializes this catalog into an isolated generated SSH
config and adds one exact managed `Include` to the config used by Remote - SSH. The
generated file is a rebuildable local cache, not a second source of truth.
Passwords, keys, passphrases, and tokens are never stored or synchronized; Remote -
SSH continues to prompt when authentication is needed.

The product has one Agent Pivot connection model. The owner's existing data has
already been converted and the managed catalog is now the only runtime authority.
Legacy values and the frozen conversion snapshot may remain as inert emergency
backup bytes, but startup does not read, clean, verify, restore, or expose them.

## 2. Problem

The current Machine view is a projection of saved Project URIs:

- a Machine cannot exist without a Project;
- an SSH alias is embedded in every Project path;
- an alias that works on computer A may not exist, or may mean something else, on
  computer B;
- a non-default port depends on local SSH config and does not follow the synced
  Project;
- editing a Machine connection is not a first-class operation;
- users maintain Agent Pivot Projects and local SSH config separately.

The synchronized UI therefore looks authoritative while the information required
to connect is local and implicit.

## 3. Product principles

1. **One business authority.** The synchronized catalog owns managed Machine
   identity and endpoint metadata. Generated SSH config is disposable.
2. **No setup flow.** A Machine contains enough non-secret information to connect
   on any computer. Each VS Code installation automatically builds the local
   generated projection when it first receives the catalog.
3. **Authentication stays with SSH.** Agent Pivot never accepts or persists a
   password, private key, passphrase, certificate, or token.
4. **Identity is stable.** Renaming a Machine or changing its endpoint does not
   change its ID or Project membership.
5. **A local-only authority stays local.** Local filesystem Projects, Projects
   addressed through this computer's `wsl+<distro>` authority, and local-container
   Projects stay on the computer where they were saved. A remote WSL distro with
   its own SSH endpoint is instead a Managed Machine and synchronizes normally.
6. **The cutover is final in product behavior.** Startup reads the managed catalog
   directly. There is no migration wizard, upgrade state, cleanup gate, rollback
   action, or legacy remote fallback.

## 4. Goals

- Add, edit, rename, and remove an SSH Machine directly in Agent Pivot.
- Synchronize `name + host + user + port` and Machine/Environment/Project
  relationships across computers.
- Require an explicit remote user and support ports `1` through `65535`, defaulting
  to `22`.
- Show Machines even when they have no Projects.
- Preserve `Machine → Environment → Project`, Favorites, tags, colors, filtering,
  collapse behavior, and row menus.
- Open a Machine in a new Remote - SSH window and a Project at its current path.
- Save a remote WSL distro that exposes SSH as an independent Managed Machine.
- Distinguish the fixed Host environment from every Dev Container environment.
- Treat the already-converted managed catalog as the sole remote Project authority.
- Keep frozen legacy bytes untouched and unreachable from normal product behavior.

## 5. Non-goals

- Managing authentication material or installing keys on a server.
- Replacing Microsoft Remote - SSH or Dev Containers.
- Synchronizing arbitrary OpenSSH behavior such as `ProxyJump`, `ProxyCommand`,
  tunnels, certificates, or per-host identity files.
- Treating a computer-local `wsl+<distro>` authority as portable, or inferring a
  remote WSL connection that has no independently reachable SSH endpoint.
- Synchronizing Local, computer-local WSL, or local-container Projects.
- Providing a general-purpose SSH config editor.
- Removing or rewriting existing user-owned SSH `Host` blocks.
- Manually creating arbitrary Dev Container launch definitions in the first release.

## 6. Data ownership

| Concept | Meaning | Storage | Synced |
| --- | --- | --- | --- |
| Managed Machine | Stable SSH endpoint for a remote computer or independently reachable remote WSL distro | managed remote catalog | Yes |
| Host Environment | Fixed non-container environment of a Managed Machine | managed remote catalog | Yes |
| Dev Container Environment | Distinct container reached through a Managed Machine | managed remote catalog | Yes |
| Remote Project | Metadata, tags, color, remote path, Environment ID | managed remote catalog | Yes |
| Client-local Project | Local, computer-local `wsl+` WSL, or local-container Project | extension local storage | No |
| Client-local Machine | This Computer, a WSL distro reached through this computer's Windows host, or a local container | extension local storage | No |
| Generated SSH config | Stable alias → host/user/port projection | local filesystem | Rebuilt locally |
| Legacy SSH entry | User-owned migration input and rollback material | user's SSH config | Not managed |

For managed records, the catalog is authoritative. Editing the generated file is
unsupported because reconciliation overwrites it. The file is labeled and can be
regenerated. Retained legacy entries are not a live Agent Pivot fallback.

## 7. Primary journeys

### 7.1 Add a Machine

The Projects toolbar has `Add Machine`. A VS Code QuickInput flow collects:

1. **Name** — required, display only, and case-insensitively unique in a resolved
   catalog. Offline duplicate-name creation becomes a rename conflict; until it is
   resolved, both rows expose `user@host:port` as a disambiguator. In normal state,
   the endpoint stays in the Machine tooltip and accessible name instead of taking
   permanent vertical space under the display name.
2. **Host** — required DNS name, IPv4 address, or IPv6 address.
3. **User** — required so every computer uses the same remote account.
4. **Port** — required integer, defaults to `22`.
5. **Review** — endpoint, `Saved to your VS Code User settings`, `Passwords and keys
   are not saved`, and `Save Machine`.

The flow shows `Step x of 5`, Back, and Escape. Escape discards an Add draft; Edit
keeps the previous saved value. Validation stays on the first invalid field and
never commits a partial record.

Saving creates the synchronized Machine and its fixed Host environment immediately.
There is no per-Machine `Setup`, `Assign`, `Rebind`, or Profile state. The Machine
appears even with no Projects.

### 7.2 Automatic local SSH projection

The first time a VS Code installation creates or receives a Managed Machine catalog,
Agent Pivot automatically backs up the active SSH config, inserts its exact owned
Include, generates the Machine aliases, validates their OpenSSH syntax, and activates
the new catalog. There is no Migrate, Setup, Enable, or connection-rehearsal step.

The update uses a no-overwrite exchange: if another editor saves during the
operation, that save wins and Agent Pivot reports the exact config path requiring
attention. Normal use requires no SSH config editing. Later synchronized Machine
changes automatically rebuild the generated file.

There is no normal Disable action in this personal always-on model. If the local
projection is absent, stale, or from an older Agent Pivot format, startup rewrites
the Agent Pivot-owned `current.conf` automatically. Ownership or marker mismatch in
the user-owned active SSH config still fails closed so Agent Pivot never overwrites
unrelated SSH bytes.

### 7.3 Open a Machine

- Machine main-row activation only expands/collapses.
- Its right-side Open starts a new Remote - SSH window for Host.
- Remote - SSH prompts for authentication as normal.
- The row menu contains `Add Project…`, `Edit Machine…`, `Open SSH Terminal…`,
  `Copy SSH Command`, and `Remove Machine…`. Local SSH projection maintenance has
  no product control in this menu.

### 7.4 SSH from the Command Palette

`Agent Pivot: SSH to Machine…` appears in the Command Palette. It shows ready
Managed Machines by name and endpoint, then opens an integrated terminal whose
process runs on the local computer, even when the current VS Code window is SSH,
WSL, or Dev Container. The terminal executes the locally resolved SSH executable
with the stable managed alias as an argument and remains interactive for password
input.

`Agent Pivot: Copy SSH Command…` uses the same picker and copies the equivalent
local command, normally `ssh <readable-machine-name>`. It
contains no password or other credential. Both commands resolve the exact current
catalog revision in the local runtime, repair the generated projection when needed,
and then execute. Catalog conflicts still fail closed.

### 7.5 Add or edit a Project

There is no global `Add Project` toolbar action. A Managed Project is added from a
Machine row's `Add Project…` menu, which fixes the Machine context and defaults to
Host. The Open tab's Save action remains the entry point for the current Local,
computer-local WSL, local-container, or already managed remote workspace. Review
always shows the final hierarchy, and the Save action disappears as soon as the
current workspace matches an existing managed or local Project.

`Edit Project…` changes metadata and the path in the current Environment only. A
Project cannot be moved to another Machine or Environment: that represents a
different checkout/location, so the user adds a separate Project under the target
instead. Row activation opens directly. The row menu exposes Edit, Favorite, and
Remove.

### 7.6 Edit a Machine

The review shows old → new endpoint, affected Project count, and `Changes the next
connection on every synced computer`. Its CTA is `Save Changes to All Computers`.
The Machine ID and relationships remain unchanged.

### 7.7 Dev Container Environment

The first release creates a Dev Container Environment only by migration or `Save
Current Project` when the current container anchor proves one unique Managed Machine
ID. A container opened through a legacy/non-managed alias or an ambiguous logical
Machine cannot be auto-assigned: Save explains `Open this container from a Managed
Machine first` and leaves it unchanged. Local container windows remain client-local.
There is no arbitrary container-definition editor.

- Machine Open always opens Host.
- A Dev Container row has its own Open action; Shift+F10 exposes the same action.
- A Dev Container with Projects cannot be removed; an empty one can.
- An unknown launch-anchor version shows `Needs repair`; Open is disabled and the
  actions are `Repair from Current Window…` or `Remove…`.
- A missing Dev Containers extension shows Install and Retry.

### 7.8 Remote WSL

A WSL distro on another Windows computer is synchronized when it exposes its own
SSH endpoint. The user adds that endpoint's host, required user, and port exactly as
for any other Machine; a non-22 port is supported. It appears as an independent
Machine, for example `Build PC — Ubuntu`, and Projects inside it are ordinary synced
Remote Projects.

The parent Windows host and its WSL distro are separate logical Machines because
they can have different endpoints, ports, users, availability, and filesystem paths.
The first release does not model a portable nested `Remote-SSH → WSL` Environment
and never guesses a WSL endpoint from a Windows Machine. A `wsl+Ubuntu` authority
continues to mean Ubuntu on the current Windows computer and therefore stays local.

During migration, an existing WSL Project offers either `Keep on this computer` or
`Use an SSH-reachable WSL Machine…`. The second path requires explicit host, user,
port, and path information. After activation, converting between a local WSL Project
and a Managed Project creates a separate Project rather than moving it.

### 7.9 Remove a Machine

A Machine with Projects or Dev Container environments cannot be removed. The user
must remove those children first, creating separate Projects elsewhere if needed.
An empty Machine with only its fixed Host can be removed after confirmation. Enabled
computers remove its generated alias on their next reconcile.

### 7.10 Use another computer

Every computer automatically materializes newly synced catalog data. There is no
per-computer or per-Machine setup/disable step.

Managed mode requires `agentPivot.storeProjectsInSettings=true`; Add/Edit and
automatic migration enable it before changing data. User-setting storage makes the catalog
eligible for VS Code Settings Sync. Sign-in, Settings Sync enablement, offline
delivery, and ignored-settings policy remain VS Code responsibilities. Agent Pivot
says `Saved to User settings`, not that another computer received data when that is
not observable.

## 8. Information architecture, status, and accessibility

```text
Favorites
Machines
  This Computer
    Project
  WSL: Ubuntu (this computer)
    Project
  Local Dev Container (this computer)
    Project
  Managed Machine
    Host
      Project
    Dev Container
      Project
```

Machine rows use a computer icon. Project rows retain their color marker. Redundant
derived labels such as `#REDDEV` are not shown because hierarchy and accessible
names already provide context.

The toolbar contains Tags and one compact `+` icon whose tooltip and accessible name
are `Add Machine`. Project creation remains contextual to a Machine row (or the Open
tab for the current workspace), so the toolbar never shows a global Add Project
action. These controls remain available at 260 px.

Client-wide status is a persistent banner above filters and never appears as a
Machine property:

- `Applying SSH config…`;
- `SSH config needs attention` with Retry, Show Details, and Open Config;
- `Remote - SSH required` with Install and Retry;
- `Migration needs connection details`.

Match count is separate and filtering never hides an error. During Applying, one
Open action queues behind the current reconcile; it does not start another write.
Machine-specific conflicts and repairs remain on affected rows.

Reuse the accepted native nested-list interaction model: no `tree`/`treegrid` roles,
one primary Tab stop per visible row, Enter/Space for Machine/Environment disclosure,
and Shift+F10 for equivalent row actions. Refresh, filter, edit, and delete restore
focus by stable ID, then mirror, adjacent row, parent, section first row, or toolbar.
The tag chooser uses a labeled group that announces selected tags match all.

## 9. Personal data cutover

The owner's existing remote Projects have already been converted into the managed
catalog. This conversion is not a reusable product workflow. On every startup,
Agent Pivot reads that catalog directly and renders `Machine → Environment →
Project`; it does not inspect live legacy Project values, verify their cleanup, or
offer migration and rollback actions.

The frozen pre-cutover snapshot remains internal, inert backup data. Keeping it
does not create a second authority: no renderer, editor, opener, synchronizer, or
SSH generator reads it. The product never deletes it automatically.

The historical mapping below documents how the preserved catalog was produced; it
is not executed during startup.

### 9.1 Preserved field mapping

| V1 field | Managed result |
| --- | --- |
| Project `id` | preserved exactly |
| `name`, `description`, `color` | preserved after validation |
| explicit `tags` | preserved in original order |
| non-empty `groupName` | appended as an ordinary tag; case-insensitive dedupe |
| `favorite` / `favoriteOrder` | preserved in one managed layout model |
| `machineDisplayName` | proposed as Machine name; endpoint disambiguates |
| remote URI | split into Environment reference and remote path |
| `lastOpenedAt` | retained only in client-local usage state |

The preserved catalog retains all non-connection metadata. Equal normalized
`(host, user, port)` endpoints became one Machine, and each remote Dev Container
became a distinct Environment under its outer SSH Machine.

## 10. Runtime authority

- The Machine → Environment → Project renderer is always used; there is no
  user-facing feature flag or legacy remote renderer.
- Only the active managed revision is authoritative for remote Machines and
  Projects.
- Startup may repair synchronized/local replicas of that same managed revision,
  but never starts a conversion or touches legacy Project storage.
- Migration, rollback, downgrade, and mixed-version behavior are outside this
  personal build's product contract.
- Existing legacy and frozen-snapshot bytes are retained untouched as emergency
  evidence only and have no command, UI, open, or synchronization path.

## 11. Conflict behavior

- Different-Machine edits merge; identical concurrent edits coalesce.
- Divergent edits to one Machine preserve candidates and show `Connection conflict
  — Review`; Agent Pivot never picks an endpoint silently.
- Related Projects remain visible, but Open is disabled with full identity and
  reason in its accessible name.
- Review shows the non-secret endpoint diff and offers `Use this connection`, `Edit
  connection`, or Cancel. Resolution dominates all candidates, restores focus to
  the Machine, and announces completion in a live region.
- Parents cannot be removed while any live relationship candidate references them.
- New main + new UI Bridge never materialize or open a conflicted Machine. Offline
  or old clients are explicitly unsupported and may still hold a stale V1 URI; the
  product does not claim it can remotely disable already-installed old code.

## 12. Validation and safety

- Host, user, and port reject newlines, control characters, config directives, and
  record injection.
- Port is an integer from `1` through `65535`.
- Machine names become readable SSH aliases directly; safe Unicode letters are
  retained and normalized collisions are rejected. Names never become business
  identity.
- Host/user are synchronized by product requirement but redacted from diagnostics
  and telemetry by default.
- Generated files contain `DO NOT EDIT` and a connection checksum, but no
  credentials.
- The one-time preflight exposes the exact Include and active-config backup path.

## 13. Acceptance criteria

- [ ] Add an empty Machine with required user and port `22` or a custom port; it is
  stored in User settings and appears on a second computer after Settings Sync.
- [ ] Each new computer/config-path automatically materializes the managed SSH
  projection without a Setup, Enable, or Disable flow.
- [ ] No credential or key path/content appears in synced storage, logs,
  diagnostics, or telemetry.
- [ ] Password-authenticated opens delegate to Remote - SSH and prompt normally.
- [ ] Edit keeps Machine ID and Projects but changes subsequent opens everywhere.
- [ ] Host and each Dev Container are distinguishable and independently openable.
- [ ] Local, computer-local `wsl+` WSL, and local-container Projects never enter the
  managed catalog; the local WSL distro remains a separate client-local Machine.
- [ ] A remote WSL distro with an explicitly configured SSH host/user/port is stored
  as an independent Managed Machine, syncs, and opens from another computer.
- [ ] Project activation opens its current Environment/path; Edit cannot change its
  Machine or Environment, and saving the same code elsewhere creates a new Project.
- [ ] From a Host or Dev Container window, Projects on that same Machine reuse the
  window's proven SSH authority and open even when local managed-config projection
  needs attention; Projects on another Machine still require the local UI bridge.
- [ ] `SSH to Machine` launched from Local, SSH, WSL, and Dev Container windows runs
  the local SSH executable in an interactive terminal; Copy produces the equivalent
  credential-free command.
- [ ] Tags use AND filtering, Group migrates to an ordinary tag, and Favorites do
  not double-count.
- [ ] Generated aliases work with port `22`, two non-default ports, and boundaries
  `1` and `65535`.
- [ ] Reconcile never changes unrelated SSH config bytes.
- [ ] Startup loads the active managed catalog directly and logs non-sensitive
  Machine/Environment/Project counts without running legacy cleanup.
- [ ] No migration, rollback, Setup, Assign, or legacy remote fallback action is
  present in the Projects UI.
- [ ] Project navigation cannot bypass conflict review. Current-Machine navigation
  proves identity from the live remote authority; cross-Machine navigation requires
  new main + new UI Bridge. Old/offline clients are explicitly outside that guarantee.
- [ ] Pointer actions have keyboard equivalents; unavailable controls retain full
  identity in their accessible name.
- [ ] Two offline-created equal Machine names enter rename conflict and remain
  visually and accessibly distinguishable at 260 px until resolved.
- [ ] The 260 px layout works without horizontal scrolling.

## 14. Decisions already made

- Agent Pivot owns synchronized Machine and Project metadata only.
- Password entry stays in Remote - SSH; key management is out of scope.
- User is required and non-default SSH ports are supported.
- Command Palette can open an interactive local SSH terminal or copy its command.
- Project Machine/Environment ownership is immutable; another location is another
  Project rather than a move.
- Generated SSH config is a local projection, not an authority.
- Existing user-authored SSH blocks and legacy Project bytes are not deleted;
  active Agent Pivot does not read them.
- The target is one managed runtime mechanism; preserved legacy bytes are inert
  emergency evidence only.
- Work remains on this branch and one PR is opened only after all owner milestones.

## 15. Confirmed owner decisions

1. The owner's data has already been converted. The active managed catalog is used
   directly; there is no migration, cleanup, rollback, Setup, Assign, review form,
   rehearsal, or legacy remote fallback.
2. First-release Dev Containers are created only by migration or `Save
   Current Project`, without an arbitrary container editor. **Recommendation:
   approve this narrower boundary.**
3. Advanced proxy/command/forwarding behavior stays unsupported, with no legacy
   runtime fallback; ordinary host/user/port aliases migrate automatically. An
   unresolved alias aborts without changing data and never opens a form.
