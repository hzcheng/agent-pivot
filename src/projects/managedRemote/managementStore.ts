'use strict';

import type { Group } from '../../models';

import {
    AddManagedMachineInput,
    AddManagedProjectInput,
    EditManagedMachineInput,
    EditManagedProjectInput,
    ManagedRemoteCatalogService,
} from './catalogService';
import { distinctCandidateValues } from './causal';
import { createEmptyManagedRemoteCatalog, materializeManagedRemoteCatalog } from './merge';
import {
    buildManagedCatalogFromMigrationPlan,
    buildManagedRemoteMigrationPlan,
    ManagedRemoteMigrationPlanV1,
} from './migrationPlan';
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
        const values = distinctCandidateValues(register)
            .filter((value): value is ManagedSshMachine => value !== null);
        if (values.length > 1) { result[machineId] = values; }
    }
    return result;
}

export class ManagedRemoteCatalogManagementStore implements ManagedRemoteManagementStore {
    constructor(
        private readonly coordinator: ManagedCatalogCoordinator,
        private readonly catalogActorId: string,
        private readonly createId?: (prefix: string) => string,
        private readonly migrationSource?: {
            getGroups(): Group[];
            getProjectData(): unknown;
            getProjectSyncData(): unknown;
        },
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

    prepareMigration(): ManagedRemoteMigrationPlanV1 {
        if (!this.migrationSource) {
            throw new Error('Managed Remote migration source is unavailable.');
        }
        return buildManagedRemoteMigrationPlan(this.migrationSource.getGroups());
    }

    async beginMigration(
        expectedRevisionId: string | null,
        plan: ManagedRemoteMigrationPlanV1,
    ): Promise<ManagedRemoteManagementSnapshot> {
        if (!this.migrationSource) {
            throw new Error('Managed Remote migration source is unavailable.');
        }
        const reconciled = await this.coordinator.reconcile();
        const authority = authorityState(reconciled);
        const actualRevisionId = authority.active?.revisionId || null;
        if (actualRevisionId !== expectedRevisionId) {
            throw new Error('The Managed Remote catalog changed. Refresh and try again.');
        }
        const current = authority.active
            ? materializeManagedRemoteCatalog(authority.active.document) : null;
        if (current && (current.machines.length || current.environments.length
            || current.projects.length)) {
            throw new Error(
                'Remove manually added preview entries before reviewing legacy migration.',
            );
        }
        const currentPlan = buildManagedRemoteMigrationPlan(this.migrationSource.getGroups());
        if (currentPlan.planId !== plan.planId
            || currentPlan.sourceChecksum !== plan.sourceChecksum) {
            throw new Error('Existing Projects changed during migration review. Start again.');
        }
        const document = buildManagedCatalogFromMigrationPlan(plan, this.catalogActorId);
        await this.coordinator.prepareMigration({
            planId: plan.planId,
            frozenLegacy: {
                projectData: this.migrationSource.getProjectData(),
                projectSyncData: this.migrationSource.getProjectSyncData(),
            },
            document,
        });
        return this.snapshot(await this.coordinator.reconcile());
    }

    async activateMigration(
        expectedRevisionId: string,
    ): Promise<ManagedRemoteManagementSnapshot> {
        const reconciled = await this.coordinator.reconcile();
        const authority = authorityState(reconciled);
        if (authority.lifecycle !== 'preview'
            || !authority.migrationPlanId
            || authority.active?.revisionId !== expectedRevisionId) {
            throw new Error('Managed migration preview changed before activation.');
        }
        await this.coordinator.activatePreparedMigration(
            authority.migrationPlanId,
            expectedRevisionId,
        );
        return this.snapshot(await this.coordinator.reconcile());
    }

    private async mutate(
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
        if (!['disabled', 'preview', 'active'].includes(authority.lifecycle)) {
            throw new Error(`Managed Remote catalog is ${authority.lifecycle}.`);
        }
        const service = new ManagedRemoteCatalogService(
            current,
            this.catalogActorId,
            this.createId,
        );
        change(service);
        const stageId = await this.coordinator.stageCatalog(service.getDocument());
        await this.coordinator.activateStagedCatalog(
            stageId,
            authority.lifecycle === 'active' ? 'active' : 'preview',
        );
        return this.snapshot(await this.coordinator.reconcile());
    }

    private snapshot(result: ManagedCatalogReconcileResult): ManagedRemoteManagementSnapshot {
        const authority = authorityState(result);
        const document = authority.active?.document
            || createEmptyManagedRemoteCatalog(this.catalogActorId);
        return {
            revisionId: authority.active?.revisionId || null,
            lifecycle: authority.lifecycle,
            ...(authority.migrationPlanId
                ? { migrationPlanId: authority.migrationPlanId } : {}),
            catalog: materializeManagedRemoteCatalog(document),
            machineConflictCandidates: machineConflictCandidates(document),
        };
    }
}
