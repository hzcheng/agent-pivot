'use strict';

import { createHash } from 'crypto';

import type { Group, Project } from '../../models';
import { cloneManagedValue, stableManagedValue } from './causal';
import { parseManagedDevContainerProjectUri } from './devContainerCodec';
import {
    applyManagedCatalogTransaction,
    collectManagedCatalogStructuralConflicts,
    createEmptyManagedRemoteCatalog,
    hostEnvironmentId,
} from './merge';
import {
    ManagedEnvironment,
    ManagedRemoteCatalogV1,
    ManagedRemoteLayout,
    ManagedRemoteProject,
    ManagedSshMachine,
} from './types';
import { isManagedMachine, parseManagedRemoteCatalog } from './validation';

export type ManagedMigrationClassification =
    | 'ready'
    | 'needsInput'
    | 'unsupported'
    | 'clientLocal'
    | 'excluded';

export interface ManagedMigrationEndpoint {
    host: string;
    user: string;
    port: number;
}

export interface ManagedLegacySshInspection {
    status: 'needsInput' | 'unsupported';
    reason: string;
    endpoint?: ManagedMigrationEndpoint;
}

export function parseManagedLegacySshInspection(
    value: unknown,
): ManagedLegacySshInspection | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return null; }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (!keys.every(key => ['status', 'reason', 'endpoint'].includes(key))
        || !['needsInput', 'unsupported'].includes(String(record.status))
        || typeof record.reason !== 'string'
        || !record.reason
        || record.reason.length > 512) {
        return null;
    }
    if (record.endpoint === undefined) {
        return record.status === 'unsupported' || record.status === 'needsInput'
            ? record as unknown as ManagedLegacySshInspection : null;
    }
    if (record.status !== 'needsInput'
        || !record.endpoint
        || typeof record.endpoint !== 'object'
        || Array.isArray(record.endpoint)) {
        return null;
    }
    const endpoint = record.endpoint as Record<string, unknown>;
    if (Object.keys(endpoint).sort().join(',') !== 'host,port,user') { return null; }
    const machine: ManagedSshMachine = {
        id: 'legacy-inspection-validation',
        name: 'Legacy inspection validation',
        connection: {
            kind: 'ssh',
            host: endpoint.host as string,
            user: endpoint.user as string,
            port: endpoint.port as number,
        },
    };
    return isManagedMachine(machine)
        ? record as unknown as ManagedLegacySshInspection : null;
}

export interface ManagedProjectMigrationRecord {
    projectId: string;
    classification: ManagedMigrationClassification;
    reason: string;
    originalProject: Project;
    proposedMachineId?: string;
    proposedMachineName?: string;
    endpoint?: ManagedMigrationEndpoint;
    remotePath?: string;
    tags: string[];
    devContainerAuthority?: string;
    outerSshAuthority?: string;
}

export interface ManagedRemoteMigrationPlanV1 {
    schemaVersion: 1;
    planId: string;
    sourceChecksum: string;
    records: ManagedProjectMigrationRecord[];
}

function hash(value: unknown): string {
    return createHash('sha256').update(stableManagedValue(value), 'utf8').digest('hex');
}

function normalizeTags(project: Project, groupName: string): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of [...(Array.isArray(project.tags) ? project.tags : []), groupName]) {
        if (typeof value !== 'string') { continue; }
        const tag = value.trim().replace(/^#+/, '').trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) { continue; }
        seen.add(key);
        result.push(tag);
    }
    return result;
}

function splitRemoteUri(projectPath: string): { authority: string; remotePath: string } | null {
    const prefix = 'vscode-remote://';
    if (typeof projectPath !== 'string' || !projectPath.startsWith(prefix)) {
        return null;
    }
    const remainder = projectPath.slice(prefix.length);
    const slash = remainder.indexOf('/');
    const encodedAuthority = slash < 0 ? remainder : remainder.slice(0, slash);
    try {
        return {
            authority: decodeURIComponent(encodedAuthority),
            remotePath: slash < 0 ? '/' : remainder.slice(slash),
        };
    } catch (_error) {
        return null;
    }
}

function parseHostPort(value: string): { host: string; port: number } | null {
    if (value.startsWith('[')) {
        const close = value.indexOf(']');
        if (close < 0) { return null; }
        const host = value.slice(1, close);
        const suffix = value.slice(close + 1);
        const port = suffix ? Number(suffix.replace(/^:/, '')) : 22;
        return suffix && !suffix.startsWith(':') ? null : { host, port };
    }
    const colonCount = (value.match(/:/g) || []).length;
    if (colonCount > 1) {
        return { host: value, port: 22 };
    }
    const separator = value.lastIndexOf(':');
    if (separator < 0) {
        return { host: value, port: 22 };
    }
    return { host: value.slice(0, separator), port: Number(value.slice(separator + 1)) };
}

