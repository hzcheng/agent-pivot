'use strict';

import { randomBytes } from 'crypto';

import {
    cloneManagedValue,
    distinctCandidateValues,
    normalizeVersionedCandidates,
    stableManagedValue,
} from './causal';
import {
    applyManagedCatalogTransaction,
    collectManagedCatalogStructuralConflicts,
    createEmptyManagedRemoteCatalog,
    hostEnvironmentId,
    ManagedCatalogTransaction,
    materializeManagedRemoteCatalog,
} from './merge';
import {
    DevContainerLaunchAnchorV1,
    ManagedEnvironment,
    ManagedRemoteCatalogV1,
    ManagedRemoteLayout,
    ManagedRemoteProject,
    ManagedSshMachine,
    MaterializedManagedRemoteCatalog,
    VersionedCandidates,
} from './types';
import { parseManagedRemoteCatalog } from './validation';

export interface AddManagedMachineInput {
    name: string;
    host: string;
    user: string;
    port?: number;
}

export interface EditManagedMachineInput {
    name?: string;
    host?: string;
    user?: string;
    port?: number;
}

export interface AddManagedProjectInput {
    id?: string;
    environmentId: string;
    name: string;
    remotePath: string;
    description?: string;
    tags?: string[];
    color?: string;
    favorite?: boolean;
}

export interface EditManagedProjectInput {
    name?: string;
    remotePath?: string;
    description?: string | null;
    tags?: string[] | null;
    color?: string | null;
    favorite?: boolean;
}

function defaultCreateId(prefix: string): string {
    return `${prefix}:${randomBytes(16).toString('hex')}`;
}

function nonNullValues<T>(register: VersionedCandidates<T | null>): T[] {
    return normalizeVersionedCandidates(register).candidates
        .map(candidate => candidate.value)
        .filter((value): value is T => value !== null)
        .map(cloneManagedValue);
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
    if (tags === undefined) { return undefined; }
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of tags) {
        const tag = typeof value === 'string' ? value.trim().replace(/^#+/, '').trim() : '';
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) { continue; }
        seen.add(key);
        result.push(tag);
    }
    return result;
}

function singleValue<T>(
    register: VersionedCandidates<T | null> | undefined,
    label: string,
): T {
    if (!register) {
        throw new Error(`${label} no longer exists.`);
    }
    const values = distinctCandidateValues(register)
        .filter((value): value is T => value !== null);
    const hasDelete = normalizeVersionedCandidates(register).candidates
        .some(candidate => candidate.value === null);
    if (values.length !== 1 || hasDelete) {
        throw new Error(`${label} has unresolved concurrent changes.`);
    }
    return cloneManagedValue(values[0]);
}

function removeFromLayout(
    layout: ManagedRemoteLayout,
    ids: { machineId?: string; environmentId?: string; projectId?: string },
): ManagedRemoteLayout {
    const result = cloneManagedValue(layout);
    if (ids.projectId) {
        result.favoriteProjectIds = result.favoriteProjectIds.filter(id => id !== ids.projectId);
        for (const environmentId of Object.keys(result.projectIdsByEnvironment)) {
            result.projectIdsByEnvironment[environmentId] =
                result.projectIdsByEnvironment[environmentId].filter(id => id !== ids.projectId);
        }
    }
    if (ids.environmentId) {
        delete result.projectIdsByEnvironment[ids.environmentId];
        for (const machineId of Object.keys(result.environmentIdsByMachine)) {
            result.environmentIdsByMachine[machineId] =
                result.environmentIdsByMachine[machineId].filter(id => id !== ids.environmentId);
        }
    }
    if (ids.machineId) {
        result.machineIds = result.machineIds.filter(id => id !== ids.machineId);
        delete result.environmentIdsByMachine[ids.machineId];
    }
    return result;
}

export class ManagedRemoteCatalogService {
    private document: ManagedRemoteCatalogV1;

    constructor(
        document: ManagedRemoteCatalogV1,
        private readonly actorId: string,
        private readonly createId: (prefix: string) => string = defaultCreateId,
    ) {
        const parsed = parseManagedRemoteCatalog(document);
        if (!parsed) {
            throw new Error('Managed Remote catalog is invalid.');
        }
        this.document = parsed;
    }

    static create(
        actorId: string,
        createId: (prefix: string) => string = defaultCreateId,
    ): ManagedRemoteCatalogService {
        return new ManagedRemoteCatalogService(
            createEmptyManagedRemoteCatalog(actorId),
            actorId,
            createId,
        );
    }

    getDocument(): ManagedRemoteCatalogV1 {
        return cloneManagedValue(this.document);
    }

    getCatalog(): MaterializedManagedRemoteCatalog {
        return materializeManagedRemoteCatalog(this.document);
    }

