'use strict';

import type { Group, Project } from '../../models';
import { normalizePosixPath, normalizeRemoteAuthority } from '../projectPathUtils';
import { createEmptyProjectCatalogV2, parseProjectCatalogV2Document } from './merge';
import { deterministicProjectCatalogV2Id, projectCatalogMigrationActorId } from './identity';
import {
    ProjectCatalogV2Document,
    ProjectCatalogV2EntityKind,
    ProjectCatalogV2FieldValue,
    ProjectCatalogV2LaunchAnchor,
} from './types';

export interface LegacyRemoteMigrationTarget {
    machineFingerprint: string;
    environmentFingerprint: string;
    environmentKind: 'host' | 'devContainer' | 'legacyRemote';
    normalizedPath: string;
    localConnection: {
        kind: 'ssh' | 'wsl';
        target: string;
        resolverAuthority: string;
    } | null;
    launchAnchor: ProjectCatalogV2LaunchAnchor | null;
    needsAssignment: boolean;
    needsSetup: boolean;
}

export interface ProjectCatalogV2MigrationReport {
    schemaVersion: 1;
    sourceFingerprint: string;
    machineCount: number;
    environmentCount: number;
    projectCount: number;
    uniqueGroupTagCount: number;
    groupTagAssociationsAdded: number;
    needsAssignmentProjectIds: string[];
    needsSetupEnvironmentIds: string[];
}

export interface ProjectCatalogV2MigrationResult {
    document: ProjectCatalogV2Document;
    report: ProjectCatalogV2MigrationReport;
    localBindingProposals: Array<{
        machineId: string;
        kind: 'ssh' | 'wsl';
        target: string;
        resolverAuthority: string;
    }>;
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) { return value.map(stableValue); }
    if (!value || typeof value !== 'object') { return value; }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
}

function canonicalInput(groups: Group[]): string {
    return JSON.stringify(stableValue(projectEntries(groups).map(entry => ({
        groupId: entry.group.id,
        groupName: entry.group.groupName,
        groupIndex: entry.groupIndex,
        projectIndex: entry.projectIndex,
        project: {
            id: entry.project.id,
            name: entry.project.name,
            description: entry.project.description,
            path: entry.project.path,
            tags: entry.project.tags,
            favorite: entry.project.favorite,
            favoriteOrder: entry.project.favoriteOrder,
            color: entry.project.color,
            remoteType: entry.project.remoteType,
        },
    }))));
}

function splitRemoteProjectPath(projectPath: string): { authority: string; path: string } | null {
    if (typeof projectPath !== 'string' || !projectPath.startsWith('vscode-remote://')) { return null; }
    const rest = projectPath.slice('vscode-remote://'.length);
    const slash = rest.indexOf('/');
    const encodedAuthority = slash < 0 ? rest : rest.slice(0, slash);
    if (!encodedAuthority) { return null; }
    return {
        authority: normalizeRemoteAuthority(encodedAuthority),
        path: normalizePosixPath(slash < 0 ? '/' : rest.slice(slash)),
    };
}

function projectScopedEnvironmentFingerprint(legacyProjectId: string): string {
    if (typeof legacyProjectId !== 'string' || !legacyProjectId) {
        throw new Error('project catalog V2 migration project scope is required');
    }
    return deterministicProjectCatalogV2Id(`legacy-environment:${legacyProjectId}`);
}

function hostEnvironmentFingerprint(machineFingerprint: string): string {
    return `${machineFingerprint}:host`;
}

