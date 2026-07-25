'use strict';

import { PromptService } from './service';

const OPEN_AI_PROMPTS_ACTION = 'Open AI Prompts';
const PREVIEW_MAX_LENGTH = 120;

export interface PromptTerminalLike {
    sendText(text: string, addNewLine?: boolean): void | PromiseLike<void>;
    show?(): void;
}

export interface PromptQuickPickItem {
    label: string;
    description: string;
    promptId: string;
}

export interface PromptTerminalCommandControllerOptions {
    service: Pick<PromptService, 'getSnapshot'>;
    getActiveTerminal: () => PromptTerminalLike | null | undefined;
    isTerminalAvailable: (terminal: PromptTerminalLike) => boolean;
    showQuickPick: (
        items: readonly PromptQuickPickItem[],
        options: { placeHolder: string; matchOnDescription: boolean },
    ) => PromiseLike<PromptQuickPickItem | undefined>;
    showWarningMessage: (message: string) => unknown;
    showInformationMessage: (
        message: string,
        action: 'Open AI Prompts',
    ) => PromiseLike<string | undefined>;
    openAiPrompts: () => unknown;
}

function getFirstLinePreview(text: string): string {
    const firstLine = text.split(/[\r\n]/, 1)[0];
    return firstLine.length > PREVIEW_MAX_LENGTH
        ? `${firstLine.slice(0, PREVIEW_MAX_LENGTH)}…`
        : firstLine;
}

export class PromptTerminalCommandController {
    constructor(private readonly options: PromptTerminalCommandControllerOptions) {
    }

    async insertPromptToActiveTerminal(): Promise<void> {
        const terminal = this.options.getActiveTerminal();
        if (!terminal) {
            this.options.showWarningMessage('No active terminal is available to receive the Prompt.');
            return;
        }

        const snapshot = this.options.service.getSnapshot();
        if (snapshot.readOnlyReason) {
            this.options.showWarningMessage(
                'AI Prompts are unavailable because their saved data is invalid or unsupported.'
            );
            return;
        }

        let prompt = snapshot.prompts.find(candidate => candidate.id === snapshot.selectedPromptId);
        if (!prompt) {
            if (snapshot.prompts.length === 0) {
                const action = await this.options.showInformationMessage(
                    'No AI Prompts are configured. Create one in AI > PROMPTS.',
                    OPEN_AI_PROMPTS_ACTION
                );
                if (action === OPEN_AI_PROMPTS_ACTION) {
                    await Promise.resolve(this.options.openAiPrompts());
                }
                return;
            }

            const selected = await this.options.showQuickPick(
                snapshot.prompts.map(candidate => ({
                    label: candidate.name,
                    description: getFirstLinePreview(candidate.text),
                    promptId: candidate.id,
                })),
                { placeHolder: 'Select an AI Prompt', matchOnDescription: true }
            );
            prompt = selected
                ? snapshot.prompts.find(candidate => candidate.id === selected.promptId)
                : undefined;
        }

        if (!prompt) {
            return;
        }

        if (!this.options.isTerminalAvailable(terminal)) {
            this.options.showWarningMessage('The selected terminal is no longer available.');
            return;
        }

        try {
            await Promise.resolve(terminal.sendText(prompt.text, false));
            terminal.show?.();
        } catch (_error) {
            this.options.showWarningMessage('The selected terminal is no longer available.');
        }
    }
}
