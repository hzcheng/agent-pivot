'use strict';

import type { ProjectDetailsForSave } from '../projects/projectMutationController';
import type { OpenWorkspace } from './types';
import {
    PendingWorkspaceSaveStore,
    PENDING_WORKSPACE_SAVE_TTL_MS,
} from './pendingWorkspaceSaveStore';

export interface SavedWorkspaceProjectAdapterOptions {
    getCurrentWorkspace: () => OpenWorkspace | null;
    pendingStore: PendingWorkspaceSaveStore;
    getProjectDetailsForSave: (navigationUri: string) => Promise<ProjectDetailsForSave | null>;
    saveWorkspaceProject: (details: ProjectDetailsForSave | null) => Promise<boolean>;
    executeSaveWorkspaceAs: () => Promise<unknown>;
    nowMs?: () => number;
}

export class SavedWorkspaceProjectAdapter {
    private transaction: Promise<boolean> | null = null;

    constructor(private readonly options: SavedWorkspaceProjectAdapterOptions) { }

    saveCurrentWorkspace(): Promise<boolean> {
        return this.runTransaction(() => this.saveCurrentWorkspaceUnlocked());
    }

    completePendingWorkspaceSave(): Promise<boolean> {
        return this.runTransaction(() => this.completePendingWorkspaceSaveUnlocked());
    }

    private async saveCurrentWorkspaceUnlocked(): Promise<boolean> {
        const workspace = this.options.getCurrentWorkspace();
        if (this.options.pendingStore.read()
            && await this.completePendingWorkspaceSaveUnlocked()) {
            return true;
        }
        if (!workspace) {
            return this.options.saveWorkspaceProject(null);
        }

        if (workspace.kind !== 'untitledMultiRoot') {
            return this.saveWorkspace(workspace);
        }

        const createdAtMs = this.nowMs();
        await this.options.pendingStore.write(
            workspace.scopeIdentity,
            createdAtMs,
            createdAtMs + PENDING_WORKSPACE_SAVE_TTL_MS
        );

        try {
            await this.options.executeSaveWorkspaceAs();
        } catch (error) {
            await this.options.pendingStore.clear();
            throw error;
        }

        const transitioned = this.options.getCurrentWorkspace();
        if (transitioned?.kind === 'savedMultiRoot'
            && transitioned.scopeIdentity === workspace.scopeIdentity) {
            return this.completePendingWorkspaceSaveUnlocked();
        }

        await this.options.pendingStore.clear();
        return false;
    }

    private async completePendingWorkspaceSaveUnlocked(): Promise<boolean> {
        const intent = this.options.pendingStore.read();
        await this.options.pendingStore.clear();
        if (!intent || !this.options.pendingStore.isValidAt(intent, this.nowMs())) {
            return false;
        }

        const workspace = this.options.getCurrentWorkspace();
        if (!workspace
            || workspace.kind !== 'savedMultiRoot'
            || workspace.scopeIdentity !== intent.scopeIdentity) {
            return false;
        }

        return this.saveWorkspace(workspace);
    }

    private async saveWorkspace(workspace: OpenWorkspace): Promise<boolean> {
        const details = await this.options.getProjectDetailsForSave(workspace.navigationUri);
        return (await this.options.saveWorkspaceProject(details)) !== false;
    }

    private runTransaction(operation: () => Promise<boolean>): Promise<boolean> {
        if (this.transaction) {
            return this.transaction;
        }

        const operationPromise = Promise.resolve().then(operation);
        let transaction: Promise<boolean>;
        transaction = operationPromise.finally(() => {
            if (this.transaction === transaction) {
                this.transaction = null;
            }
        });
        this.transaction = transaction;
        return transaction;
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }
}