export function parseLegacyRemoteMigrationTarget(
    projectPath: string,
    legacyProjectId: string,
): LegacyRemoteMigrationTarget {
    const projectScope = projectScopedEnvironmentFingerprint(legacyProjectId);
    const remote = splitRemoteProjectPath(projectPath);
    if (!remote) {
        return {
            machineFingerprint: 'unassigned-local',
            environmentFingerprint: hostEnvironmentFingerprint('unassigned-local'),
            environmentKind: 'host',
            normalizedPath: projectPath || '/',
            localConnection: null,
            launchAnchor: null,
            needsAssignment: true,
            needsSetup: false,
        };
    }
    if (remote.authority.startsWith('ssh-remote+')) {
        const target = remote.authority.slice('ssh-remote+'.length);
        return {
            machineFingerprint: `ssh:${target}`,
            environmentFingerprint: hostEnvironmentFingerprint(`ssh:${target}`),
            environmentKind: 'host',
            normalizedPath: remote.path,
            localConnection: target ? { kind: 'ssh', target, resolverAuthority: `ssh-remote+${target}` } : null,
            launchAnchor: null,
            needsAssignment: false,
            needsSetup: !target,
        };
    }
    if (remote.authority.startsWith('dev-container+')) {
        const nested = remote.authority.slice('dev-container+'.length);
        const separator = nested.lastIndexOf('@ssh-remote+');
        if (separator > 0) {
            const rawAnchor = nested.slice(0, separator);
            const target = nested.slice(separator + '@ssh-remote+'.length);
            const anchor = parseDevContainerLaunchAnchor(rawAnchor);
            return {
                machineFingerprint: `ssh:${target}`,
                environmentFingerprint: anchor
                    ? `ssh:${target}:dev-container:${JSON.stringify(anchor)}`
                    : `ssh:${target}:legacy-dev-container:${projectScope}`,
                environmentKind: anchor ? 'devContainer' : 'legacyRemote',
                normalizedPath: remote.path,
                localConnection: target ? { kind: 'ssh', target, resolverAuthority: `ssh-remote+${target}` } : null,
                launchAnchor: anchor,
                needsAssignment: false,
                needsSetup: !target || !anchor,
            };
        }
        return {
            machineFingerprint: 'unassigned-dev-container',
            environmentFingerprint: `unassigned-dev-container:legacy:${projectScope}`,
            environmentKind: 'legacyRemote',
            normalizedPath: remote.path,
            localConnection: null,
            launchAnchor: null,
            needsAssignment: true,
            needsSetup: true,
        };
    }
    if (remote.authority.startsWith('wsl+')) {
        const distribution = remote.authority.slice('wsl+'.length);
        return {
            machineFingerprint: distribution ? `wsl:${distribution}` : 'unassigned-wsl',
            environmentFingerprint: hostEnvironmentFingerprint(
                distribution ? `wsl:${distribution}` : 'unassigned-wsl',
            ),
            environmentKind: 'host',
            normalizedPath: remote.path,
            localConnection: distribution ? {
                kind: 'wsl', target: distribution, resolverAuthority: `wsl+${distribution}`,
            } : null,
            launchAnchor: null,
            needsAssignment: !distribution,
            needsSetup: !distribution,
        };
    }
    if (remote.authority.startsWith('attached-container+')) {
        return {
            machineFingerprint: 'unassigned-attached-container',
            environmentFingerprint: `unassigned-attached-container:legacy:${projectScope}`,
            environmentKind: 'legacyRemote',
            normalizedPath: remote.path,
            localConnection: null,
            launchAnchor: null,
            needsAssignment: true,
            needsSetup: true,
        };
    }
    return {
        machineFingerprint: `remote:${remote.authority}`,
        environmentFingerprint: `remote:${remote.authority}:legacy`,
        environmentKind: 'legacyRemote',
        normalizedPath: remote.path,
        localConnection: null,
        launchAnchor: null,
        needsAssignment: false,
        needsSetup: true,
    };
}

function parseDevContainerLaunchAnchor(raw: string): ProjectCatalogV2LaunchAnchor | null {
    if (!raw || raw.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(raw)) { return null; }
    try {
        const decoded = Buffer.from(raw, 'hex').toString('utf8');
        if (Buffer.from(decoded, 'utf8').toString('hex').toLowerCase() !== raw.toLowerCase()) { return null; }
        const value = JSON.parse(decoded) as Record<string, unknown>;
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || typeof value.hostPath !== 'string' || !value.hostPath
            || !value.configFile || typeof value.configFile !== 'object' || Array.isArray(value.configFile)
            || typeof (value.configFile as Record<string, unknown>).path !== 'string'
            || !(value.configFile as Record<string, unknown>).path) {
            return null;
        }
        return {
            hostPath: value.hostPath,
            configPath: (value.configFile as Record<string, unknown>).path as string,
            sourceProjectId: null,
        };
    } catch (_error) {
        return null;
    }
}

export function normalizeMigratedProjectTags(raw: unknown, groupName: unknown): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    if (raw !== undefined && !Array.isArray(raw)) {
        throw new Error('project catalog V2 migration cannot preserve a non-array tag field');
    }
    const values = [...(Array.isArray(raw) ? raw : []), groupName];
    for (const value of values) {
        if (value === undefined || value === null) { continue; }
        if (typeof value !== 'string') {
            throw new Error('project catalog V2 migration cannot preserve a non-string tag');
        }
        const tag = value.trim().replace(/^#+/, '').trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) { continue; }
        seen.add(key);
        result.push(tag);
    }
    return result;
}

