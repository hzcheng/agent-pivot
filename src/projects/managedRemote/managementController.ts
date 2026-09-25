'use strict';

import type {
    AddManagedMachineInput,
    AddManagedMachineProjectInput,
    AddManagedDevContainerProjectInput,
    AddManagedProjectInput,
    EditManagedMachineInput,
    EditManagedProjectInput,
} from './catalogService';
import {
    createManagedRemoteManagementSettlement,
    ManagedRemoteMachineInput,
    ManagedRemoteProjectInput,
    ManagedRemoteManagementOperation,
    ManagedRemoteManagementSettlement,
    parseManagedRemoteManagementRequest,
    readManagedRemoteManagementCorrelation,
} from './managementProtocol';
import type {
    ManagedEnvironment,
    ManagedRemoteProject,
    ManagedSshMachine,
    MaterializedManagedRemoteCatalog,
} from './types';

export interface ManagedRemoteManagementSnapshot {
    revisionId: string | null;
    lifecycle: 'disabled' | 'active';
    catalog: MaterializedManagedRemoteCatalog;
    machineConflictCandidates: Record<string, ManagedSshMachine[]>;
    projectConflictCandidates?: Record<string, Array<ManagedRemoteProject | null>>;
    environmentConflictCandidates?: Record<string, Array<ManagedEnvironment | null>>;
    machineRemovalCounts?: Record<string, { projectCount: number; environmentCount: number }>;
    environmentRemovalProjectCounts?: Record<string, number>;
}

export interface ManagedRemoteManagementStore {
    getSnapshot(): Promise<ManagedRemoteManagementSnapshot>;
    addMachine(expectedRevisionId: string | null, input: AddManagedMachineInput): Promise<ManagedRemoteManagementSnapshot>;
    addMachineProject(expectedRevisionId: string | null, input: AddManagedMachineProjectInput): Promise<ManagedRemoteManagementSnapshot>;
    editMachine(expectedRevisionId: string | null, machineId: string, input: EditManagedMachineInput): Promise<ManagedRemoteManagementSnapshot>;
    removeMachine(expectedRevisionId: string | null, machineId: string): Promise<ManagedRemoteManagementSnapshot>;
    addProject(expectedRevisionId: string | null, input: AddManagedProjectInput): Promise<ManagedRemoteManagementSnapshot>;
    addDevContainerProject(expectedRevisionId: string | null, input: AddManagedDevContainerProjectInput): Promise<ManagedRemoteManagementSnapshot>;
    editProject(expectedRevisionId: string | null, projectId: string, input: EditManagedProjectInput): Promise<ManagedRemoteManagementSnapshot>;
    removeProject(expectedRevisionId: string | null, projectId: string): Promise<ManagedRemoteManagementSnapshot>;
    resolveProjectConflict?(expectedRevisionId: string | null, projectId: string, selected: ManagedRemoteProject | null): Promise<ManagedRemoteManagementSnapshot>;
    resolveEnvironmentConflict?(expectedRevisionId: string | null, environmentId: string, selected: ManagedEnvironment | null): Promise<ManagedRemoteManagementSnapshot>;
    resolveMachineConflict(expectedRevisionId: string | null, machineId: string, selected: ManagedSshMachine): Promise<ManagedRemoteManagementSnapshot>;
}