export function parseDirectManagedSshTarget(value: string): ManagedMigrationEndpoint | null {
    if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) {
        return null;
    }
    const separator = value.lastIndexOf('@');
    if (separator <= 0 || separator === value.length - 1) {
        return null;
    }
    const user = value.slice(0, separator);
    const hostPort = parseHostPort(value.slice(separator + 1));
    if (!hostPort) { return null; }
    const machine: ManagedSshMachine = {
        id: 'migration-validation',
        name: 'Migration validation',
        connection: { kind: 'ssh', user, ...hostPort },
    };
    return isManagedMachine(machine) ? {
        host: machine.connection.host,
        user: machine.connection.user,
        port: machine.connection.port,
    } : null;
}

function stableMachineId(endpoint: ManagedMigrationEndpoint): string {
    return `machine:${hash(endpoint).slice(0, 32)}`;
}

function classifyProject(project: Project, groupName: string): ManagedProjectMigrationRecord {
    const base: ManagedProjectMigrationRecord = {
        projectId: project.id,
        classification: 'unsupported',
        reason: 'The saved Project URI is not supported by managed connections.',
        originalProject: cloneManagedValue(project),
        tags: normalizeTags(project, groupName),
    };
    const remote = splitRemoteUri(project.path);
    if (!remote) {
        const isLegacyWsl = typeof project.path === 'string'
            && /^\\\\(?:wsl\$|wsl\.localhost)\\/i.test(project.path);
        return {
            ...base,
            classification: 'clientLocal',
            reason: isLegacyWsl
                ? 'This WSL Project belongs to the current Windows computer.'
                : 'This Project belongs to the current computer.',
        };
    }
    if (remote.authority.startsWith('wsl+')) {
        return {
            ...base,
            classification: 'clientLocal',
            reason: 'A wsl+ authority names a distro on the current Windows computer.',
            remotePath: remote.remotePath,
        };
    }
    if (remote.authority.startsWith('attached-container+')) {
        return {
            ...base,
            classification: 'clientLocal',
            reason: 'Attached containers do not provide a portable outer Machine.',
            remotePath: remote.remotePath,
        };
    }
    if (remote.authority.startsWith('dev-container+')) {
        const parsed = parseManagedDevContainerProjectUri(project.path);
        return parsed ? {
            ...base,
            classification: 'needsInput',
            reason: 'The outer SSH authority must be resolved to plain host, user, and port details.',
            remotePath: parsed.remotePath,
            devContainerAuthority: parsed.anchor.originalAuthority,
            outerSshAuthority: parsed.outerSshAuthority,
        } : {
            ...base,
            classification: 'unsupported',
            reason: 'The Dev Container launch authority is unknown or cannot round-trip safely.',
            remotePath: remote.remotePath,
        };
    }
    if (!remote.authority.startsWith('ssh-remote+')) {
        return base;
    }
    const sshTarget = remote.authority.slice('ssh-remote+'.length);
    const endpoint = parseDirectManagedSshTarget(sshTarget);
    if (!endpoint) {
        return {
            ...base,
            classification: 'needsInput',
            reason: 'The SSH alias needs local inspection or explicit connection details.',
            remotePath: remote.remotePath,
            outerSshAuthority: sshTarget,
        };
    }
    return {
        ...base,
        classification: 'ready',
        reason: 'The Project contains an explicit SSH user and endpoint.',
        proposedMachineId: stableMachineId(endpoint),
        proposedMachineName: project.machineDisplayName || sshTarget,
        endpoint,
        remotePath: remote.remotePath,
        outerSshAuthority: sshTarget,
    };
}

export function buildManagedRemoteMigrationPlan(
    groups: readonly Group[],
): ManagedRemoteMigrationPlanV1 {
    const source = cloneManagedValue(Array.isArray(groups) ? groups : []);
    const sourceChecksum = hash(source);
    const records: ManagedProjectMigrationRecord[] = [];
    for (const group of source) {
        for (const project of Array.isArray(group?.projects) ? group.projects : []) {
            if (project && typeof project.id === 'string' && project.id) {
                records.push(classifyProject(project, group.groupName));
            }
        }
    }
    records.sort((left, right) => left.projectId.localeCompare(right.projectId));
    return {
        schemaVersion: 1,
        planId: `migration:${sourceChecksum}`,
        sourceChecksum,
        records,
    };
}