function projectEntries(groups: Group[]): Array<{
    group: Group;
    project: Project;
    groupIndex: number;
    projectIndex: number;
    migrationOrder: number;
}> {
    const result: Array<{
        group: Group;
        project: Project;
        groupIndex: number;
        projectIndex: number;
        migrationOrder: number;
    }> = [];
    (groups || []).forEach((group, groupIndex) => {
        (Array.isArray(group?.projects) ? group.projects : []).forEach((project, projectIndex) => {
            if (!project || typeof project.id !== 'string' || !project.id
                || typeof project.path !== 'string' || !project.path) {
                throw new Error(`project catalog V2 migration cannot preserve project at ${groupIndex}:${projectIndex}`);
            }
            result.push({ group, project, groupIndex, projectIndex, migrationOrder: result.length });
        });
    });
    return result;
}

function migrationPosition(index: number, id: string): string {
    return `migration:${index.toString(36).padStart(8, '0')}:${id}`;
}

function legacyRemoteType(value: unknown): string | null {
    if (typeof value === 'string' && value.length > 0) { return value; }
    if (typeof value === 'number' && Number.isInteger(value)) {
        return ['none', 'ssh', 'wsl', 'devContainer', 'remote'][value] || null;
    }
    return null;
}

function addMigrationRecord(
    document: ProjectCatalogV2Document,
    kind: ProjectCatalogV2EntityKind,
    id: string,
    values: Record<string, ProjectCatalogV2FieldValue>,
    actorId: string,
    counter: number,
): void {
    const version = {
        dot: { actorId, counter },
        context: counter > 1 ? { [actorId]: counter - 1 } : {},
    };
    const fields: Record<string, {
        candidates: Array<{ value: ProjectCatalogV2FieldValue; version: typeof version }>;
        baselines: Array<{ value: ProjectCatalogV2FieldValue; version: typeof version }>;
    }> = {};
    for (const field of Object.keys(values).sort()) {
        fields[field] = { candidates: [{ value: values[field], version }], baselines: [] };
    }
    document[kind][id] = { fields, tombstones: [] };
    document.versionVector[actorId] = counter;
}

