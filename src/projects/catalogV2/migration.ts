'use strict';

import type { Group, Project } from '../../models';
import { normalizePosixPath, normalizeRemoteAuthority } from '../projectPathUtils';
import { applyProjectCatalogV2Patch, createEmptyProjectCatalogV2 } from './merge';
import { deterministicProjectCatalogV2Id, projectCatalogMigrationActorId } from './identity';
import { ProjectCatalogV2Document } from './types';

export interface LegacyRemoteMigrationTarget {
    machineFingerprint: string;
    environmentFingerprint: string;
    environmentKind: 'host' | 'devContainer' | 'legacyRemote';
    normalizedPath: string;
    localConnection: { kind: 'ssh'; target: string } | null;
    launchAnchor: string | null;
    needsAssignment: boolean;
    needsSetup: boolean;
}

export interface ProjectCatalogV2MigrationReport {
    schemaVersion: 1;
    sourceFingerprint: string;
    machineCount: number;
    environmentCount: number;
    projectCount: number;
    groupTagsAdded: number;
    needsAssignmentProjectIds: string[];
    needsSetupEnvironmentIds: string[];
    localBindings: Array<{ machineId: string; kind: 'ssh'; target: string }>;
}

export interface ProjectCatalogV2MigrationResult {
    document: ProjectCatalogV2Document;
    report: ProjectCatalogV2MigrationReport;
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
}

function canonicalInput(groups: Group[]): string {
    return JSON.stringify(stableValue(Array.isArray(groups) ? groups : []));
}

function splitRemoteProjectPath(projectPath: string): { authority: string; path: string } | null {
    if (typeof projectPath !== 'string' || !projectPath.startsWith('vscode-remote://')) return null;
    const rest = projectPath.slice('vscode-remote://'.length);
    const slash = rest.indexOf('/');
    const encodedAuthority = slash < 0 ? rest : rest.slice(0, slash);
    if (!encodedAuthority) return null;
    return {
        authority: normalizeRemoteAuthority(encodedAuthority),
        path: normalizePosixPath(slash < 0 ? '/' : rest.slice(slash)),
    };
}

