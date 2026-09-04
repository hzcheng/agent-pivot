'use strict';

import type * as vscode from 'vscode';

import type { Group } from '../models';
import {
    buildMachineProjectsViewModel,
    MACHINE_DISPLAY_NAME_MAX_LENGTH,
    normalizeMachineDisplayName,
    withMachineDisplayName,
} from './machineProjectsViewModel';

export interface MachineRenameControllerOptions {
    getGroups: () => Group[];
    localMachineScope?: string | null;
    saveGroups: (groups: Group[]) => Thenable<unknown>;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showWarningMessage: (message: string) => unknown;
    refreshAfterMutation: () => void;
}

export class MachineRenameController {
    constructor(private readonly options: MachineRenameControllerOptions) {
    }

    async renameMachine(machineId: string): Promise<void> {
        const groups = this.options.getGroups();
        const model = buildMachineProjectsViewModel(
            groups,
            this.options.localMachineScope,
        );
        const machine = model.machines.find(candidate => candidate.id === machineId);
        if (!machine) {
            this.options.showWarningMessage('The Machine no longer exists.');
            return;
        }
        const otherNames = new Set(model.machines
            .filter(candidate => candidate.id !== machineId)
            .map(candidate => candidate.displayName.toLocaleLowerCase()));
        const input = await this.options.showInputBox({
            prompt: 'Changes the display name only. Connection details stay the same.',
            placeHolder: 'Machine display name',
            value: machine.displayName,
            valueSelection: [0, machine.displayName.length],
            ignoreFocusOut: true,
            validateInput: value => {
                const normalized = normalizeMachineDisplayName(value);
                if (!normalized) {
                    return value.trim().length > MACHINE_DISPLAY_NAME_MAX_LENGTH
                        ? `Machine names cannot exceed ${MACHINE_DISPLAY_NAME_MAX_LENGTH} characters.`
                        : 'Enter a Machine display name.';
                }
                return otherNames.has(normalized.toLocaleLowerCase())
                    ? 'Another Machine already uses this display name.'
                    : '';
            },
        });
        if (input === undefined) { return; }
        const displayName = normalizeMachineDisplayName(input);
        if (!displayName || otherNames.has(displayName.toLocaleLowerCase())
            || displayName === machine.displayName) {
            return;
        }
        await this.persist(machineId, displayName);
    }

    async resetMachineName(machineId: string): Promise<void> {
        const groups = this.options.getGroups();
        const machine = buildMachineProjectsViewModel(
            groups,
            this.options.localMachineScope,
        ).machines
            .find(candidate => candidate.id === machineId);
        if (!machine) {
            this.options.showWarningMessage('The Machine no longer exists.');
            return;
        }
        if (!machine.renamed) { return; }
        await this.persist(machineId, null);
    }

    private async persist(
        machineId: string,
        displayName: string | null,
    ): Promise<void> {
        const updated = withMachineDisplayName(
            this.options.getGroups(),
            machineId,
            displayName,
            this.options.localMachineScope,
        );
        if (!updated) {
            this.options.showWarningMessage('The Machine no longer exists.');
            return;
        }
        await this.options.saveGroups(updated);
        this.options.refreshAfterMutation();
    }
}
