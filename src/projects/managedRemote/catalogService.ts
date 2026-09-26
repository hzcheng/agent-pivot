'use strict';

import { machineSshAlias, isManagedSshAliasForMachine } from './sshAlias';

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
import { managedJumpAlias, managedJumpRoute } from './jumpRoutes';
import { normalizePosixPath } from '../projectPathUtils';

export interface PortableSshHop {
    name: string;
    host: string;
    user: string;
    port: number;
}

export interface AddManagedMachineInput {
    name: string;
    host: string;
    user: string;
    port?: number;
    proxyJump?: string;
    sshConfigAlias?: string;
    sourceSshAliases?: string[];
    jumpHosts?: PortableSshHop[];
}

export interface EditManagedMachineInput {
    jumpHosts?: PortableSshHop[];
    name?: string;
    host?: string;
    user?: string;
    port?: number;
    proxyJump?: string | null;
    sshConfigAlias?: string | null;
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

export interface AddManagedDevContainerProjectInput {
    machineId: string;
    environmentName: string;
    anchor: DevContainerLaunchAnchorV1;
    project: Omit<AddManagedProjectInput, 'environmentId'>;
}

export interface AddManagedMachineProjectInput {
    machine: AddManagedMachineInput;
    project: Omit<AddManagedProjectInput, 'environmentId'>;
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

    private importJumpHosts(hops: PortableSshHop[]): string | undefined {
        if (hops.length > 8) { throw new Error('A connection supports at most eight jump hosts.'); }
        let parent: string | undefined;
        const endpoints = new Set<string>();
        for (const hop of hops) {
            const identity = `${hop.user}@${hop.host.toLowerCase()}:${hop.port}`;
            if (endpoints.has(identity)) { throw new Error('The imported jump route contains a cycle.'); }
            endpoints.add(identity);
            const matches = this.getCatalog().machines.filter(machine => !machine.connection.sshConfigAlias
                && machine.connection.host.toLowerCase() === hop.host.toLowerCase()
                && machine.connection.user === hop.user && machine.connection.port === hop.port
                && machine.connection.proxyJump === parent);
            if (matches.length > 1) { throw new Error(`Multiple saved jump hosts match ${hop.name}. Resolve the duplicate connections first.`); }
            const machine = matches[0] || this.addMachine({ ...hop, proxyJump: parent });
            parent = managedJumpAlias(machine.id);
        }
        return parent;
    }