export function parseLegacyRemoteMigrationTarget(projectPath: string): LegacyRemoteMigrationTarget {
    const remote = splitRemoteProjectPath(projectPath);
    if (!remote) {
        return {
            machineFingerprint: 'unassigned-local',
            environmentFingerprint: 'unassigned-local:host',
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
            environmentFingerprint: `ssh:${target}:host`,
            environmentKind: 'host',
            normalizedPath: remote.path,
            localConnection: target ? { kind: 'ssh', target } : null,
            launchAnchor: null,
            needsAssignment: false,
            needsSetup: !target,
        };
    }
    if (remote.authority.startsWith('dev-container+')) {
        const nested = remote.authority.slice('dev-container+'.length);
        const separator = nested.lastIndexOf('@ssh-remote+');
        if (separator > 0) {
            const anchor = nested.slice(0, separator);
            const target = nested.slice(separator + '@ssh-remote+'.length);
            return {
                machineFingerprint: `ssh:${target}`,
                environmentFingerprint: `ssh:${target}:dev-container:${anchor}`,
                environmentKind: 'devContainer',
                normalizedPath: remote.path,
                localConnection: target ? { kind: 'ssh', target } : null,
                launchAnchor: anchor || null,
                needsAssignment: false,
                needsSetup: !target || !anchor,
            };
        }
        return {
            machineFingerprint: `remote:${remote.authority}`,
            environmentFingerprint: `remote:${remote.authority}:dev-container`,
            environmentKind: 'devContainer',
            normalizedPath: remote.path,
            localConnection: null,
            launchAnchor: nested || null,
            needsAssignment: false,
            needsSetup: !nested,
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

export function normalizeMigratedProjectTags(raw: unknown, groupName: unknown): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const values = [...(Array.isArray(raw) ? raw : []), groupName];
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const tag = value.trim().replace(/^#+/, '').trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        result.push(tag.slice(0, 256));
        if (result.length >= 256) break;
    }
    return result;
}

function projectEntries(groups: Group[]): Array<{ group: Group; project: Project; groupIndex: number; projectIndex: number }> {
    const result: Array<{ group: Group; project: Project; groupIndex: number; projectIndex: number }> = [];
    (groups || []).forEach((group, groupIndex) => {
        (Array.isArray(group?.projects) ? group.projects : []).forEach((project, projectIndex) => {
            if (project && project.id && project.path) result.push({ group, project, groupIndex, projectIndex });
        });
    });
    return result;
}

export function migrateProjectCatalogV1ToV2(groups: Group[]): ProjectCatalogV2MigrationResult {
    const canonical = canonicalInput(groups);
    const actorId = projectCatalogMigrationActorId(canonical);
    let document = createEmptyProjectCatalogV2();
    const machines = new Map<string, string>();
    const environments = new Map<string, string>();
    const bindings = new Map<string, { machineId: string; kind: 'ssh'; target: string }>();
    const needsAssignmentProjectIds: string[] = [];
    const needsSetupEnvironmentIds = new Set<string>();
    let groupTagsAdded = 0;

    for (const entry of projectEntries(groups)) {
        const target = parseLegacyRemoteMigrationTarget(entry.project.path);
        let machineId = machines.get(target.machineFingerprint);
        if (!machineId) {
            machineId = deterministicProjectCatalogV2Id(`machine:${target.machineFingerprint}`);
            machines.set(target.machineFingerprint, machineId);
            document = applyProjectCatalogV2Patch(document, 'machines', machineId, {
                name: target.needsAssignment ? 'Needs Assignment' : `Machine ${machines.size}`,
                color: null,
                order: machines.size - 1,
            }, actorId);
        }
        let environmentId = environments.get(target.environmentFingerprint);
        if (!environmentId) {
            environmentId = deterministicProjectCatalogV2Id(`environment:${target.environmentFingerprint}`);
            environments.set(target.environmentFingerprint, environmentId);
            document = applyProjectCatalogV2Patch(document, 'environments', environmentId, {
                machineId,
                kind: target.environmentKind,
                name: target.environmentKind === 'host' ? 'Host' : target.environmentKind === 'devContainer' ? 'Dev Container' : 'Remote Environment',
                order: environments.size - 1,
                launchAnchor: target.launchAnchor,
            }, actorId);
        }
        if (target.localConnection) {
            bindings.set(machineId, { machineId, ...target.localConnection });
        }
        if (target.needsSetup) needsSetupEnvironmentIds.add(environmentId);
        const projectId = deterministicProjectCatalogV2Id(
            `project:${entry.group.id}:${entry.project.id}:${entry.project.path}`,
        );
        const tags = normalizeMigratedProjectTags(entry.project.tags, entry.group.groupName);
        if (typeof entry.group.groupName === 'string'
            && tags.some(tag => tag.toLowerCase() === entry.group.groupName.trim().replace(/^#+/, '').trim().toLowerCase())) {
            groupTagsAdded += 1;
        }
        document = applyProjectCatalogV2Patch(document, 'projects', projectId, {
            environmentId,
            name: entry.project.name || 'Unnamed Project',
            description: entry.project.description || null,
            normalizedPath: target.normalizedPath,
            tags,
            favorite: entry.project.favorite === true,
            favoriteOrder: Number.isSafeInteger(entry.project.favoriteOrder) && entry.project.favoriteOrder >= 0
                ? entry.project.favoriteOrder : null,
            color: entry.project.color || null,
            order: entry.projectIndex,
        }, actorId);
        if (target.needsAssignment) needsAssignmentProjectIds.push(projectId);
    }

    return {
        document,
        report: {
            schemaVersion: 1,
            sourceFingerprint: projectCatalogMigrationActorId(canonical),
            machineCount: machines.size,
            environmentCount: environments.size,
            projectCount: Object.keys(document.projects).length,
            groupTagsAdded,
            needsAssignmentProjectIds: needsAssignmentProjectIds.sort(),
            needsSetupEnvironmentIds: Array.from(needsSetupEnvironmentIds).sort(),
            localBindings: Array.from(bindings.values()).sort((left, right) => left.machineId.localeCompare(right.machineId)),
        },
    };
}
