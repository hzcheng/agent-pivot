'use strict';

import { isIP } from 'net';

import {
    CausalVersion,
    DevContainerLaunchAnchorV1,
    ManagedEnvironment,
    ManagedRemoteCatalogV1,
    ManagedRemoteLayout,
    ManagedRemoteProject,
    ManagedSshMachine,
    VersionedCandidates,
    VersionVector,
} from './types';
import { cloneManagedValue, normalizeVersionedCandidates } from './causal';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DNS_HOST = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const SAFE_USER = /^[A-Za-z0-9][A-Za-z0-9._@\\-]{0,255}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
    const keys = Object.keys(value);
    return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every(key => required.includes(key) || optional.includes(key));
}

function isSafeId(value: unknown): value is string {
    return typeof value === 'string' && SAFE_ID.test(value);
}

function isSafeText(value: unknown, maxLength: number, allowEmpty = false): value is string {
    return typeof value === 'string'
        && value.length <= maxLength
        && (allowEmpty || value.trim().length > 0)
        && !CONTROL_CHARACTERS.test(value);
}

function isVersionVector(value: unknown): value is VersionVector {
    return isRecord(value) && Object.keys(value).every(actorId =>
        Boolean(actorId)
        && Number.isSafeInteger(value[actorId])
        && (value[actorId] as number) >= 0);
}

export function isCausalVersion(value: unknown): value is CausalVersion {
    if (!isRecord(value)
        || !hasExactKeys(value, ['dot', 'context'])
        || !isRecord(value.dot)
        || !hasExactKeys(value.dot, ['actorId', 'counter'])
        || typeof value.dot.actorId !== 'string'
        || !value.dot.actorId
        || !Number.isSafeInteger(value.dot.counter)
        || (value.dot.counter as number) <= 0
        || !isVersionVector(value.context)) {
        return false;
    }
    return ((value.context as VersionVector)[value.dot.actorId] || 0)
        < (value.dot.counter as number);
}

function isRegister<T>(
    value: unknown,
    isValue: (candidate: unknown) => candidate is T,
): value is VersionedCandidates<T> {
    if (!isRecord(value)
        || !hasExactKeys(value, ['candidates'])
        || !Array.isArray(value.candidates)
        || !value.candidates.length) {
        return false;
    }
    return value.candidates.every(candidate =>
        isRecord(candidate)
        && hasExactKeys(candidate, ['value', 'version'])
        && isValue(candidate.value)
        && isCausalVersion(candidate.version));
}

function catalogVectorCoversRegister<T>(
    vector: VersionVector,
    register: VersionedCandidates<T>,
): boolean {
    return register.candidates.every(candidate =>
        (vector[candidate.version.dot.actorId] || 0) >= candidate.version.dot.counter
        && Object.keys(candidate.version.context).every(actorId =>
            (vector[actorId] || 0) >= candidate.version.context[actorId]));
}

export function isManagedMachine(value: unknown): value is ManagedSshMachine {
    if (!isRecord(value)
        || !hasExactKeys(value, ['id', 'name', 'connection'])
        || !isSafeId(value.id)
        || !isSafeText(value.name, 128)
        || !isRecord(value.connection)
        || !hasExactKeys(value.connection, ['kind', 'host', 'user', 'port'])
        || value.connection.kind !== 'ssh'
        || typeof value.connection.host !== 'string'
        || typeof value.connection.user !== 'string'
        || !Number.isSafeInteger(value.connection.port)
        || (value.connection.port as number) < 1
        || (value.connection.port as number) > 65535) {
        return false;
    }
    const host = value.connection.host as string;
    return (isIP(host) !== 0 || DNS_HOST.test(host))
        && SAFE_USER.test(value.connection.user as string);
}

function isDevContainerAnchor(value: unknown): value is DevContainerLaunchAnchorV1 {
    return isRecord(value)
        && hasExactKeys(value, ['version', 'originalAuthority', 'sourceKind', 'sourceLocator'])
        && value.version === 1
        && isSafeText(value.originalAuthority, 16384)
        && (value.sourceKind === 'workspace' || value.sourceKind === 'config')
        && isSafeText(value.sourceLocator, 4096);
}

export function isManagedEnvironment(value: unknown): value is ManagedEnvironment {
    if (!isRecord(value)
        || !hasExactKeys(value, ['id', 'machineId', 'kind', 'name'], ['devContainerAnchor'])
        || !isSafeId(value.id)
        || !isSafeId(value.machineId)
        || (value.kind !== 'host' && value.kind !== 'devContainer')
        || !isSafeText(value.name, 128)) {
        return false;
    }
    if (value.kind === 'host') {
        return value.devContainerAnchor === undefined;
    }
    return isDevContainerAnchor(value.devContainerAnchor);
}

