'use strict';

import type { ManagedRemoteManagementSnapshot } from './managementController';
import {
    ManagedRemoteBridgeClient,
    ManagedRemoteBridgeClientError,
} from './bridgeClient';
import type { ManagedRemoteClientUiState } from './viewModel';

interface ManagedEnablePreflightSummary {
    activeConfigPath: string;
    generatedConfigPath: string;
    backupPath: string;
    editMode: 'automatic' | 'manualFallback';
}

interface ManagedDisablePreflightSummary {
    activeConfigPath: string;
    generatedDirectory: string;
    backupPath: string;
    editMode: 'automatic' | 'manualFallback';
}

export interface ManagedRemoteClientActionControllerOptions {
    getSnapshot(): Promise<ManagedRemoteManagementSnapshot>;
    bridge: ManagedRemoteBridgeClient;
    confirmEnable(summary: ManagedEnablePreflightSummary): Promise<boolean>;
    confirmDisable(summary: ManagedDisablePreflightSummary): Promise<boolean>;
    refresh(
        snapshot: ManagedRemoteManagementSnapshot,
        state: ManagedRemoteClientUiState,
    ): Promise<void>;
    showInformationMessage(message: string): Thenable<unknown>;
    showErrorMessage(message: string): Thenable<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parsePreflight(value: unknown): ManagedEnablePreflightSummary {
    if (!isRecord(value)
        || typeof value.activeConfigPath !== 'string'
        || typeof value.generatedConfigPath !== 'string'
        || typeof value.backupPath !== 'string'
        || (value.editMode !== 'automatic' && value.editMode !== 'manualFallback')) {
        throw new Error('Agent Pivot UI Bridge returned an invalid enable preview.');
    }
    return {
        activeConfigPath: value.activeConfigPath,
        generatedConfigPath: value.generatedConfigPath,
        backupPath: value.backupPath,
        editMode: value.editMode,
    };
}

function parseDisablePreflight(value: unknown): ManagedDisablePreflightSummary {
    if (!isRecord(value)
        || typeof value.activeConfigPath !== 'string'
        || typeof value.generatedDirectory !== 'string'
        || typeof value.backupPath !== 'string'
        || (value.editMode !== 'automatic' && value.editMode !== 'manualFallback')) {
        throw new Error('Agent Pivot UI Bridge returned an invalid disable preview.');
    }
    return {
        activeConfigPath: value.activeConfigPath,
        generatedDirectory: value.generatedDirectory,
        backupPath: value.backupPath,
        editMode: value.editMode,
    };
}

function resultStatus(value: unknown): string {
    return isRecord(value) && typeof value.status === 'string' ? value.status : '';
}

function resultGeneration(value: unknown): number {
    return isRecord(value) && Number.isSafeInteger(value.generation)
        && Number(value.generation) >= 0 ? Number(value.generation) : 0;
}

function stateFromStatus(status: string): ManagedRemoteClientUiState {
    if (status === 'enabled') { return 'ready'; }
    if (status === 'enabling' || status === 'disabling') { return 'applying'; }
    if (status === 'recoveryRequired') { return 'attention'; }
    return 'enableRequired';
}

export class ManagedRemoteClientActionController {
    private pending: Promise<unknown> = Promise.resolve();

    constructor(private readonly options: ManagedRemoteClientActionControllerOptions) {
    }

    readState(snapshot: ManagedRemoteManagementSnapshot): Promise<ManagedRemoteClientUiState> {
        if (snapshot.lifecycle !== 'active') { return Promise.resolve('preview'); }
        return this.options.bridge.execute('getStatus').then(value =>
            stateFromStatus(resultStatus(value)), () => 'attention');
    }

    enable(expectedRevisionId: string | null): Promise<void> {
        return this.enqueue(() => this.enableNow(expectedRevisionId, true));
    }

