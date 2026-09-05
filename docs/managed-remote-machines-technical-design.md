# Managed Remote Machines Technical Design

> Current cutover contract (2026-09-04): the owner's already-active managed
> catalog is the sole runtime authority. Startup only reconciles and reads this
> catalog. It does not prepare migrations, clear or verify legacy storage, activate
> previews, or expose rollback. Existing migration-envelope fields and frozen V1
> bytes are retained only so the persisted catalog can be decoded without a
> destructive storage rewrite; no product path consumes them.

> Status: personal managed-catalog cutover active
>
> Date: 2026-09-04
> Product contract: [Managed Remote Machines PRD](./managed-remote-machines-prd.md)

## 1. Scope and pain statement

This refactor replaces URI-derived remote Machine identity with synchronized,
first-class Machine records while preserving Project behavior, tags, Favorites,
colors, local-only records, and Remote - SSH as the navigation engine.

Today one `Project.path` carries three responsibilities: Project location,
Environment identity, and SSH connection identity. Machine edits therefore rewrite
Projects, empty Machines cannot exist, and a synced custom-port Project is not
portable unless every computer independently recreates the same alias.

This is the architecture-refactor investigation and plan. It stops before code so
the owner can approve the boundary and trade-offs first.

## 2. Current implementation

```text
ProjectPromptController
  └─ stores Project.path (local path or vscode-remote URI)
       ├─ remote Projects → projectData + projectSyncData
       └─ local Projects  → globalState['localProjects.v1']

buildMachineProjectsViewModel(groups)
  └─ parses Project.path into presentation-only Machine/Environment rows

Project row → ProjectOpenController
  └─ sends a full Project path to UI Bridge
       └─ vscode.openFolder(...)
```

Important boundaries:

- `src/models.ts` has no Machine or Environment foreign key.
- `src/projects/machineProjectsViewModel.ts` derives the hierarchy from V1 URIs.
- `src/services/projectService.ts` already keeps Local Projects in
  `globalState['localProjects.v1']`.
- `src/services/projectCatalogSyncService.ts` reconciles the synced setting, legacy
  projection, and a durable local replica.
- the main extension is `extensionKind: ["workspace"]` and may run remotely;
- `extensions/attention-ui-bridge` is `extensionKind: ["ui"]` and performs local
  navigation.

The defects are connection duplication, no independent Machine lifecycle, alias
portability assumptions, no second-computer connection contract, and a filesystem
ownership mismatch when the main extension runs remotely.

## 3. Target architecture and authority

```text
                  application-scoped synced envelope
                agentPivot.managedRemoteCatalogData
                               │
                  ManagedRemoteCatalogService
              sole coordinator and business-data writer
                    ┌──────────┴──────────┐
                    │                     │
              shared view model      frozen V1 snapshot
                    │                 inert backup bytes only
             identity + revision intent
              ┌─────┴──────────────────┐
              │                        │
       current-Machine open      cross-Machine open
       workspace Extension Host  UI Bridge on local host
       reuses live authority      materializes SSH alias
              └──────────┬─────────────┘
                 vscode.openFolder
```

There is one business authority and one runtime projection:

- the managed envelope is edited and synchronized;
- generated SSH config is local, revisioned, accepts no reverse import, and can be
  deleted/rebuilt;
- the original V1 values and frozen snapshot are ignored by runtime behavior and
  are never automatically cleared, verified, restored, or projected.

The UI Bridge never saves Machine or Project business data. It owns local SSH
filesystem effects and cross-Machine navigation. A Project on the currently
connected Machine opens directly from the workspace Extension Host by reusing the
window's proven SSH/Dev Container authority; this path does not depend on local SSH
projection health. Existing user SSH blocks are
neither an Agent Pivot source nor modified by this release.

## 4. Runtime lifecycle

The supported product state is `active`: one managed revision drives the Machine
hierarchy, edits, generated SSH projection, and navigation. `disabled`, `preview`,
`rolledBack`, migration-plan fields, and frozen V1 values remain decodable only to
avoid a destructive rewrite of the owner's persisted envelope. No runtime command
can enter or leave those historical states, and the renderer never falls back to a
legacy remote catalog.

## 5. Synchronized persistence and recovery

### 5.1 Separate key

Add application-scoped `agentPivot.managedRemoteCatalogData`. Do not change
`projectSyncData` in place because old versions may parse or overwrite it.

```ts
interface ManagedCatalogEnvelopeV1 {
  envelopeVersion: 1;
  causalContext: Record<string, number>;
  authority: VersionedCandidates<AuthorityState>;
  stagedRevisions: Record<string, VersionedCandidates<RevisionSlot | null>>;
  migrationPlans: Record<string, VersionedCandidates<MigrationJournal | null>>;
  rollbackPlans: Record<string, VersionedCandidates<RollbackJournal | null>>;
  legacyDivergences: Record<string, VersionedCandidates<ChecksummedLegacySnapshot | null>>;
}

interface AuthorityState {
  lifecycle: 'disabled' | 'preview' | 'active' | 'rolledBack';
  active?: RevisionSlot;
  previous?: RevisionSlot;
  migrationPlanId?: string;
  rollbackPlanId?: string;
}

interface RevisionSlot {
  revisionId: string;
  checksum: string;
  document: ManagedRemoteCatalogV1;
}
```

