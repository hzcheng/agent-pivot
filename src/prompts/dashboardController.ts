import {
    PromptMutationErrorCode,
    PromptMutationOperation,
    PromptPanelSnapshot,
} from './types';
import { PromptMutationError, PromptService } from './service';
import {
    getAiPanelContent,
    getAiPanelRecoveryContent,
    getPromptRecoveryContent,
    getPromptSurfaceContent,
} from './webviewContent';

const PROMPT_COMMAND_VERSION = 1;
const PROMPT_TARGET = 'global-prompt-library';
const MAX_PROMPT_REQUEST_ID_LENGTH = 128;
const COMMAND_KEYS = [
    'type',
    'version',
    'requestId',
    'target',
    'expectedRevision',
    'operation',
    'payload',
];
const PROMPT_OPERATIONS = new Set<PromptMutationOperation>([
    'create',
    'update',
    'delete',
    'reorder',
    'select-default',
]);
const UNAVAILABLE_SNAPSHOT: PromptPanelSnapshot = Object.freeze({
    version: 1,
    revision: 0,
    selectedPromptId: null,
    prompts: Object.freeze([]),
    readOnlyReason: 'invalid-data',
});

export interface PromptCommandMessage {
    readonly type: 'prompt-command';
    readonly version: 1;
    readonly requestId: string;
    readonly target: 'global-prompt-library';
    readonly expectedRevision: number;
    readonly operation: PromptMutationOperation;
    readonly payload: unknown;
}

export interface PromptCommandResultMessage {
    readonly type: 'prompt-command-result';
    readonly version: 1;
    readonly authoritySequence: number;
    readonly requestId: string;
    readonly target: 'global-prompt-library';
    readonly operation: PromptMutationOperation;
    readonly success: boolean;
    readonly snapshot: PromptPanelSnapshot;
    readonly html: string;
    readonly errorCode?: PromptMutationErrorCode;
}

export interface PromptPanelContentMessage {
    readonly type: 'ai-panel-content';
    readonly version: 1;
    readonly authoritySequence: number;
    readonly requestId: string;
    readonly target: 'global-prompt-library';
    readonly snapshot: PromptPanelSnapshot;
    readonly html: string;
}

export interface PromptPanelRefreshMessage {
    readonly type: 'prompt-panel-updated';
    readonly version: 1;
    readonly authoritySequence: number;
    readonly target: 'global-prompt-library';
    readonly snapshot: PromptPanelSnapshot;
    readonly html: string;
}

export interface PromptDeleteConfirmation {
    readonly id: string;
    readonly name: string;
}

export interface PromptDashboardControllerOptions {
    readonly service: PromptService;
    readonly confirmDelete: (prompt: PromptDeleteConfirmation) => Promise<boolean>;
    readonly renderPromptSurface?: (snapshot: PromptPanelSnapshot) => string;
    readonly renderAiPanel?: (snapshot: PromptPanelSnapshot) => string;
}

class PromptCommandValidationError extends Error {
    constructor(readonly code: PromptMutationErrorCode) {
        super(code);
        this.name = 'PromptCommandValidationError';
        Object.setPrototypeOf(this, PromptCommandValidationError.prototype);
    }
}

type UnknownRecord = { [key: string]: unknown };

interface PromptContentSnapshot {
    readonly snapshot: PromptPanelSnapshot;
    readonly readFailed: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
    return Object.keys(value).length === keys.length
        && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isRequestId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_PROMPT_REQUEST_ID_LENGTH;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function requireExactPayload(value: unknown, keys: readonly string[]): UnknownRecord {
    if (!isRecord(value) || !hasExactKeys(value, keys)) {
        throw new PromptCommandValidationError('invalid');
    }
    return value;
}

function requireString(value: unknown): string {
    if (typeof value !== 'string') {
        throw new PromptCommandValidationError('invalid');
    }
    return value;
}

function requirePromptId(value: unknown): string {
    if (!isNonEmptyString(value)) {
        throw new PromptCommandValidationError('invalid');
    }
    return value;
}

function requirePromptIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(id => !isNonEmptyString(id))) {
        throw new PromptCommandValidationError('invalid');
    }
    return value.slice();
}

