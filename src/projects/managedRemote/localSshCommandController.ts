'use strict';

import type { ManagedRemoteManagementSnapshot } from './managementController';
import { ManagedRemoteBridgeClient } from './bridgeClient';
import type { ManagedSshMachine } from './types';

interface MachinePickItem {
    label: string;
    description: string;
    machine: ManagedSshMachine;
}

export interface ManagedRemoteLocalSshCommandControllerOptions {
    getSnapshot(): Promise<ManagedRemoteManagementSnapshot>;
    showQuickPick(
        items: MachinePickItem[],
        options: { title: string; placeHolder: string },
    ): Thenable<MachinePickItem | undefined>;
    bridge: ManagedRemoteBridgeClient;
    showInformationMessage(message: string): Thenable<unknown>;
    showErrorMessage(message: string): Thenable<unknown>;
}

function endpoint(machine: ManagedSshMachine): string {
    const host = machine.connection.host.includes(':')
        ? `[${machine.connection.host}]` : machine.connection.host;
    return `${machine.connection.user}@${host}:${machine.connection.port}`;
}

export class ManagedRemoteLocalSshCommandController {
    constructor(private readonly options: ManagedRemoteLocalSshCommandControllerOptions) {
    }

    sshToMachine(machineId?: string, expectedRevisionId?: string | null): Promise<void> {
        return this.run('openLocalSshTerminal', machineId, expectedRevisionId);
    }

    copySshCommand(machineId?: string, expectedRevisionId?: string | null): Promise<void> {
        return this.run('copyLocalSshCommand', machineId, expectedRevisionId);
    }

    private async run(
        operation: 'openLocalSshTerminal' | 'copyLocalSshCommand',
        machineId?: string,
        expectedRevisionId?: string | null,
    ): Promise<void> {
        try {
            const snapshot = await this.options.getSnapshot();
            if (snapshot.lifecycle !== 'active' || !snapshot.revisionId) {
                throw new Error('The Managed Machine catalog is unavailable.');
            }
            if (expectedRevisionId !== undefined
                && expectedRevisionId !== snapshot.revisionId) {
                throw new Error('The Managed Remote catalog changed. Refresh and try again.');
            }
            const conflicted = new Set(Object.keys(snapshot.machineConflictCandidates));
            const items = snapshot.catalog.machines
                .filter(machine => !conflicted.has(machine.id))
                .map(machine => ({
                    label: machine.name,
                    description: endpoint(machine),
                    machine,
                }));
            if (!items.length) {
                throw new Error('No ready Managed Machines are available.');
            }
            const selected = machineId
                ? items.find(item => item.machine.id === machineId)
                : await this.options.showQuickPick(items, {
                    title: operation === 'openLocalSshTerminal'
                        ? 'SSH to Managed Machine' : 'Copy SSH Command',
                    placeHolder: 'Choose a Machine by name and endpoint',
                });
            if (machineId && !selected) {
                throw new Error('The selected Managed Machine is unavailable.');
            }
            if (!selected) { return; }
            await this.options.bridge.execute(
                operation,
                snapshot.revisionId,
                selected.machine.id,
            );
            if (operation === 'copyLocalSshCommand') {
                await this.options.showInformationMessage(
                    `Copied SSH command for ${selected.machine.name}.`,
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.options.showErrorMessage(`Agent Pivot: ${message}`);
        }
    }
}