Revision slots are embedded only in causally live authority/plan candidates; there
is no append-only global revision map. The parser validates each slot independently.
A corrupt active slot cannot hide a valid previous or concurrent authority candidate
and enters `Recovery required`; it never guesses another active revision.

Migration/rollback plans, legacy-divergence candidates, and authority pointers live
inside this envelope. No second setting is assumed atomic with it.

`joinEnvelope(left, right)` is a pure commutative, associative, and idempotent join:

1. join causal contexts component-wise;
2. causally join authority, staged revision, each plan, and each legacy-divergence register; embedded
   slots with the same revision ID but different bytes are corruption, not a tie-break;
3. collect every revision embedded by either live authority/plan candidate before
   any catalog merge;
4. retain causally live candidates and tombstones; never select by revision ID;
5. drop an authority/plan value and its embedded full snapshots only when a causal
   successor dominates it; plan tombstones prevent observed offline plans reviving;
6. if `active` and `rolledBack` authority candidates are concurrent, or concurrent
   active candidates cannot be safely merged, enter `Recovery required` with both
   branches visible and perform no navigation.

Migration plan and rollback intent carry a stable plan ID plus causal dot. Two
different legacy branches are stored under distinct divergence IDs; a single field
can never overwrite another branch.

### 5.2 Durable writer replica

Every workspace Extension Host activation that can write creates a fresh actor ID.
Its non-synced durable replica is a map of actor slots containing next counter, last
envelope, and staged candidate. Windows sharing one `globalState` serialize slot
creation/counter allocation through one local facade; they never share an actor or
reuse a dot. Counter allocation is persisted before publication.

Commit ordering is:

1. parse and reconcile backend envelope with the local replica;
2. create and validate the merged candidate revision;
3. persist it as a staged local candidate;
4. publish it under a unique `stagedRevisions` ID without
   changing authority;
5. reread and merge any concurrent backend revision;
6. validate structure, then write a new causally versioned authority candidate that
   points to active/previous revisions;
7. mirror the committed envelope locally and causally tombstone the staged ID.

Reconcile compares backend and replica separately and repairs whichever is missing
or behind. If a Settings Sync whole-value overwrite temporarily removes branch A,
the A writer's durable replica reintroduces it when that writer next observes branch
B. The design does not claim durability if a device is destroyed before its local
write reaches any other replica.

Authority-write failures keep staged/referenced revisions recoverable. Public
recovery operations are `activateRecoveryCandidate`, `discardRecoveryCandidate`,
and `rollBackToPrevious`; discard writes a causal tombstone/reference cleanup rather
than deleting evidence needed by another live plan. Out-of-order Settings Sync,
duplicate deliveries, missing backend, corrupt active, and crash at every commit
step are contract tests.

An authority value carries at most active and previous full catalog snapshots.
Completed migration/rollback plans are causally tombstoned after the rollback
retention contract permits it. A thousand sequential mutations therefore replace
dominated authority values instead of unioning a thousand snapshots; tests combine
that history with an offline old replica and verify bounded payload plus merge laws.

### 5.3 Catalog document

```ts
interface ManagedRemoteCatalogV1 {
  schemaVersion: 1;
  versionVector: Record<string, number>;
  machines: Record<MachineId, VersionedCandidates<ManagedSshMachine | null>>;
  environments: Record<EnvironmentId, VersionedCandidates<ManagedEnvironment | null>>;
  projects: Record<ProjectId, VersionedCandidates<ManagedRemoteProject | null>>;
  layout: VersionedCandidates<ManagedRemoteLayout>;
}

interface ManagedSshMachine {
  id: string;                 // immutable UUID
  name: string;               // display only; unique after conflict resolution
  connection: {
    kind: 'ssh';
    host: string;
    user: string;             // required for cross-computer identity
    port: number;             // 1..65535
  };
}

interface DevContainerLaunchAnchorV1 {
  version: 1;
  originalAuthority: string;  // exact opaque bytes for diagnostics/round-trip
  sourceKind: 'workspace' | 'config';
  sourceLocator: string;
}

interface ManagedEnvironment {
  id: string;
  machineId: string;
  kind: 'host' | 'devContainer';
  name: string;
  devContainerAnchor?: DevContainerLaunchAnchorV1;
}

interface ManagedRemoteProject {
  id: string;
  environmentId: string;
  name: string;
  description?: string;
  remotePath: string;
  tags?: string[];
  color?: string;
  favorite?: boolean;
}

interface ManagedRemoteLayout {
  machineIds: string[];
  environmentIdsByMachine: Record<string, string[]>;
  projectIdsByEnvironment: Record<string, string[]>;
  favoriteProjectIds: string[]; // sole favorite-order authority
}
```