export function isManagedProject(value: unknown): value is ManagedRemoteProject {
    if (!isRecord(value)
        || !hasExactKeys(
            value,
            ['id', 'environmentId', 'name', 'remotePath'],
            ['description', 'tags', 'color', 'favorite'],
        )
        || !isSafeId(value.id)
        || !isSafeId(value.environmentId)
        || !isSafeText(value.name, 256)
        || !isSafeText(value.remotePath, 8192)
        || !value.remotePath.startsWith('/')
        || (value.description !== undefined && !isSafeText(value.description, 8192, true))
        || (value.color !== undefined && !isSafeText(value.color, 256))
        || (value.favorite !== undefined && typeof value.favorite !== 'boolean')) {
        return false;
    }
    return value.tags === undefined || (Array.isArray(value.tags)
        && value.tags.every(tag => isSafeText(tag, 1024)));
}

export function isManagedLayout(value: unknown): value is ManagedRemoteLayout {
    if (!isRecord(value)
        || !hasExactKeys(value, [
            'machineIds',
            'environmentIdsByMachine',
            'projectIdsByEnvironment',
            'favoriteProjectIds',
        ])
        || !Array.isArray(value.machineIds)
        || !isRecord(value.environmentIdsByMachine)
        || !isRecord(value.projectIdsByEnvironment)
        || !Array.isArray(value.favoriteProjectIds)) {
        return false;
    }
    const machineIds = value.machineIds;
    const favoriteProjectIds = value.favoriteProjectIds;
    const environmentIdsByMachine = value.environmentIdsByMachine;
    const projectIdsByEnvironment = value.projectIdsByEnvironment;
    return machineIds.every(isSafeId)
        && favoriteProjectIds.every(isSafeId)
        && Object.keys(environmentIdsByMachine).every(machineId =>
            isSafeId(machineId)
            && Array.isArray(environmentIdsByMachine[machineId])
            && (environmentIdsByMachine[machineId] as unknown[]).every(isSafeId))
        && Object.keys(projectIdsByEnvironment).every(environmentId =>
            isSafeId(environmentId)
            && Array.isArray(projectIdsByEnvironment[environmentId])
            && (projectIdsByEnvironment[environmentId] as unknown[]).every(isSafeId));
}

export function parseManagedRemoteCatalog(value: unknown): ManagedRemoteCatalogV1 | null {
    if (!isRecord(value)
        || !hasExactKeys(value, [
            'schemaVersion', 'versionVector', 'machines', 'environments', 'projects', 'layout',
        ])
        || value.schemaVersion !== 1
        || !isVersionVector(value.versionVector)
        || !isRecord(value.machines)
        || !isRecord(value.environments)
        || !isRecord(value.projects)
        || !isRegister(value.layout, isManagedLayout)) {
        return null;
    }
    const vector = value.versionVector as VersionVector;
    const maps: Array<[Record<string, unknown>, (candidate: unknown) => boolean]> = [
        [value.machines, candidate => candidate === null || isManagedMachine(candidate)],
        [value.environments, candidate => candidate === null || isManagedEnvironment(candidate)],
        [value.projects, candidate => candidate === null || isManagedProject(candidate)],
    ];
    try {
        for (const [records, validator] of maps) {
            for (const id of Object.keys(records)) {
                if (!isSafeId(id)
                    || !isRegister(records[id], validator as (candidate: unknown) => candidate is unknown)
                    || !catalogVectorCoversRegister(vector, records[id] as VersionedCandidates<unknown>)) {
                    return null;
                }
                normalizeVersionedCandidates(records[id] as VersionedCandidates<unknown>);
            }
        }
        if (!catalogVectorCoversRegister(vector, value.layout as VersionedCandidates<ManagedRemoteLayout>)) {
            return null;
        }
        normalizeVersionedCandidates(value.layout as VersionedCandidates<ManagedRemoteLayout>);
    } catch (_error) {
        return null;
    }
    return cloneManagedValue(value) as unknown as ManagedRemoteCatalogV1;
}

export function assertManagedMachine(value: unknown): asserts value is ManagedSshMachine {
    if (!isManagedMachine(value)) {
        throw new Error('Managed Machine is invalid or contains unsupported fields.');
    }
}

export function assertManagedEnvironment(value: unknown): asserts value is ManagedEnvironment {
    if (!isManagedEnvironment(value)) {
        throw new Error('Managed Environment is invalid or contains unsupported fields.');
    }
}

export function assertManagedProject(value: unknown): asserts value is ManagedRemoteProject {
    if (!isManagedProject(value)) {
        throw new Error('Managed Project is invalid or contains unsupported fields.');
    }
}
