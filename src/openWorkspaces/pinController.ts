'use strict';

export const OPEN_WORKSPACE_PIN_WEBVIEW_PROTOCOL_VERSION = 1;

export interface OpenWorkspacePinControllerOptions {
    getNavigationIdentity(cardId: string): string | null;
    setPinned(
        requestId: number,
        navigationIdentity: string,
        pinned: boolean,
    ): PromiseLike<unknown>;
    publishAuthoritativeUpdate(): PromiseLike<unknown>;
    postMessage(message: unknown): PromiseLike<unknown>;
    showError(message: string): unknown;
    logError(message: string, error: unknown): void;
}

interface ParsedPinRequest {
    requestId: number;
    cardId: string;
    pinned: boolean;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

function parseRequest(raw: unknown): ParsedPinRequest | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const value = raw as Record<string, unknown>;
    if (!exactKeys(value, ['type', 'version', 'requestId', 'cardId', 'pinned'])
        || value.type !== 'set-open-workspace-pin'
        || value.version !== OPEN_WORKSPACE_PIN_WEBVIEW_PROTOCOL_VERSION
        || !Number.isSafeInteger(value.requestId)
        || (value.requestId as number) < 1
        || typeof value.cardId !== 'string'
        || !/^__(?:openWorkspaceNavigation|currentWorkspace)-[a-f0-9]{24}$/.test(value.cardId)
        || typeof value.pinned !== 'boolean') {
        return null;
    }
    return {
        requestId: value.requestId as number,
        cardId: value.cardId,
        pinned: value.pinned,
    };
}

export class OpenWorkspacePinController {
    constructor(private readonly options: OpenWorkspacePinControllerOptions) {
    }

    async handle(raw: unknown): Promise<void> {
        const request = parseRequest(raw);
        if (!request) {
            await this.settleMalformed(raw);
            return;
        }
        const navigationIdentity = this.options.getNavigationIdentity(request.cardId);
        if (!navigationIdentity) {
            await this.settle(request, false);
            return;
        }
        let success = false;
        try {
            await this.options.setPinned(
                request.requestId,
                navigationIdentity,
                request.pinned,
            );
            await this.options.publishAuthoritativeUpdate();
            success = true;
        } catch (error) {
            this.options.logError('Failed to update OPEN workspace pin.', error);
            this.options.showError('Could not update the pinned window.');
        }
        await this.settle(request, success);
    }

    private async settleMalformed(raw: unknown): Promise<void> {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return;
        }
        const value = raw as Record<string, unknown>;
        if (!Number.isSafeInteger(value.requestId)
            || (value.requestId as number) < 1
            || typeof value.cardId !== 'string'
            || value.cardId.length < 1
            || value.cardId.length > 128
            || typeof value.pinned !== 'boolean') {
            return;
        }
        await this.settle({
            requestId: value.requestId as number,
            cardId: value.cardId,
            pinned: value.pinned,
        }, false);
    }

    private async settle(request: ParsedPinRequest, success: boolean): Promise<void> {
        try {
            await this.options.postMessage({
                type: 'open-workspace-pin-result',
                version: OPEN_WORKSPACE_PIN_WEBVIEW_PROTOCOL_VERSION,
                requestId: request.requestId,
                cardId: request.cardId,
                pinned: request.pinned,
                success,
            });
        } catch (error) {
            this.options.logError('Failed to settle OPEN workspace pin request.', error);
        }
    }
}