`lastOpenedAt` stays client-local and does not rewrite a synchronized Project.
Dev Container Environment IDs use persisted random IDs, not a hash of private VS
Code serialization. `ManagedEnvironment.machineId` is the only outer Machine
authority; the codec never reads Machine identity from `originalAuthority` or the
anchor. Unknown anchor versions are preserved but unavailable, and code never
guesses how to rewrite them.

### 5.4 Invariants and merge

- exactly one deterministic Host Environment per live Machine;
- every live Environment/Project candidate has a live parent candidate;
- a Project's `environmentId` is immutable after creation; code on another Machine
  or Environment is represented by a separate Project ID, not a move mutation;
- Local, computer-local `wsl+` WSL, and local-container Projects cannot enter this
  catalog; an independently SSH-reachable remote WSL distro is represented as an
  ordinary Managed Machine and uses no WSL-specific catalog authority;
- parents cannot be deleted while any causally live child candidate references them;
- only Dev Containers carry a launch anchor;
- generated aliases are the sanitized Machine name itself, including safe Unicode
  letters such as Chinese. If the name has no SSH-safe letters or digits, the
  connection host supplies the readable alias. Add/Edit rejects two names that
  normalize to the same alias; names remain display metadata rather than identity.
- resolved Machine names are case-insensitively unique; concurrent duplicates keep
  both IDs, enter rename conflict, and use endpoint disambiguators until resolved;

All mutations use one `ManagedRemoteCatalogService`. Controllers, renderers,
migration helpers, and UI Bridge cannot write the setting directly.

Entity registers retain causally live candidates and tombstones. Dominated candidates
drop; concurrent identical values coalesce while retaining causal dots; divergent
Machine endpoints remain blocked until explicit resolution. Merge/normalize/
materialize must be deterministic, commutative, associative, and idempotent.

New managed navigation exposes no openable URI for a conflicted Machine. Explicit
resolution observes and dominates all candidates. An old/offline client may still
hold a stale frozen V1 URI and is outside this guarantee. Candidate/vector compaction
is not added without a proved causal checkpoint; two individually valid documents
must always be mergeable.

### 5.5 Payload and performance gates

VS Code exposes an oversize Settings Sync failure but does not publish a stable
numeric resource limit that this extension can rely on. M1 therefore uses a
conservative provisional product ceiling of 768 KiB (25% below a 1 MiB working
budget), while M4 keeps activation blocked until the same corpus succeeds against
the real supported Settings Sync service. The cross-milestone test corpus contains
50 Machines, 500 Projects, 100 tags, two concurrent candidates per entity, previous
revision, and rollback snapshot. It must:

- serialize below the verified ceiling with 25% headroom;
- merge and validate in under 200 ms on the CI reference machine;
- render the initial Projects panel in under 200 ms after data is available;
- avoid rewriting SSH config when only tags, descriptions, Favorites, or layout
  change by comparing a connection-only projection digest.

M1 owns the serialization and merge/validation gates, M2 owns the connection-only
digest gate, and M3 owns the render gate. A later milestone cannot activate merely
because an earlier subset passed.

If this corpus cannot fit, implementation stops for owner scope approval rather than
silently truncating history or metadata.

## 6. Automatic local projection and config discovery

UI Bridge stores local projection state scoped to the canonical active SSH config
path. Synchronization never sets it. Any disabled generation is automatically
enabled from the active managed catalog; the product has no persistent local
opt-out.

Legacy disable journal states remain decodable for crash recovery, but no runtime UI
or message can initiate Disable. Startup converges them back to enabled after
validating ownership and the dependency fingerprint.

Resolve local Remote - SSH inputs from User settings:

1. use `remote.SSH.path` when configured, otherwise the platform OpenSSH executable;
2. use `remote.SSH.configFile` when configured, otherwise the platform default user
   config (`~/.ssh/config` or `%USERPROFILE%\.ssh\config`);
3. probe that the exact executable supports the required `-F`, `-G`, and Include
   behavior;
4. fail closed when the executable/config is missing or unsupported.

M2 verifies protocol compilation/activation and the installed POSIX OpenSSH client.
The real VS Code, Remote - SSH, Windows OpenSSH, and cross-host version matrix is an
M4 activation gate. If VS Code 1.51 cannot satisfy the tested protocol, raise
`engines.vscode` explicitly rather than shipping an untested claim.

## 7. Generated SSH projection

### 7.1 Files and alias

For `/path/to/.ssh/config`:

```text
/path/to/.ssh/config
/path/to/.ssh/agent-pivot/current.conf
/path/to/.ssh/agent-pivot/revisions/<digest>.conf
/path/to/.ssh/agent-pivot/previous.conf
/path/to/.ssh/agent-pivot/state.json
/path/to/.ssh/agent-pivot/config.lock
```

