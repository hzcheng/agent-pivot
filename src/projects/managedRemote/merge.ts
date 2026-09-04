'use strict';

import {
    candidateKey,
    cloneManagedValue,
    createCausalVersion,
    createVersionedCandidates,
    distinctCandidateValues,
    joinVersionVectors,
    joinVersionedCandidates,
    normalizeVersionedCandidates,
    stableManagedValue,
    vectorIncludingVersion,
} from './causal';
import {
    ManagedCatalogConflict,
    ManagedEnvironment,
    ManagedRemoteCatalogV1,
    ManagedRemoteLayout,
    ManagedRemoteProject,
    ManagedSshMachine,
    MaterializedManagedRemoteCatalog,
    VersionedCandidate,
    VersionedCandidates,
} from './types';
import {
    assertManagedEnvironment,
    assertManagedMachine,
    assertManagedProject,
    parseManagedRemoteCatalog,
} from './validation';

export interface ManagedCatalogTransaction {
    machines?: Record<string, ManagedSshMachine | null>;
    environments?: Record<string, ManagedEnvironment | null>;
    projects?: Record<string, ManagedRemoteProject | null>;
    layout?: ManagedRemoteLayout;
}

function sortedRecord<T>(source: Record<string, T>): Record<string, T> {
    const result: Record<string, T> = {};
    for (const key of Object.keys(source || {}).sort()) {
        result[key] = source[key];
    }
    return result;
}

function unique(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values || []) {
        if (!seen.has(value)) {
            seen.add(value);
            result.push(value);
        }
    }
    return result;
}

function normalizeLayoutValue(layout: ManagedRemoteLayout): ManagedRemoteLayout {
    const environmentIdsByMachine: Record<string, string[]> = {};
    const projectIdsByEnvironment: Record<string, string[]> = {};
    for (const machineId of Object.keys(layout.environmentIdsByMachine || {}).sort()) {
        environmentIdsByMachine[machineId] = unique(layout.environmentIdsByMachine[machineId]);
    }
    for (const environmentId of Object.keys(layout.projectIdsByEnvironment || {}).sort()) {
        projectIdsByEnvironment[environmentId] = unique(
            layout.projectIdsByEnvironment[environmentId],
        );
    }
    return {
        machineIds: unique(layout.machineIds || []),
        environmentIdsByMachine,
        projectIdsByEnvironment,
        favoriteProjectIds: unique(layout.favoriteProjectIds || []),
    };
}

function normalizeLayoutRegister(
    register: VersionedCandidates<ManagedRemoteLayout>,
): VersionedCandidates<ManagedRemoteLayout> {
    return normalizeVersionedCandidates({
        candidates: register.candidates.map(candidate => ({
            value: normalizeLayoutValue(candidate.value),
            version: cloneManagedValue(candidate.version),
        })),
    });
}

function normalizeEntityMap<T>(
    source: Record<string, VersionedCandidates<T>>,
): Record<string, VersionedCandidates<T>> {
    const result: Record<string, VersionedCandidates<T>> = {};
    for (const id of Object.keys(source || {}).sort()) {
        result[id] = normalizeVersionedCandidates(source[id]);
    }
    return result;
}

export function normalizeManagedRemoteCatalog(
    document: ManagedRemoteCatalogV1,
): ManagedRemoteCatalogV1 {
    return {
        schemaVersion: 1,
        versionVector: joinVersionVectors({}, document.versionVector),
        machines: normalizeEntityMap(document.machines),
        environments: normalizeEntityMap(document.environments),
        projects: normalizeEntityMap(document.projects),
        layout: normalizeLayoutRegister(document.layout),
    };
}

function joinEntityMaps<T>(
    left: Record<string, VersionedCandidates<T>>,
    right: Record<string, VersionedCandidates<T>>,
): Record<string, VersionedCandidates<T>> {
    const result: Record<string, VersionedCandidates<T>> = {};
    for (const id of Array.from(new Set([
        ...Object.keys(left || {}),
        ...Object.keys(right || {}),
    ])).sort()) {
        if (left[id] && right[id]) {
            result[id] = joinVersionedCandidates(left[id], right[id]);
        } else {
            result[id] = normalizeVersionedCandidates(left[id] || right[id]);
        }
    }
    return result;
}

