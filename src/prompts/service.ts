import {
    PromptDataV1,
    PromptMutationErrorCode,
    PromptMutationOperation,
    PromptPanelSnapshot,
    PromptReadResult,
    PromptV1,
} from './types';

export interface PromptServiceOptions {
    readSetting: () => unknown;
    writeGlobalSetting: (data: PromptDataV1) => Promise<void>;
    createId: () => string;
    logDiagnostic?: (event: {
        category: string;
        revision?: number;
        promptId?: string;
        promptName?: string;
    }) => void;
}

export class PromptMutationError extends Error {
    constructor(
        readonly code: PromptMutationErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'PromptMutationError';
        Object.setPrototypeOf(this, PromptMutationError.prototype);
    }
}

type PromptMutation = (data: PromptDataV1) => PromptDataV1;

interface PendingLocalWriteEcho {
    id: number;
    fingerprint: string;
}

const EMPTY_PROMPT_DATA: PromptDataV1 = {
    version: 1,
    revision: 0,
    selectedPromptId: null,
    prompts: [],
};

function isRecord(value: unknown): value is { [key: string]: unknown } {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: { [key: string]: unknown }, keys: readonly string[]): boolean {
    return Object.keys(value).every(key => keys.indexOf(key) >= 0)
        && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cloneAndFreezeSnapshot(
    data: PromptDataV1,
    readOnlyReason?: 'invalid-data' | 'unsupported-version'
): PromptPanelSnapshot {
    const prompts = data.prompts.map(prompt => Object.freeze({
        id: prompt.id,
        name: prompt.name,
        text: prompt.text,
    }));
    const snapshot: PromptPanelSnapshot = {
        version: 1,
        revision: data.revision,
        selectedPromptId: data.selectedPromptId,
        prompts: Object.freeze(prompts),
    };
    if (readOnlyReason) {
        (snapshot as { readOnlyReason?: 'invalid-data' | 'unsupported-version' }).readOnlyReason = readOnlyReason;
    }
    return Object.freeze(snapshot);
}

function readyResult(data: PromptDataV1): PromptReadResult {
    return { status: 'ready', snapshot: cloneAndFreezeSnapshot(data) };
}

function readOnlyResult(reason: 'invalid-data' | 'unsupported-version'): PromptReadResult {
    return {
        status: 'read-only',
        snapshot: cloneAndFreezeSnapshot(EMPTY_PROMPT_DATA, reason),
    };
}

function normalizeName(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const name = value.trim();
    return name.length > 0 ? name : undefined;
}

function hasNonBlankText(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isPromptId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function normalizePrompt(value: unknown): PromptV1 | undefined {
    if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'text'])) {
        return undefined;
    }
    const name = normalizeName(value.name);
    if (!isPromptId(value.id) || !name || !hasNonBlankText(value.text)) {
        return undefined;
    }
    return { id: value.id, name, text: value.text };
}

function promptNameKey(name: string): string {
    // Prompt identity must remain stable for globally synchronized settings.
    return name.toLowerCase();
}

function namesEqual(left: string, right: string): boolean {
    return promptNameKey(left) === promptNameKey(right);
}

function hasDuplicateNames(prompts: readonly PromptV1[]): boolean {
    const names = new Set<string>();
    for (const prompt of prompts) {
        const key = promptNameKey(prompt.name);
        if (names.has(key)) {
            return true;
        }
        names.add(key);
    }
    return false;
}

function isExactPermutation(candidate: readonly string[], prompts: readonly PromptV1[]): boolean {
    if (candidate.length !== prompts.length) {
        return false;
    }
    const knownIds = new Set(prompts.map(prompt => prompt.id));
    const seen = new Set<string>();
    for (const id of candidate) {
        if (!isPromptId(id) || !knownIds.has(id) || seen.has(id)) {
            return false;
        }
        seen.add(id);
    }
    return true;
}

function fingerprint(data: PromptDataV1): string {
    return JSON.stringify(data);
}

