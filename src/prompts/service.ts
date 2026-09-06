import {
    PromptDataV1,
    PromptDataV2,
    PromptGroupV1,
    PromptMutationErrorCode,
    PromptMutationOperation,
    PromptPanelSnapshot,
    PromptReadResult,
    PromptV1,
    PromptV2,
    GENERAL_PROMPT_GROUP_ID,
} from './types';

export interface PromptServiceOptions {
    readSetting: () => unknown;
    writeGlobalSetting: (data: PromptDataV2) => Promise<void>;
    createId: () => string;
    logDiagnostic?: (event: {
        category: string;
        revision?: number;
        promptId?: string;
        promptName?: string;
    }) => void;
}

const PROMPT_DATA_SYNC_KEY = 'promptData.v1';

interface PromptMemento {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
    setKeysForSync(keys: string[]): void;
}

export interface PromptMementoStoreOptions {
    globalState: PromptMemento;
    readLegacySetting: () => unknown;
}

export interface PromptMementoStore {
    readSetting: () => unknown;
    writeGlobalSetting: (data: PromptDataV2) => Promise<void>;
}

export async function initializePromptMementoStore(
    options: PromptMementoStoreOptions
): Promise<PromptMementoStore> {
    options.globalState.setKeysForSync([PROMPT_DATA_SYNC_KEY]);
    if (options.globalState.get(PROMPT_DATA_SYNC_KEY) === undefined) {
        const legacyData = options.readLegacySetting();
        if (legacyData !== undefined) {
            await options.globalState.update(PROMPT_DATA_SYNC_KEY, legacyData);
        }
    }
    return {
        readSetting: () => options.globalState.get(PROMPT_DATA_SYNC_KEY),
        writeGlobalSetting: async data => {
            await options.globalState.update(PROMPT_DATA_SYNC_KEY, data);
        },
    };
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

type PromptMutation = (data: PromptDataV2) => PromptDataV2;

interface PendingLocalWriteEcho {
    id: number;
    fingerprint: string;
}

const GENERAL_GROUP: PromptGroupV1 = Object.freeze({
    id: GENERAL_PROMPT_GROUP_ID,
    name: 'General',
    kind: 'general',
});

const EMPTY_PROMPT_DATA: PromptDataV2 = {
    version: 2,
    revision: 0,
    selectedPromptId: null,
    groups: [GENERAL_GROUP],
    prompts: [],
};

function isRecord(value: unknown): value is { [key: string]: unknown } {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSettingsWriteConflict(error: unknown): boolean {
    const message = error instanceof Error
        ? error.message
        : isRecord(error) && typeof error.message === 'string'
            ? error.message
            : '';
    const normalized = message.toLowerCase();
    return normalized.includes('user settings')
        && (
            normalized.includes('unsaved changes')
            || normalized.includes('content of the file is newer')
        );
}

function hasOnlyKeys(value: { [key: string]: unknown }, keys: readonly string[]): boolean {
    return Object.keys(value).every(key => keys.indexOf(key) >= 0)
        && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cloneAndFreezeSnapshot(
    data: PromptDataV2,
    readOnlyReason?: 'invalid-data' | 'unsupported-version'
): PromptPanelSnapshot {
    const prompts = data.prompts.map(prompt => Object.freeze({
        id: prompt.id,
        name: prompt.name,
        ...(prompt.description === undefined ? {} : { description: prompt.description }),
        text: prompt.text,
        groupId: prompt.groupId,
    }));
    const groups = data.groups.map(group => Object.freeze({
        id: group.id,
        name: group.name,
        kind: group.kind,
    }));
    const snapshot: PromptPanelSnapshot = {
        version: 2,
        revision: data.revision,
        selectedPromptId: data.selectedPromptId,
        groups: Object.freeze(groups),
        prompts: Object.freeze(prompts),
    };
    if (readOnlyReason) {
        (snapshot as { readOnlyReason?: 'invalid-data' | 'unsupported-version' }).readOnlyReason = readOnlyReason;
    }
    return Object.freeze(snapshot);
}

function readyResult(data: PromptDataV2): PromptReadResult {
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

function normalizePromptV1(value: unknown): PromptV1 | undefined {
    if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'text'])) {
        return undefined;
    }
    const name = normalizeName(value.name);
    if (!isPromptId(value.id) || !name || !hasNonBlankText(value.text)) {
        return undefined;
    }
    return { id: value.id, name, text: value.text };
}

function normalizeOptionalDescription(value: unknown): string | undefined | null {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const description = value.trim();
    return description || undefined;
}

function normalizePromptV2(value: unknown): PromptV2 | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const keys = value.description === undefined
        ? ['id', 'name', 'text', 'groupId']
        : ['id', 'name', 'description', 'text', 'groupId'];
    if (!hasOnlyKeys(value, keys)) {
        return undefined;
    }
    const name = normalizeName(value.name);
    const description = normalizeOptionalDescription(value.description);
    if (!isPromptId(value.id) || !name || description === null
        || !hasNonBlankText(value.text) || !isPromptId(value.groupId)) {
        return undefined;
    }
    return {
        id: value.id,
        name,
        ...(description === undefined ? {} : { description }),
        text: value.text,
        groupId: value.groupId,
    };
}