export function joinManagedRemoteCatalogs(
    leftValue: ManagedRemoteCatalogV1,
    rightValue: ManagedRemoteCatalogV1,
): ManagedRemoteCatalogV1 {
    const left = parseManagedRemoteCatalog(leftValue);
    const right = parseManagedRemoteCatalog(rightValue);
    if (!left || !right) {
        throw new Error('Cannot join an invalid Managed Remote catalog.');
    }
    return normalizeManagedRemoteCatalog({
        schemaVersion: 1,
        versionVector: joinVersionVectors(left.versionVector, right.versionVector),
        machines: joinEntityMaps(left.machines, right.machines),
        environments: joinEntityMaps(left.environments, right.environments),
        projects: joinEntityMaps(left.projects, right.projects),
        layout: joinVersionedCandidates(left.layout, right.layout),
    });
}

export function createEmptyManagedRemoteCatalog(actorId: string): ManagedRemoteCatalogV1 {
    const version = createCausalVersion({}, actorId);
    return normalizeManagedRemoteCatalog({
        schemaVersion: 1,
        versionVector: vectorIncludingVersion(version),
        machines: {},
        environments: {},
        projects: {},
        layout: createVersionedCandidates({
            machineIds: [],
            environmentIdsByMachine: {},
            projectIdsByEnvironment: {},
            favoriteProjectIds: [],
        }, version),
    });
}

function validateTransaction(transaction: ManagedCatalogTransaction): void {
    for (const [id, machine] of Object.entries(transaction.machines || {})) {
        if (machine !== null) {
            assertManagedMachine(machine);
            if (machine.id !== id) {
                throw new Error('Managed Machine key must match its immutable ID.');
            }
        }
    }
    for (const [id, environment] of Object.entries(transaction.environments || {})) {
        if (environment !== null) {
            assertManagedEnvironment(environment);
            if (environment.id !== id) {
                throw new Error('Managed Environment key must match its immutable ID.');
            }
        }
    }
    for (const [id, project] of Object.entries(transaction.projects || {})) {
        if (project !== null) {
            assertManagedProject(project);
            if (project.id !== id) {
                throw new Error('Managed Project key must match its immutable ID.');
            }
        }
    }
}

function assertImmutableProjectPlacement(
    document: ManagedRemoteCatalogV1,
    transaction: ManagedCatalogTransaction,
): void {
    for (const [projectId, project] of Object.entries(transaction.projects || {})) {
        if (!project || !document.projects[projectId]) {
            continue;
        }
        const placements = distinctCandidateValues(document.projects[projectId])
            .filter((value): value is ManagedRemoteProject => value !== null)
            .map(value => value.environmentId);
        if (placements.some(environmentId => environmentId !== project.environmentId)) {
            throw new Error('Managed Project Machine/Environment ownership is immutable.');
        }
    }
}

export function applyManagedCatalogTransaction(
    documentValue: ManagedRemoteCatalogV1,
    actorId: string,
    transaction: ManagedCatalogTransaction,
): ManagedRemoteCatalogV1 {
    const parsed = parseManagedRemoteCatalog(documentValue);
    if (!parsed) {
        throw new Error('Cannot mutate an invalid Managed Remote catalog.');
    }
    validateTransaction(transaction);
    assertImmutableProjectPlacement(parsed, transaction);
    const document = normalizeManagedRemoteCatalog(parsed);
    const version = createCausalVersion(document.versionVector, actorId);
    const machines = cloneManagedValue(document.machines);
    const environments = cloneManagedValue(document.environments);
    const projects = cloneManagedValue(document.projects);

    for (const [id, value] of Object.entries(transaction.machines || {})) {
        machines[id] = createVersionedCandidates(value, version);
    }
    for (const [id, value] of Object.entries(transaction.environments || {})) {
        environments[id] = createVersionedCandidates(value, version);
    }
    for (const [id, value] of Object.entries(transaction.projects || {})) {
        projects[id] = createVersionedCandidates(value, version);
    }

    return normalizeManagedRemoteCatalog({
        schemaVersion: 1,
        versionVector: joinVersionVectors(document.versionVector, vectorIncludingVersion(version)),
        machines,
        environments,
        projects,
        layout: transaction.layout
            ? createVersionedCandidates(normalizeLayoutValue(transaction.layout), version)
            : document.layout,
    });
}

function candidateWinner<T>(register: VersionedCandidates<T | null>): T | null {
    const candidates = normalizeVersionedCandidates(register).candidates;
    const visible = candidates.filter(candidate => candidate.value !== null);
    const pool = visible.length ? visible : candidates;
    return cloneManagedValue(pool.slice().sort((left, right) =>
        stableManagedValue(left.value).localeCompare(stableManagedValue(right.value))
        || candidateKey(left).localeCompare(candidateKey(right)))[0].value);
}