    addMachine(input: AddManagedMachineInput): ManagedSshMachine {
        this.assertUniqueMachineName(input.name);
        const machineId = this.createId('machine');
        const machine: ManagedSshMachine = {
            id: machineId,
            name: input.name,
            connection: {
                kind: 'ssh',
                host: input.host,
                user: input.user,
                port: input.port === undefined ? 22 : input.port,
            },
        };
        const hostId = hostEnvironmentId(machineId);
        const host: ManagedEnvironment = {
            id: hostId,
            machineId,
            kind: 'host',
            name: 'Host',
        };
        const layout = this.getCatalog().layout;
        layout.machineIds.push(machineId);
        layout.environmentIdsByMachine[machineId] = [hostId];
        layout.projectIdsByEnvironment[hostId] = [];
        this.commit({
            machines: { [machineId]: machine },
            environments: { [hostId]: host },
            layout,
        });
        return cloneManagedValue(machine);
    }

    editMachine(machineId: string, patch: EditManagedMachineInput): ManagedSshMachine {
        const current = singleValue<ManagedSshMachine>(
            this.document.machines[machineId],
            'Managed Machine',
        );
        const machine: ManagedSshMachine = {
            ...current,
            name: patch.name === undefined ? current.name : patch.name,
            connection: {
                kind: 'ssh',
                host: patch.host === undefined ? current.connection.host : patch.host,
                user: patch.user === undefined ? current.connection.user : patch.user,
                port: patch.port === undefined ? current.connection.port : patch.port,
            },
        };
        this.assertUniqueMachineName(machine.name, machineId);
        const transaction: ManagedCatalogTransaction = { machines: { [machineId]: machine } };
        const hostId = hostEnvironmentId(machineId);
        if (!this.document.environments[hostId]
            || !nonNullValues(this.document.environments[hostId]).some(environment =>
                environment.machineId === machineId && environment.kind === 'host')) {
            transaction.environments = {
                [hostId]: { id: hostId, machineId, kind: 'host', name: 'Host' },
            };
            const layout = this.getCatalog().layout;
            layout.environmentIdsByMachine[machineId] ||= [];
            if (!layout.environmentIdsByMachine[machineId].includes(hostId)) {
                layout.environmentIdsByMachine[machineId].unshift(hostId);
            }
            layout.projectIdsByEnvironment[hostId] ||= [];
            transaction.layout = layout;
        }
        this.commit(transaction);
        return cloneManagedValue(machine);
    }

    addDevContainer(
        machineId: string,
        name: string,
        anchor: DevContainerLaunchAnchorV1,
    ): ManagedEnvironment {
        singleValue<ManagedSshMachine>(this.document.machines[machineId], 'Managed Machine');
        const environmentId = this.createId('environment');
        const environment: ManagedEnvironment = {
            id: environmentId,
            machineId,
            kind: 'devContainer',
            name,
            devContainerAnchor: cloneManagedValue(anchor),
        };
        const layout = this.getCatalog().layout;
        layout.environmentIdsByMachine[machineId] ||= [];
        layout.environmentIdsByMachine[machineId].push(environmentId);
        layout.projectIdsByEnvironment[environmentId] = [];
        this.commit({ environments: { [environmentId]: environment }, layout });
        return cloneManagedValue(environment);
    }