export function normalizePromptSetting(value: unknown): PromptReadResult {
    if (value === undefined) {
        return readyResult(EMPTY_PROMPT_DATA);
    }
    if (!isRecord(value)) {
        return readOnlyResult('invalid-data');
    }

    if (typeof value.version === 'number'
        && Number.isSafeInteger(value.version)
        && value.version > 1) {
        return readOnlyResult('unsupported-version');
    }

    if (!hasOnlyKeys(value, ['version', 'revision', 'selectedPromptId', 'prompts'])
        || value.version !== 1
        || !isNonNegativeInteger(value.revision)
        || (value.selectedPromptId !== null && typeof value.selectedPromptId !== 'string')
        || !Array.isArray(value.prompts)) {
        return readOnlyResult('invalid-data');
    }

    const prompts: PromptV1[] = [];
    const promptIds = new Set<string>();
    for (const valuePrompt of value.prompts) {
        const prompt = normalizePrompt(valuePrompt);
        if (!prompt || promptIds.has(prompt.id)) {
            return readOnlyResult('invalid-data');
        }
        promptIds.add(prompt.id);
        prompts.push(prompt);
    }
    if (hasDuplicateNames(prompts)) {
        return readOnlyResult('invalid-data');
    }

    const selectedPromptId = value.selectedPromptId !== null && promptIds.has(value.selectedPromptId)
        ? value.selectedPromptId
        : null;
    return readyResult({
        version: 1,
        revision: value.revision,
        selectedPromptId,
        prompts,
    });
}

export class PromptService {
    private mutationQueue: Promise<void> = Promise.resolve();
    private pendingLocalWriteEchoes: PendingLocalWriteEcho[] = [];
    private nextLocalWriteEchoId = 0;

    constructor(private readonly options: PromptServiceOptions) {}

    getSnapshot(): PromptPanelSnapshot {
        const result = normalizePromptSetting(this.options.readSetting());
        this.logReadOnlyResult(result);
        return result.snapshot;
    }