function registerConflict<T>(
    entityType: ManagedCatalogConflict['entityType'],
    entityId: string,
    register: VersionedCandidates<T | null>,
): ManagedCatalogConflict | null {
    const values = distinctCandidateValues(register);
    if (values.length <= 1) {
        return null;
    }
    return {
        kind: values.some(value => value === null) ? 'delete-update' : 'update-update',
        entityType,
        entityId,
    };
}

function liveValues<T>(register: VersionedCandidates<T | null>): T[] {
    return normalizeVersionedCandidates(register).candidates
        .map(candidate => candidate.value)
        .filter((value): value is T => value !== null)
        .map(cloneManagedValue);
}

function mergeRequestedOrder(candidates: VersionedCandidate<ManagedRemoteLayout>[]): ManagedRemoteLayout {
    const machineIds: string[] = [];
    const environmentIdsByMachine: Record<string, string[]> = {};
    const projectIdsByEnvironment: Record<string, string[]> = {};
    const favoriteProjectIds: string[] = [];
    const append = (target: string[], values: string[]) => {
        for (const value of values || []) {
            if (!target.includes(value)) {
                target.push(value);
            }
        }
    };
    for (const candidate of candidates.slice().sort((left, right) =>
        candidateKey(left).localeCompare(candidateKey(right)))) {
        const layout = candidate.value;
        append(machineIds, layout.machineIds);
        append(favoriteProjectIds, layout.favoriteProjectIds);
        for (const machineId of Object.keys(layout.environmentIdsByMachine).sort()) {
            environmentIdsByMachine[machineId] ||= [];
            append(environmentIdsByMachine[machineId], layout.environmentIdsByMachine[machineId]);
        }
        for (const environmentId of Object.keys(layout.projectIdsByEnvironment).sort()) {
            projectIdsByEnvironment[environmentId] ||= [];
            append(projectIdsByEnvironment[environmentId], layout.projectIdsByEnvironment[environmentId]);
        }
    }
    return { machineIds, environmentIdsByMachine, projectIdsByEnvironment, favoriteProjectIds };
}

function orderedIds(
    requested: readonly string[],
    available: readonly string[],
): string[] {
    const availableSet = new Set(available);
    const result = unique(requested).filter(id => availableSet.has(id));
    for (const id of available.slice().sort()) {
        if (!result.includes(id)) {
            result.push(id);
        }
    }
    return result;
}

export function collectManagedCatalogStructuralConflicts(
    document: ManagedRemoteCatalogV1,
): ManagedCatalogConflict[] {
    const conflicts: ManagedCatalogConflict[] = [];
    const liveMachineIds = new Set(Object.entries(document.machines)
        .filter(([, register]) => liveValues(register).length > 0)
        .map(([id]) => id));
    const liveEnvironmentIds = new Set(Object.entries(document.environments)
        .filter(([, register]) => liveValues(register).length > 0)
        .map(([id]) => id));

    for (const [environmentId, register] of Object.entries(document.environments)) {
        for (const environment of liveValues(register)) {
            if (!liveMachineIds.has(environment.machineId)) {
                conflicts.push({
                    kind: 'missing-parent',
                    entityType: 'environment',
                    entityId: environmentId,
                    relatedEntityIds: [environment.machineId],
                });
            }
        }
    }
    for (const [projectId, register] of Object.entries(document.projects)) {
        for (const project of liveValues(register)) {
            if (!liveEnvironmentIds.has(project.environmentId)) {
                conflicts.push({
                    kind: 'missing-parent',
                    entityType: 'project',
                    entityId: projectId,
                    relatedEntityIds: [project.environmentId],
                });
            }
        }
    }
    for (const machineId of Array.from(liveMachineIds).sort()) {
        const hostIds = Object.entries(document.environments)
            .filter(([, register]) => liveValues(register).some(environment =>
                environment.machineId === machineId && environment.kind === 'host'))
            .map(([environmentId]) => environmentId)
            .sort();
        if (!hostIds.length) {
            conflicts.push({
                kind: 'missing-host',
                entityType: 'machine',
                entityId: machineId,
            });
        } else if (hostIds.length > 1) {
            conflicts.push({
                kind: 'duplicate-host',
                entityType: 'machine',
                entityId: machineId,
                relatedEntityIds: hostIds,
            });
        }
    }
    return conflicts;
}

