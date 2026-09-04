# Managed Remote Machines PRD

> Status: M1 accepted; M2 local materializer implemented behind a disabled path, owner acceptance pending
>
> Date: 2026-09-04
> Related: [Remote Machines Projects PRD](./remote-machines-projects-prd.md)

## 1. Summary

Agent Pivot will own a synchronized directory of remote development Machines and
Projects. A user adds an SSH Machine once with a display name, host, user, and port.
Projects and Dev Container environments reference the Machine by stable ID rather
than inferring identity from an SSH alias embedded in a URI.

After one computer-level consent, Agent Pivot materializes this catalog into an
isolated generated SSH config and automatically adds one exact managed `Include`
to the config used by Remote - SSH. The generated file is a rebuildable local
cache, not a second source of truth. Passwords, keys, passphrases, and tokens are
never stored or synchronized; Remote - SSH continues to prompt when authentication
is needed.

The intended end state has one Agent Pivot connection model. Existing alias-based
Projects are migrated once and then open through stable Agent Pivot aliases. The
first release does not delete existing SSH blocks: they remain inert, user-owned
rollback material and are never consulted by managed mode.

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
2. **No per-Machine binding.** A Machine contains enough non-secret information to
   connect on any enabled computer. Each VS Code installation asks once before
   enabling the local generated projection.
3. **Authentication stays with SSH.** Agent Pivot never accepts or persists a
   password, private key, passphrase, certificate, or token.
4. **Identity is stable.** Renaming a Machine or changing its endpoint does not
   change its ID or Project membership.
5. **A local-only authority stays local.** Local filesystem Projects, Projects
   addressed through this computer's `wsl+<distro>` authority, and local-container
   Projects stay on the computer where they were saved. A remote WSL distro with
   its own SSH endpoint is instead a Managed Machine and synchronizes normally.
6. **Migration is automatic and reversible.** Existing compatible remote Projects
   are converted once on startup. Only records that cannot be resolved safely ask
   for input. The first release never removes an existing SSH config entry.

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
- Automatically migrate compatible existing SSH and remote Dev Container Projects;
  ask only when a connection cannot be resolved safely.
- Retain a bounded rollback path until owner acceptance.

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
   resolved, both rows show `user@host:port` and every related visible/accessibility
   name uses that disambiguator.
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

### 7.2 Enable managed connections on this computer

The first time a VS Code installation receives or creates a Managed Machine, the
catalog is visible but SSH files stay untouched. A client-level banner offers
`Enable on This Computer`. Its preflight shows:

- the active SSH config path and SSH executable;
- the exact Include block;
- generated-directory and generated-file backup paths;
- that later synchronized Machine changes update the generated file automatically;
- `Enable` and `Cancel`.

After confirmation, Enable backs up the exact active config, inserts the Include
automatically, and validates the result. It uses a no-overwrite exchange: if another
editor saves during the operation, that save wins and Agent Pivot offers
`Copy Include` + `Open Config` as the manual fallback. Normal use requires no SSH
config editing.

Consent is local to that installation and canonical active-config path, and applies
to all Managed Machines. Changing the active config path requires a new preflight.
It is not Machine setup. Until enabled, remote Open actions are disabled with an
accessible reason pointing to the preflight.

`Disable on This Computer…` previews removal of only the exact owned Include and
generated directory; it never changes the catalog or another SSH block. Checksum or
ownership mismatch fails closed with Open Config/Show Details. Cancel is
byte-identical. An interrupted disable resumes or restores the prior enabled state;
after success all managed Open actions explain that local connections are disabled
and offer Enable. Removal uses the same automatic exchange with manual fallback.

### 7.3 Open a Machine

- Machine main-row activation only expands/collapses.
- Its right-side Open starts a new Remote - SSH window for Host.
- Remote - SSH prompts for authentication as normal.
- The row menu contains `Add Project…`, `Edit Machine…`, `Regenerate SSH Config`,
  `Open SSH Terminal…`, `Copy SSH Command`, and `Remove Machine…`.

### 7.4 SSH from the Command Palette

`Agent Pivot: SSH to Machine…` appears in the Command Palette. It shows ready
Managed Machines by name and endpoint, then opens an integrated terminal whose
process runs on the local computer, even when the current VS Code window is SSH,
WSL, or Dev Container. The terminal executes the locally resolved SSH executable
with the stable managed alias as an argument and remains interactive for password
input.

`Agent Pivot: Copy SSH Command…` uses the same picker and copies the equivalent
local command, normally `ssh agent-pivot-<machine-id>`. It contains no password or
other credential. Both commands require this computer to be enabled and the exact
catalog revision/config projection to be ready; otherwise they show the same
Enable/Retry/conflict recovery as Machine Open.

### 7.5 Add or edit a Project