The active config receives one marked Include before ordinary Host/Match sections:

```sshconfig
# >>> Agent Pivot managed SSH hosts (do not edit)
Include "/path/to/.ssh/agent-pivot/current.conf"
# <<< Agent Pivot managed SSH hosts
```

Generated records use the sanitized Machine name itself as the readable alias.
Safe Unicode letters are retained, whitespace becomes `-`, and an unusable name
falls back to the connection host. Add/Edit rejects normalized alias collisions.
Renaming changes the local alias and triggers projection regeneration; Project
identity remains the stable Machine/Environment/Project IDs:

```sshconfig
Host reddev
    HostName dev.example.com
    User alice
    Port 22022
```

Generated config contains no auth directive. Local/global SSH authentication rules
may still provide keys or an agent; otherwise Remote - SSH prompts for a password.
Endpoint/route behavior outside host/user/port is not synchronized. Capability tests
determine which route-neutralizing directives can safely be emitted across the
supported OpenSSH matrix; if a safe closed route cannot be guaranteed, the Machine
is unavailable rather than inheriting a hidden `ProxyJump`, `ProxyCommand`, or
`LocalCommand` from a wildcard.

### 7.2 Safe write protocol

The lock path derives from the canonical active-config path, so different VS Code
Profiles sharing one config also share one lock. The lock coordinates Agent Pivot
processes. It is not presented as protection from an external editor.

Every background materialization statically checks the bounded active-config Include
graph. File identities and checksums form a dependency fingerprint stored in local
state. Dynamic Includes, `Match exec`, cycles, unsafe links, or route directives that
cannot be neutralized make managed navigation unavailable. A change to any dependency
invalidates the proof and requires revalidation. After safe scanning, validate the
candidate through a temporary aggregate config that uses the same static graph but
points its managed Include to the candidate revision.

Reconcile performs:

1. lock; snapshot the active config and full static dependency fingerprint, including
   bytes, identity, timestamps, ownership, links, permissions/ACL, and checksums;
2. validate catalog values and render a versioned candidate in stable Machine-ID
   order;
3. write and fsync a sibling revision file and directory;
4. validate the generated file in isolation, then the safe temporary aggregate, with
   the exact executable using `ssh -F <file> -G <alias>`; no scanned file may contain
   `Match exec` or dynamic Include;
5. atomically install Agent Pivot-owned `current.conf`, fsync its parent, retain
   `previous.conf`, and verify revision/checksum; a crash here is harmless because
   first enable has not published the Include yet;
6. on first enable only, snapshot the active config,
   write and fsync a sibling candidate, rename the active file to an exchange path,
   verify that the displaced inode and checksum still match the snapshot, then
   hard-link the candidate into the now-empty active path; `EEXIST` means an external
   editor won and Agent Pivot never overwrites its bytes;
7. archive the exact displaced file as the local active-config backup; if automatic
   publication cannot complete safely, fail the local action without adding a
   Project-tab setup mode or treating local files as catalog authority;
8. re-read the active config and every dependency, reject a changed fingerprint,
   validate the actual aggregate read-only, and commit local state.

First materialization publishes and verifies `current.conf` before updating the
active config, then adds the exact owned Include automatically. A crash before that
commit leaves either
an unreferenced generated file or a recoverable exchange: missing active restores
the displaced original, while active plus exchange preserves the active bytes and
archives the displaced original before revalidation. Normal reconcile never
rewrites the user-owned active config when its exact marker is intact. Startup
treats `recoveryRequired` as an automatic recovery request: it compares the desired
projection with Agent Pivot-owned `current.conf` and atomically replaces stale,
malformed, or previous-format owned bytes without requiring Retry.
Existing-Include reconcile validates before swapping `current.conf`, so unvalidated
bytes are never active. The Project tab exposes no Enable, Disable, Retry, Rebind,
or Regenerate control for this local projection.

POSIX owned-file writes require private directories/files, current-user ownership,
one link, and no symlink; atomic replacement rechecks an existing target before
rename. The active config and static Include dependencies are read-only and reject
foreign ownership, writable-by-group/other modes, unexpected hardlinks, symlinks,
and read races. Windows materialization remains fail-closed in M2 until the M4 real
Windows gate proves DACL and reparse-point handling; Node `chmod` is never treated
as an ACL substitute. Platform limitations fail closed with remediation text.

The first release never deletes or rewrites legacy Host blocks. This removes the
highest-risk byte-range cleanup and keeps rollback coherent.

## 8. UI Bridge protocol, trust, and revision checks

The workspace Extension Host cannot write local SSH files. Extend UI Bridge with a
versioned capability handshake and strict commands:

