'use strict';

import { createHash } from 'crypto';

import type { Group, Project } from '../../models';
import { cloneManagedValue, stableManagedValue } from './causal';
import { parseManagedDevContainerProjectUri } from './devContainerCodec';
import { ManagedSshMachine } from './types';
import { isManagedMachine } from './validation';

export type ManagedMigrationClassification =
    | 'ready'
    | 'needsInput'
    | 'unsupported'
    | 'clientLocal';

export interface ManagedMigrationEndpoint {
    host: string;
    user: string;
    port: number;
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
            reason: 'The outer SSH authority must be resolved and rehearsed on this computer.',
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
        reason: 'Remote - SSH rehearsal is required before this WSL Project is ready.',
        proposedMachineId: stableMachineId(endpoint),
        proposedMachineName: machineName,
        endpoint: cloneManagedValue(endpoint),
        remotePath: confirmedRemotePath,
    };
}