export function resolveWslMigrationAsManagedMachine(
    record: ManagedProjectMigrationRecord,
    machineName: string,
    endpoint: ManagedMigrationEndpoint,
    confirmedRemotePath: string,
): ManagedProjectMigrationRecord {
    const validation: ManagedSshMachine = {
        id: 'migration-validation',
        name: machineName,
        connection: { kind: 'ssh', ...endpoint },
    };
    if (record.classification !== 'clientLocal'
        || !isManagedMachine(validation)
        || typeof confirmedRemotePath !== 'string'
        || !confirmedRemotePath.startsWith('/')) {
        throw new Error('WSL migration requires explicit valid SSH details and Linux path.');
    }
    return {
        ...cloneManagedValue(record),
        classification: 'needsInput',
        reason: 'Plain SSH host, user, port, and Linux path are required for this WSL Project.',
        proposedMachineId: stableMachineId(endpoint),
        proposedMachineName: machineName,
        endpoint: cloneManagedValue(endpoint),
        remotePath: confirmedRemotePath,
    };
}

export function resolveManagedMigrationWithConnection(
    record: ManagedProjectMigrationRecord,
    machineName: string,
    endpoint: ManagedMigrationEndpoint,
    confirmedRemotePath: string = record.remotePath || '',
): ManagedProjectMigrationRecord {
    const machine: ManagedSshMachine = {
        id: 'migration-validation',
        name: machineName,
        connection: { kind: 'ssh', ...endpoint },
    };
    if (!['ready', 'needsInput', 'clientLocal'].includes(record.classification)
        || !isManagedMachine(machine)
        || typeof confirmedRemotePath !== 'string'
        || !confirmedRemotePath.startsWith('/')) {
        throw new Error('Migration requires valid SSH details and an absolute remote path.');
    }
    return {
        ...cloneManagedValue(record),
        classification: 'ready',
        reason: 'The explicit managed connection details were reviewed.',
        proposedMachineId: stableMachineId(endpoint),
        proposedMachineName: machineName.trim(),
        endpoint: cloneManagedValue(endpoint),
        remotePath: confirmedRemotePath,
    };
}

export function excludeManagedMigrationRecord(
    record: ManagedProjectMigrationRecord,
): ManagedProjectMigrationRecord {
    if (record.classification === 'clientLocal') {
        throw new Error('Client-local Projects are already excluded from synchronization.');
    }
    return {
        ...cloneManagedValue(record),
        classification: 'excluded',
        reason: 'The Project will not be included in Managed Remote.',
        proposedMachineId: undefined,
        proposedMachineName: undefined,
        endpoint: undefined,
    };
}

function boundedName(value: string, fallback: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return (normalized || fallback).slice(0, 128);
}

function endpointLabel(endpoint: ManagedMigrationEndpoint): string {
    const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
    return `${endpoint.user}@${host}:${endpoint.port}`;
}

function uniqueMachineNames(
    records: readonly ManagedProjectMigrationRecord[],
): Map<string, string> {
    const firstByMachine = new Map<string, ManagedProjectMigrationRecord>();
    for (const record of records) {
        if (record.classification === 'ready' && record.proposedMachineId && record.endpoint
            && !firstByMachine.has(record.proposedMachineId)) {
            firstByMachine.set(record.proposedMachineId, record);
        }
    }
    const result = new Map<string, string>();
    const used = new Set<string>();
    for (const [machineId, record] of Array.from(firstByMachine.entries())
        .sort(([left], [right]) => left.localeCompare(right))) {
        const endpoint = record.endpoint as ManagedMigrationEndpoint;
        const base = boundedName(record.proposedMachineName || '', endpointLabel(endpoint));
        let name = base;
        if (used.has(name.toLocaleLowerCase())) {
            name = boundedName(`${base} — ${endpointLabel(endpoint)}`, endpointLabel(endpoint));
        }
        let suffix = 2;
        const unsuffixed = name;
        while (used.has(name.toLocaleLowerCase())) {
            const marker = ` (${suffix})`;
            name = `${unsuffixed.slice(0, 128 - marker.length)}${marker}`;
            suffix += 1;
        }
        used.add(name.toLocaleLowerCase());
        result.set(machineId, name);
    }
    return result;
}

function devContainerEnvironment(
    record: ManagedProjectMigrationRecord,
    machineId: string,
): ManagedEnvironment | null {
    if (!record.devContainerAuthority) { return null; }
    const parsed = parseManagedDevContainerProjectUri(record.originalProject.path);
    if (!parsed) {
        throw new Error(`Managed Project ${record.projectId} has an invalid Dev Container anchor.`);
    }
    const id = `environment:${hash({ machineId, anchor: parsed.anchor }).slice(0, 32)}`;
    return {
        id,
        machineId,
        kind: 'devContainer',
        name: 'Dev Container',
        devContainerAnchor: parsed.anchor,
    };
}

/**
 * Builds the synchronized candidate only from reviewed remote records. Local,
 * WSL-local, and explicitly excluded records remain outside this catalog.
 */