```ts
type ManagedRemoteIntent =
  | { type: 'reconcile'; expectedRevisionId: string; requestId: string }
  | { type: 'openMachine'; machineId: string; expectedRevisionId: string; requestId: string }
  | { type: 'openProject'; projectId: string; expectedRevisionId: string; requestId: string }
  | { type: 'openLocalSshTerminal'; machineId: string; expectedRevisionId: string; requestId: string }
  | { type: 'copyLocalSshCommand'; machineId: string; expectedRevisionId: string; requestId: string };
```

Every runtime request is identity-only. UI Bridge reads the synchronized catalog
itself and never accepts host, user, port, generated config bytes, or a Project URI
from the remote workspace Extension Host.

For open/reconcile, UI Bridge rereads `managedRemoteCatalogData` locally and requires
the expected active revision. Mismatch returns `catalogOutOfDate`. The caller never
supplies host/user/port/full URI, so it cannot forward stale endpoint values. Open
uses a fast connection-digest/current-checksum/Include readiness check. When stale,
it waits only for the bounded latest-wins projection worker; it never invokes a full
reconcile in the action handler or joins an unbounded user-action queue.

Reuse the existing main/UI Bridge challenge and require the
`managedActionProjectionV2` runtime capability before exposing the new action path;
an older Bridge fails fast with an update error instead of running the previous
action-triggered reconcile behavior. Issue a short-lived per-session capability for
correlation/replay rejection. VS Code Commands API does not provide a
strong caller identity: all installed extensions in the same Extension Host are in
the trusted computing base. The security boundary is therefore validation plus the
local state, not a claim that a token defeats a malicious installed extension. The
threat model explicitly excludes a malicious extension already able
to read User settings and invoke VS Code commands.

Responses are discriminated unions with protocol version and request ID. Progress
is non-terminal. A missing local runtime makes cross-Machine navigation fail with a
normal action error; it never adds a persistent setup state to the Project tab.
Current-Machine Project navigation remains available by reusing its live authority.

## 9. Navigation

### 9.1 Machine and Host Project

For a different Machine, UI Bridge resolves the unconflicted Machine from the exact
catalog revision, verifies the alias projection is ready, and opens:

```text
vscode-remote://ssh-remote+<encoded-managed-alias>/
```

For a Host Project on the current Machine, the workspace host proves the current
Environment from the live `vscode-remote` authority. It preserves the already
working outer SSH alias, replaces only the path, and invokes `vscode.openFolder` in
a new window. When the current window is a Dev Container, its parsed outer SSH
authority is reused to cross from that Container to the Machine Host. Paths alone
never establish Machine identity because the same path may exist on multiple hosts.

### 9.2 Dev Container

Resolve Project → versioned Dev Container anchor → Machine. A format-specific codec
rebuilds the authority with the verified managed alias and path. It preserves opaque
source bytes for diagnostics but never derives stable identity from those bytes.
Unknown versions or failed round-trip are `Needs repair`, never string-replaced.

On the current Machine, the same codec uses the outer SSH authority already proven
by the open Host/Container window. This permits Host ↔ Dev Container and Container
↔ Container Project opens without UI Bridge or regenerated SSH config. A target on
another Machine continues through UI Bridge and its authoritative local projection.

M1 cannot pass until at least one real current Remote-SSH → Dev Container URI fixture
round-trips across two different aliases and unsupported formats fail closed.
`Save Current Project` may create a managed container only when the parsed outer
authority is the exact stable alias of one managed Machine. Legacy aliases,
ambiguous equal endpoints, and attached-container identifiers are not assigned by
inference; they remain client-local where applicable or require migration/repair.

### 9.3 Client-local

Local filesystem, computer-local `wsl+<distro>`, and local-container Projects stay
in their existing local paths and do not cross this protocol. This Computer opens a
blank local window. A WSL distro reached through this computer's Windows-side WSL
extension remains its own client-local Machine because `wsl+Ubuntu` names a distro
on the current computer, not a portable remote endpoint.

An independently SSH-reachable WSL distro uses the ordinary Managed Machine path:
its explicit host/user/port is synchronized, projection creates a stable SSH alias,
and Remote - SSH opens that alias. No `wsl+` authority enters the managed catalog.
The parent remote Windows host and the SSH-reachable WSL distro have distinct
Machine IDs; V1 does not attempt a nested `Remote-SSH → WSL` launch or infer the WSL
endpoint from its parent.

### 9.4 Local SSH terminal command

The main extension contributes `Agent Pivot: SSH to Machine…` and `Agent Pivot:
Copy SSH Command…`. It reads the current managed view and offers an endpoint-qualified
Machine QuickPick. Copy writes a complete config-independent command such as
`ssh -p 22022 -l "alice" "host.example.com"` through the VS Code clipboard API and
never waits for SSH projection.

For terminal launch the main extension sends only Machine ID plus expected revision
to UI Bridge. UI Bridge rereads the exact catalog revision, rejects conflicts, and
calls `vscode.window.createTerminal` from the local `extensionKind: ["ui"]` host with:

```ts
{
  name: `SSH: ${machine.name}`,
  shellPath: resolvedRemoteSshExecutable,
  shellArgs: ['-p', String(port), '-l', user, host],
}
```

