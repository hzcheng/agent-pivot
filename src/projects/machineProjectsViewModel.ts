'use strict';

import { createHash } from 'crypto';
import * as path from 'path';

import type { Group, Project } from '../models';
import { ProjectRemoteType, getRemoteType } from '../models';
import { getFavoriteProjectsInOrder } from './favoriteProjectOrder';
import { encodeRemoteAuthority, normalizeRemoteAuthority } from './projectPathUtils';

export type MachineEnvironmentKind = 'host' | 'devContainer';

export interface MachineProjectRowViewModel {
    id: string;
    environmentId: string;
    machineId: string;
    machineName: string;
    environmentName: string;
    name: string;
    description: string | null;
    path: string;
    tags: string[];
    favorite: boolean;
    color: string | null;
    searchText: string;
}

export interface MachineEnvironmentViewModel {
    id: string;
    machineId: string;
    kind: MachineEnvironmentKind;
    displayName: string;
    projects: MachineProjectRowViewModel[];
}

export interface MachineRowViewModel {
    id: string;
    defaultName: string;
    displayName: string;
    renamed: boolean;
    hostOpenable: boolean;
    /** A current V1 Project identity used only to revalidate the derived Host target. */
    hostProjectId: string | null;
    environments: MachineEnvironmentViewModel[];
}

export interface MachineProjectsViewModel {
    projectCount: number;
    tags: string[];
    favorites: MachineProjectRowViewModel[];
    machines: MachineRowViewModel[];
}

export interface LocalMachineTarget {
    kind: 'local';
    name: string;
}

export interface RemoteMachineHostTarget {
    kind: 'remote';
    name: string;
    path: string;
    remoteType: ProjectRemoteType;
}

export type MachineHostTarget = LocalMachineTarget | RemoteMachineHostTarget;

interface ProjectTopology {
    machineKey: string;
    machineName: string;
    environmentKey: string;
    environmentName: string;
    environmentKind: MachineEnvironmentKind;
    hostAuthority: string | null;
    hostRemoteType: ProjectRemoteType;
}

interface MachineBuilder extends MachineRowViewModel {
    key: string;
    hostAuthority: string | null;
    hostRemoteType: ProjectRemoteType;
    environmentByKey: Map<string, MachineEnvironmentViewModel>;
}

const REMOTE_URI_PREFIX = 'vscode-remote://';
export const MACHINE_DISPLAY_NAME_MAX_LENGTH = 80;
const LOCAL_MACHINE_SCOPE_PATTERN = /^local-machine-[a-f0-9]{16}$/;

export function createLocalMachineScopeId(machineId: unknown): string | null {
    if (typeof machineId !== 'string' || !machineId.trim()) { return null; }
    return stableViewId('local-machine', machineId.trim());
}

export function normalizeLocalMachineScope(value: unknown): string | null {
    return typeof value === 'string' && LOCAL_MACHINE_SCOPE_PATTERN.test(value)
        ? value
        : null;
}

export function isLocalMachineProjectPath(projectPath: string): boolean {
    return deriveProjectTopology(projectPath).machineKey === 'local';
}

export function isProjectVisibleOnLocalMachine(
    project: Project,
    localMachineScope: string | null = null,
): boolean {
    if (!isLocalMachineProjectPath(project.path) || !localMachineScope) {
        return true;
    }
    const projectScope = normalizeLocalMachineScope(project.localMachineScope);
    return !projectScope || projectScope === localMachineScope;
}

export function filterGroupsForLocalMachine(
    groups: readonly Group[],
    localMachineScope: string | null,
): Group[] {
    return (groups || []).map(group => ({
        ...group,
        projects: (group?.projects || []).filter(project =>
            isProjectVisibleOnLocalMachine(project, localMachineScope)),
    } as Group));
}

export function normalizeMachineDisplayName(value: unknown): string | null {
    if (typeof value !== 'string') { return null; }
    const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ').trim();
    return normalized && normalized.length <= MACHINE_DISPLAY_NAME_MAX_LENGTH
        ? normalized
        : null;
}

/**
 * Return a catalog snapshot with the presentation alias applied to every
 * Project on one derived Machine. Keeping the value on the existing Project
 * records lets the current conflict-aware Project sync remain the sole writer.
 */
