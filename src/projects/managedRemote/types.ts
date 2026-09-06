'use strict';

export type ManagedMachineId = string;
export type ManagedEnvironmentId = string;
export type ManagedProjectId = string;
export type VersionVector = Record<string, number>;

export interface CausalDot {
    actorId: string;
    counter: number;
}

/**
 * The context contains every dot observed before this candidate was written.
 * Keeping the dot separate prevents concurrent equal values from losing causal
 * information when documents are joined in a different order.
 */
export interface CausalVersion {
    dot: CausalDot;
    context: VersionVector;
}

export interface VersionedCandidate<T> {
    value: T;
    version: CausalVersion;
}

export interface VersionedCandidates<T> {
    candidates: VersionedCandidate<T>[];
}

export interface ManagedSshMachine {
    id: ManagedMachineId;
    name: string;
    /** SSH aliases through which an already-open workspace was adopted. */
    sourceSshAliases?: string[];
    connection: {
        kind: 'ssh';
        host: string;
        user: string;
        port: number;
    };
}

export interface DevContainerLaunchAnchorV1 {
    version: 1;
    originalAuthority: string;
    sourceKind: 'workspace' | 'config';
    sourceLocator: string;
}

export interface ManagedEnvironment {
    id: ManagedEnvironmentId;
    machineId: ManagedMachineId;
    kind: 'host' | 'devContainer';
    name: string;
    devContainerAnchor?: DevContainerLaunchAnchorV1;
}

export interface ManagedRemoteProject {
    id: ManagedProjectId;
    environmentId: ManagedEnvironmentId;
    name: string;
    description?: string;
    remotePath: string;
    tags?: string[];
    color?: string;
    favorite?: boolean;
}

export interface ManagedRemoteLayout {
    machineIds: ManagedMachineId[];
    environmentIdsByMachine: Record<ManagedMachineId, ManagedEnvironmentId[]>;
    projectIdsByEnvironment: Record<ManagedEnvironmentId, ManagedProjectId[]>;
    favoriteProjectIds: ManagedProjectId[];
}

export interface ManagedRemoteCatalogV1 {
    schemaVersion: 1;
    versionVector: VersionVector;
    machines: Record<ManagedMachineId, VersionedCandidates<ManagedSshMachine | null>>;
    environments: Record<ManagedEnvironmentId, VersionedCandidates<ManagedEnvironment | null>>;
    projects: Record<ManagedProjectId, VersionedCandidates<ManagedRemoteProject | null>>;
    layout: VersionedCandidates<ManagedRemoteLayout>;
}

export type ManagedAuthorityLifecycle = 'disabled' | 'active';

export interface ManagedRevisionSlot {
    revisionId: string;
    checksum: string;
    document: ManagedRemoteCatalogV1;
}

export interface ManagedAuthorityState {
    lifecycle: ManagedAuthorityLifecycle;
    active?: ManagedRevisionSlot;
    previous?: ManagedRevisionSlot;
}

export interface ManagedCatalogEnvelopeV1 {
    envelopeVersion: 1;
    causalContext: VersionVector;
    authority: VersionedCandidates<ManagedAuthorityState>;
    stagedRevisions: Record<string, VersionedCandidates<ManagedRevisionSlot | null>>;
}

export type ManagedCatalogConflictKind =
    | 'update-update'
    | 'delete-update'
    | 'duplicate-machine-name'
    | 'missing-parent'
    | 'missing-host'
    | 'duplicate-host';

export interface ManagedCatalogConflict {
    kind: ManagedCatalogConflictKind;
    entityType: 'machine' | 'environment' | 'project';
    entityId: string;
    relatedEntityIds?: string[];
}

export interface MaterializedManagedRemoteCatalog {
    machines: ManagedSshMachine[];
    environments: ManagedEnvironment[];
    projects: ManagedRemoteProject[];
    layout: ManagedRemoteLayout;
    conflicts: ManagedCatalogConflict[];
}

export interface ManagedCatalogWriterReplicaV1 {
    actorId: string;
    nextCounter: number;
    envelope: ManagedCatalogEnvelopeV1;
    stagedCandidate?: ManagedCatalogEnvelopeV1;
}

export interface ManagedCatalogReplicaV1 {
    schemaVersion: 1;
    writers: Record<string, ManagedCatalogWriterReplicaV1>;
}