It shows the terminal and leaves it interactive, so the SSH client owns password
prompts. Terminal and Copy are independent of `current.conf`; Machine/remote-window
navigation alone needs the generated alias.

Although VS Code documents UI extensions as running locally, M2 must prove the
terminal process location in Local, SSH, WSL, and Dev Container windows with a local
marker executable. If any supported VS Code routes this terminal remotely, the
interactive command is blocked on that combination rather than accidentally running
`ssh` on the remote host; Copy remains available.

## 10. Mutation and failure ordering

- **Add/Edit:** validate and commit catalog, refresh UI, then request local reconcile.
  A local failure keeps synced data and reports the failed action; it never rolls
  back using a stale local snapshot or changes the Project-tab information model.
- **Open:** current-Machine Projects fail closed unless the live remote authority
  identifies exactly one managed Environment; cross-Machine opens fail closed until
  UI Bridge sees the expected unconflicted revision and a verified local projection.
- **Delete:** authoritative tombstone first, local cleanup later. A stale generated
  alias may remain temporarily but UI no longer references it. All live relationship
  candidates participate in delete guards.
- **Sync arrival:** merge/render first, then reconcile only if the connection digest
  changed. A filesystem error cannot mutate business data.
- **Conflict:** keep rows visible and produce no managed open/terminal/copy target
  until explicit resolution dominates candidates.
- **Project edit:** reject any `environmentId` mutation. The UI creates a separate
  Project when the same repository/path exists on another Machine or Environment.

## 11. Migration ownership and safety

### 11.1 Coordinator split

The workspace service first reconciles and freezes the authoritative V1 result from
`projectSyncData`, `projectData`, and its durable local shadow. It persists a
checksummed snapshot and stable candidate IDs in the managed envelope, then asks UI
Bridge to inspect only the referenced local SSH authorities.

UI Bridge resolves local config/executable and returns facts. It never owns the
business migration journal. `ManagedRemoteCatalogService` joins facts to the frozen
snapshot, applies user decisions, validates, stages, and activates the catalog.

Historically synchronized WSL records need an explicit disposition. Preview names
the migration-owner client and offers `Keep on this computer` or `Use an
SSH-reachable WSL Machine…`. For the local choice, before remote activation the
coordinator writes a migration-tagged copy to that client's `localProjects.v1`,
rereads it, and records `{projectId, ownerClientId, localDigest}` in the migration
plan. Other clients seeing the plan remove the record from the managed candidate but
never create a local copy. A failed later activation leaves a recognizable staged
local copy that retry reuses; rollback removes it only when its digest is unchanged,
otherwise preserves it and asks the owner.

For the managed choice, migration collects an explicit SSH host, required user,
port, and confirmed Linux path and creates an independent Machine candidate. It
never derives this endpoint from `wsl+<distro>` or from the parent Windows Machine.

### 11.2 Safe alias inspection

For direct targets, parsing requires explicit `user@host` and port 22 unless a port
was already represented by known structured data. Support Windows domain users by
splitting on the final valid `@`; IPv6 uses a bracketed UI grammar and canonical
unbracketed HostName. Reject control characters, `%` expansion, `${...}`, ambiguous
quotes, and unsupported Unicode/IDN forms rather than guessing.

For config aliases:

1. use the exact Remote - SSH executable as
   `ssh -F <active-config> -G <alias>` with argument arrays, no shell, bounded output,
   timeout, and whole-process-tree termination;
2. collect effective hostname/user/port and compare route facts;
3. never log raw output or source contents.

The active SSH config is user-owned trusted input. OpenSSH itself evaluates its
normal `Match` semantics while resolving the alias. Agent Pivot does not parse or
execute a command string and does not copy any resulting authentication directive.
If OpenSSH cannot produce a valid plain endpoint, migration aborts without a prompt
or any data mutation.

Migration intentionally keeps only the resolved host/user/port. Authentication
directives are not copied, so local SSH defaults apply and password authentication
continues to prompt. Proxy/Jump, forwarding, and command behavior stays unsupported.

### 11.3 Field mapping and identity

- preserve Project ID, name, description, color, explicit tags, and favorite state;
- append non-empty V1 `groupName` as an ordinary tag with stable case-insensitive
  deduplication;
- keep favorite order only in `ManagedRemoteLayout.favoriteProjectIds`;
- propose `machineDisplayName` as Machine label;
- keep `lastOpenedAt` client-local;
- split URI into Environment and remote path;
- use persisted UUIDs for Machines/Dev Containers and reuse them across Preview.

Suggested endpoint dedupe uses normalized `(host, user, port)`, but the user may
keep equal endpoints as separate logical Machines.

### 11.4 Activation journal

