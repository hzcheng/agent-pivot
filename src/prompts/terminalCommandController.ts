'use strict';

import { PromptService } from './service';

const OPEN_AI_PROMPTS_ACTION = 'Open AI Prompts';
const PREVIEW_MAX_LENGTH = 120;
const PROMPT_INSERT_VERSION = 1;
const PROMPT_INSERT_TARGET = 'global-prompt-library';
const MAX_REQUEST_ID_LENGTH = 128;
const PROMPT_INSERT_REQUEST_KEYS = [
    'type',
    'version',
    'requestId',
    'target',
    'promptId',
];

export type PromptTerminalInsertErrorCode =
    | 'no-active-terminal'
    | 'prompt-unavailable'
    | 'prompt-not-found'
    | 'terminal-unavailable';

export interface PromptTerminalInsertRequest {
    readonly type: 'prompt-insert-terminal';
    readonly version: 1;
    readonly requestId: string;
    readonly target: 'global-prompt-library';
    readonly promptId: string;
}

export interface PromptTerminalInsertResult {
    readonly type: 'prompt-insert-terminal-result';
    readonly version: 1;
    readonly requestId: string;
    readonly target: 'global-prompt-library';
    readonly success: boolean;
    readonly errorCode: PromptTerminalInsertErrorCode | null;
}

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
    private readonly claimedInsertRequestIds = new Set<string>();

    constructor(private readonly options: PromptTerminalCommandControllerOptions) {
    }

    async handleInsertRequest(value: unknown): Promise<PromptTerminalInsertResult | undefined> {
        const request = readInsertRequest(value);
        if (!request || this.claimedInsertRequestIds.has(request.requestId)) {
            return undefined;
        }
        this.claimedInsertRequestIds.add(request.requestId);

        const errorCode = await this.insertPromptByIdToActiveTerminal(request.promptId);
        return {
            type: 'prompt-insert-terminal-result',
            version: PROMPT_INSERT_VERSION,
            requestId: request.requestId,
            target: PROMPT_INSERT_TARGET,
            success: errorCode === null,
            errorCode,
        };
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

    private async insertPromptByIdToActiveTerminal(
        promptId: string
    ): Promise<PromptTerminalInsertErrorCode | null> {
        const terminal = this.options.getActiveTerminal();
        if (!terminal) {
            this.options.showWarningMessage('No active terminal is available to receive the Prompt.');
            return 'no-active-terminal';
        }

        let snapshot;
        try {
            snapshot = this.options.service.getSnapshot();
        } catch (_error) {
            this.options.showWarningMessage(
                'AI Prompts are unavailable because their saved data is invalid or unsupported.'
            );
            return 'prompt-unavailable';
        }
        if (snapshot.readOnlyReason) {
            this.options.showWarningMessage(
                'AI Prompts are unavailable because their saved data is invalid or unsupported.'
            );
            return 'prompt-unavailable';
        }

        const prompt = snapshot.prompts.find(candidate => candidate.id === promptId);
        if (!prompt) {
            this.options.showWarningMessage('That Prompt is no longer available.');
            return 'prompt-not-found';
        }

        if (!this.options.isTerminalAvailable(terminal)) {
            this.options.showWarningMessage('The selected terminal is no longer available.');
            return 'terminal-unavailable';
        }

        try {
            await Promise.resolve(terminal.sendText(prompt.text, false));
        } catch (_error) {
            this.options.showWarningMessage('The selected terminal is no longer available.');
            return 'terminal-unavailable';
        }

        try {
            terminal.show?.();
        } catch (_error) {
            this.options.showWarningMessage(
                'The Prompt was inserted, but the terminal could not be revealed.'
            );
        }
        return null;
    }
}

function readInsertRequest(value: unknown): PromptTerminalInsertRequest | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value as { [key: string]: unknown };
    const keys = Object.keys(candidate);
    if (keys.length !== PROMPT_INSERT_REQUEST_KEYS.length
        || PROMPT_INSERT_REQUEST_KEYS.some(key =>
            !Object.prototype.hasOwnProperty.call(candidate, key))
        || candidate.type !== 'prompt-insert-terminal'
        || candidate.version !== PROMPT_INSERT_VERSION
        || candidate.target !== PROMPT_INSERT_TARGET
        || typeof candidate.requestId !== 'string'
        || candidate.requestId.length < 1
        || candidate.requestId.length > MAX_REQUEST_ID_LENGTH
        || typeof candidate.promptId !== 'string'
        || candidate.promptId.length < 1) {
        return undefined;
    }
    return candidate as unknown as PromptTerminalInsertRequest;
}