export function materializeManagedRemoteCatalog(
    documentValue: ManagedRemoteCatalogV1,
): MaterializedManagedRemoteCatalog {
    const parsed = parseManagedRemoteCatalog(documentValue);
    if (!parsed) {
        throw new Error('Cannot materialize an invalid Managed Remote catalog.');
    }
    const document = normalizeManagedRemoteCatalog(parsed);
    const conflicts: ManagedCatalogConflict[] = [];
    const machinesById = new Map<string, ManagedSshMachine>();
    const environmentsById = new Map<string, ManagedEnvironment>();
    const projectsById = new Map<string, ManagedRemoteProject>();

    for (const [id, register] of Object.entries(document.machines)) {
        const conflict = registerConflict('machine', id, register);
        if (conflict) { conflicts.push(conflict); }
        const winner = candidateWinner(register);
        if (winner) { machinesById.set(id, winner); }
    }
    for (const [id, register] of Object.entries(document.environments)) {
        const conflict = registerConflict('environment', id, register);
        if (conflict) { conflicts.push(conflict); }
        const winner = candidateWinner(register);
        if (winner) { environmentsById.set(id, winner); }
    }
    for (const [id, register] of Object.entries(document.projects)) {
        const conflict = registerConflict('project', id, register);
        if (conflict) { conflicts.push(conflict); }
        const winner = candidateWinner(register);
        if (winner) { projectsById.set(id, winner); }
    }

    const machineIdsByName = new Map<string, string[]>();
    for (const machine of machinesById.values()) {
        const name = machine.name.trim().toLowerCase();
        machineIdsByName.set(name, [...(machineIdsByName.get(name) || []), machine.id]);
    }
    for (const ids of machineIdsByName.values()) {
        if (ids.length > 1) {
            for (const id of ids.sort()) {
                conflicts.push({
                    kind: 'duplicate-machine-name',
                    entityType: 'machine',
                    entityId: id,
                    relatedEntityIds: ids.filter(candidate => candidate !== id),
                });
            }
        }
    }
    conflicts.push(...collectManagedCatalogStructuralConflicts(document));

    const requested = mergeRequestedOrder(document.layout.candidates);
    const machineIds = orderedIds(requested.machineIds, Array.from(machinesById.keys()));
    const environmentIdsByMachine: Record<string, string[]> = {};
    for (const machineId of machineIds) {
        const available = Array.from(environmentsById.values())
            .filter(environment => environment.machineId === machineId)
            .map(environment => environment.id);
        const requestedIds = requested.environmentIdsByMachine[machineId] || [];
        const ordered = orderedIds(requestedIds, available);
        const requestedRank = new Map(ordered.map((id, index) => [id, index]));
        ordered.sort((left, right) => {
            const leftHost = environmentsById.get(left)?.kind === 'host' ? 0 : 1;
            const rightHost = environmentsById.get(right)?.kind === 'host' ? 0 : 1;
            return leftHost - rightHost
                || (requestedRank.get(left) || 0) - (requestedRank.get(right) || 0);
        });
        environmentIdsByMachine[machineId] = ordered;
    }
    const projectIdsByEnvironment: Record<string, string[]> = {};
    for (const environmentId of environmentsById.keys()) {
        const available = Array.from(projectsById.values())
            .filter(project => project.environmentId === environmentId)
            .map(project => project.id);
        projectIdsByEnvironment[environmentId] = orderedIds(
            requested.projectIdsByEnvironment[environmentId] || [],
            available,
        );
    }
    const favoriteAvailable = Array.from(projectsById.values())
        .filter(project => project.favorite === true)
        .map(project => project.id);
    const layout: ManagedRemoteLayout = {
        machineIds,
        environmentIdsByMachine: sortedRecord(environmentIdsByMachine),
        projectIdsByEnvironment: sortedRecord(projectIdsByEnvironment),
        favoriteProjectIds: orderedIds(requested.favoriteProjectIds, favoriteAvailable),
    };

    const environments: ManagedEnvironment[] = [];
    const projects: ManagedRemoteProject[] = [];
    for (const machineId of machineIds) {
        for (const environmentId of layout.environmentIdsByMachine[machineId] || []) {
            environments.push(cloneManagedValue(environmentsById.get(environmentId)!));
            for (const projectId of layout.projectIdsByEnvironment[environmentId] || []) {
                projects.push(cloneManagedValue(projectsById.get(projectId)!));
            }
        }
    }
    return {
        machines: machineIds.map(id => cloneManagedValue(machinesById.get(id)!)),
        environments,
        projects,
        layout,
        conflicts: conflicts.sort((left, right) =>
            `${left.kind}:${left.entityType}:${left.entityId}`
                .localeCompare(`${right.kind}:${right.entityType}:${right.entityId}`)),
    };
}

export function hostEnvironmentId(machineId: string): string {
    return `host:${machineId}`;
}