Global `Add Project` first offers `Current Environment — <actual Local, local WSL
distro, Local Dev Container, or Managed Machine/Environment>` followed by named
Managed Machines. Review always shows the final hierarchy. Selecting a local,
computer-local WSL, or local-container environment uses the local-only save path.
An independently SSH-reachable remote WSL is selected by its Managed Machine name,
not by a `wsl+` authority. Choosing a Machine collects metadata, tags, color,
favorite state, Environment, and path. Machine-row `Add Project…` skips the Machine
step and defaults to Host.

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
port, path confirmation, and a successful Remote - SSH rehearsal before the Project
can enter the managed catalog. After activation, converting between a local WSL
Project and a Managed Project creates a separate Project rather than moving it.

### 7.9 Remove a Machine

A Machine with Projects or Dev Container environments cannot be removed. The user
must remove those children first, creating separate Projects elsewhere if needed.
An empty Machine with only its fixed Host can be removed after confirmation. Enabled
computers remove its generated alias on their next reconcile.

### 7.10 Use another computer

An already-enabled computer automatically materializes newly synced catalog data.
A new computer asks once for local file consent. There is no per-Machine step.

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

The toolbar groups Tags, Add Machine, and Add Project. Use text where width permits;
at 260 px use distinct icon actions or one overflow with full action text. Actions
must not disappear.

Client-wide status is a persistent banner above filters and never appears as a
Machine property:

- `Enable managed connections on this computer`;
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

## 9. Migration

Migration preparation runs automatically once when the managed lifecycle is
`disabled`. There is no Migrate button and no final “build preview” confirmation.
V1 remains authoritative until the user enables managed SSH on this computer, and
the frozen V1 snapshot remains available for rollback.

### 9.1 Automatic preparation and exception resolution

Every synchronized remote Project is classified:

- **Ready** — direct `user@host`, or an alias whose endpoint and connection behavior
  are proven compatible with the managed subset;
- **Needs input** — alias unavailable, fields ambiguous, or identity deduplication
  requires a choice;
- **Unsupported** — route or authentication/host-checking behavior is outside the
  first release, including `ProxyJump`, `ProxyCommand`, `Match exec`, dynamic
  Includes, or unverified alias-specific directives;
- **Client-local** — Local, computer-local `wsl+` WSL, and local-container records
  stay on this computer unless a WSL record is explicitly converted using an
  independently reachable SSH endpoint.

Direct endpoints and compatible aliases detected by the UI-host OpenSSH inspector
are accepted automatically. Client-local records are skipped automatically. Only
unresolved records open a focused prompt for `Enter connection details` or `Remove
from Agent Pivot` (does not delete files). Cancelling leaves V1 authoritative and
retries preparation on a later startup. Activation requires zero unresolved
records.

An alias using `IdentityFile`, `IdentitiesOnly`, `CertificateFile`, `IdentityAgent`,
`HostKeyAlias`, or `UserKnownHostsFile` is not Ready merely because host/user/port
can be parsed. Credentials remain out of scope: the user must confirm the managed
endpoint and successfully rehearse the generated alias through Remote - SSH with
their intended local authentication before it becomes Ready.

### 9.2 Field mapping

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

The automatically prepared candidate preserves all non-connection metadata. Equal
normalized `(host, user, port)` endpoints become one Machine. Each remote Dev
Container becomes a distinct versioned Environment under its outer SSH Machine.

### 9.3 Activation

1. Automatically resolve compatible remote records and save a checksummed,
   restorable V1 snapshot.
2. For each historically synced WSL Project, ask either `Keep on this computer` or
   `Use an SSH-reachable WSL Machine…`. The local choice writes and verifies a
   migration-tagged local copy before remote activation; other clients do not copy
   it. The managed choice requires explicit endpoint/path confirmation and a
   successful Remote - SSH rehearsal.
3. Generate and validate stable Agent Pivot aliases locally.
4. Complete the required Remote - SSH rehearsal for risky migrated aliases.
5. Commit the managed catalog and lifecycle activation atomically.

The first release does not alter legacy Host blocks. Managed mode never consults
them after activation; they remain inert rollback material.

## 10. Lifecycle, compatibility, and rollback

- Lifecycle is `disabled → preview → active → rolledBack`; lifecycle, active
  revision, and recovery state share one managed envelope.
- The Machine → Environment → Project renderer is the default; there is no
  user-facing feature flag for this view.
- Before activation, existing V1 Project data remains authoritative and is
  projected into the Machine view without migration.
- After activation, only `Roll Back Managed Remote Migration` changes authority. It
  restores the exact V1 snapshot and leaves all legacy SSH blocks untouched.
- Rollback data remains through owner acceptance and at least one released minor
  version.
- Managed activation freezes the original V1 keys; it does not emit managed-alias
  URIs into them. An older plugin may show the pre-migration snapshot and can open
  it only on a computer where its original aliases already work. It receives no
  managed updates, empty Machines, or conflict safety guarantee.
