'use strict';

export const PROJECT_CATALOG_V2_SCHEMA_VERSION = 2;
export const PROJECT_CATALOG_V2_CANONICALIZATION_VERSION = 1;

export type ProjectCatalogV2EntityKind = 'machines' | 'environments' | 'projects';
export type ProjectCatalogV2FieldValue = string | number | boolean | null | string[];

export interface ProjectCatalogV2Dot {
    actorId: string;
    counter: number;
}

export interface ProjectCatalogV2CausalVersion {
    dot: ProjectCatalogV2Dot;
    context: Record<string, number>;
}

export interface ProjectCatalogV2FieldCandidate {
    value: ProjectCatalogV2FieldValue;
    version: ProjectCatalogV2CausalVersion;
}

export interface ProjectCatalogV2FieldRegister {
    candidates: ProjectCatalogV2FieldCandidate[];
}

export interface ProjectCatalogV2EntityRecord {
    fields: Record<string, ProjectCatalogV2FieldRegister>;
    tombstones: ProjectCatalogV2CausalVersion[];
}

export interface ProjectCatalogV2Document {
    schemaVersion: 2;
    canonicalizationVersion: 1;
    versionVector: Record<string, number>;
    machines: Record<string, ProjectCatalogV2EntityRecord>;
    environments: Record<string, ProjectCatalogV2EntityRecord>;
    projects: Record<string, ProjectCatalogV2EntityRecord>;
}

export interface ProjectCatalogV2Machine {
    id: string;
    name: string;
    color: string | null;
    order: number;
}

export interface ProjectCatalogV2Environment {
    id: string;
    machineId: string;
    kind: 'host' | 'devContainer' | 'legacyRemote';
    name: string;
    order: number;
    launchAnchor: string | null;
}

export interface ProjectCatalogV2Project {
    id: string;
    environmentId: string;
    name: string;
    description: string | null;
    normalizedPath: string;
    tags: string[];
    favorite: boolean;
    favoriteOrder: number | null;
    color: string | null;
    order: number;
}

export interface ProjectCatalogV2Conflict {
    entityKind: ProjectCatalogV2EntityKind;
    entityId: string;
    field: string | null;
    kind: 'field' | 'placement' | 'delete-update' | 'missing-parent';
}

export interface ProjectCatalogV2Materialized {
    machines: ProjectCatalogV2Machine[];
    environments: ProjectCatalogV2Environment[];
    projects: ProjectCatalogV2Project[];
    conflicts: ProjectCatalogV2Conflict[];
}

export interface ProjectCatalogV2RevisionSlot {
    revision: string;
    checksum: string;
    document: ProjectCatalogV2Document;
}

export interface ProjectCatalogV2Envelope {
    schemaVersion: 2;
    activeRevision: string | null;
    active: ProjectCatalogV2RevisionSlot | null;
    previous: ProjectCatalogV2RevisionSlot | null;
    candidate: ProjectCatalogV2RevisionSlot | null;
}
