'use strict';

import { randomBytes } from 'crypto';
import type * as vscode from 'vscode';

import {
    ManagedRemoteManagementController,
    ManagedRemoteManagementPrompts,
    ManagedRemoteManagementSnapshot,
} from './managementController';
import type { ManagedRemoteManagementOperation } from './managementProtocol';
import { ManagedRemoteCatalogManagementStore } from './managementStore';
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

export async function createManagedRemoteManagementCapability(options: {
    configuration: ManagedRemoteConfigurationLike;
    catalogSettingKey: string;
    globalTarget: vscode.ConfigurationTarget;
    memento: ManagedRemoteMementoLike;
    writerIdentityMemento: ManagedRemoteMementoLike;
    localReplicaKey: string;
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
    const catalogActorKey = `${options.localReplicaKey}.catalogActorId`;
    let catalogActorId = options.writerIdentityMemento.get<string>(catalogActorKey);
    if (!catalogActorId || !/^managed-catalog:[a-f0-9]{32}$/u.test(catalogActorId)) {
        catalogActorId = `managed-catalog:${randomBytes(16).toString('hex')}`;
        await options.writerIdentityMemento.update(catalogActorKey, catalogActorId);
    }
    const store = new ManagedRemoteCatalogManagementStore(
        coordinator,
        catalogActorId,
    );
    return {
        snapshot: await store.getSnapshot(),
        controller: new ManagedRemoteManagementController({
            store,
            prompts: options.prompts,
            refreshAuthoritative: options.refreshAuthoritative,
            postSettlement: options.postSettlement,
        }),
        reconcile: () => store.getSnapshot(),
    };
}