export function migrateProjectCatalogV1ToV2(groups: Group[]): ProjectCatalogV2MigrationResult {
    const canonical = canonicalInput(groups);
    const actorId = projectCatalogMigrationActorId(canonical);
    const document = createEmptyProjectCatalogV2();
    const machines = new Map<string, string>();
    const environments = new Map<string, string>();
    const bindings = new Map<string, {
        machineId: string;
        kind: 'ssh' | 'wsl';
        target: string;
        resolverAuthority: string;
    }>();
    const needsAssignmentProjectIds: string[] = [];
    const needsSetupEnvironmentIds = new Set<string>();
    const migratedProjectIds = new Set<string>();
    let groupTagsAdded = 0;
    const uniqueGroupTags = new Set<string>();
    let mutationCounter = 0;

    const entries = projectEntries(groups).map(entry => ({
        ...entry,
        target: parseLegacyRemoteMigrationTarget(entry.project.path, entry.project.id),
    }));
    const environmentOrder = new Map<string, number>();
    const environmentsByMachine = new Map<
        string,
        Map<string, LegacyRemoteMigrationTarget['environmentKind']>
    >();
    for (const entry of entries) {
        const values = environmentsByMachine.get(entry.target.machineFingerprint) || new Map();
        const hostFingerprint = hostEnvironmentFingerprint(entry.target.machineFingerprint);
        if (!values.has(hostFingerprint)) { values.set(hostFingerprint, 'host'); }
        if (!values.has(entry.target.environmentFingerprint)) {
            values.set(entry.target.environmentFingerprint, entry.target.environmentKind);
        }
        environmentsByMachine.set(entry.target.machineFingerprint, values);
    }
    const kindRank = { host: 0, devContainer: 1, legacyRemote: 2 } as const;
    for (const environmentsForMachine of environmentsByMachine.values()) {
        Array.from(environmentsForMachine.entries())
            .sort((left, right) => kindRank[left[1]] - kindRank[right[1]])
            .forEach(([fingerprint], index) => environmentOrder.set(fingerprint, index));
    }

    for (const entry of entries) {
        const target = entry.target;
        let machineId = machines.get(target.machineFingerprint);
        if (!machineId) {
            machineId = deterministicProjectCatalogV2Id(`machine:${target.machineFingerprint}`);
            machines.set(target.machineFingerprint, machineId);
            addMigrationRecord(document, 'machines', machineId, {
                displayName: target.needsAssignment ? 'Needs Assignment' : `Machine ${machines.size}`,
                color: null,
                position: migrationPosition(machines.size - 1, machineId),
                source: 'migration',
            }, actorId, ++mutationCounter);
            const hostFingerprint = hostEnvironmentFingerprint(target.machineFingerprint);
            const hostEnvironmentId = deterministicProjectCatalogV2Id(`environment:${hostFingerprint}`);
            environments.set(hostFingerprint, hostEnvironmentId);
            addMigrationRecord(document, 'environments', hostEnvironmentId, {
                machineId,
                kind: 'host',
                displayName: 'Host',
                position: migrationPosition(0, hostEnvironmentId),
                launchAnchor: null,
            }, actorId, ++mutationCounter);
        }
        let environmentId = environments.get(target.environmentFingerprint);
        if (!environmentId) {
            environmentId = deterministicProjectCatalogV2Id(`environment:${target.environmentFingerprint}`);
            environments.set(target.environmentFingerprint, environmentId);
            addMigrationRecord(document, 'environments', environmentId, {
                machineId,
                kind: target.environmentKind,
                displayName: target.environmentKind === 'host' ? 'Host' : target.environmentKind === 'devContainer' ? 'Dev Container' : 'Remote Environment',
                position: migrationPosition(environmentOrder.get(target.environmentFingerprint) || 0, environmentId),
                launchAnchor: target.launchAnchor,
            }, actorId, ++mutationCounter);
        }
        if (target.localConnection) {
            bindings.set(machineId, { machineId, ...target.localConnection });
        }
        if (target.needsSetup) { needsSetupEnvironmentIds.add(environmentId); }
        const projectId = deterministicProjectCatalogV2Id(`project:${entry.project.id}`);
        if (migratedProjectIds.has(projectId)) {
            throw new Error(`project catalog V2 migration found duplicate legacy project id: ${entry.project.id}`);
        }
        migratedProjectIds.add(projectId);
        const existingTagKeys = new Set(
            (Array.isArray(entry.project.tags) ? entry.project.tags : [])
                .filter(tag => typeof tag === 'string')
                .map(tag => tag.trim().replace(/^#+/, '').trim().toLowerCase())
                .filter(Boolean),
        );
        const tags = normalizeMigratedProjectTags(entry.project.tags, entry.group.groupName);
        const groupTagKey = typeof entry.group.groupName === 'string'
            ? entry.group.groupName.trim().replace(/^#+/, '').trim().toLowerCase()
            : '';
        if (groupTagKey && !existingTagKeys.has(groupTagKey)
            && tags.some(tag => tag.toLowerCase() === groupTagKey)) {
            groupTagsAdded += 1;
        }
        if (groupTagKey) { uniqueGroupTags.add(groupTagKey); }
        const favoriteOrder = Number.isSafeInteger(entry.project.favoriteOrder) && entry.project.favoriteOrder >= 0
            ? entry.project.favoriteOrder : null;
        addMigrationRecord(document, 'projects', projectId, {
            environmentId,
            name: entry.project.name || 'Unnamed Project',
            description: entry.project.description || null,
            path: target.normalizedPath,
            position: migrationPosition(entry.migrationOrder, projectId),
            tags,
            favorite: entry.project.favorite === true,
            favoritePosition: favoriteOrder === null ? null : migrationPosition(favoriteOrder, projectId),
            color: entry.project.color || null,
            remoteType: legacyRemoteType(entry.project.remoteType),
            legacyPlacement: {
                groupId: typeof entry.group.id === 'string' ? entry.group.id : null,
                groupName: typeof entry.group.groupName === 'string' ? entry.group.groupName : null,
                groupOrder: entry.groupIndex,
                projectOrder: entry.projectIndex,
                favoriteOrder,
            },
        }, actorId, ++mutationCounter);
        if (target.needsAssignment) { needsAssignmentProjectIds.push(projectId); }
    }

    const parsedDocument = parseProjectCatalogV2Document(document);
    if (!parsedDocument) { throw new Error('project catalog V2 migration output is invalid'); }
    return {
        document: parsedDocument,
        report: {
            schemaVersion: 1,
            sourceFingerprint: projectCatalogMigrationActorId(canonical),
            machineCount: machines.size,
            environmentCount: environments.size,
            projectCount: Object.keys(parsedDocument.projects).length,
            uniqueGroupTagCount: uniqueGroupTags.size,
            groupTagAssociationsAdded: groupTagsAdded,
            needsAssignmentProjectIds: needsAssignmentProjectIds.sort(),
            needsSetupEnvironmentIds: Array.from(needsSetupEnvironmentIds).sort(),
        },
        localBindingProposals: Array.from(bindings.values()).sort((left, right) => left.machineId.localeCompare(right.machineId)),
    };
}
