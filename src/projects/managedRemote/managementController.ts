'use strict';

import type {
    AddManagedMachineInput,
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
}

export interface ManagedRemoteManagementStore {
    getSnapshot(): Promise<ManagedRemoteManagementSnapshot>;
    addMachine(expectedRevisionId: string | null, input: AddManagedMachineInput): Promise<ManagedRemoteManagementSnapshot>;
    editMachine(expectedRevisionId: string | null, machineId: string, input: EditManagedMachineInput): Promise<ManagedRemoteManagementSnapshot>;
    removeMachine(expectedRevisionId: string | null, machineId: string): Promise<ManagedRemoteManagementSnapshot>;
    addProject(expectedRevisionId: string | null, input: AddManagedProjectInput): Promise<ManagedRemoteManagementSnapshot>;
    addDevContainerProject(expectedRevisionId: string | null, input: AddManagedDevContainerProjectInput): Promise<ManagedRemoteManagementSnapshot>;
    editProject(expectedRevisionId: string | null, projectId: string, input: EditManagedProjectInput): Promise<ManagedRemoteManagementSnapshot>;
    removeProject(expectedRevisionId: string | null, projectId: string): Promise<ManagedRemoteManagementSnapshot>;
    resolveMachineConflict(expectedRevisionId: string | null, machineId: string, selected: ManagedSshMachine): Promise<ManagedRemoteManagementSnapshot>;
}

export interface ManagedRemoteManagementPrompts {
    addMachine(): Promise<AddManagedMachineInput | undefined>;
    editMachine(machine: ManagedSshMachine, affectedProjectCount: number): Promise<EditManagedMachineInput | undefined>;
    confirmRemoveMachine(machine: ManagedSshMachine): Promise<boolean>;
    chooseMachineForProject(machines: ManagedSshMachine[]): Promise<ManagedSshMachine | undefined>;
    addProject(
        machine: ManagedSshMachine,
        environments: ManagedEnvironment[],
    ): Promise<AddManagedProjectInput | undefined>;
    editProject(project: ManagedRemoteProject): Promise<EditManagedProjectInput | undefined>;
    confirmRemoveProject(project: ManagedRemoteProject): Promise<boolean>;
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
        if (operation === 'addMachine') {
            const machine = input as ManagedRemoteMachineInput | undefined || await this.options.prompts.addMachine();
            return machine
                ? this.options.store.addMachine(snapshot.revisionId, machine) : null;
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
            return await this.options.prompts.confirmRemoveMachine(machine)
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
