'use strict';

import type { Group } from '../../models';
import type {
    AddManagedMachineInput,
    AddManagedProjectInput,
    EditManagedMachineInput,
    EditManagedProjectInput,
} from './catalogService';
import type { ManagedRemoteMigrationPlanV1 } from './migrationPlan';
import {
    createManagedRemoteManagementSettlement,
    ManagedRemoteManagementOperation,
    ManagedRemoteManagementSettlement,
    parseManagedRemoteManagementRequest,
    readManagedRemoteManagementCorrelation,
} from './managementProtocol';
import type {
    ChecksummedLegacySnapshot,
    ManagedEnvironment,
    ManagedRemoteProject,
    ManagedSshMachine,
    MaterializedManagedRemoteCatalog,
} from './types';

export interface ManagedRemoteManagementSnapshot {
    revisionId: string | null;
    lifecycle: 'disabled' | 'preview' | 'active' | 'rolledBack';
    migrationPlanId?: string;
    catalog: MaterializedManagedRemoteCatalog;
    machineConflictCandidates: Record<string, ManagedSshMachine[]>;
}

export interface ManagedRemoteManagementStore {
    getSnapshot(): Promise<ManagedRemoteManagementSnapshot>;
    addMachine(expectedRevisionId: string | null, input: AddManagedMachineInput): Promise<ManagedRemoteManagementSnapshot>;
    editMachine(expectedRevisionId: string | null, machineId: string, input: EditManagedMachineInput): Promise<ManagedRemoteManagementSnapshot>;
    removeMachine(expectedRevisionId: string | null, machineId: string): Promise<ManagedRemoteManagementSnapshot>;
    addProject(expectedRevisionId: string | null, input: AddManagedProjectInput): Promise<ManagedRemoteManagementSnapshot>;
    editProject(expectedRevisionId: string | null, projectId: string, input: EditManagedProjectInput): Promise<ManagedRemoteManagementSnapshot>;
    removeProject(expectedRevisionId: string | null, projectId: string): Promise<ManagedRemoteManagementSnapshot>;
    resolveMachineConflict(expectedRevisionId: string | null, machineId: string, selected: ManagedSshMachine): Promise<ManagedRemoteManagementSnapshot>;
    prepareMigration(): ManagedRemoteMigrationPlanV1;
    beginMigration(expectedRevisionId: string | null, plan: ManagedRemoteMigrationPlanV1): Promise<ManagedRemoteManagementSnapshot>;
    finalizeMigrationCleanup(expectedRevisionId: string): Promise<ManagedRemoteManagementSnapshot>;
    rollbackMigration(expectedRevisionId: string): Promise<ManagedRemoteManagementSnapshot>;
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
    reviewMigration(plan: ManagedRemoteMigrationPlanV1): Promise<ManagedRemoteMigrationPlanV1 | undefined>;
}

export interface ManagedRemoteMigrationSource {
    getGroups(): Group[];
    getProjectData(): unknown;
    getProjectSyncData(): unknown;
    clearLegacyData(): Promise<void>;
    restoreLegacyData(snapshot: ChecksummedLegacySnapshot): Promise<void>;
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
            const result = await this.run(request.operation, request.targetId, current);
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
    ): Promise<ManagedRemoteManagementSnapshot | null> {
        if (operation === 'addMachine') {
            const input = await this.options.prompts.addMachine();
            return input
                ? this.options.store.addMachine(snapshot.revisionId, input) : null;
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
            const input = await this.options.prompts.editMachine(
                machine,
                affectedProjectCount(snapshot, targetId),
            );
            return input
                ? this.options.store.editMachine(snapshot.revisionId, targetId, input) : null;
        }
        if (operation === 'removeMachine') {
            const machine = findMachine(snapshot, targetId);
            return await this.options.prompts.confirmRemoveMachine(machine)
                ? this.options.store.removeMachine(snapshot.revisionId, targetId) : null;
        }
        if (operation === 'editProject') {
            const project = findProject(snapshot, targetId);
            const input = await this.options.prompts.editProject(project);
            return input
                ? this.options.store.editProject(snapshot.revisionId, targetId, input) : null;
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
        if (candidates.length < 2) {
            throw new Error('The Managed Machine no longer has a connection conflict.');
        }
        const selected = await this.options.prompts.resolveMachineConflict(targetId, candidates);
        return selected
            ? this.options.store.resolveMachineConflict(snapshot.revisionId, targetId, selected)
            : null;
    }
}
