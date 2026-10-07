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
    ManagedCatalogConflict,
    ManagedEnvironment,
    ManagedRemoteProject,
    VersionedCandidates,
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

function conflictCandidates<T>(registers: Record<string, VersionedCandidates<T | null>>, conflicts: ManagedCatalogConflict[], entityType: ManagedCatalogConflict['entityType']): Record<string, Array<T | null>> {
    const result: Record<string, Array<T | null>> = {};
    for (const [id, register] of Object.entries(registers)) {
        const values = distinctCandidateValues(register);
        if (values.length > 1 || conflicts.some(conflict => conflict.entityType === entityType
            && conflict.entityId === id && conflict.kind === 'missing-parent')) { result[id] = values; }
    }
    return result;
}

function environmentRemovalProjectCounts(document: ManagedRemoteCatalogV1): Record<string, number> {
    const result: Record<string, number> = {};
    for (const register of Object.values(document.projects)) {
        const ids = new Set(distinctCandidateValues(register).filter((value): value is ManagedRemoteProject => value !== null)
            .map(value => value.environmentId));
        for (const id of ids) { result[id] = (result[id] || 0) + 1; }
    }
    return result;
}

function machineRemovalCounts(document: ManagedRemoteCatalogV1): Record<string, { projectCount: number; environmentCount: number }> {
    const result: Record<string, { projectCount: number; environmentCount: number }> = {};
    for (const machineId of Object.keys(document.machines)) {
        const environments = new Set(Object.entries(document.environments)
            .filter(([, register]) => distinctCandidateValues(register).some(value => value?.machineId === machineId))
            .map(([id]) => id));
        const projectCount = Object.values(document.projects).filter(register =>
            distinctCandidateValues(register).some(value => value && environments.has(value.environmentId))).length;
        result[machineId] = { projectCount, environmentCount: environments.size };
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

    resolveProjectConflict(expectedRevisionId: string | null, projectId: string, selected: ManagedRemoteProject | null): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => { service.resolveProjectConflict(projectId, selected); });
    }

    resolveEnvironmentConflict(expectedRevisionId: string | null, environmentId: string, selected: ManagedEnvironment | null): Promise<ManagedRemoteManagementSnapshot> {
        return this.mutate(expectedRevisionId, service => { service.resolveEnvironmentConflict(environmentId, selected); });
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
        const catalog = materializeManagedRemoteCatalog(document);
        return {
            revisionId: authority.active?.revisionId || null,
            lifecycle: authority.lifecycle,
            catalog,
            machineConflictCandidates: machineConflictCandidates(document),
            projectConflictCandidates: conflictCandidates(document.projects, catalog.conflicts, 'project'),
            environmentConflictCandidates: conflictCandidates(document.environments, catalog.conflicts, 'environment'),
            machineRemovalCounts: machineRemovalCounts(document),
            environmentRemovalProjectCounts: environmentRemovalProjectCounts(document),
        };
    }
}
