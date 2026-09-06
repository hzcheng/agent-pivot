'use strict';

import type { ManagedRemoteManagementSnapshot } from './managementController';
import type { ManagedRemoteBridgeClient } from './bridgeClient';
import {
    formatManagedSshCommand,
    resolveManagedEnvironmentTarget,
    resolveManagedMachineTarget,
    resolveManagedProjectIdentity,
} from './targetResolver';

export interface ManagedRemoteActionControllerOptions {
    getCurrentSnapshot(): ManagedRemoteManagementSnapshot;
    openCurrentProject(
        snapshot: ManagedRemoteManagementSnapshot,
        projectId: string,
    ): Promise<boolean>;
    bridge: Pick<ManagedRemoteBridgeClient, 'execute'>;
    writeClipboard(value: string): Promise<void> | Thenable<void>;
    showInformationMessage(message: string): Promise<unknown> | Thenable<unknown>;
    showErrorMessage(message: string): Promise<unknown> | Thenable<unknown>;
    logProjectionError(error: Error): void;
}

export class ManagedRemoteActionController {
    constructor(private readonly options: ManagedRemoteActionControllerOptions) {
    }

    syncProjection(expectedRevisionId: string): void {
        void this.options.bridge.execute('reconcile', expectedRevisionId).catch(error => {
            this.options.logProjectionError(
                error instanceof Error ? error : new Error(String(error)),
            );
        });
    }

    async handleMessage(raw: unknown): Promise<void> {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return; }
        const value = raw as Record<string, unknown>;
        const action = String(value.action);
        const actions = [
            'sshTerminal', 'copySsh', 'openMachine', 'openProject', 'openEnvironment',
        ];
        if (!actions.includes(action)
            || value.version !== 1
            || typeof value.requestId !== 'string'
            || value.requestId.length < 16
            || value.requestId.length > 256
            || typeof value.targetId !== 'string'
            || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.targetId)
            || (value.expectedRevisionId !== null
                && (typeof value.expectedRevisionId !== 'string'
                    || !/^revision:[a-f0-9]{64}$/u.test(value.expectedRevisionId)))
            || Object.keys(value).sort().join('\n') !== [
                'action', 'expectedRevisionId', 'requestId', 'targetId', 'type', 'version',
            ].sort().join('\n')) {
            return;
        }
        const targetId = value.targetId;
        const revisionId = value.expectedRevisionId as string | null;
        if (action === 'openMachine') {
            await this.openMachine(targetId, revisionId);
        } else if (action === 'openProject') {
            await this.openProject(targetId, revisionId);
        } else if (action === 'openEnvironment') {
            await this.openEnvironment(targetId, revisionId);
        } else if (action === 'sshTerminal') {
            await this.openSshTerminal(targetId, revisionId);
        } else {
            await this.copySshCommand(targetId, revisionId);
        }
    }

    openMachine(machineId: string, expectedRevisionId: string | null): Promise<void> {
        return this.bridgeAction('openManagedMachine', machineId, expectedRevisionId);
    }

    openEnvironment(
        environmentId: string,
        expectedRevisionId: string | null,
    ): Promise<void> {
        return this.bridgeAction(
            'openManagedEnvironment', environmentId, expectedRevisionId,
        );
    }

    openSshTerminal(machineId: string, expectedRevisionId: string | null): Promise<void> {
        return this.bridgeAction('openLocalSshTerminal', machineId, expectedRevisionId);
    }

    async openProject(projectId: string, expectedRevisionId: string | null): Promise<void> {
        try {
            const snapshot = this.currentSnapshot(expectedRevisionId);
            resolveManagedProjectIdentity(snapshot.catalog, projectId);
            if (await this.options.openCurrentProject(snapshot, projectId)) { return; }
            await this.options.bridge.execute(
                'openManagedProject', snapshot.revisionId as string, projectId,
            );
        } catch (error) {
            await this.reportError(error);
        }
    }

    async copySshCommand(machineId: string, expectedRevisionId: string | null): Promise<void> {
        try {
            const snapshot = this.currentSnapshot(expectedRevisionId);
            const target = resolveManagedMachineTarget(snapshot.catalog, machineId);
            await this.options.writeClipboard(formatManagedSshCommand(target.machine));
            await this.options.showInformationMessage(
                `Copied SSH command for ${target.machine.name}.`,
            );
        } catch (error) {
            await this.reportError(error);
        }
    }

    private async bridgeAction(
        operation: 'openManagedMachine' | 'openManagedEnvironment' | 'openLocalSshTerminal',
        targetId: string,
        expectedRevisionId: string | null,
    ): Promise<void> {
        try {
            const snapshot = this.currentSnapshot(expectedRevisionId);
            if (operation === 'openManagedMachine'
                || operation === 'openLocalSshTerminal') {
                resolveManagedMachineTarget(snapshot.catalog, targetId);
            } else {
                resolveManagedEnvironmentTarget(snapshot.catalog, targetId);
            }
            await this.options.bridge.execute(
                operation, snapshot.revisionId as string, targetId,
            );
        } catch (error) {
            await this.reportError(error);
        }
    }

    private currentSnapshot(
        expectedRevisionId: string | null,
    ): ManagedRemoteManagementSnapshot {
        const snapshot = this.options.getCurrentSnapshot();
        if (snapshot.lifecycle !== 'active' || !snapshot.revisionId) {
            throw new Error('The Managed Machine catalog is unavailable.');
        }
        if (snapshot.revisionId !== expectedRevisionId) {
            throw new Error('The Managed Remote catalog changed. Refresh and try again.');
        }
        return snapshot;
    }

    private reportError(error: unknown): Promise<unknown> | Thenable<unknown> {
        const message = error instanceof Error ? error.message : String(error);
        return this.options.showErrorMessage(`Agent Pivot: ${message}`);
    }
}