export function withMachineDisplayName(
    groups: readonly Group[],
    machineId: string,
    displayName: string | null,
    localMachineScope: string | null = null,
): Group[] | null {
    const normalized = displayName === null ? null : normalizeMachineDisplayName(displayName);
    if (typeof machineId !== 'string' || !machineId
        || (displayName !== null && !normalized)) {
        return null;
    }
    let matched = false;
    const updated = (groups || []).map(group => {
        let changed = false;
        const projects = (group?.projects || []).map(project => {
            const topology = deriveProjectTopology(project.path);
            if (!isProjectVisibleOnLocalMachine(project, localMachineScope)
                || getMachineViewId(project.path) !== machineId) {
                return project;
            }
            matched = true;
            const next = { ...project };
            if (normalized && normalized !== topology.machineName) {
                next.machineDisplayName = normalized;
            } else {
                delete next.machineDisplayName;
            }
            changed = true;
            return next;
        });
        return changed ? { ...group, projects } as Group : group as Group;
    });
    return matched ? updated : null;
}

export function getMachineViewId(projectPath: string): string {
    return stableViewId('machine', deriveProjectTopology(projectPath).machineKey);
}

export function getMachineDisplayNameForPath(
    groups: readonly Group[],
    projectPath: string,
    localMachineScope: string | null = null,
): string | null {
    const machineKey = deriveProjectTopology(projectPath).machineKey;
    return resolveMachineDisplayNames(groups, localMachineScope).get(machineKey) || null;
}

/**
 * Build a presentation-only Machine hierarchy from the existing, synced V1
 * Project records. No second catalog, migration, or client-local connection
 * profile participates in this projection. The Project path is copied exactly
 * so Project activation can continue through the existing opener.
 */
export function buildMachineProjectsViewModel(
    groups: readonly Group[],
    localMachineScope: string | null = null,
): MachineProjectsViewModel {
    const machines = new Map<string, MachineBuilder>();
    const rowByProject = new Map<Project, MachineProjectRowViewModel>();
    const allProjects: Project[] = [];
    const tagsByKey = new Map<string, string>();
    const displayNames = resolveMachineDisplayNames(groups, localMachineScope);

    for (const group of groups || []) {
        for (const project of group?.projects || []) {
            if (!isProjectVisibleOnLocalMachine(project, localMachineScope)) {
                continue;
            }
            const topology = deriveProjectTopology(project.path);
            let machine = machines.get(topology.machineKey);
            if (!machine) {
                const machineId = stableViewId('machine', topology.machineKey);
                const hostEnvironment: MachineEnvironmentViewModel = {
                    id: stableViewId('environment', `${topology.machineKey}:host`),
                    machineId,
                    kind: 'host',
                    displayName: 'Host',
                    projects: [],
                };
                machine = {
                    key: topology.machineKey,
                    id: machineId,
                    defaultName: topology.machineName,
                    displayName: displayNames.get(topology.machineKey) || topology.machineName,
                    renamed: displayNames.has(topology.machineKey),
                    hostOpenable: true,
                    hostProjectId: null,
                    hostAuthority: topology.hostAuthority,
                    hostRemoteType: topology.hostRemoteType,
                    environments: [hostEnvironment],
                    environmentByKey: new Map([['host', hostEnvironment]]),
                };
                machines.set(topology.machineKey, machine);
            }

            if (!machine.hostAuthority && topology.hostAuthority) {
                machine.hostAuthority = topology.hostAuthority;
                machine.hostRemoteType = topology.hostRemoteType;
                machine.hostOpenable = true;
            }
            if (!machine.hostProjectId || topology.environmentKind === 'host') {
                machine.hostProjectId = project.id;
            }

            const environmentKey = topology.environmentKind === 'host'
                ? 'host'
                : topology.environmentKey;
            let environment = machine.environmentByKey.get(environmentKey);
            if (!environment) {
                environment = {
                    id: stableViewId(
                        'environment',
                        `${topology.machineKey}:${environmentKey}`,
                    ),
                    machineId: machine.id,
                    kind: topology.environmentKind,
                    displayName: topology.environmentName,
                    projects: [],
                };
                machine.environmentByKey.set(environmentKey, environment);
                machine.environments.push(environment);
            }

            const tags = normalizeViewTags([
                ...(Array.isArray(project.tags) ? project.tags : []),
                group?.groupName,
            ]);
            for (const tag of tags) {
                const key = tag.toLocaleLowerCase();
                if (!tagsByKey.has(key)) { tagsByKey.set(key, tag); }
            }
            const row: MachineProjectRowViewModel = {
                id: project.id,
                environmentId: environment.id,
                machineId: machine.id,
                machineName: machine.displayName,
                environmentName: environment.displayName,
                name: project.name || 'Unnamed Project',
                description: project.description || null,
                path: project.path || '',
                tags,
                favorite: project.favorite === true,
                color: project.color || null,
                searchText: [
                    project.name || '',
                    project.description || '',
                    project.path || '',
                    tags.join(' '),
                    machine.displayName,
                    environment.displayName,
                ].join(' ').toLocaleLowerCase(),
            };
            environment.projects.push(row);
            rowByProject.set(project, row);
            allProjects.push(project);
        }
    }

    const machineRows = Array.from(machines.values()).map(machine => ({
        id: machine.id,
        defaultName: machine.defaultName,
        displayName: machine.displayName,
        renamed: machine.renamed,
        hostOpenable: machine.hostOpenable,
        hostProjectId: machine.hostProjectId,
        environments: machine.environments,
    }));
    return {
        projectCount: allProjects.length,
        tags: Array.from(tagsByKey.values()).sort((left, right) =>
            left.localeCompare(right, undefined, { sensitivity: 'base' })),
        favorites: getFavoriteProjectsInOrder(allProjects)
            .map(project => rowByProject.get(project))
            .filter((row): row is MachineProjectRowViewModel => Boolean(row)),
        machines: machineRows,
    };
}

