'use strict';

import type { WorkspaceCardViewModel } from '../models';
import type { OpenWorkspaceRecord } from './protocol';

export interface OpenWindowQuickPickItem {
    label: string;
    description?: string;
    cardId: string;
}

export interface OpenWindowProjectDisplay {
    name: string;
    groupName: string | null;
}

export interface WorkspaceNavigationQuickPickControllerOptions {
    getCards: () => WorkspaceCardViewModel[];
    getRecord: (cardId: string) => OpenWorkspaceRecord | null;
    getProjectDisplay: (
        workspace: Pick<OpenWorkspaceRecord, 'kind' | 'navigationUri'>,
    ) => OpenWindowProjectDisplay | null;
    showQuickPick: (
        items: OpenWindowQuickPickItem[],
        options: { placeHolder: string; title: string },
    ) => Thenable<OpenWindowQuickPickItem | undefined> | Promise<OpenWindowQuickPickItem | undefined>;
    open: (cardId: string) => Promise<void>;
    showInformationMessage: (message: string) => unknown;
}

export class WorkspaceNavigationQuickPickController {
    constructor(private readonly options: WorkspaceNavigationQuickPickControllerOptions) {
    }

    async pickAndOpen(): Promise<void> {
        const cards = this.options.getCards().filter(card => card.kind === 'navigation');
        if (cards.length === 0) {
            this.options.showInformationMessage('No other open windows to switch to.');
            return;
        }

        const picked = await this.options.showQuickPick(cards.map(card => this.createItem(card)), {
            placeHolder: 'Select an open window to switch to',
            title: 'Switch to Open Window',
        });
        if (!picked) {
            return;
        }
        await this.options.open(picked.cardId);
    }

    private createItem(card: WorkspaceCardViewModel): OpenWindowQuickPickItem {
        const record = this.options.getRecord(card.id);
        const projectDisplay = record ? this.options.getProjectDisplay(record) : null;
        return {
            label: projectDisplay ? projectDisplay.name : card.name,
            description: projectDisplay?.groupName || undefined,
            cardId: card.id,
        };
    }
}
