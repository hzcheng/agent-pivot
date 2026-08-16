'use strict';

const STORAGE_KEY = 'agentPivot.worktreeBaseRefs.v1';
const MAX_REPOSITORIES = 128;
const MAX_REPOSITORY_KEY_LENGTH = 32 * 1024;
const MAX_REF_LENGTH = 1024;

interface MementoLike {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

/** Persists the once-detected (or later explicitly selected) base ref per repo. */
export class WorktreeBaseRefStore {
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(private readonly memento: MementoLike) {
    }

    get(repositoryKey: string): string | undefined {
        return this.read()[repositoryKey];
    }

    rememberInitial(repositoryKey: string, baseRef: string): Promise<void> {
        return this.enqueue(async () => {
            const records = this.read();
            if (records[repositoryKey]) {
                return;
            }
            await this.write(repositoryKey, baseRef, records);
        });
    }

    set(repositoryKey: string, baseRef: string): Promise<void> {
        return this.enqueue(() => this.write(repositoryKey, baseRef, this.read()));
    }

    delete(repositoryKey: string): Promise<void> {
        return this.enqueue(async () => {
            if (!isSafeRepositoryKey(repositoryKey)) {
                return;
            }
            const records = this.read();
            if (!records[repositoryKey]) {
                return;
            }
            delete records[repositoryKey];
            await this.memento.update(STORAGE_KEY, records);
        });
    }

    private async write(
        repositoryKey: string,
        baseRef: string,
        records: Record<string, string>
    ): Promise<void> {
        if (!isSafeRepositoryKey(repositoryKey) || !isSafeBaseRef(baseRef)) {
            throw new Error('The worktree base-ref record is invalid.');
        }
        if (!records[repositoryKey] && Object.keys(records).length >= MAX_REPOSITORIES) {
            throw new Error('The worktree base-ref store is full.');
        }
        records[repositoryKey] = baseRef;
        await this.memento.update(STORAGE_KEY, records);
    }

    private read(): Record<string, string> {
        const stored = this.memento.get<unknown>(STORAGE_KEY, {});
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
            return {};
        }
        const records: Record<string, string> = {};
        for (const [repositoryKey, baseRef] of Object.entries(
            stored as Record<string, unknown>
        ).slice(0, MAX_REPOSITORIES)) {
            if (isSafeRepositoryKey(repositoryKey) && isSafeBaseRef(baseRef)) {
                records[repositoryKey] = baseRef;
            }
        }
        return records;
    }

    private enqueue(operation: () => Promise<void>): Promise<void> {
        const result = this.writeQueue.then(operation, operation);
        this.writeQueue = result.catch(() => undefined);
        return result;
    }
}

function isSafeRepositoryKey(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
        && value.length <= MAX_REPOSITORY_KEY_LENGTH && !/[\0\r\n]/.test(value);
}

function isSafeBaseRef(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_REF_LENGTH
        && !value.startsWith('-') && !/[\0\r\n]/.test(value);
}