    addMachine(input: AddManagedMachineInput): ManagedSshMachine {
        if (input.jumpHosts) {
            const before = cloneManagedValue(this.document);
            try { return this.addMachine({ ...input, jumpHosts: undefined, proxyJump: this.importJumpHosts(input.jumpHosts), sshConfigAlias: undefined }); }
            catch (error) { this.document = before; throw error; }
        }
        this.assertUniqueMachineName(input.name, input.host);
        const machineId = this.createId('machine');
        const machine: ManagedSshMachine = {
            id: machineId,
            name: input.name,
            ...(input.sourceSshAliases?.length
                ? { sourceSshAliases: Array.from(new Set(input.sourceSshAliases)).sort() }
                : {}),
            connection: {
                kind: 'ssh',
                host: input.host,
                user: input.user,
                port: input.port === undefined ? 22 : input.port,
                ...(input.proxyJump ? { proxyJump: input.proxyJump } : {}),
                ...(input.sshConfigAlias ? { sshConfigAlias: input.sshConfigAlias } : {}),
            },
        };
        const proposed = this.getCatalog();
        proposed.machines.push(machine);
        managedJumpRoute(proposed, machine);
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
        if (patch.jumpHosts) {
            const before = cloneManagedValue(this.document);
            try { return this.editMachine(machineId, { ...patch, jumpHosts: undefined, proxyJump: this.importJumpHosts(patch.jumpHosts) || null, sshConfigAlias: null }); }
            catch (error) { this.document = before; throw error; }
        }
        const current = singleValue<ManagedSshMachine>(
            this.document.machines[machineId],
            'Managed Machine',
        );
        const machine: ManagedSshMachine = {
            ...current,
            name: patch.name === undefined ? current.name : patch.name,
            connection: {
                ...current.connection,
                kind: 'ssh',
                host: patch.host === undefined ? current.connection.host : patch.host,
                user: patch.user === undefined ? current.connection.user : patch.user,
                port: patch.port === undefined ? current.connection.port : patch.port,
            },
        };
        for (const key of ['proxyJump', 'sshConfigAlias'] as const) {
            if (patch[key] === null) { delete machine.connection[key]; }
            else if (patch[key] !== undefined) { machine.connection[key] = patch[key]!; }
        }
        this.assertSharedJumpHostIsPortable(machine);
        this.assertUniqueMachineName(machine.name, machine.connection.host, machineId);
        const proposed = this.getCatalog();
        proposed.machines = proposed.machines.map(value => value.id === machineId ? machine : value);
        managedJumpRoute(proposed, machine);
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
        const remotePath = normalizePosixPath(input.remotePath);
        const existing = this.getCatalog().projects.find(project =>
            project.environmentId === input.environmentId
            && normalizePosixPath(project.remotePath) === remotePath);
        if (existing) { return cloneManagedValue(existing); }
        const projectId = input.id || this.createId('project');
        if (this.document.projects[projectId]
            && nonNullValues(this.document.projects[projectId]).length) {
            throw new Error('Managed Project ID already exists.');
        }
        const project: ManagedRemoteProject = {
            id: projectId,
            environmentId: input.environmentId,
            name: input.name,
            remotePath,
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

    /**
     * The current workspace has already proved both the SSH connection and its
     * path. Persist its newly adopted Machine, fixed Host Environment, and
     * Project through the single surrounding catalog transaction.
     */
    addMachineProject(input: AddManagedMachineProjectInput): ManagedRemoteProject {
        const sourceAliases = new Set(input.machine.sourceSshAliases || []);
        const matchingMachines = sourceAliases.size
            ? this.getCatalog().machines.filter(machine =>
                machine.sourceSshAliases?.some(alias => sourceAliases.has(alias)))
            : [];
        if (matchingMachines.length > 1) {
            throw new Error('Current SSH target matches multiple Managed Machines.');
        }
        if (matchingMachines.length === 1) {
            return this.addProject({
                ...input.project,
                environmentId: hostEnvironmentId(matchingMachines[0].id),
            });
        }
        const machine = this.addMachine(input.machine);
        return this.addProject({
            ...input.project,
            environmentId: hostEnvironmentId(machine.id),
        });
    }

    addDevContainerProject(
        input: AddManagedDevContainerProjectInput,
    ): ManagedRemoteProject {
        const environment = this.addDevContainer(
            input.machineId,
            input.environmentName,
            input.anchor,
        );
        return this.addProject({
            ...input.project,
            environmentId: environment.id,
        });
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

    /** Remove only catalog records in one causal transaction; remote files are untouched. */
    removeMachine(machineId: string): void {
        singleValue<ManagedSshMachine>(this.document.machines[machineId], 'Managed Machine');
        const alias = managedJumpAlias(machineId);
        const dependents = Object.values(this.document.machines).reduce<ManagedSshMachine[]>((values, register) => values.concat(nonNullValues(register)), []).filter(machine => (machine.connection.proxyJump || '').split(',').includes(alias));
        if (dependents.length) { throw new Error(`This jump host is used by ${dependents.map(value => value.name).join(', ')}. Change their routes before removing it.`); }
        const environmentIds = Object.entries(this.document.environments)
            .filter(([, register]) => nonNullValues(register)
                .some(environment => environment.machineId === machineId))
            .map(([environmentId]) => environmentId);
        const transaction = this.removeEnvironmentRecords(environmentIds);
        transaction.machines = { [machineId]: null };
        transaction.layout = removeFromLayout(transaction.layout!, { machineId });
        this.commit(transaction);
    }

    resolveProjectConflict(projectId: string, selected: ManagedRemoteProject | null): void {
        const values = this.document.projects[projectId] ? nonNullValues(this.document.projects[projectId]) : [];
        const removesOrphan = selected === null && values.length > 0
            && values.every(value => !this.hasLiveEnvironmentParent(value.environmentId));
        if (!removesOrphan) { this.assertConflictCandidate(this.document.projects[projectId], selected, 'Project'); }
        const layout = removeFromLayout(this.getCatalog().layout, { projectId });
        if (selected) {
            singleValue(this.document.environments[selected.environmentId], 'Parent Environment');
            layout.projectIdsByEnvironment[selected.environmentId] ||= [];
            layout.projectIdsByEnvironment[selected.environmentId].push(projectId);
            if (selected.favorite) { layout.favoriteProjectIds.push(projectId); }
        }
        this.commit({ projects: { [projectId]: cloneManagedValue(selected) }, layout });
    }

    resolveEnvironmentConflict(environmentId: string, selected: ManagedEnvironment | null): void {
        const values = this.document.environments[environmentId] ? nonNullValues(this.document.environments[environmentId]) : [];
        const removesOrphan = selected === null && values.length > 0
            && values.every(value => !this.hasLiveMachineParent(value.machineId));
        if (!removesOrphan) { this.assertConflictCandidate(this.document.environments[environmentId], selected, 'Environment'); }
        if (!selected) {
            const hasLiveHostParent = nonNullValues(this.document.environments[environmentId])
                .some(environment => environment.kind === 'host'
                    && this.hasLiveMachineParent(environment.machineId));
            if (hasLiveHostParent) {
                throw new Error('Keep the Host Environment, or remove its Machine and saved Projects together.');
            }
            this.commit(this.removeEnvironmentRecords([environmentId]));
            return;
        }
        singleValue(this.document.machines[selected.machineId], 'Parent Machine');
        const layout = removeFromLayout(this.getCatalog().layout, { environmentId });
        layout.environmentIdsByMachine[selected.machineId] ||= [];
        layout.environmentIdsByMachine[selected.machineId].push(environmentId);
        layout.projectIdsByEnvironment[environmentId] = this.getCatalog().layout.projectIdsByEnvironment[environmentId] || [];
        this.commit({ environments: { [environmentId]: cloneManagedValue(selected) }, layout });
    }

    private hasLiveMachineParent(machineId: string): boolean {
        const register = this.document.machines[machineId];
        return Boolean(register && nonNullValues(register).length);
    }

    private hasLiveEnvironmentParent(environmentId: string): boolean {
        const register = this.document.environments[environmentId];
        return Boolean(register && nonNullValues(register).some(environment => this.hasLiveMachineParent(environment.machineId)));
    }

    private assertConflictCandidate<T>(
        register: VersionedCandidates<T | null> | undefined,
        selected: T | null,
        label: string,
    ): void {
        const candidates = register ? distinctCandidateValues(register) : [];
        if (candidates.length < 2) { throw new Error(`${label} no longer has concurrent changes.`); }
        if (!candidates.some(value => stableManagedValue(value) === stableManagedValue(selected))) {
            throw new Error(`Select an existing ${label} conflict version.`);
        }
    }

    private removeEnvironmentRecords(environmentIds: string[]): ManagedCatalogTransaction {
        const removed = new Set(environmentIds);
        const projectIds = Object.entries(this.document.projects)
            .filter(([, register]) => nonNullValues(register)
                .some(project => removed.has(project.environmentId)))
            .map(([projectId]) => projectId);
        for (const projectId of projectIds) {
            if (nonNullValues(this.document.projects[projectId]).some(project => !removed.has(project.environmentId))) {
                throw new Error('Resolve Project placement conflicts before removing this Machine or Environment.');
            }
        }
        let layout = this.getCatalog().layout;
        for (const projectId of projectIds) { layout = removeFromLayout(layout, { projectId }); }
        for (const environmentId of environmentIds) { layout = removeFromLayout(layout, { environmentId }); }
        const environments: Record<string, null> = {};
        const projects: Record<string, null> = {};
        for (const id of environmentIds) { environments[id] = null; }
        for (const id of projectIds) { projects[id] = null; }
        return { environments, projects, layout };
    }

    resolveMachineConflict(machineId: string, selected: ManagedSshMachine): ManagedSshMachine {
        this.assertConflictCandidate(this.document.machines[machineId], selected, 'Machine');
        if (!selected || selected.id !== machineId) {
            throw new Error('Conflict resolution must retain the Managed Machine ID.');
        }
        this.assertSharedJumpHostIsPortable(selected);
        this.assertUniqueMachineName(
            selected.name,
            selected.connection.host,
            machineId,
        );
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

    private assertSharedJumpHostIsPortable(machine: ManagedSshMachine): void {
        if (machine.connection.sshConfigAlias && Object.values(this.document.machines).some(register =>
            nonNullValues(register).some(value =>
                (value.connection.proxyJump || '').split(',').includes(managedJumpAlias(machine.id))))) {
            throw new Error('A shared jump host must keep synced connection settings. Change its dependents before switching to a local SSH reference.');
        }
    }

    private hasLiveProjectPlacement(environmentId: string): boolean {
        return Object.values(this.document.projects).some(register =>
            nonNullValues(register).some(project => project.environmentId === environmentId));
    }

    private assertUniqueMachineName(
        name: string,
        _connectionHost: string,
        exceptMachineId?: string,
    ): void {
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
        for (const [id, machine] of Object.entries(transaction.machines || {})) {
            if (!machine) { continue; }
            const alias = machineSshAlias(machine).toLowerCase();
            if (machine.connection.sshConfigAlias && [id, ...Object.keys(this.document.machines)]
                .some(ownerId => isManagedSshAliasForMachine(alias, ownerId))) {
                throw new Error('This SSH alias is generated by Agent Pivot. Keep its managed connection, or use the original alias from your SSH configuration.');
            }
            const collision = Object.entries(this.document.machines).some(([otherId, register]) =>
                otherId !== id && nonNullValues(register).some(other => machineSshAlias(other).toLowerCase() === alias));
            if (collision) { throw new Error('This SSH alias already belongs to another Machine. Use that Machine or choose a different SSH alias.'); }
        }
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