export interface ManagedRemoteManagementPrompts {
    importMachine?(): Promise<AddManagedMachineInput | undefined>;
    addMachine(): Promise<AddManagedMachineInput | undefined>;
    adoptCurrentSshProject(input: AddManagedMachineProjectInput['project'] & { sshAlias: string }): Promise<AddManagedMachineInput | undefined>;
    editMachine(machine: ManagedSshMachine, affectedProjectCount: number): Promise<EditManagedMachineInput | undefined>;
    confirmRemoveMachine(machine: ManagedSshMachine, counts?: { projectCount: number; environmentCount: number }): Promise<boolean>;
    chooseMachineForProject(machines: ManagedSshMachine[]): Promise<ManagedSshMachine | undefined>;
    addProject(
        machine: ManagedSshMachine,
        environments: ManagedEnvironment[],
    ): Promise<AddManagedProjectInput | undefined>;
    editProject(project: ManagedRemoteProject): Promise<EditManagedProjectInput | undefined>;
    confirmRemoveProject(project: ManagedRemoteProject): Promise<boolean>;
    resolveProjectConflict?(projectId: string, candidates: Array<ManagedRemoteProject | null>, environmentNames?: Record<string, string>, allowOrphanRemoval?: boolean): Promise<ManagedRemoteProject | null | undefined>;
    resolveEnvironmentConflict?(environmentId: string, candidates: Array<ManagedEnvironment | null>, projectCount: number, machineNames?: Record<string, string>, allowOrphanRemoval?: boolean): Promise<ManagedEnvironment | null | undefined>;
    resolveMachineConflict(machineId: string, candidates: ManagedSshMachine[]): Promise<ManagedSshMachine | undefined>;
}

export interface ManagedRemoteManagementControllerOptions {
    store: ManagedRemoteManagementStore;
    prompts: ManagedRemoteManagementPrompts;
    refreshAuthoritative: (
        requestId: string,
        operation: ManagedRemoteManagementOperation,
        snapshot: ManagedRemoteManagementSnapshot,
    ) => Promise<void>;
    postSettlement: (settlement: ManagedRemoteManagementSettlement) => Promise<void>;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function findMachine(
    snapshot: ManagedRemoteManagementSnapshot,
    machineId: string,
): ManagedSshMachine {
    const machine = snapshot.catalog.machines.find(value => value.id === machineId);
    if (!machine) { throw new Error('Managed Machine no longer exists.'); }
    return machine;
}

function findProject(
    snapshot: ManagedRemoteManagementSnapshot,
    projectId: string,
): ManagedRemoteProject {
    const project = snapshot.catalog.projects.find(value => value.id === projectId);
    if (!project) { throw new Error('Managed Project no longer exists.'); }
    return project;
}

function affectedProjectCount(
    snapshot: ManagedRemoteManagementSnapshot,
    machineId: string,
): number {
    const environmentIds = new Set(snapshot.catalog.environments
        .filter(environment => environment.machineId === machineId)
        .map(environment => environment.id));
    return snapshot.catalog.projects
        .filter(project => environmentIds.has(project.environmentId)).length;
}

export class ManagedRemoteManagementController {
    constructor(private readonly options: ManagedRemoteManagementControllerOptions) {
    }

    /**
     * Add a Project directly, without the wizard.
     *
     * Saving the open window already determines the Environment and the path, so
     * prompting for them would only invite a typo that stops the Project from
     * being recognised as saved.
     */
    async addProjectDirectly(
        input: AddManagedProjectInput,
    ): Promise<ManagedRemoteManagementSnapshot> {
        const current = await this.options.store.getSnapshot();
        const result = await this.options.store.addProject(current.revisionId, input);
        await this.options.refreshAuthoritative('save-workspace', 'addProject', result);
        return result;
    }

    /** Save an already-open SSH workspace after the user explicitly adopts its Machine. */
    async addCurrentSshProject(
        project: AddManagedMachineProjectInput['project'] & { sshAlias: string },
    ): Promise<boolean> {
        const machine = await this.options.prompts.adoptCurrentSshProject(project);
        if (!machine) { return false; }
        const current = await this.options.store.getSnapshot();
        const result = await this.options.store.addMachineProject(current.revisionId, {
            machine: { ...machine, sourceSshAliases: [project.sshAlias] },
            project: { name: project.name, remotePath: project.remotePath },
        });
        await this.options.refreshAuthoritative('save-workspace', 'addMachine', result);
        return true;
    }

    async addDevContainerProjectDirectly(
        input: AddManagedDevContainerProjectInput,
    ): Promise<ManagedRemoteManagementSnapshot> {
        const current = await this.options.store.getSnapshot();
        const result = await this.options.store.addDevContainerProject(
            current.revisionId,
            input,
        );
        await this.options.refreshAuthoritative(
            'save-workspace',
            'addProject',
            result,
        );
        return result;
    }