    addProject(input: AddManagedProjectInput): ManagedRemoteProject {
        singleValue<ManagedEnvironment>(
            this.document.environments[input.environmentId],
            'Managed Environment',
        );
        const projectId = input.id || this.createId('project');
        if (this.document.projects[projectId]
            && nonNullValues(this.document.projects[projectId]).length) {
            throw new Error('Managed Project ID already exists.');
        }
        const project: ManagedRemoteProject = {
            id: projectId,
            environmentId: input.environmentId,
            name: input.name,
            remotePath: input.remotePath,
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.tags === undefined ? {} : { tags: normalizeTags(input.tags) }),
            ...(input.color === undefined ? {} : { color: input.color }),
            ...(input.favorite === undefined ? {} : { favorite: input.favorite }),
        };
        const layout = this.getCatalog().layout;
        layout.projectIdsByEnvironment[input.environmentId] ||= [];
        layout.projectIdsByEnvironment[input.environmentId].push(projectId);
        if (project.favorite) {
            layout.favoriteProjectIds.push(projectId);
        }
        this.commit({ projects: { [projectId]: project }, layout });
        return cloneManagedValue(project);
    }

    editProject(projectId: string, patch: EditManagedProjectInput): ManagedRemoteProject {
        const current = singleValue<ManagedRemoteProject>(
            this.document.projects[projectId],
            'Managed Project',
        );
        const project = cloneManagedValue(current);
        if (patch.name !== undefined) { project.name = patch.name; }
        if (patch.remotePath !== undefined) { project.remotePath = patch.remotePath; }
        if (patch.description === null) { delete project.description; }
        else if (patch.description !== undefined) { project.description = patch.description; }
        if (patch.tags === null) { delete project.tags; }
        else if (patch.tags !== undefined) { project.tags = normalizeTags(patch.tags); }
        if (patch.color === null) { delete project.color; }
        else if (patch.color !== undefined) { project.color = patch.color; }
        if (patch.favorite !== undefined) { project.favorite = patch.favorite; }
        const layout = this.getCatalog().layout;
        layout.favoriteProjectIds = layout.favoriteProjectIds.filter(id => id !== projectId);
        if (project.favorite) { layout.favoriteProjectIds.push(projectId); }
        this.commit({ projects: { [projectId]: project }, layout });
        return cloneManagedValue(project);
    }

    removeProject(projectId: string): void {
        singleValue<ManagedRemoteProject>(this.document.projects[projectId], 'Managed Project');
        this.commit({
            projects: { [projectId]: null },
            layout: removeFromLayout(this.getCatalog().layout, { projectId }),
        });
    }

    removeEnvironment(environmentId: string): void {
        const environment = singleValue<ManagedEnvironment>(
            this.document.environments[environmentId],
            'Managed Environment',
        );
        if (environment.kind === 'host') {
            throw new Error('The fixed Host Environment cannot be removed independently.');
        }
        if (this.hasLiveProjectPlacement(environmentId)) {
            throw new Error('Remove Projects from this Environment first.');
        }
        this.commit({
            environments: { [environmentId]: null },
            layout: removeFromLayout(this.getCatalog().layout, { environmentId }),
        });
    }

    removeMachine(machineId: string): void {
        singleValue<ManagedSshMachine>(this.document.machines[machineId], 'Managed Machine');
        const environmentIds = Object.entries(this.document.environments)
            .filter(([, register]) => nonNullValues(register)
                .some(environment => environment.machineId === machineId))
            .map(([environmentId]) => environmentId);
        for (const environmentId of environmentIds) {
            const kinds = new Set(nonNullValues(this.document.environments[environmentId])
                .map(environment => environment.kind));
            if (kinds.size !== 1 || !kinds.has('host')) {
                throw new Error('Remove Dev Container Environments before removing this Machine.');
            }
            if (this.hasLiveProjectPlacement(environmentId)) {
                throw new Error('Remove Projects from this Machine first.');
            }
        }
        const environments: Record<string, null> = {};
        for (const environmentId of environmentIds) {
            environments[environmentId] = null;
        }
        this.commit({
            machines: { [machineId]: null },
            environments,
            layout: environmentIds.reduce(
                (layout, environmentId) => removeFromLayout(layout, { environmentId }),
                removeFromLayout(this.getCatalog().layout, { machineId }),
            ),
        });
    }

    resolveMachineConflict(machineId: string, selected: ManagedSshMachine): ManagedSshMachine {
        if (!selected || selected.id !== machineId) {
            throw new Error('Conflict resolution must retain the Managed Machine ID.');
        }
        this.assertUniqueMachineName(selected.name, machineId);
        const hostId = hostEnvironmentId(machineId);
        const transaction: ManagedCatalogTransaction = {
            machines: { [machineId]: cloneManagedValue(selected) },
        };
        if (!this.document.environments[hostId]
            || !nonNullValues(this.document.environments[hostId]).some(environment =>
                environment.machineId === machineId && environment.kind === 'host')) {
            transaction.environments = {
                [hostId]: { id: hostId, machineId, kind: 'host', name: 'Host' },
            };
            const layout = this.getCatalog().layout;
            layout.environmentIdsByMachine[machineId] ||= [];
            if (!layout.environmentIdsByMachine[machineId].includes(hostId)) {
                layout.environmentIdsByMachine[machineId].unshift(hostId);
            }
            layout.projectIdsByEnvironment[hostId] ||= [];
            transaction.layout = layout;
        }
        this.commit(transaction);
        return cloneManagedValue(selected);
    }

    private hasLiveProjectPlacement(environmentId: string): boolean {
        return Object.values(this.document.projects).some(register =>
            nonNullValues(register).some(project => project.environmentId === environmentId));
    }

    private assertUniqueMachineName(name: string, exceptMachineId?: string): void {
        const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
        const duplicate = Object.entries(this.document.machines).some(([machineId, register]) =>
            machineId !== exceptMachineId
            && nonNullValues(register).some(machine =>
                machine.name.trim().toLowerCase() === key));
        if (duplicate) {
            throw new Error('Managed Machine names must be unique.');
        }
    }

    private commit(transaction: ManagedCatalogTransaction): void {
        const before = new Set(collectManagedCatalogStructuralConflicts(this.document)
            .map(conflict => stableManagedValue(conflict)));
        const candidate = applyManagedCatalogTransaction(this.document, this.actorId, transaction);
        const introduced = collectManagedCatalogStructuralConflicts(candidate)
            .filter(conflict => !before.has(stableManagedValue(conflict)));
        if (introduced.length) {
            throw new Error(`Managed catalog structure is invalid: ${introduced[0].kind}.`);
        }
        this.document = candidate;
    }
}