    enableAutomatically(expectedRevisionId: string): Promise<void> {
        return this.enqueue(async () => {
            try {
                const snapshot = await this.requireCurrentSnapshot(expectedRevisionId);
                let localState: unknown;
                try {
                    localState = await this.options.bridge.execute('getStatus');
                } catch (_error) {
                    await this.reconcileNow('recover', expectedRevisionId, false);
                    return;
                }
                const status = resultStatus(localState);
                if (status === 'enabled') {
                    await this.reconcileNow('reconcile', expectedRevisionId, false);
                    return;
                }
                if (status === 'disabled' && resultGeneration(localState) === 0) {
                    await this.enableNow(expectedRevisionId, false);
                    return;
                }
                await this.options.refresh(snapshot, stateFromStatus(status));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const snapshot = await this.options.getSnapshot().catch(() => null);
                if (snapshot) { await this.options.refresh(snapshot, 'attention'); }
                await this.options.showErrorMessage(`Agent Pivot: ${message}`);
            }
        });
    }

    disable(expectedRevisionId: string | null): Promise<void> {
        return this.enqueue(() => this.disableNow(expectedRevisionId));
    }

    recover(expectedRevisionId: string | null): Promise<void> {
        return this.enqueue(() => this.reconcileNow('recover', expectedRevisionId));
    }

    regenerate(expectedRevisionId: string | null): Promise<void> {
        return this.enqueue(() => this.reconcileNow('reconcile', expectedRevisionId, true));
    }

    syncCatalog(expectedRevisionId: string): Promise<void> {
        return this.enqueue(() => this.reconcileNow('reconcile', expectedRevisionId, false));
    }

    openMachine(targetId: string, expectedRevisionId: string | null): Promise<void> {
        return this.navigate('openManagedMachine', targetId, expectedRevisionId);
    }

    openProject(targetId: string, expectedRevisionId: string | null): Promise<void> {
        return this.navigate('openManagedProject', targetId, expectedRevisionId);
    }

    openEnvironment(targetId: string, expectedRevisionId: string | null): Promise<void> {
        return this.navigate('openManagedEnvironment', targetId, expectedRevisionId);
    }