```text
PREPARED
  ├─ frozen V1 snapshot + checksum
  ├─ candidate IDs and review decisions
  └─ inactive candidate catalog
LOCAL_READY
  └─ managed config generated and verified automatically
ACTIVE
  └─ active authority candidate committed in the envelope
COMPLETE
  ├─ frozen V1 values retained in the synchronized journal
  └─ live V1 settings and obsolete local replica deleted
```

Every phase is resumable and idempotent. Activation never writes a managed-alias
projection to `projectData` or `projectSyncData`. Cleanup starts only after the
managed authority commit, can be retried after a partial settings write, and treats
both `undefined` and the schema default `null` as cleared. Configuration-change
handling must not let the retired V1 replica republish deleted data.

## 12. Rollback, downgrade, and mixed versions

Managed activation backs up and then clears the original `projectSyncData` and
`projectData`; it does not emit managed aliases into either key. Rollback is a
journaled cross-resource
operation because VS Code offers no transaction across those two settings and the
managed envelope:

```text
ROLLBACK_PREPARED
  └─ causal rollback intent + target checksums in envelope; managed UI stays active
LEGACY_RESTORED
  └─ restore projectSyncData first, then projectData; reread/verify both
ROLLED_BACK
  └─ causally commit rolledBack authority as the final step
```

Each legacy write is idempotent. A crash can retry restoration from the frozen
journal. Both keys are reread and checksum-verified before the final authority
transition commits; the V1 renderer remains unreachable until both are valid.

Generated Agent Pivot aliases and all original legacy SSH blocks remain untouched by
rollback. Migration-created WSL local copies follow the digest rule in section 11.1.

Old versions cannot be forced read-only. They are outside this personal-upgrade
contract: the current version deletes any V1 values that reappear after sync and
continues to use only the managed catalog. The frozen journal remains the sole
rollback source.

Compatibility gates use real packaged versions:

| Combination | Required behavior |
| --- | --- |
| new main + new Bridge | full managed behavior |
| new main + old Bridge | disabled local actions + Update Bridge |
| old main + new Bridge | existing V1 behavior; no managed command is invoked |
| N-1/N-2 after cleanup | no V1 Project catalog is available |
| downgrade then rollback | explicit rollback restores the frozen V1 snapshot |
| second old client syncs during active | current version retires the reappearing V1 data again |

Activation warns that all clients should be upgraded and that editing from an old
version is unsupported, while the divergence protocol prevents silent loss.

## 13. Security and privacy

- Schema/UI reject credential fields instead of hiding them.
- Host/user are intentionally synchronized account metadata and are redacted from
  diagnostics/telemetry by default.
- Config input rejects CR/LF, NUL/control characters, option syntax, expansion
  tokens, and oversized values.
- Renderer uses a closed SSH-config grammar; child processes receive argument arrays
  without a shell.
- Migration plans/backups are local; only normalized domain records synchronize.
- Secret-sentinel tests scan settings, local replicas, generated files, logs,
  diagnostics, errors, and telemetry.
- Filesystem ownership, ACL, link, external-writer, and crash rules from section 7
  are security requirements, not best-effort behavior.

## 14. Proposed code boundaries

```text
src/projects/managedRemote/
  types.ts
  envelope.ts
  validation.ts
  merge.ts
  catalogService.ts
  legacyCompatibilityGuard.ts
  migrationPlan.ts
  actionController.ts
  targetResolver.ts

src/projects/managedRemoteProtocol.ts

extensions/attention-ui-bridge/src/
  managedRemoteBridgeController.ts
  managedSshConsentCoordinator.ts
  managedSshProjectionWorker.ts
  managedRemotePlatform.ts
```

Existing renderers consume one shared view model. Current URI derivation stays
isolated behind the pre-activation/rollback adapter and is removed only after the
rollback window.

## 15. Verification strategy

### 15.1 Catalog and recovery

- schema/invariant rejection, including credential fields and ports;
- catalog and outer-envelope join laws and deterministic bytes, including concurrent
  rollback vs active edit;
- concurrent endpoint conflict and resolution;
- live-candidate parent deletion guards;
- local/backend replica loss, out-of-order sync, corrupt slot, candidate activate/
  discard, and crash at every commit step;
- one thousand sequential commits plus an offline old replica remain bounded and do
  not resurrect dominated full snapshots;
- 50-Machine/500-Project payload/performance gate.

### 15.2 Filesystem and platform

- temp-directory fault points at write/fsync/rename/CAS/state steps;
- real external writer races around automatic publication and manual fallback,
  multi-process lock, and process kill;
- first Enable process-kill before/after `current.conf` publication and before/after
  active-config displacement/publication; Disable process-kill before/after Include
  removal;
- unrelated-byte/EOL preservation;
- POSIX mode/owner/link/symlink/ACL behavior;
- real Windows `ssh.exe`, DACL, reparse point, custom/default config, CRLF, and paths
  with spaces;
- exact `remote.SSH.path`, Include, and `-G` capability matrix.

### 15.3 Migration/navigation

