# Managed Remote Machines Technical Design

> Status: implementation contract
>
> This design starts with a new managed catalog. It intentionally contains no
> legacy Project migration, rollback, compatibility reader, or alias-adoption path.

## Architecture and authority

```text
VS Code user setting: managedRemoteCatalogData
                    │
                    ▼
       Managed catalog coordinator
      (causal merge + writer replicas)
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
 Management controller   Dashboard projection
          │                   │
          └─────────┬─────────┘
                    ▼
            identity-only Bridge
                    │
                    ▼
      local generated SSH configuration
```

Remote Machine, Environment, Project, layout, tags, color, and Favorite data have
one business authority: `managedRemoteCatalogData`. Client-local Projects have a
separate local authority. Generated SSH files are disposable projections. Legacy
`projectData` and `projectSyncData` are outside this feature and are never read by
Managed Remote runtime code.

## Catalog model

`ManagedRemoteCatalogV1` contains causal registers for Machines, Environments, and
Projects plus one layout register. Machine connection data is limited to
`{kind:'ssh', host, user, port}`. Every Machine owns one deterministic Host
Environment; Dev Container Environments carry a validated versioned launch anchor.

The synchronized envelope contains only:

```ts
interface ManagedCatalogEnvelopeV1 {
  envelopeVersion: 1;
  causalContext: VersionVector;
  authority: VersionedCandidates<{
    lifecycle: 'disabled' | 'active';
    active?: ManagedRevisionSlot;
    previous?: ManagedRevisionSlot;
  }>;
  stagedRevisions: Record<string, VersionedCandidates<ManagedRevisionSlot | null>>;
}
```

`disabled` means there is no catalog revision yet. The first owner mutation stages
the new document and immediately activates it. `previous` exists only for bounded
crash/conflict recovery; it is not a product rollback feature.

## Persistence, concurrency, and recovery

Each extension window receives a durable writer ID and causal actor ID. A mutation
serializes the complete transaction:

1. reconcile settings and every valid local writer replica;
2. verify the caller's expected active revision;
3. apply one catalog service transaction;
4. stage the checksummed revision;
5. activate the staged revision as `active`;
6. reconcile and return the authoritative snapshot.

Concurrent updates from different writers are joined causally. Concurrent updates
to unrelated entities merge. Divergent values for one entity remain candidates and
surface as conflicts. A staged candidate and the active document are joined during
activation, preventing a stale stage from replacing a newer activated edit.

The configuration backend uses verify-after-write and bounded retries. Writer
replicas preserve the last committed and in-flight envelope so startup can repair a
missing settings value or expose explicit recovery candidates. Corrupt or ambiguous
authority never silently selects an endpoint.

## Management and Webview protocol

The management protocol accepts only identity/revision operations:

- add/edit/remove Machine;
- add/edit/remove Project;
- toggle Favorite;
- resolve a Machine endpoint conflict.

Requests contain a bounded request ID, operation, expected revision, and optional
target ID. Endpoint and Project fields are collected in the extension host, not
accepted from Webview messages. Every accepted request receives one terminal
settlement after the authoritative refresh.

There are no migration, activation, rollback, client-enable, or legacy-inspection
operations. Public legacy remote Project commands are not contributed.

## Dashboard projection

The Projects panel combines:

- `localProjects.v1` rendered as This Computer/local WSL/local container rows;
- the active managed catalog rendered as Managed Machine → Environment → Project.

Search receives both sources. A local result routes through `selected-project`; a
managed result routes through `managed-remote-client-action` with its catalog
revision and stable Project ID. Saved-state matching follows the same authority
split. A remote window that does not prove one exact managed identity is not
adopted.

Dev Container saving is one atomic catalog transaction: create the Environment
with its launch anchor and the Project referencing it, then stage/activate once.

## SSH projection

The local UI Bridge discovers the SSH executable and active Remote - SSH config
lazily per operation. This keeps bridge activation independent from Managed Remote
availability and observes configuration changes without a window reload.

The bridge writes an Agent Pivot-owned generated file and maintains one exact
marked Include. Projection work is coalesced by revision. Before navigation,
`ensureReady` requires either a successful reconcile or byte-for-byte equality with
the expected generated projection plus an exact Include. Alias presence alone is
never sufficient.

Filesystem mutation uses secure ownership/mode checks, checksums, atomic rename,
backup bytes, and a per-config lock. Stale-lock recovery records file identity and
rechecks it before claiming/removing the lock, so two windows cannot both discard a
new live owner.

The bridge protocol contains only status, reconcile, recovery, local SSH command,
and managed navigation operations. Requests never carry endpoint values. The UI
host rereads the active catalog and verifies the expected revision before effects.

## Navigation

Machine Open resolves the deterministic managed alias and opens a Remote - SSH
window. Host Project Open builds an SSH remote URI. Dev Container Open decodes its
launch anchor and nests it under the exact managed SSH alias.

URIs are constructed structurally. Remote path bytes are percent-encoded as path
data, so legal names containing `#`, `?`, or `%` cannot become fragments, queries,
or accidental escape sequences.

`SSH to Machine` and Copy SSH Command use the synchronized host/user/port directly
with an argument array; no shell interpolation or stored authentication material is
involved.

## Verification

Required automated coverage includes:

- first mutation activation and stale/concurrent mutation schedules;
- causal joins, corrupt replicas, staged recovery, and payload ceiling;
- exact managed Host/Dev Container save matching and special-character paths;
- management/Bridge protocol rejection and revision checks;
- projection byte equality, config safety, symlink rejection, lock recovery, and
  Windows/Linux path behavior;
- Dashboard search routing, filtering, disabled interaction, focus restoration,
  and source/generated Webview parity;
- extension-host command surface and release packaging.
