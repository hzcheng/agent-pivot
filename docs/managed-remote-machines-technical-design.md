# Managed Remote Machines Technical Design

> Status: M1 catalog foundation implemented behind a disabled path; owner acceptance pending
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
                    │                 rollback/old-client view
             identity + revision intent
                    │
          UI Bridge on the local Extension Host
                    │
        ManagedSshConfigMaterializer + path lock
          ├─ isolated generated SSH config
          ├─ one consented Include in active config
          └─ Remote - SSH / vscode.openFolder
```

There is one business authority and one runtime projection:

- the managed envelope is edited and synchronized;
- generated SSH config is local, revisioned, accepts no reverse import, and can be
  deleted/rebuilt;
- the original V1 keys are frozen as rollback material; no managed-alias Project
  projection is emitted into them.

The UI Bridge never saves Machine or Project business data. It owns only local SSH
filesystem effects and local VS Code navigation. Existing user SSH blocks are
neither an Agent Pivot source nor modified by this release.

## 4. Lifecycle state machine

```text
disabled ── preview ── active
    ▲          │          │
    └──────────┴── rolledBack
```

- `disabled`: current URI-derived view and V1 authority.
- `preview`: candidate IDs and decisions are durable, but V1 remains authoritative.
- `active`: managed envelope is authoritative; original V1 keys are frozen.
- `rolledBack`: exact captured V1 snapshot is authoritative again.

Lifecycle and active revision are one envelope mutation. The existing
`remoteMachineProjects.enabled` setting controls only the pre-activation renderer;
it is never described as data rollback. In `active`, the legacy editor is not
reachable from the new version. Actual authority changes only through the migration
or rollback coordinator.

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
- generated aliases derive from Machine IDs, not names or endpoints.
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

## 6. Local consent and config discovery

UI Bridge stores a local `managedSshConsent.v1`, scoped to the canonical active SSH
config path, with `disabled | enabling | enabled | disabling | recoveryRequired`
state and a journal. Synchronization never sets it. The first preflight shows the
path, executable, Include, generated directory, generated-file backup, and
automatic-update behavior. Cancel performs no write.

`Disable on This Computer` previews and journal-removes only the exact owned marker/
Include plus generated directory; it does not change the catalog or legacy blocks.
It uses the same ownership, dependency-fingerprint, and atomic-write rules as enable.
Mismatch enters recovery with Open Config/Show Details, while crashes resume or
restore the prior enabled state. Successful disable causes every managed Open to
return `clientNotEnabled` until a new preflight completes.

Disable uses activation's inverse order: first remove and verify the Include (or ask
the user to remove it through the manual fallback), then delete Agent Pivot-owned
generated files. A crash after Include removal leaves inert files; it never leaves
an Include pointing at a removed file.

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

Generated records use an immutable reserved alias derived from the SHA-256 digest
of the Machine ID (the first 32 hexadecimal characters):

```sshconfig
Host agent-pivot-74c29df6f27da9e44a741ea31183243b
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

Every Enable, Reconcile, and Open statically checks the bounded active-config Include
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
6. on first enable only, return the exact marked Include through the local UI flow;
   `Copy Include` + `Open Config` waits for the user to save it;
7. re-read the active config and every dependency, reject a changed fingerprint,
   validate the actual aggregate read-only, and commit local state.

First enable publishes and verifies `current.conf` before asking the user to add the
Include; that manual edit plus read-only verification is its final activation
commit. A crash before that commit leaves only an unreferenced generated file.
Normal reconcile never rewrites the user-owned active config when its exact marker
is intact. Existing-Include reconcile validates before swapping `current.conf`, so
unvalidated bytes are never active. Cancel leaves the active config byte-identical.

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
  | { type: 'copyLocalSshCommand'; machineId: string; expectedRevisionId: string; requestId: string }
  | { type: 'inspectLegacySsh'; snapshotFingerprint: string; authorities: string[]; requestId: string };
