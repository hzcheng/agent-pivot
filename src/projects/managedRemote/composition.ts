'use strict';

import type * as vscode from 'vscode';
import type { Group } from '../../models';

import {
    ManagedRemoteManagementController,
    ManagedRemoteManagementPrompts,
    ManagedRemoteManagementSnapshot,
    ManagedRemoteManagementStore,
} from './managementController';
import type { ManagedRemoteManagementOperation } from './managementProtocol';
import { ManagedRemoteCatalogManagementStore } from './managementStore';
import { createEmptyManagedRemoteCatalog, materializeManagedRemoteCatalog } from './merge';
import {
    ConfigurationManagedCatalogBackend,
    ManagedRemoteConfigurationLike,
    ManagedRemoteMementoLike,
    MementoManagedCatalogReplicaFacade,
} from './productionStore';
import { ManagedCatalogCoordinator } from './store';

export interface ManagedRemoteManagementCapability {
    snapshot: ManagedRemoteManagementSnapshot;
    controller: ManagedRemoteManagementController;
    reconcile(): Promise<ManagedRemoteManagementSnapshot>;
    activateMigration(expectedRevisionId: string): Promise<ManagedRemoteManagementSnapshot>;
}

export async function prepareAutomaticManagedRemoteMigration(
    store: ManagedRemoteManagementStore,
    prompts: ManagedRemoteManagementPrompts,
): Promise<ManagedRemoteManagementSnapshot> {
    const snapshot = await store.getSnapshot();
    if (snapshot.lifecycle !== 'disabled') { return snapshot; }

    const plan = store.prepareMigration();
    const hasRemoteProject = plan.records.some(record =>
        record.classification !== 'clientLocal'
        && record.classification !== 'excluded');
    if (!hasRemoteProject) { return snapshot; }

    const resolved = await prompts.reviewMigration(plan);
    if (!resolved) { return snapshot; }
    try {
        return await store.beginMigration(snapshot.revisionId, resolved);
    } catch (error) {
        // Another Extension Host may have completed the same one-time migration
        // while this window was resolving aliases. Treat its authority as the
        // result instead of failing the entire capability initialization.
        const current = await store.getSnapshot();
        if (current.lifecycle !== 'disabled') { return current; }
        throw error;
    }
}

export function createDisabledManagedRemoteSnapshot(
    catalogActorId: string,
): ManagedRemoteManagementSnapshot {
    return {
        revisionId: null,
        lifecycle: 'disabled',
        catalog: materializeManagedRemoteCatalog(
            createEmptyManagedRemoteCatalog(catalogActorId),
        ),
        machineConflictCandidates: {},
    };
}

export async function createManagedRemoteManagementCapability(options: {
    configuration: ManagedRemoteConfigurationLike;
    catalogSettingKey: string;
    globalTarget: vscode.ConfigurationTarget;
    memento: ManagedRemoteMementoLike;
    writerIdentityMemento: ManagedRemoteMementoLike;
    localReplicaKey: string;
    catalogActorId: string;
    migrationSource: {
        getGroups(): Group[];
        getProjectData(): unknown;
        getProjectSyncData(): unknown;
    };
    prompts: ManagedRemoteManagementPrompts;
    refreshAuthoritative(
        requestId: string,
        operation: ManagedRemoteManagementOperation,
        snapshot: ManagedRemoteManagementSnapshot,
    ): Promise<void>;
    postSettlement: ConstructorParameters<typeof ManagedRemoteManagementController>[0]['postSettlement'];
}): Promise<ManagedRemoteManagementCapability> {
    const coordinator = await ManagedCatalogCoordinator.create(
        new ConfigurationManagedCatalogBackend(
            options.configuration,
            options.catalogSettingKey,
            options.globalTarget,
        ),
        new MementoManagedCatalogReplicaFacade(
            options.memento,
            options.localReplicaKey,
            options.writerIdentityMemento,
        ),
    );
    const store = new ManagedRemoteCatalogManagementStore(
        coordinator,
        options.catalogActorId,
        undefined,
        options.migrationSource,
    );
    const snapshot = await prepareAutomaticManagedRemoteMigration(
        store,
        options.prompts,
    );
    return {
        snapshot,
        controller: new ManagedRemoteManagementController({
            store,
            prompts: options.prompts,
            refreshAuthoritative: options.refreshAuthoritative,
            postSettlement: options.postSettlement,
        }),
        reconcile: () => store.getSnapshot(),
        activateMigration: expectedRevisionId => store.activateMigration(expectedRevisionId),
    };
}