- direct/domain user, DNS, IPv4/IPv6, ports 22/1/65535/two custom ports;
- literal alias, static Include, wildcard defaults, custom config;
- startup resolves aliases and creates one preview without a Migrate action or any
  migration Quick Pick;
- IdentityFile/certificate/agent/host-checking/proxy directives never become Ready
  from endpoint parsing alone;
- automatic host/user/port projection without a Remote - SSH rehearsal;
- versioned nested Dev Container round-trip and unknown anchor failure;
- V1 Group→tag and full metadata round-trip;
- two-computer plus offline-client local-WSL claim/stage/failure/rollback behavior;
- remote WSL explicit SSH conversion, non-22 port, cross-computer open, and rejection
  when only a `wsl+` authority or inferred parent-Windows route is available;
- activation cleanup crash/retry, settings-default `null`, rollback restore, and
  downgrade-after-explicit-rollback matrix.

### 15.4 UI/accessibility

- transparent background materialization, latest-wins coalescing, bounded foreground
  readiness, and recovery without Project-tab setup controls;
- Add/Edit Machine global-impact copy and custom ports;
- Machine-context Add Project, Open-tab current-workspace Save, saved-workspace
  recognition, and rejection of Machine/Environment changes during Edit;
- Command Palette local SSH terminal/copy actions, endpoint-qualified picker, and a
  process-location matrix across Local/SSH/WSL/Dev Container windows;
- Dev Container Open/repair/remove and missing extension;
- action-specific projection failure without a persistent client banner;
- current native-list keyboard contract, Shift+F10 parity, stable-ID focus fallback,
  complete unavailable accessible names, live-region results;
- 260 px/wide layout, tag AND semantics, Favorites uniqueness, colors, Local/WSL.

Every milestone uses the worktree lock and finishes with compile, focused tests,
dashboard checks where relevant, behavior contracts, and `git diff --check`.

## 16. Delivery in one PR

All work stays on this branch. Each milestone receives a separate green commit for
review, bisect, and exact-SHA VSIX installation; only one final PR is opened after
all owner acceptance.

1. **M0 — Design acceptance:** approve these documents and three product decisions.
2. **M1 — Catalog, disabled:** envelope/replica/merge, migration planning, frozen-V1
   divergence guard, Dev Container codec spike, payload gate, no activation.
3. **M2 — Materializer, disabled:** automatic local projection, Bridge capability, generated config,
   POSIX fault/security tests, and an explicit Windows fail-closed gate.
4. **M3 — Management UI, disabled:** Machine/Project operations, automatic
   migration exception handling, conflict review, accessibility/browser tests.
5. **M4 — Owner installation:** complete and prove the Windows DACL/reparse-point
   adapter, build from an exact commit, install both VSIXs, migrate
   port-22/non-22/password/Dev Container fixtures, and test rollback.
6. **M5 — Owner real-data acceptance:** no legacy SSH deletion; verify a second
   computer and mixed-version warnings; final full verification.
7. **PR:** open one PR, wait for green checks, then request exact-head-SHA owner
   approval required by repository policy.

Stop for renewed scope approval if implementation needs arbitrary SSH directives,
credentials, `remote.SSH.configFile` mutation, legacy Host deletion, guessed Dev
Container parsing, or cannot meet payload/platform gates.

## 17. Rejected alternatives

- **URI-derived Machines plus alias map:** two editable connection sources; empty
  Machines and atomic endpoint edits remain awkward.
- **Sync raw SSH config:** may include local paths, credentials, proxies, shell
  commands, and platform-specific behavior; unsafe to merge.
- **Managed Host blocks mixed into user text:** ownership and deletion are ambiguous;
  one Include gives a narrow mutation boundary.
- **Change `remote.SSH.configFile`:** a global preference could hide the user's
  existing host inventory.
- **Workspace sends endpoint on open:** can be stale and comes from a remote process;
  UI Bridge rereads exact synced revision locally.
- **Live legacy fallback:** recreates two authorities. Legacy is bounded migration/
  rollback material only.
- **Legacy cleanup in this release:** high-risk, not required for core value, and
  contradicts reliable rollback.

## 18. External assumptions

The design relies on documented Remote - SSH behavior: OpenSSH config-backed hosts,
`remote.SSH.configFile`, `HostName`, `User`, `Port`, and password prompting without
saving the password. Reference: [VS Code Remote Development using
SSH](https://code.visualstudio.com/docs/remote/ssh).

The local-terminal boundary relies on the documented rule that UI extensions run on
the user's local machine and on the `window.createTerminal` API. It is still guarded
by the explicit process-location matrix rather than assumed from extension kind:
[Supporting Remote Development and GitHub Codespaces](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
and [VS Code API](https://code.visualstudio.com/api/references/vscode-api).

OpenSSH configuration evaluation and permissions are platform dependencies, not
reimplemented assumptions. Security-sensitive behavior must be verified against the
supported OpenSSH and Windows OpenSSH manuals during M2.
