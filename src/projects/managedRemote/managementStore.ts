'use strict';

import {
    AddManagedMachineInput,
    AddManagedMachineProjectInput,
    AddManagedDevContainerProjectInput,
    AddManagedProjectInput,
    EditManagedMachineInput,
    EditManagedProjectInput,
    ManagedRemoteCatalogService,
} from './catalogService';
import { distinctCandidateValues } from './causal';
import { createEmptyManagedRemoteCatalog, materializeManagedRemoteCatalog } from './merge';
import {
    ManagedRemoteManagementSnapshot,
    ManagedRemoteManagementStore,
} from './managementController';
import { ManagedCatalogCoordinator, ManagedCatalogReconcileResult } from './store';
import {
    ManagedAuthorityState,
    ManagedRemoteCatalogV1,
    ManagedSshMachine,
} from './types';

function authorityState(result: ManagedCatalogReconcileResult): ManagedAuthorityState {
    const values = distinctCandidateValues(result.envelope.authority);
    if (result.recoveryRequired || values.length !== 1) {
        throw new Error('Managed Remote catalog recovery is required.');
    }
    return values[0];
}

function machineConflictCandidates(
    document: ManagedRemoteCatalogV1,
): Record<string, ManagedSshMachine[]> {
    const result: Record<string, ManagedSshMachine[]> = {};
    for (const [machineId, register] of Object.entries(document.machines)) {
        const candidates = distinctCandidateValues(register);
        const values = candidates
            .filter((value): value is ManagedSshMachine => value !== null);
        if (candidates.length > 1 && values.length) { result[machineId] = values; }
    }
    return result;
}

export class ManagedRemoteCatalogManagementStore implements ManagedRemoteManagementStore {
    private pendingMutation: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly coordinator: ManagedCatalogCoordinator,
        private readonly catalogActorId: string,
        private readonly createId?: (prefix: string) => string,
    ) {
    }

    async getSnapshot(): Promise<ManagedRemoteManagementSnapshot> {
        return this.snapshot(await this.coordinator.reconcile());
    }

    addMachine(
        expectedRevisionId: string | null,
        input: AddManagedMachineInput,
    ): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => { service.addMachine(input); });
    }

    addMachineProject(
        expectedRevisionId: string | null,
        input: AddManagedMachineProjectInput,
    ): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => {
            service.addMachineProject(input);
        });
    }

    editMachine(
        expectedRevisionId: string | null,
        machineId: string,
        input: EditManagedMachineInput,
    ): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => {
            service.editMachine(machineId, input);
        });
    }

    removeMachine(
        expectedRevisionId: string | null,
        machineId: string,
    ): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => { service.removeMachine(machineId); });
    }

    addProject(
        expectedRevisionId: string | null,
        input: AddManagedProjectInput,
    ): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => { service.addProject(input); });
    }

    addDevContainerProject(
        expectedRevisionId: string | null,
        input: AddManagedDevContainerProjectInput,
    ): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => {
            service.addDevContainerProject(input);
        });
    }

    editProject(
        expectedRevisionId: string | null,
        projectId: string,
        input: EditManagedProjectInput,
    ): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => {
            service.editProject(projectId, input);
        });
    }

    removeProject(
        expectedRevisionId: string | null,
        projectId: string,
    ): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => { service.removeProject(projectId); });
    }

    resolveMachineConflict(
        expectedRevisionId: string | null,
        machineId: string,
        selected: ManagedSshMachine,
    ): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => {
            service.resolveMachineConflict(machineId, selected);
        });
    }

    private mutate(
        expectedRevisionId: string | null,
        change: (service: ManagedRemoteCatalogService) => void,
    ): Promise<ManagedRemoteManagementSnapshot> {
        const operation = this.pendingMutation.then(() =>
            this.mutateNow(expectedRevisionId, change));
        this.pendingMutation = operation.catch(() => undefined);
        return operation;
    }

    private async mutateNow(
        expectedRevisionId: string | null,
        change: (service: ManagedRemoteCatalogService) => void,
    ): Promise<ManagedRemoteManagementSnapshot> {
        const reconciled = await this.coordinator.reconcile();
        const authority = authorityState(reconciled);
        const current = authority.active?.document
            || createEmptyManagedRemoteCatalog(this.catalogActorId);
        const actualRevisionId = authority.active?.revisionId || null;
        if (actualRevisionId !== expectedRevisionId) {
            throw new Error('The Managed Remote catalog changed. Refresh and try again.');
        }
        const service = new ManagedRemoteCatalogService(
            current,
            this.catalogActorId,
            this.createId,
        );
        change(service);
        const stageId = await this.coordinator.stageCatalog(service.getDocument());
        await this.coordinator.activateStagedCatalog(stageId);
        return this.snapshot(await this.coordinator.reconcile());
    }

    private snapshot(result: ManagedCatalogReconcileResult): ManagedRemoteManagementSnapshot {
        const authority = authorityState(result);
        const document = authority.active?.document
            || createEmptyManagedRemoteCatalog(this.catalogActorId);
        return {
            revisionId: authority.active?.revisionId || null,
            lifecycle: authority.lifecycle,
            catalog: materializeManagedRemoteCatalog(document),
            machineConflictCandidates: machineConflictCandidates(document),
        };
    }
}