function resolveMachineDisplayNames(
    groups: readonly Group[],
    localMachineScope: string | null,
): Map<string, string> {
    const votesByMachine = new Map<string, Map<string, number>>();
    for (const group of groups || []) {
        for (const project of group?.projects || []) {
            if (!isProjectVisibleOnLocalMachine(project, localMachineScope)) {
                continue;
            }
            const displayName = normalizeMachineDisplayName(project.machineDisplayName);
            if (!displayName) { continue; }
            const topology = deriveProjectTopology(project.path);
            if (displayName === topology.machineName) { continue; }
            const machineKey = topology.machineKey;
            let votes = votesByMachine.get(machineKey);
            if (!votes) {
                votes = new Map<string, number>();
                votesByMachine.set(machineKey, votes);
            }
            votes.set(displayName, (votes.get(displayName) || 0) + 1);
        }
    }
    const result = new Map<string, string>();
    votesByMachine.forEach((votes, machineKey) => {
        const winner = Array.from(votes).sort((left, right) =>
            right[1] - left[1]
            || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))[0];
        if (winner) { result.set(machineKey, winner[0]); }
    });
    return result;
}

/** Re-resolve the Host target from authoritative V1 Projects at click time. */
export function resolveMachineHostTarget(
    groups: readonly Group[],
    target: { machineId: string; projectId: string },
    localMachineScope: string | null = null,
): MachineHostTarget | null {
    if (!target || typeof target.machineId !== 'string'
        || typeof target.projectId !== 'string') {
        return null;
    }
    for (const group of groups || []) {
        const project = (group?.projects || []).find(candidate =>
            candidate.id === target.projectId);
        if (!project) { continue; }
        if (!isProjectVisibleOnLocalMachine(project, localMachineScope)) {
            return null;
        }
        const topology = deriveProjectTopology(project.path);
        if (stableViewId('machine', topology.machineKey) !== target.machineId) {
            return null;
        }
        if (topology.machineKey === 'local') {
            return { kind: 'local', name: 'Local' };
        }
        if (!topology.hostAuthority) { return null; }
        return {
            kind: 'remote',
            name: topology.machineName,
            path: `${REMOTE_URI_PREFIX}${encodeRemoteAuthority(topology.hostAuthority)}/`,
            remoteType: topology.hostRemoteType,
        };
    }
    return null;
}