function normalizeGroup(value: unknown): PromptGroupV1 | undefined {
    if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'kind'])) {
        return undefined;
    }
    const name = normalizeName(value.name);
    if (!isPromptId(value.id) || !name || (value.kind !== 'general' && value.kind !== 'custom')) {
        return undefined;
    }
    if (value.kind === 'general'
        && (value.id !== GENERAL_PROMPT_GROUP_ID || value.name !== 'General')) {
        return undefined;
    }
    return { id: value.id, name, kind: value.kind };
}

function promptNameKey(name: string): string {
    // Prompt identity must remain stable for globally synchronized settings.
    return name.toLowerCase();
}

function namesEqual(left: string, right: string): boolean {
    return promptNameKey(left) === promptNameKey(right);
}

function hasDuplicateNames(prompts: readonly (PromptV1 | PromptV2)[]): boolean {
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

function isExactPermutation(candidate: readonly string[], prompts: readonly PromptV2[]): boolean {
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

function fingerprint(data: PromptDataV2): string {
    return JSON.stringify(data);
}

function promptsOrderedByGroups(
    groups: readonly PromptGroupV1[],
    prompts: readonly PromptV2[],
): PromptV2[] {
    const ordered: PromptV2[] = [];
    for (const group of groups) {
        for (const prompt of prompts) {
            if (prompt.groupId === group.id) {
                ordered.push(prompt);
            }
        }
    }
    return ordered;
}

function migrateV1(data: PromptDataV1): PromptDataV2 {
    return {
        version: 2,
        revision: data.revision,
        selectedPromptId: data.selectedPromptId,
        groups: [GENERAL_GROUP],
        prompts: data.prompts.map(prompt => ({
            id: prompt.id,
            name: prompt.name,
            text: prompt.text,
            groupId: GENERAL_PROMPT_GROUP_ID,
        })),
    };
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
        && value.version > 2) {
        return readOnlyResult('unsupported-version');
    }

    if (value.version === 1) {
        if (!hasOnlyKeys(value, ['version', 'revision', 'selectedPromptId', 'prompts'])
            || !isNonNegativeInteger(value.revision)
            || (value.selectedPromptId !== null && typeof value.selectedPromptId !== 'string')
            || !Array.isArray(value.prompts)) {
            return readOnlyResult('invalid-data');
        }
        const prompts: PromptV1[] = [];
        const promptIds = new Set<string>();
        for (const valuePrompt of value.prompts) {
            const prompt = normalizePromptV1(valuePrompt);
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
        return readyResult(migrateV1({
            version: 1, revision: value.revision, selectedPromptId, prompts,
        }));
    }

    if (!hasOnlyKeys(value, ['version', 'revision', 'selectedPromptId', 'groups', 'prompts'])
        || value.version !== 2
        || !isNonNegativeInteger(value.revision)
        || (value.selectedPromptId !== null && typeof value.selectedPromptId !== 'string')
        || !Array.isArray(value.groups)
        || !Array.isArray(value.prompts)) {
        return readOnlyResult('invalid-data');
    }

    const groups: PromptGroupV1[] = [];
    const groupIds = new Set<string>();
    for (const valueGroup of value.groups) {
        const group = normalizeGroup(valueGroup);
        if (!group || groupIds.has(group.id)) {
            return readOnlyResult('invalid-data');
        }
        groupIds.add(group.id);
        groups.push(group);
    }
    if (groups.length === 0 || groups[0].id !== GENERAL_PROMPT_GROUP_ID
        || groups[0].kind !== 'general' || groups.filter(group => group.kind === 'general').length !== 1) {
        return readOnlyResult('invalid-data');
    }

    const prompts: PromptV2[] = [];
    const promptIds = new Set<string>();
    for (const valuePrompt of value.prompts) {
        const prompt = normalizePromptV2(valuePrompt);
        if (!prompt || promptIds.has(prompt.id) || !groupIds.has(prompt.groupId)) {
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
        version: 2,
        revision: value.revision,
        selectedPromptId,
        groups,
        prompts,
    });
}

export class PromptService {
    private mutationQueue: Promise<void> = Promise.resolve();
    private pendingLocalWriteEchoes: PendingLocalWriteEcho[] = [];
    private nextLocalWriteEchoId = 0;

    constructor(private readonly options: PromptServiceOptions) {}

    getSnapshot(): PromptPanelSnapshot {
        return this.readCurrentSetting().snapshot;
    }

    createPrompt(
        expectedRevision: number,
        input: { name: string; description?: string; text: string; groupId?: string },
    ): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'create', data => {
            const name = this.requireName(input && input.name);
            const description = this.requireOptionalDescription(input && input.description);
            const text = this.requireText(input && input.text);
            const groupId = this.requireGroupId(data, input && input.groupId || GENERAL_PROMPT_GROUP_ID);
            if (data.prompts.some(prompt => namesEqual(prompt.name, name))) {
                throw new PromptMutationError('invalid', 'A Prompt with that name already exists.');
            }
            const id = this.options.createId();
            if (!isPromptId(id) || data.prompts.some(prompt => prompt.id === id)) {
                throw new PromptMutationError('invalid', 'Could not create a unique Prompt ID.');
            }
            return {
                version: 2,
                revision: data.revision + 1,
                selectedPromptId: data.selectedPromptId,
                groups: data.groups,
                prompts: [...data.prompts, {
                    id, name, ...(description === undefined ? {} : { description }), text, groupId,
                }],
            };
        });
    }

    updatePrompt(
        expectedRevision: number,
        input: { promptId: string; name: string; description?: string; text: string },
    ): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'update', data => {
            const promptId = this.requirePromptId(input && input.promptId);
            const existing = data.prompts.find(prompt => prompt.id === promptId);
            if (!existing) {
                throw new PromptMutationError('not-found', 'The Prompt no longer exists.');
            }
            const name = this.requireName(input && input.name);
            const description = this.requireOptionalDescription(input && input.description);
            const text = this.requireText(input && input.text);
            if (data.prompts.some(prompt => prompt.id !== promptId && namesEqual(prompt.name, name))) {
                throw new PromptMutationError('invalid', 'A Prompt with that name already exists.');
            }
            return {
                version: 2,
                revision: data.revision + 1,
                selectedPromptId: data.selectedPromptId,
                groups: data.groups,
                prompts: data.prompts.map(prompt => prompt.id === promptId ? {
                    id: prompt.id, name, ...(description === undefined ? {} : { description }),
                    text, groupId: prompt.groupId,
                } : prompt),
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
                version: 2,
                revision: data.revision + 1,
                selectedPromptId: data.selectedPromptId === id ? null : data.selectedPromptId,
                groups: data.groups,
                prompts: data.prompts.filter(prompt => prompt.id !== id),
            };
        });
    }

    reorderPrompts(
        expectedRevision: number,
        groupIdOrPromptIds: string | readonly string[],
        promptIdsArg?: readonly string[],
    ): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'reorder', data => {
            const groupId = typeof groupIdOrPromptIds === 'string'
                ? groupIdOrPromptIds
                : GENERAL_PROMPT_GROUP_ID;
            const promptIds = typeof groupIdOrPromptIds === 'string'
                ? promptIdsArg
                : groupIdOrPromptIds;
            const targetGroupId = this.requireGroupId(data, groupId);
            const groupPrompts = data.prompts.filter(prompt => prompt.groupId === targetGroupId);
            if (!Array.isArray(promptIds) || !isExactPermutation(promptIds, groupPrompts)) {
                throw new PromptMutationError('invalid', 'Prompt order must include every Prompt in the group exactly once.');
            }
            const promptsById = new Map(data.prompts.map(prompt => [prompt.id, prompt]));
            return {
                version: 2,
                revision: data.revision + 1,
                selectedPromptId: data.selectedPromptId,
                groups: data.groups,
                prompts: promptsOrderedByGroups(data.groups, data.groups.reduce((all, group) => {
                    const groupItems = group.id === targetGroupId
                        ? promptIds.map(id => promptsById.get(id) as PromptV2)
                        : data.prompts.filter(prompt => prompt.groupId === group.id);
                    return all.concat(groupItems);
                }, [] as PromptV2[])),
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
                version: 2,
                revision: data.revision + 1,
                selectedPromptId: data.selectedPromptId === promptId ? null : promptId,
                groups: data.groups,
                prompts: data.prompts,
            };
        });
    }

    createGroup(expectedRevision: number, name: string): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'create-group', data => {
            const normalizedName = this.requireName(name);
            if (data.groups.some(group => namesEqual(group.name, normalizedName))) {
                throw new PromptMutationError('invalid', 'A Prompt group with that name already exists.');
            }
            const id = this.options.createId();
            if (!isPromptId(id) || data.groups.some(group => group.id === id)
                || data.prompts.some(prompt => prompt.id === id)) {
                throw new PromptMutationError('invalid', 'Could not create a unique Prompt group ID.');
            }
            return {
                version: 2, revision: data.revision + 1, selectedPromptId: data.selectedPromptId,
                groups: [...data.groups, { id, name: normalizedName, kind: 'custom' }],
                prompts: data.prompts,
            };
        });
    }

    renameGroup(expectedRevision: number, groupId: string, name: string): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'rename-group', data => {
            const group = this.requireCustomGroup(data, groupId);
            const normalizedName = this.requireName(name);
            if (data.groups.some(candidate => candidate.id !== group.id && namesEqual(candidate.name, normalizedName))) {
                throw new PromptMutationError('invalid', 'A Prompt group with that name already exists.');
            }
            return {
                version: 2, revision: data.revision + 1, selectedPromptId: data.selectedPromptId,
                groups: data.groups.map(candidate => candidate.id === group.id
                    ? { ...candidate, name: normalizedName } : candidate),
                prompts: data.prompts,
            };
        });
    }

    deleteGroup(expectedRevision: number, groupId: string): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'delete-group', data => {
            const group = this.requireCustomGroup(data, groupId);
            const moved = data.prompts.filter(prompt => prompt.groupId === group.id)
                .map(prompt => ({ ...prompt, groupId: GENERAL_PROMPT_GROUP_ID }));
            const remaining = data.prompts.filter(prompt => prompt.groupId !== group.id);
            const generalPrompts = remaining.filter(prompt => prompt.groupId === GENERAL_PROMPT_GROUP_ID);
            const otherPrompts = remaining.filter(prompt => prompt.groupId !== GENERAL_PROMPT_GROUP_ID);
            return {
                version: 2, revision: data.revision + 1, selectedPromptId: data.selectedPromptId,
                groups: data.groups.filter(candidate => candidate.id !== group.id),
                prompts: [...generalPrompts, ...moved, ...otherPrompts],
            };
        });
    }

    movePrompt(
        expectedRevision: number,
        promptId: string,
        targetGroupId: string,
    ): Promise<PromptPanelSnapshot> {
        return this.mutate(expectedRevision, 'move', data => {
            const id = this.requirePromptId(promptId);
            const target = this.requireGroupId(data, targetGroupId);
            const prompt = data.prompts.find(candidate => candidate.id === id);
            if (!prompt) {
                throw new PromptMutationError('not-found', 'The Prompt no longer exists.');
            }
            if (prompt.groupId === target) {
                return data;
            }
            const moved = { ...prompt, groupId: target };
            const unchanged = data.prompts.filter(candidate => candidate.id !== id);
            const beforeTarget = unchanged.filter(candidate => candidate.groupId !== target);
            const targetItems = unchanged.filter(candidate => candidate.groupId === target);
            return {
                version: 2, revision: data.revision + 1, selectedPromptId: data.selectedPromptId,
                groups: data.groups,
                prompts: promptsOrderedByGroups(data.groups, data.groups.reduce((all, group) => {
                    const groupItems = group.id === target
                        ? targetItems.concat([moved])
                        : beforeTarget.filter(candidate => candidate.groupId === group.id);
                    return all.concat(groupItems);
                }, [] as PromptV2[])),
            };
        });
    }

    consumeCurrentSettingsDataLocalWriteEcho(): boolean {
        try {
            const current = this.readCurrentSetting();
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

            const current = this.readCurrentSetting();
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
            } catch (error) {
                this.pendingLocalWriteEchoes = this.pendingLocalWriteEchoes
                    .filter(candidate => candidate.id !== echo.id);
                this.getSnapshot();
                const settingsConflict = isSettingsWriteConflict(error);
                this.logDiagnostic({
                    category: settingsConflict
                        ? 'prompt-write-settings-conflict'
                        : 'prompt-write-failed',
                    revision: current.snapshot.revision,
                });
                if (settingsConflict) {
                    throw new PromptMutationError(
                        'settings-write-conflict',
                        'User Settings must be saved or reverted before Prompt data can be written.'
                    );
                }
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

    private requireOptionalDescription(value: unknown): string | undefined {
        const description = normalizeOptionalDescription(value);
        if (description === null) {
            throw new PromptMutationError('invalid', 'Prompt description must be text.');
        }
        return description;
    }

    private requirePromptId(value: unknown): string {
        if (!isPromptId(value)) {
            throw new PromptMutationError('invalid', 'Prompt ID must be a non-empty string.');
        }
        return value;
    }

    private requireGroupId(data: PromptDataV2, value: unknown): string {
        if (!isPromptId(value)) {
            throw new PromptMutationError('invalid', 'Prompt group ID must be a non-empty string.');
        }
        if (!data.groups.some(group => group.id === value)) {
            throw new PromptMutationError('not-found', 'The Prompt group no longer exists.');
        }
        return value;
    }

    private requireCustomGroup(data: PromptDataV2, value: unknown): PromptGroupV1 {
        const id = this.requireGroupId(data, value);
        const group = data.groups.find(candidate => candidate.id === id) as PromptGroupV1;
        if (group.kind !== 'custom') {
            throw new PromptMutationError('invalid', 'The General Prompt group cannot be changed.');
        }
        return group;
    }

    private readCurrentSetting(): PromptReadResult {
        const value = this.options.readSetting();
        const result = normalizePromptSetting(value);
        this.logReadOnlyResult(result);
        if (result.status === 'ready'
            && isRecord(value)
            && isPromptId(value.selectedPromptId)
            && value.selectedPromptId !== result.snapshot.selectedPromptId) {
            this.logDiagnostic({
                category: 'prompt-stale-selection',
                revision: result.snapshot.revision,
                promptId: value.selectedPromptId,
            });
        }
        return result;
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
