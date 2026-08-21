'use strict';

import {
    OPEN_WORKSPACE_NAVIGATE_COMMAND,
    OPEN_WORKSPACE_PROTOCOL_VERSION,
    validateOpenWorkspaceNavigationOutcome,
} from './protocol';
import type { OpenWorkspaceRecord } from './protocol';

export interface WorkspaceNavigationControllerOptions {
    getRecord: (cardId: string) => OpenWorkspaceRecord | null;
    executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown> | Promise<unknown>;
    showInformationMessage: (message: string) => unknown;
    showWarningMessage: (message: string) => unknown;
    refresh: (reason: string) => void;
}

// Settlement vocabulary for the versioned open-window navigation request
// protocol: every webview request resolves to exactly one of these outcomes.
export type OpenWorkspaceNavigationSettlement =
    'focused' | 'stale-target' | 'untitled-workspace' | 'failed';

export class WorkspaceNavigationController {
    constructor(private readonly options: WorkspaceNavigationControllerOptions) {
    }

    async open(cardId: string): Promise<void> {
        await this.openForSettlement(cardId);
    }

    async openForSettlement(cardId: string): Promise<OpenWorkspaceNavigationSettlement> {
        const record = this.options.getRecord(cardId);
        if (!record) {
            this.options.refresh('open-workspace-navigation-stale');
            return 'stale-target';
        }

        if (record.kind === 'untitledMultiRoot') {
            this.options.showInformationMessage('Save this workspace before switching to it');
            return 'untitled-workspace';
        }

        try {
            validateOpenWorkspaceNavigationOutcome(await this.options.executeCommand(
                OPEN_WORKSPACE_NAVIGATE_COMMAND,
                {
                    protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION,
                    navigationIdentity: record.navigationIdentity,
                },
            ));
            return 'focused';
        } catch (_error) {
            this.options.showWarningMessage(
                'Unable to switch directly to this workspace. Use VS Code Switch Window instead.',
            );
            return 'failed';
        }
    }
}