    async handle(raw: unknown): Promise<void> {
        const correlation = readManagedRemoteManagementCorrelation(raw);
        if (!correlation) { return; }
        const request = parseManagedRemoteManagementRequest(raw);
        if (!request) {
            await this.options.postSettlement(createManagedRemoteManagementSettlement({
                ...correlation,
                status: 'failed',
                message: 'The Managed Remote action was invalid.',
            }));
            return;
        }
        try {
            const current = await this.options.store.getSnapshot();
            if (current.revisionId !== request.expectedRevisionId) {
                throw new Error('The Managed Remote catalog changed. Refresh and try again.');
            }
            const result = await this.run(request.operation, request.targetId, current, request.input);
            if (!result) {
                await this.options.postSettlement(createManagedRemoteManagementSettlement({
                    requestId: request.requestId,
                    operation: request.operation,
                    status: 'cancelled',
                }));
                return;
            }
            await this.options.refreshAuthoritative(
                request.requestId,
                request.operation,
                result,
            );
            await this.options.postSettlement(createManagedRemoteManagementSettlement({
                requestId: request.requestId,
                operation: request.operation,
                status: 'applied',
                ...(result.revisionId
                    ? { authoritativeRevisionId: result.revisionId } : {}),
            }));
        } catch (error) {
            await this.options.postSettlement(createManagedRemoteManagementSettlement({
                requestId: request.requestId,
                operation: request.operation,
                status: 'failed',
                message: errorMessage(error),
            }));
        }
    }