export function buildManagedCatalogFromMigrationPlan(
    planValue: ManagedRemoteMigrationPlanV1,
    actorId: string,
): ManagedRemoteCatalogV1 {
    const plan = cloneManagedValue(planValue);
    if (plan.schemaVersion !== 1
        || !/^migration:[a-f0-9]{64}$/u.test(plan.planId)
        || !/^[a-f0-9]{64}$/u.test(plan.sourceChecksum)) {
        throw new Error('Managed Remote migration plan is invalid.');
    }
    const unresolved = plan.records.find(record =>
        record.classification === 'needsInput' || record.classification === 'unsupported');
    if (unresolved) {
        throw new Error(`Managed Project ${unresolved.projectId} still requires migration review.`);
    }
    const ready = plan.records.filter(record => record.classification === 'ready');
    const names = uniqueMachineNames(ready);
    const machines: Record<string, ManagedSshMachine> = {};
    const environments: Record<string, ManagedEnvironment> = {};
    const projects: Record<string, ManagedRemoteProject> = {};
    const layout: ManagedRemoteLayout = {
        machineIds: [],
        environmentIdsByMachine: {},
        projectIdsByEnvironment: {},
        favoriteProjectIds: [],
    };
    const favorites: Array<{ id: string; order: number; ordinal: number }> = [];
    const projectIds = new Set<string>();

    ready.forEach((record, ordinal) => {
        if (!record.proposedMachineId || !record.endpoint || !record.remotePath
            || !record.remotePath.startsWith('/')) {
            throw new Error(`Managed Project ${record.projectId} has incomplete migration details.`);
        }
        if (projectIds.has(record.projectId)) {
            throw new Error(`Managed Project ${record.projectId} appears more than once.`);
        }
        projectIds.add(record.projectId);
        const machineId = record.proposedMachineId;
        const machine: ManagedSshMachine = {
            id: machineId,
            name: names.get(machineId) || endpointLabel(record.endpoint),
            connection: { kind: 'ssh', ...cloneManagedValue(record.endpoint) },
        };
        const existingMachine = machines[machineId];
        if (existingMachine
            && stableManagedValue(existingMachine.connection)
                !== stableManagedValue(machine.connection)) {
            throw new Error(`Managed Machine ${machineId} maps to multiple endpoints.`);
        }
        if (!existingMachine) {
            if (!isManagedMachine(machine)) {
                throw new Error(`Managed Machine ${machineId} is invalid.`);
            }
            machines[machineId] = machine;
            layout.machineIds.push(machineId);
            const hostId = hostEnvironmentId(machineId);
            environments[hostId] = {
                id: hostId,
                machineId,
                kind: 'host',
                name: 'Host',
            };
            layout.environmentIdsByMachine[machineId] = [hostId];
            layout.projectIdsByEnvironment[hostId] = [];
        }

        const devContainer = devContainerEnvironment(record, machineId);
        const environment: ManagedEnvironment = devContainer || {
            id: hostEnvironmentId(machineId),
            machineId,
            kind: 'host',
            name: 'Host',
        };
        if (!environments[environment.id]) {
            environments[environment.id] = environment;
            layout.environmentIdsByMachine[machineId].push(environment.id);
            layout.projectIdsByEnvironment[environment.id] = [];
        }
        const original = record.originalProject;
        const project: ManagedRemoteProject = {
            id: record.projectId,
            environmentId: environment.id,
            name: original.name,
            remotePath: record.remotePath,
            ...(typeof original.description === 'string'
                ? { description: original.description } : {}),
            ...(record.tags.length ? { tags: cloneManagedValue(record.tags) } : {}),
            ...(typeof original.color === 'string' && original.color
                ? { color: original.color } : {}),
            ...(original.favorite === true ? { favorite: true } : {}),
        };
        projects[project.id] = project;
        layout.projectIdsByEnvironment[environment.id].push(project.id);
        if (project.favorite) {
            favorites.push({
                id: project.id,
                order: Number.isFinite(original.favoriteOrder)
                    ? Number(original.favoriteOrder) : Number.MAX_SAFE_INTEGER,
                ordinal,
            });
        }
    });
    layout.favoriteProjectIds = favorites
        .sort((left, right) => left.order - right.order
            || left.ordinal - right.ordinal
            || left.id.localeCompare(right.id))
        .map(value => value.id);
    const document = applyManagedCatalogTransaction(
        createEmptyManagedRemoteCatalog(actorId),
        actorId,
        { machines, environments, projects, layout },
    );
    if (!parseManagedRemoteCatalog(document)) {
        throw new Error('Managed Remote migration produced an invalid catalog.');
    }
    const conflicts = collectManagedCatalogStructuralConflicts(document);
    if (conflicts.length) {
        throw new Error(`Managed Remote migration produced ${conflicts[0].kind}.`);
    }
    return document;
}