function mapError(error: unknown): PromptMutationErrorCode {
    if (error instanceof PromptMutationError
        || error instanceof PromptCommandValidationError) {
        return error.code;
    }
    return 'storage';
}

function correlationKey(message: PromptCommandMessage): string {
    return JSON.stringify([
        message.version,
        message.requestId,
        message.target,
        message.operation,
    ]);
}

export class PromptDashboardController {
    private readonly service: PromptService;
    private readonly confirmDelete: (prompt: PromptDeleteConfirmation) => Promise<boolean>;
    private readonly renderPromptSurface: (snapshot: PromptPanelSnapshot) => string;
    private readonly renderAiPanel: (snapshot: PromptPanelSnapshot) => string;
    private readonly claimedCorrelationKeys = new Set<string>();
    private authoritySequence = 0;

    constructor(options: PromptDashboardControllerOptions) {
        this.service = options.service;
        this.confirmDelete = options.confirmDelete;
        this.renderPromptSurface = options.renderPromptSurface || getPromptSurfaceContent;
        this.renderAiPanel = options.renderAiPanel || getAiPanelContent;
    }

    async handle(value: unknown): Promise<PromptCommandResultMessage | undefined> {
        const message = this.readCorrelatedMessage(value);
        if (!message) {
            return undefined;
        }

        const key = correlationKey(message);
        if (this.claimedCorrelationKeys.has(key)) {
            return undefined;
        }
        this.claimedCorrelationKeys.add(key);
        return this.handleCorrelated(message);
    }

    private async handleCorrelated(message: PromptCommandMessage): Promise<PromptCommandResultMessage> {
        let success = false;
        let errorCode: PromptMutationErrorCode | undefined;
        let snapshot: PromptPanelSnapshot | undefined;
        try {
            this.validateTopLevel(message);
            snapshot = this.service.getSnapshot();
            snapshot = await this.execute(message, snapshot);
            success = true;
        } catch (error) {
            errorCode = mapError(error);
        }

        let requiresRecovery = false;
        try {
            snapshot = this.service.getSnapshot();
        } catch (_error) {
            success = false;
            errorCode = 'storage';
            snapshot = snapshot || (
                isNonNegativeInteger(message.expectedRevision)
                    ? { ...UNAVAILABLE_SNAPSHOT, revision: message.expectedRevision }
                    : UNAVAILABLE_SNAPSHOT
            );
            requiresRecovery = true;
        }

        let html: string;
        if (requiresRecovery) {
            html = getPromptRecoveryContent(snapshot);
        } else {
            try {
                html = this.renderPromptSurface(snapshot);
            } catch (_error) {
                success = false;
                errorCode = 'storage';
                html = getPromptRecoveryContent(snapshot);
            }
        }

        return {
            type: 'prompt-command-result',
            version: PROMPT_COMMAND_VERSION,
            authoritySequence: this.nextAuthoritySequence(),
            requestId: message.requestId,
            target: PROMPT_TARGET,
            operation: message.operation,
            success,
            snapshot,
            html,
            ...(errorCode ? { errorCode } : {}),
        };
    }

    getPanelContent(requestId: string): PromptPanelContentMessage {
        const content = this.getSnapshotForContent();
        const snapshot = content.snapshot;
        let html: string;
        if (content.readFailed) {
            html = getAiPanelRecoveryContent(snapshot);
        } else {
            try {
                html = this.renderAiPanel(snapshot);
            } catch (_error) {
                html = getAiPanelRecoveryContent(snapshot);
            }
        }
        return {
            type: 'ai-panel-content',
            version: PROMPT_COMMAND_VERSION,
            authoritySequence: this.nextAuthoritySequence(),
            requestId,
            target: PROMPT_TARGET,
            snapshot,
            html,
        };
    }

    getRefreshContent(): PromptPanelRefreshMessage {
        const content = this.getSnapshotForContent();
        const snapshot = content.snapshot;
        let html: string;
        if (content.readFailed) {
            html = getPromptRecoveryContent(snapshot);
        } else {
            try {
                html = this.renderPromptSurface(snapshot);
            } catch (_error) {
                html = getPromptRecoveryContent(snapshot);
            }
        }
        return {
            type: 'prompt-panel-updated',
            version: PROMPT_COMMAND_VERSION,
            authoritySequence: this.nextAuthoritySequence(),
            target: PROMPT_TARGET,
            snapshot,
            html,
        };
    }