    private async enableNow(
        expectedRevisionId: string | null,
        requireConfirmation: boolean,
    ): Promise<void> {
        try {
            const snapshot = await this.requireCurrentSnapshot(expectedRevisionId);
            if (snapshot.lifecycle !== 'active') {
                throw new Error('The Managed Machine catalog is unavailable.');
            }
            const revisionId = snapshot.revisionId as string;
            let preflight: ManagedEnablePreflightSummary | undefined;
            if (requireConfirmation) {
                preflight = parsePreflight(await this.options.bridge.execute(
                    'preflightEnable',
                    revisionId,
                ));
                if (!await this.options.confirmEnable(preflight)) { return; }
            }
            await this.options.refresh(snapshot, 'applying');
            const result = await this.options.bridge.execute('beginEnable', revisionId);
            const status = resultStatus(result);
            if (status === 'awaitingManualInclude') {
                await this.options.refresh(snapshot, 'attention');
                const fallback = preflight || parsePreflight(
                    isRecord(result) ? result.preflight : undefined,
                );
                throw new Error(
                    `Automatic SSH config update was unavailable. Add the Agent Pivot Include to ${fallback.activeConfigPath}, then Retry.`,
                );
            }
            if (status !== 'enabled') {
                throw new Error('Managed SSH configuration did not reach the enabled state.');
            }
            await this.options.refresh(snapshot, 'ready');
            if (requireConfirmation) {
                await this.options.showInformationMessage(
                    'Managed Remote is ready on this computer.',
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const snapshot = await this.options.getSnapshot().catch(() => null);
            if (snapshot) { await this.options.refresh(snapshot, 'attention'); }
            await this.options.showErrorMessage(`Agent Pivot: ${message}`);
        }
    }

    private async disableNow(expectedRevisionId: string | null): Promise<void> {
        try {
            const snapshot = await this.requireCurrentSnapshot(expectedRevisionId);
            if (snapshot.lifecycle !== 'active') {
                throw new Error('Managed Remote is not active.');
            }
            const preflight = parseDisablePreflight(await this.options.bridge.execute(
                'preflightDisable',
            ));
            if (!await this.options.confirmDisable(preflight)) { return; }
            await this.options.refresh(snapshot, 'applying');
            const result = await this.options.bridge.execute('beginDisable');
            const status = resultStatus(result);
            if (status === 'awaitingManualIncludeRemoval') {
                await this.options.refresh(snapshot, 'attention');
                throw new Error(
                    `Automatic SSH config update was unavailable. Remove the exact Agent Pivot Include from ${preflight.activeConfigPath}, then Retry.`,
                );
            }
            if (status !== 'disabled') {
                throw new Error('Managed SSH configuration did not reach the disabled state.');
            }
            await this.options.refresh(snapshot, 'enableRequired');
            await this.options.showInformationMessage(
                'Managed SSH connections are disabled on this computer. Synced Machines and Projects were not changed.',
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const snapshot = await this.options.getSnapshot().catch(() => null);
            if (snapshot) { await this.options.refresh(snapshot, 'attention'); }
            await this.options.showErrorMessage(`Agent Pivot: ${message}`);
        }
    }

    private async reconcileNow(
        operation: 'recover' | 'reconcile',
        expectedRevisionId: string | null,
        announce = true,
    ): Promise<void> {
        try {
            const snapshot = await this.requireCurrentSnapshot(expectedRevisionId);
            if (snapshot.lifecycle !== 'active') {
                throw new Error('The Managed Machine catalog is unavailable.');
            }
            await this.options.refresh(snapshot, 'applying');
            const result = await this.options.bridge.execute(
                operation,
                snapshot.revisionId as string,
            );
            const state = stateFromStatus(resultStatus(result));
            await this.options.refresh(snapshot, state);
            if (state === 'ready' && announce) {
                await this.options.showInformationMessage(
                    'Managed SSH configuration is up to date.',
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const snapshot = await this.options.getSnapshot().catch(() => null);
            if (snapshot) { await this.options.refresh(snapshot, 'attention'); }
            await this.options.showErrorMessage(`Agent Pivot: ${message}`);
        }
    }

    private async requireCurrentSnapshot(
        expectedRevisionId: string | null,
    ): Promise<ManagedRemoteManagementSnapshot> {
        const snapshot = await this.options.getSnapshot();
        if (!snapshot.revisionId || snapshot.revisionId !== expectedRevisionId) {
            throw new Error('The Managed Remote catalog changed. Refresh and try again.');
        }
        if (snapshot.lifecycle !== 'active') {
            throw new Error('The Managed Machine catalog is unavailable.');
        }
        return snapshot;
    }

    private navigate(
        operation: 'openManagedMachine' | 'openManagedProject' | 'openManagedEnvironment',
        targetId: string,
        expectedRevisionId: string | null,
    ): Promise<void> {
        return this.enqueue(async () => {
            try {
                const snapshot = await this.requireCurrentSnapshot(expectedRevisionId);
                await this.options.bridge.execute(
                    operation,
                    snapshot.revisionId as string,
                    targetId,
                );
            } catch (error) {
                if (error instanceof ManagedRemoteBridgeClientError) {
                    const snapshot = await this.options.getSnapshot().catch(() => null);
                    if (snapshot && error.status === 'clientNotEnabled') {
                        await this.options.refresh(snapshot, 'enableRequired');
                    } else if (snapshot && error.status === 'recoveryRequired') {
                        await this.options.refresh(snapshot, 'attention');
                    }
                }
                const message = error instanceof Error ? error.message : String(error);
                await this.options.showErrorMessage(`Agent Pivot: ${message}`);
            }
        });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation, operation);
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }
}
