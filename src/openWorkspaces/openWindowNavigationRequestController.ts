'use strict';

import type { OpenWorkspaceNavigationSettlement } from './navigationController';

// Versioned webview request/settlement protocol for the OPEN tab window
// switcher: `open-window-navigation-request` carries { requestId, cardId } and
// every request settles exactly once via `open-window-navigation-result` with
// the association fields echoed back, so the webview can resolve its pending
// state (and ignore stale or duplicate settlements).
export const OPEN_WINDOW_NAVIGATION_WEBVIEW_PROTOCOL_VERSION = 1;
export const OPEN_WINDOW_NAVIGATION_REQUEST_MESSAGE_TYPE = 'open-window-navigation-request';
export const OPEN_WINDOW_NAVIGATION_RESULT_MESSAGE_TYPE = 'open-window-navigation-result';

export type OpenWindowNavigationResultOutcome =
    OpenWorkspaceNavigationSettlement | 'malformed-request';

export const OPEN_WINDOW_NAVIGATION_RESULT_OUTCOMES: readonly OpenWindowNavigationResultOutcome[] = [
    'focused',
    'stale-target',
    'untitled-workspace',
    'failed',
    'malformed-request',
];

export interface OpenWindowNavigationRequestControllerOptions {
    navigate(cardId: string): Promise<OpenWorkspaceNavigationSettlement>;
    postMessage(message: unknown): PromiseLike<unknown>;
    logError(message: string, error: unknown): void;
}

interface ParsedNavigationRequest {
    requestId: number;
    cardId: string;
}

const CARD_ID_PATTERN = /^__(?:openWorkspaceNavigation|currentWorkspace)-[a-f0-9]{24}$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

function isValidRequestId(value: unknown): boolean {
    return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isValidCardId(value: unknown): boolean {
    return typeof value === 'string' && CARD_ID_PATTERN.test(value);
}

function parseRequest(raw: unknown): ParsedNavigationRequest | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const value = raw as Record<string, unknown>;
    if (!exactKeys(value, ['type', 'version', 'requestId', 'cardId'])
        || value.type !== OPEN_WINDOW_NAVIGATION_REQUEST_MESSAGE_TYPE
        || value.version !== OPEN_WINDOW_NAVIGATION_WEBVIEW_PROTOCOL_VERSION
        || !isValidRequestId(value.requestId)
        || !isValidCardId(value.cardId)) {
        return null;
    }
    return {
        requestId: value.requestId as number,
        cardId: value.cardId as string,
    };
}

export class OpenWindowNavigationRequestController {
    constructor(private readonly options: OpenWindowNavigationRequestControllerOptions) {
    }

    async handle(raw: unknown): Promise<void> {
        const request = parseRequest(raw);
        if (!request) {
            await this.settleMalformed(raw);
            return;
        }
        let outcome: OpenWorkspaceNavigationSettlement;
        try {
            outcome = await this.options.navigate(request.cardId);
        } catch (error) {
            this.options.logError('Failed to navigate to the requested window.', error);
            outcome = 'failed';
        }
        await this.settle(request, outcome);
    }

    // Malformed requests still settle when their association fields are
    // salvageable; otherwise the webview falls back to its own timeout.
    private async settleMalformed(raw: unknown): Promise<void> {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return;
        }
        const value = raw as Record<string, unknown>;
        if (!isValidRequestId(value.requestId) || !isValidCardId(value.cardId)) {
            return;
        }
        await this.settle({
            requestId: value.requestId as number,
            cardId: value.cardId as string,
        }, 'malformed-request');
    }

    private async settle(
        request: ParsedNavigationRequest,
        outcome: OpenWindowNavigationResultOutcome,
    ): Promise<void> {
        try {
            await this.options.postMessage({
                type: OPEN_WINDOW_NAVIGATION_RESULT_MESSAGE_TYPE,
                version: OPEN_WINDOW_NAVIGATION_WEBVIEW_PROTOCOL_VERSION,
                requestId: request.requestId,
                cardId: request.cardId,
                outcome,
            });
        } catch (error) {
            this.options.logError('Failed to settle open-window navigation request.', error);
        }
    }
}