    private async run(
        operation: ManagedRemoteManagementOperation,
        targetId: string | undefined,
        snapshot: ManagedRemoteManagementSnapshot,
        input: ManagedRemoteMachineInput | ManagedRemoteProjectInput | undefined,
    ): Promise<ManagedRemoteManagementSnapshot | null> {
        if (operation === 'importMachine') {
            const machine = await this.options.prompts.importMachine?.();
            if (!machine) { return null; }
            const alias = machine.sshConfigAlias;
            const matches = alias ? snapshot.catalog.machines.filter(value =>
                value.connection.sshConfigAlias === alias || value.sourceSshAliases?.includes(alias)) : [];
            if (matches.length > 1) { throw new Error('This SSH alias belongs to multiple Machines. Edit their connections first.'); }
            if (matches.length === 1) {
                return this.options.store.editMachine(snapshot.revisionId, matches[0].id, {
                    host: machine.host, user: machine.user, port: machine.port,
                    proxyJump: null, sshConfigAlias: alias,
                });
            }
            return this.options.store.addMachine(snapshot.revisionId, machine);
        }
        if (operation === 'addMachine') {
            const machine = input as ManagedRemoteMachineInput | undefined || await this.options.prompts.addMachine();
            return machine
                ? this.options.store.addMachine(snapshot.revisionId, {
                    ...machine,
                    ...(machine.proxyJump === null ? { proxyJump: undefined } : {}),
                    ...(machine.sshConfigAlias === null ? { sshConfigAlias: undefined } : {}),
                }) : null;
        }
        if (operation === 'addProject') {
            const machine = targetId
                ? findMachine(snapshot, targetId)
                : await this.options.prompts.chooseMachineForProject(snapshot.catalog.machines);
            if (!machine) { return null; }
            const environments = snapshot.catalog.environments
                .filter(environment => environment.machineId === machine.id);
            const input = await this.options.prompts.addProject(machine, environments);
            return input
                ? this.options.store.addProject(snapshot.revisionId, input) : null;
        }
        if (!targetId) { throw new Error('The Managed Remote target is missing.'); }
        if (operation === 'editMachine') {
            const machine = findMachine(snapshot, targetId);
            const machineInput = input as ManagedRemoteMachineInput | undefined || await this.options.prompts.editMachine(
                machine,
                affectedProjectCount(snapshot, targetId),
            );
            return machineInput
                ? this.options.store.editMachine(snapshot.revisionId, targetId, machineInput) : null;
        }
        if (operation === 'removeMachine') {
            const machine = findMachine(snapshot, targetId);
            return await this.options.prompts.confirmRemoveMachine(machine, snapshot.machineRemovalCounts?.[targetId] || {
                projectCount: affectedProjectCount(snapshot, targetId),
                environmentCount: snapshot.catalog.environments.filter(value => value.machineId === targetId).length,
            })
                ? this.options.store.removeMachine(snapshot.revisionId, targetId) : null;
        }
        if (operation === 'editProject') {
            const project = findProject(snapshot, targetId);
            const projectInput = input as ManagedRemoteProjectInput | undefined || await this.options.prompts.editProject(project);
            return projectInput
                ? this.options.store.editProject(snapshot.revisionId, targetId, projectInput) : null;
        }
        if (operation === 'removeProject') {
            const project = findProject(snapshot, targetId);
            return await this.options.prompts.confirmRemoveProject(project)
                ? this.options.store.removeProject(snapshot.revisionId, targetId) : null;
        }
        if (operation === 'toggleFavorite') {
            const project = findProject(snapshot, targetId);
            return this.options.store.editProject(snapshot.revisionId, targetId, {
                favorite: project.favorite !== true,
            });
        }
        if (operation === 'resolveProjectConflict') {
            const candidates = snapshot.projectConflictCandidates?.[targetId] || [];
            const orphan = candidates.some(Boolean)
                && candidates.every(value => !value || !snapshot.catalog.environments.some(environment => environment.id === value.environmentId))
                && snapshot.catalog.conflicts.some(conflict => conflict.entityType === 'project' && conflict.entityId === targetId && conflict.kind === 'missing-parent');
            if (candidates.length < 2 && !orphan) { throw new Error('This Project no longer has a sync conflict.'); }
            const environmentNames: Record<string, string> = {};
            for (const environment of snapshot.catalog.environments) {
                const machine = snapshot.catalog.machines.find(value => value.id === environment.machineId);
                environmentNames[environment.id] = `${machine?.name || 'Unavailable Machine'} › ${environment.name}`;
            }
            const selected = await this.options.prompts.resolveProjectConflict?.(targetId, candidates, environmentNames, orphan);
            if (selected === undefined) { return null; }
            if (!this.options.store.resolveProjectConflict) { throw new Error('Project conflict recovery is unavailable.'); }
            return this.options.store.resolveProjectConflict(snapshot.revisionId, targetId, selected);
        }
        if (operation === 'resolveEnvironmentConflict') {
            const candidates = snapshot.environmentConflictCandidates?.[targetId] || [];
            const orphan = candidates.some(Boolean)
                && candidates.every(value => !value || !snapshot.catalog.machines.some(machine => machine.id === value.machineId))
                && snapshot.catalog.conflicts.some(conflict => conflict.entityType === 'environment' && conflict.entityId === targetId && conflict.kind === 'missing-parent');
            if (candidates.length < 2 && !orphan) { throw new Error('This Environment no longer has a sync conflict.'); }
            const projectIds = new Set(snapshot.catalog.projects.filter(value => value.environmentId === targetId).map(value => value.id));
            for (const [id, values] of Object.entries(snapshot.projectConflictCandidates || {})) {
                if (values.some(value => value?.environmentId === targetId)) { projectIds.add(id); }
            }
            const machineNames: Record<string, string> = {};
            for (const machine of snapshot.catalog.machines) { machineNames[machine.id] = machine.name; }
            const selected = await this.options.prompts.resolveEnvironmentConflict?.(targetId, candidates, snapshot.environmentRemovalProjectCounts?.[targetId] ?? projectIds.size, machineNames, orphan);
            if (selected === undefined) { return null; }
            if (!this.options.store.resolveEnvironmentConflict) { throw new Error('Environment conflict recovery is unavailable.'); }
            return this.options.store.resolveEnvironmentConflict(snapshot.revisionId, targetId, selected);
        }
        const candidates = snapshot.machineConflictCandidates[targetId] || [];
        if (!candidates.length) {
            throw new Error('The Managed Machine no longer has a connection conflict.');
        }
        const selected = await this.options.prompts.resolveMachineConflict(targetId, candidates);
        return selected
            ? this.options.store.resolveMachineConflict(snapshot.revisionId, targetId, selected)
            : null;
    }
}