    private readCorrelatedMessage(value: unknown): PromptCommandMessage | undefined {
        if (!isRecord(value)
            || value.type !== 'prompt-command'
            || value.version !== PROMPT_COMMAND_VERSION
            || !isRequestId(value.requestId)
            || value.target !== PROMPT_TARGET
            || typeof value.operation !== 'string'
            || !PROMPT_OPERATIONS.has(value.operation as PromptMutationOperation)) {
            return undefined;
        }
        return value as unknown as PromptCommandMessage;
    }

    private validateTopLevel(message: PromptCommandMessage): void {
        const value = message as unknown as UnknownRecord;
        if (!hasExactKeys(value, COMMAND_KEYS)
            || !isNonNegativeInteger(message.expectedRevision)) {
            throw new PromptCommandValidationError('invalid');
        }
    }

    private async execute(
        message: PromptCommandMessage,
        snapshot: PromptPanelSnapshot,
    ): Promise<PromptPanelSnapshot> {
        if (snapshot.readOnlyReason) {
            throw new PromptCommandValidationError(
                snapshot.readOnlyReason === 'unsupported-version'
                    ? 'unsupported-version'
                    : 'invalid'
            );
        }
        if (snapshot.revision !== message.expectedRevision) {
            throw new PromptCommandValidationError('conflict');
        }

        switch (message.operation) {
            case 'create': {
                const payload = requireExactPayload(message.payload, ['name', 'text']);
                return this.service.createPrompt(message.expectedRevision, {
                    name: requireString(payload.name),
                    text: requireString(payload.text),
                });
            }
            case 'update': {
                const payload = requireExactPayload(message.payload, ['promptId', 'name', 'text']);
                const promptId = requirePromptId(payload.promptId);
                this.requirePrompt(snapshot, promptId);
                return this.service.updatePrompt(message.expectedRevision, {
                    promptId,
                    name: requireString(payload.name),
                    text: requireString(payload.text),
                });
            }
            case 'delete': {
                const payload = requireExactPayload(message.payload, ['promptId']);
                const promptId = requirePromptId(payload.promptId);
                const prompt = this.requirePrompt(snapshot, promptId);
                const confirmed = await this.confirmDelete({ id: prompt.id, name: prompt.name });
                if (!confirmed) {
                    throw new PromptCommandValidationError('cancelled');
                }
                return this.service.deletePrompt(message.expectedRevision, promptId);
            }
            case 'reorder': {
                const payload = requireExactPayload(message.payload, ['promptIds']);
                const promptIds = requirePromptIds(payload.promptIds);
                if (!this.isExactPromptPermutation(snapshot, promptIds)) {
                    throw new PromptCommandValidationError('invalid');
                }
                return this.service.reorderPrompts(message.expectedRevision, promptIds);
            }
            case 'select-default': {
                const payload = requireExactPayload(message.payload, ['promptId']);
                const promptId = payload.promptId === null
                    ? null
                    : requirePromptId(payload.promptId);
                if (promptId !== null) {
                    this.requirePrompt(snapshot, promptId);
                }
                return this.service.selectDefault(message.expectedRevision, promptId);
            }
        }
    }

    private requirePrompt(snapshot: PromptPanelSnapshot, promptId: string) {
        const prompt = snapshot.prompts.find(candidate => candidate.id === promptId);
        if (!prompt) {
            throw new PromptCommandValidationError('not-found');
        }
        return prompt;
    }

    private isExactPromptPermutation(
        snapshot: PromptPanelSnapshot,
        promptIds: readonly string[],
    ): boolean {
        if (snapshot.prompts.length !== promptIds.length) {
            return false;
        }
        const requestedIds = new Set(promptIds);
        return requestedIds.size === promptIds.length
            && snapshot.prompts.every(prompt => requestedIds.has(prompt.id));
    }

    private getSnapshotForContent(): PromptContentSnapshot {
        try {
            return { snapshot: this.service.getSnapshot(), readFailed: false };
        } catch (_error) {
            return { snapshot: UNAVAILABLE_SNAPSHOT, readFailed: true };
        }
    }

    private nextAuthoritySequence(): number {
        this.authoritySequence += 1;
        return this.authoritySequence;
    }
}
