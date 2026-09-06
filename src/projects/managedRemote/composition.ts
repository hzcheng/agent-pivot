'use strict';

import type * as vscode from 'vscode';
import {
    ManagedRemoteManagementController,
    ManagedRemoteManagementPrompts,
    ManagedRemoteManagementSnapshot,
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
    /**
     * Re-acquired on every access. A `vscode.workspace.getConfiguration`
     * snapshot never observes later writes, so a cached one makes the catalog
     * unreadable immediately after it is written.
     */
    configuration: ManagedRemoteConfigurationLike
        | (() => ManagedRemoteConfigurationLike);
    catalogSettingKey: string;
    globalTarget: vscode.ConfigurationTarget;
    memento: ManagedRemoteMementoLike;
    writerIdentityMemento: ManagedRemoteMementoLike;
    localReplicaKey: string;
    catalogActorId: string;
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
    );
    const snapshot = await store.getSnapshot();
    return {
        snapshot,
        controller: new ManagedRemoteManagementController({
            store,
            prompts: options.prompts,
            refreshAuthoritative: options.refreshAuthoritative,
            postSettlement: options.postSettlement,
        }),
        reconcile: () => store.getSnapshot(),
    };
}