function deriveProjectTopology(projectPath: string): ProjectTopology {
    const remote = splitRemoteProjectUri(projectPath);
    if (!remote) {
        const wslDistribution = parseLegacyWslDistribution(projectPath);
        if (wslDistribution) {
            const authority = `wsl+${wslDistribution}`;
            return hostTopology(
                `remote:${authority}`,
                `${wslDistribution} (WSL)`,
                authority,
                ProjectRemoteType.WSL,
            );
        }
        return localTopology();
    }

    const authority = remote.authority;
    if (authority.startsWith('dev-container+')) {
        const nested = authority.slice('dev-container+'.length);
        const separator = nested.lastIndexOf('@ssh-remote+');
        if (separator > 0) {
            const sshAuthority = nested.slice(separator + 1);
            const target = sshAuthority.slice('ssh-remote+'.length) || 'SSH Host';
            return containerTopology(
                `remote:${sshAuthority}`,
                target,
                authority,
                nested.slice(0, separator),
                sshAuthority,
                ProjectRemoteType.SSH,
            );
        }
        return containerTopology(
            'local',
            'Local',
            authority,
            nested,
            null,
            ProjectRemoteType.None,
        );
    }
    if (authority.startsWith('attached-container+')) {
        return containerTopology(
            'local',
            'Local',
            authority,
            authority.slice('attached-container+'.length),
            null,
            ProjectRemoteType.None,
            'Attached Container',
        );
    }
    if (authority.startsWith('ssh-remote+')) {
        return hostTopology(
            `remote:${authority}`,
            authority.slice('ssh-remote+'.length) || 'SSH Host',
            authority,
            ProjectRemoteType.SSH,
        );
    }
    if (authority.startsWith('wsl+')) {
        const distribution = authority.slice('wsl+'.length) || 'WSL';
        return hostTopology(
            `remote:${authority}`,
            `${distribution} (WSL)`,
            authority,
            ProjectRemoteType.WSL,
        );
    }
    return hostTopology(
        `remote:${authority}`,
        remoteDisplayName(authority),
        authority,
        getRemoteType({ path: projectPath } as Project),
    );
}

function localTopology(): ProjectTopology {
    return hostTopology('local', 'Local', null, ProjectRemoteType.None);
}

function hostTopology(
    machineKey: string,
    machineName: string,
    hostAuthority: string | null,
    hostRemoteType: ProjectRemoteType,
): ProjectTopology {
    return {
        machineKey,
        machineName,
        environmentKey: 'host',
        environmentName: 'Host',
        environmentKind: 'host',
        hostAuthority,
        hostRemoteType,
    };
}

function containerTopology(
    machineKey: string,
    machineName: string,
    authority: string,
    rawAnchor: string,
    hostAuthority: string | null,
    hostRemoteType: ProjectRemoteType,
    fallbackName = 'Dev Container',
): ProjectTopology {
    return {
        machineKey,
        machineName,
        environmentKey: `container:${authority}`,
        environmentName: devContainerDisplayName(rawAnchor, fallbackName),
        environmentKind: 'devContainer',
        hostAuthority,
        hostRemoteType,
    };
}

function splitRemoteProjectUri(projectPath: string): { authority: string } | null {
    if (typeof projectPath !== 'string' || !projectPath.startsWith(REMOTE_URI_PREFIX)) {
        return null;
    }
    const rest = projectPath.slice(REMOTE_URI_PREFIX.length);
    const slash = rest.indexOf('/');
    const encodedAuthority = slash < 0 ? rest : rest.slice(0, slash);
    if (!encodedAuthority) { return null; }
    return { authority: normalizeRemoteAuthority(encodedAuthority) };
}

function parseLegacyWslDistribution(projectPath: string): string | null {
    if (typeof projectPath !== 'string') { return null; }
    const match = projectPath.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\/]+)/i);
    return match?.[1] || null;
}

function devContainerDisplayName(rawAnchor: string, fallbackName: string): string {
    const anchor = decodeHexJson(rawAnchor);
    if (!anchor) { return fallbackName; }
    const explicitName = typeof anchor.name === 'string' ? anchor.name.trim() : '';
    if (explicitName) { return `${explicitName} (Dev Container)`; }
    const hostPath = typeof anchor.hostPath === 'string' ? anchor.hostPath : '';
    const workspaceName = path.posix.basename(hostPath.replace(/\\/g, '/'));
    return workspaceName ? `${workspaceName} (Dev Container)` : fallbackName;
}

function decodeHexJson(raw: string): Record<string, unknown> | null {
    if (!raw || raw.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(raw)) { return null; }
    try {
        const decoded = Buffer.from(raw, 'hex').toString('utf8');
        const value = JSON.parse(decoded) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
    } catch (_error) {
        return null;
    }
}

function remoteDisplayName(authority: string): string {
    const separator = authority.indexOf('+');
    return separator >= 0 && authority.slice(separator + 1)
        ? authority.slice(separator + 1)
        : authority;
}

function normalizeViewTags(values: unknown[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (typeof value !== 'string') { continue; }
        const tag = value.trim().replace(/^#+/, '').trim();
        const key = tag.toLocaleLowerCase();
        if (!tag || seen.has(key)) { continue; }
        seen.add(key);
        result.push(tag);
    }
    return result;
}

function stableViewId(kind: string, value: string): string {
    return `${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}