```

Identity-only applies to open/reconcile. Migration sends no business mutation to UI
Bridge, but may send the frozen V1 fingerprint and authorities required for local
inspection. UI Bridge returns only local resolution facts and source checksums; the
main service constructs and commits catalog candidates.

For open/reconcile, UI Bridge rereads `managedRemoteCatalogData` locally and requires
the expected active revision. Mismatch returns `catalogOutOfDate`; the main service
reconciles and retries once. The caller never supplies host/user/port/full URI, so it
cannot forward stale endpoint values.

Reuse the existing main/UI Bridge challenge and issue a short-lived per-session
capability for correlation/replay rejection. VS Code Commands API does not provide a
strong caller identity: all installed extensions in the same Extension Host are in
the trusted computing base. The security boundary is therefore validation plus the
user's local consent, not a claim that a token defeats a malicious installed
extension. The threat model explicitly excludes a malicious extension already able
to read User settings and invoke VS Code commands.

Responses are discriminated unions with protocol version and request ID. Progress
is non-terminal. Missing/old Bridge capability disables navigation with `Update UI
Bridge`; there is no silent legacy fallback.

## 9. Navigation

### 9.1 Machine and Host Project

UI Bridge resolves an unconflicted Machine from the exact catalog revision,
reconciles its alias, and opens:

```text
vscode-remote://ssh-remote+<encoded-managed-alias>/
```

For a Host Project, it resolves Project → Host → Machine and appends the normalized
remote path. The path parser cannot replace the URI authority.

### 9.2 Dev Container

Resolve Project → versioned Dev Container anchor → Machine. A format-specific codec
rebuilds the authority with the verified managed alias and path. It preserves opaque
source bytes for diagnostics but never derives stable identity from those bytes.
Unknown versions or failed round-trip are `Needs repair`, never string-replaced.

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
Copy SSH Command…`. It reads the current managed view, offers an endpoint-qualified
Machine QuickPick, and sends only Machine ID plus expected revision to UI Bridge.

UI Bridge repeats the same catalog/conflict/consent/dependency checks as Machine
Open. For terminal launch it calls `vscode.window.createTerminal` from the local
`extensionKind: ["ui"]` host with:

```ts
{
  name: `SSH: ${machine.name}`,
  shellPath: resolvedRemoteSshExecutable,
  shellArgs: [stableManagedAlias],
}
```

It shows the terminal and leaves it interactive, so the SSH client owns password
prompts. It never builds or passes a shell command string. The copy command instead
writes a platform-quoted equivalent to the local clipboard and labels the target
shell; it contains only executable path and safe generated alias.

Although VS Code documents UI extensions as running locally, M2 must prove the
terminal process location in Local, SSH, WSL, and Dev Container windows with a local
marker executable. If any supported VS Code routes this terminal remotely, the
interactive command is blocked on that combination rather than accidentally running
`ssh` on the remote host; Copy remains available.

## 10. Mutation and failure ordering

- **Add/Edit:** validate and commit catalog, refresh UI, then request local reconcile.
  A local failure keeps synced data and raises the client banner; it never rolls
  back using a stale local snapshot.
- **Open:** fail closed until UI Bridge sees the expected unconflicted revision and
  a verified local projection.
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
port, and confirmed Linux path; creates an independent Machine candidate; and runs
the same generated-alias Remote - SSH rehearsal as other risky migrations. It never
derives this endpoint from `wsl+<distro>` or from the parent Windows Machine. The
Project enters the synchronized candidate only after rehearsal succeeds.

### 11.2 Safe alias inspection

For direct targets, parsing requires explicit `user@host` and port 22 unless a port
was already represented by known structured data. Support Windows domain users by
splitting on the final valid `@`; IPv6 uses a bracketed UI grammar and canonical
unbracketed HostName. Reject control characters, `%` expansion, `${...}`, ambiguous
quotes, and unsupported Unicode/IDN forms rather than guessing.

For config aliases:

1. statically read the active config and bounded Include graph without execution;
2. if a dynamic Include, `Match exec`, include cycle, unreadable source, wildcard
   ambiguity, or oversized graph is present, return Unsupported/Needs input and do
   not invoke SSH;
3. otherwise use the exact Remote - SSH executable as
   `ssh -F <active-config> -G <alias>` with argument arrays, no shell, bounded output,
   timeout, and whole-process-tree termination;
4. collect effective hostname/user/port and compare route/auth/host-checking facts;
5. never log raw output or source contents.

Endpoint resolution alone is not proof of connection equivalence. Alias-specific
`IdentityFile`, `IdentitiesOnly`, `CertificateFile`, `IdentityAgent`, `HostKeyAlias`,
`UserKnownHostsFile`, Proxy/Jump, canonicalization, or local-command behavior keeps a
record unresolved. The owner may explicitly use plain managed details only after a
generated-alias Remote - SSH rehearsal succeeds. Advanced routing stays unsupported.

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
  └─ consented managed config generated and verified
ACTIVE
  └─ active authority candidate committed in the envelope
COMPLETE
  └─ frozen V1 fingerprints recorded; no legacy-key or SSH deletion