    createPrompt(
        expectedRevision: number,
        input: { name: string; text: string },
    ): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'create', data => {
            const name = this.requireName(input && input.name);
            const text = this.requireText(input && input.text);
            if (data.prompts.some(prompt => namesEqual(prompt.name, name))) {
                throw new PromptMutationError('invalid', 'A Prompt with that name already exists.');
            }
            const id = this.options.createId();
            if (!isPromptId(id) || data.prompts.some(prompt => prompt.id === id)) {
                throw new PromptMutationError('invalid', 'Could not create a unique Prompt ID.');
            }
            return {
                version: 1,
                revision: data.revision + 1,
                selectedPromptId: data.selectedPromptId,
                prompts: [...data.prompts, { id, name, text }],
            };
        });
    }

    updatePrompt(
        expectedRevision: number,
        input: { promptId: string; name: string; text: string },
    ): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'update', data => {
            const promptId = this.requirePromptId(input && input.promptId);
            const existing = data.prompts.find(prompt => prompt.id === promptId);
            if (!existing) {
                throw new PromptMutationError('not-found', 'The Prompt no longer exists.');
            }
            const name = this.requireName(input && input.name);
            const text = this.requireText(input && input.text);
            if (data.prompts.some(prompt => prompt.id !== promptId && namesEqual(prompt.name, name))) {
                throw new PromptMutationError('invalid', 'A Prompt with that name already exists.');
            }
            return {
                version: 1,
                revision: data.revision + 1,
                selectedPromptId: data.selectedPromptId,
                prompts: data.prompts.map(prompt => prompt.id === promptId ? { id: prompt.id, name, text } : prompt),
            };
        });
    }

    deletePrompt(expectedRevision: number, promptId: string): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'delete', data => {
            const id = this.requirePromptId(promptId);
            if (!data.prompts.some(prompt => prompt.id === id)) {
                throw new PromptMutationError('not-found', 'The Prompt no longer exists.');
            }
            return {
                version: 1,
                revision: data.revision + 1,
                selectedPromptId: data.selectedPromptId === id ? null : data.selectedPromptId,
                prompts: data.prompts.filter(prompt => prompt.id !== id),
            };
        });
    }

    reorderPrompts(expectedRevision: number, promptIds: readonly string[]): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'reorder', data => {
            if (!Array.isArray(promptIds) || !isExactPermutation(promptIds, data.prompts)) {
                throw new PromptMutationError('invalid', 'Prompt order must include every Prompt exactly once.');
            }
            const promptsById = new Map(data.prompts.map(prompt => [prompt.id, prompt]));
            return {
                version: 1,
                revision: data.revision + 1,
                selectedPromptId: data.selectedPromptId,
                prompts: promptIds.map(id => promptsById.get(id) as PromptV1),
            };
        });
    }

    selectDefault(expectedRevision: number, promptId: string | null): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'select-default', data => {
            if (promptId !== null && !isPromptId(promptId)) {
                throw new PromptMutationError('invalid', 'Prompt ID must be a non-empty string or null.');
            }
            if (promptId !== null && !data.prompts.some(prompt => prompt.id === promptId)) {
                throw new PromptMutationError('not-found', 'The Prompt no longer exists.');
            }
            return {
                version: 1,
                revision: data.revision + 1,
                selectedPromptId: data.selectedPromptId === promptId ? null : promptId,
                prompts: data.prompts,
            };
        });
    }

    consumeCurrentSettingsDataLocalWriteEcho(): boolean {
        try {
            const current = normalizePromptSetting(this.options.readSetting());
            if (current.status !== 'ready') {
                this.pendingLocalWriteEchoes = [];
                return false;
            }
            const currentFingerprint = fingerprint(current.snapshot);
            const echoIndex = this.pendingLocalWriteEchoes.findIndex(
                echo => echo.fingerprint === currentFingerprint
            );
            if (echoIndex < 0) {
                this.pendingLocalWriteEchoes = [];
                return false;
            }
            this.pendingLocalWriteEchoes.splice(0, echoIndex + 1);
            return true;
        } catch (_error) {
            this.pendingLocalWriteEchoes = [];
            return false;
        }
    }

    private mutate(
        expectedRevision: number,
        operation: PromptMutationOperation,
        mutation: PromptMutation,
    ): Promise<PromptPanelSnapshot> {
        return this.enqueue(async () => {
            if (!isNonNegativeInteger(expectedRevision)) {
                throw new PromptMutationError('invalid', 'Expected revision must be a non-negative integer.');
            }

            const current = normalizePromptSetting(this.options.readSetting());
            this.logReadOnlyResult(current);
            if (current.status === 'read-only') {
                throw new PromptMutationError(
                    current.snapshot.readOnlyReason === 'unsupported-version' ? 'unsupported-version' : 'invalid',
                    'Prompt data is read-only until its stored format is corrected.'
                );
            }
            if (current.snapshot.revision !== expectedRevision) {
                throw new PromptMutationError('conflict', 'The Prompt library changed. Refresh and try again.');
            }

            const nextData = mutation(current.snapshot);
            const echo: PendingLocalWriteEcho = {
                id: ++this.nextLocalWriteEchoId,
                fingerprint: fingerprint(nextData),
            };
            this.pendingLocalWriteEchoes.push(echo);
            try {
                await this.options.writeGlobalSetting(nextData);
            } catch (_error) {
                this.pendingLocalWriteEchoes = this.pendingLocalWriteEchoes
                    .filter(candidate => candidate.id !== echo.id);
                this.getSnapshot();
                this.logDiagnostic({ category: 'prompt-write-failed', revision: current.snapshot.revision });
                throw new PromptMutationError('storage', 'Could not save the Prompt library.');
            }

            this.logDiagnostic({ category: `prompt-${operation}`, revision: nextData.revision });
            return cloneAndFreezeSnapshot(nextData);
        });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private requireName(value: unknown): string {
        const name = normalizeName(value);
        if (!name) {
            throw new PromptMutationError('invalid', 'Prompt name must not be blank.');
        }
        return name;
    }

    private requireText(value: unknown): string {
        if (!hasNonBlankText(value)) {
            throw new PromptMutationError('invalid', 'Prompt text must not be blank.');
        }
        return value;
    }

    private requirePromptId(value: unknown): string {
        if (!isPromptId(value)) {
            throw new PromptMutationError('invalid', 'Prompt ID must be a non-empty string.');
        }
        return value;
    }

    private logReadOnlyResult(result: PromptReadResult): void {
        if (result.status === 'read-only') {
            this.logDiagnostic({ category: `prompt-${result.snapshot.readOnlyReason}` });
        }
    }

    private logDiagnostic(event: {
        category: string;
        revision?: number;
        promptId?: string;
        promptName?: string;
    }): void {
        if (!this.options.logDiagnostic) {
            return;
        }
        this.options.logDiagnostic({
            category: event.category,
            revision: event.revision,
            promptId: event.promptId && event.promptId.slice(0, 120),
            promptName: event.promptName && event.promptName.slice(0, 120),
        });
    }
}