- An older plugin cannot be forced read-only. If it edits frozen V1 data, the new
  version detects fingerprint divergence,
  preserves both branches, and requires `Import legacy edits` or `Keep managed
  catalog`; it never silently discards edits. Activation warns that old-client edits
  are unsupported until all synced clients are upgraded.
- Mixed-version behavior is verified against actual N-1/N-2 VSIX builds before
  activation is offered.

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
- Names never participate in alias or identity generation.
- Host/user are synchronized by product requirement but redacted from diagnostics
  and telemetry by default.
- Generated files contain `DO NOT EDIT` and a connection checksum, but no
  credentials.
- The one-time preflight exposes the exact Include and active-config backup path.

## 13. Acceptance criteria

- [ ] Add an empty Machine with required user and port `22` or a custom port; it is
  stored in User settings and appears on a second computer after Settings Sync.
- [ ] Each computer/config-path pair asks once before enabling managed SSH; the
  normal path edits no file manually, while Cancel before confirmation leaves SSH
  files byte-identical and the catalog visible.
- [ ] No credential or key path/content appears in synced storage, logs,
  diagnostics, or telemetry.
- [ ] Password-authenticated opens delegate to Remote - SSH and prompt normally.
- [ ] Edit keeps Machine ID and Projects but changes subsequent opens everywhere.
- [ ] Host and each Dev Container are distinguishable and independently openable.
- [ ] Local, computer-local `wsl+` WSL, and local-container Projects never enter the
  managed catalog; the local WSL distro remains a separate client-local Machine.
- [ ] A remote WSL distro with an explicitly configured SSH host/user/port is stored
  as an independent Managed Machine, syncs, and opens from another computer.
- [ ] Historical synced WSL Projects are either copied only to the migration owner's
  local store or explicitly converted to a rehearsed SSH-reachable WSL Machine;
  another client never silently claims or converts them.
- [ ] Project activation opens its current Environment/path; Edit cannot change its
  Machine or Environment, and saving the same code elsewhere creates a new Project.
- [ ] `SSH to Machine` launched from Local, SSH, WSL, and Dev Container windows runs
  the local SSH executable in an interactive terminal; Copy produces the equivalent
  credential-free command.
- [ ] Tags use AND filtering, Group migrates to an ordinary tag, and Favorites do
  not double-count.
- [ ] Generated aliases work with port `22`, two non-default ports, and boundaries
  `1` and `65535`.
- [ ] Reconcile never changes unrelated SSH config bytes.
- [ ] Migration covers direct targets, simple aliases, Include, custom ports, and
  nested remote Dev Containers; unknown anchors are Unsupported.
- [ ] Alias-specific auth/host-checking config is not Ready without an explicit
  generated-alias Remote - SSH rehearsal.
- [ ] Unsupported records have a completion or cancellation path.
- [ ] Rollback restores the original V1 Project snapshot and original aliases still
  resolve because first-release migration never deletes them.
- [ ] With new main + new UI Bridge, Project navigation cannot bypass conflict
  review; old/offline clients are explicitly outside that guarantee.
- [ ] Pointer actions have keyboard equivalents; unavailable controls retain full
  identity in their accessible name.
- [ ] Two offline-created equal Machine names enter rename conflict and remain
  visually and accessibly distinguishable at 260 px until resolved.
- [ ] `Disable on This Computer` is previewed, idempotent, and cannot alter unrelated
  SSH bytes; Cancel is byte-identical.
- [ ] The 260 px layout works without horizontal scrolling.

## 14. Decisions already made

- Agent Pivot owns synchronized Machine and Project metadata only.
- Password entry stays in Remote - SSH; key management is out of scope.
- User is required and non-default SSH ports are supported.
- Command Palette can open an interactive local SSH terminal or copy its command.
- Project Machine/Environment ownership is immutable; another location is another
  Project rather than a move.
- Generated SSH config is a local projection, not an authority.
- Existing SSH blocks are retained throughout the first release and rollback window.
- Active mode freezes original V1 keys; it does not promise managed behavior on an
  old client.
- The target is one managed runtime mechanism; legacy data is migration/rollback
  material only.
- Work remains on this branch and one PR is opened only after all owner milestones.

## 15. Decisions requiring owner approval

1. Approve one-time, per-computer SSH config consent. It is not per-Machine Setup;
   without it, synced data would mutate a new computer's files without consent.
   **Recommendation: approve.**
2. Confirm first-release Dev Containers are created only by migration or `Save
   Current Project`, without an arbitrary container editor. **Recommendation:
   approve this narrower boundary.**
3. Confirm advanced/alias-specific SSH behavior stays blocked until a generated
   alias is proven to work, with no legacy runtime fallback. **Recommendation:
   block to preserve one managed authority.**