```

Every phase is resumable and idempotent. Activation never writes a managed-alias
projection to `projectData` or `projectSyncData`; it records their frozen checksums
and detects later changes as legacy divergence.

## 12. Rollback, downgrade, and mixed versions

Managed activation freezes the original `projectSyncData` and `projectData`; it does
not emit managed aliases into either key. Rollback is a journaled cross-resource
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

Each legacy write uses expected fingerprints and is idempotent. A crash resumes from
the journal. An old-client write at any point is preserved as divergence and moves
the plan to Recovery required instead of being overwritten. Because current V1 code
prefers `projectSyncData`, it is restored and verified before the secondary
`projectData`; the V1 renderer remains unreachable until both are valid and the last
authority transition commits.

Generated Agent Pivot aliases and all original legacy SSH blocks remain untouched by
rollback. Migration-created WSL local copies follow the digest rule in section 11.1.

Old versions cannot be forced read-only. While active, compare both frozen V1
fingerprints. Store every changed branch as a versioned legacy-divergence candidate
and require `Import legacy edits` through a new migration candidate or `Keep managed
catalog`. Rollback waits for resolution. No old edit is silently discarded.

Compatibility gates use real packaged versions:

| Combination | Required behavior |
| --- | --- |
| new main + new Bridge | full managed behavior |
| new main + old Bridge | disabled local actions + Update Bridge |
| old main + new Bridge | existing V1 behavior; no managed command is invoked |
| N-1/N-2 reads frozen V1 | pre-migration view; opens only where original alias works |
| N-1/N-2 edits frozen V1 | new version detects and preserves divergence |
| downgrade then re-upgrade | no silent import, loss, or authority flip |
| second old client syncs during active | divergence/recovery state is deterministic |

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
  controller.ts

src/projects/managedRemoteProtocol.ts

extensions/attention-ui-bridge/src/managedRemote/
  catalogReader.ts
  consentStore.ts
  sshConfigMaterializer.ts
  sshEffectiveConfig.ts
  migrationInspector.ts
  navigation.ts
  localSshTerminal.ts
```

Existing renderers consume one shared view model. Current URI derivation stays
isolated behind the pre-activation/rollback adapter and is removed only after the
rollback window.

## 15. Verification strategy

### 15.1 Catalog and recovery

- schema/invariant rejection, including credential fields and ports;
- catalog and outer-envelope join laws and deterministic bytes, including concurrent
  rollback vs active edit and two legacy-divergence branches;
- concurrent endpoint conflict and resolution;
- live-candidate parent deletion guards;
- local/backend replica loss, out-of-order sync, corrupt slot, candidate activate/
  discard, and crash at every commit step;
- one thousand sequential commits plus an offline old replica remain bounded and do
  not resurrect dominated full snapshots;
- 50-Machine/500-Project payload/performance gate.

### 15.2 Filesystem and platform

- temp-directory fault points at write/fsync/rename/CAS/state steps;
- real external writer races around manual confirmation, multi-process lock, and
  process kill;
- first Enable process-kill before/after `current.conf` publication and before/after
  manual Include confirmation; Disable process-kill before/after Include removal;
- unrelated-byte/EOL preservation;
- POSIX mode/owner/link/symlink/ACL behavior;
- real Windows `ssh.exe`, DACL, reparse point, custom/default config, CRLF, and paths
  with spaces;
- exact `remote.SSH.path`, Include, and `-G` capability matrix.

### 15.3 Migration/navigation

- direct/domain user, DNS, IPv4/IPv6, ports 22/1/65535/two custom ports;
- literal alias, static Include, wildcard defaults, custom config;
- `Match exec` canary proves Preview does not execute it;
- IdentityFile/certificate/agent/host-checking/proxy directives never become Ready
  from endpoint parsing alone;
- real Remote - SSH rehearsal for migrated risky aliases;
- versioned nested Dev Container round-trip and unknown anchor failure;
- V1 Group→tag and full metadata round-trip;
- two-computer plus offline-client local-WSL claim/stage/failure/rollback behavior;
- remote WSL explicit SSH conversion, non-22 port, cross-computer open, and rejection
  when only a `wsl+` authority or inferred parent-Windows route is available;
- rollback plus N-1/N-2 read/write/downgrade/re-upgrade matrix.

### 15.4 UI/accessibility

- one-time client preflight, journaled Disable, recovery, and byte-identical Cancel;
- Add/Edit Machine global-impact copy and custom ports;
- Add Project current-environment/Managed split and rejection of Machine/Environment
  changes during Edit;
- Command Palette local SSH terminal/copy actions, endpoint-qualified picker, and a
  process-location matrix across Local/SSH/WSL/Dev Container windows;
- Dev Container Open/repair/remove and missing extension;
- persistent client banner not hidden by filters;
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
3. **M2 — Materializer, disabled:** consent, Bridge capability, generated config,
   POSIX fault/security tests, and an explicit Windows fail-closed gate.
4. **M3 — Management UI, disabled:** Machine/Project operations, conflict/migration
   review, accessibility/browser tests.
5. **M4 — Disposable rehearsal:** complete and prove the Windows DACL/reparse-point
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
