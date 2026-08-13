'use strict';

interface DisposableLike {
    dispose(): void;
}

interface GitRepositoryStateLike {
    onDidChange(listener: () => void): DisposableLike;
}

export interface GitRepositoryLike {
    state: GitRepositoryStateLike;
}

export interface GitApiLike {
    repositories: readonly GitRepositoryLike[];
    onDidOpenRepository(listener: (repository: GitRepositoryLike) => void): DisposableLike;
    onDidCloseRepository(listener: (repository: GitRepositoryLike) => void): DisposableLike;
}

export interface GitRepositoryStateMonitorOptions {
    getApi: () => Promise<GitApiLike | undefined>;
    onDidChange: () => void;
    onError?: (error: unknown) => void;
}

/** Best-effort bridge from VS Code's built-in Git API to snapshot invalidation. */
export class GitRepositoryStateMonitor implements DisposableLike {
    private disposed = false;
    private started = false;
    private readonly apiDisposables: DisposableLike[] = [];
    private readonly repositoryDisposables = new Map<GitRepositoryLike, DisposableLike>();

    constructor(private readonly options: GitRepositoryStateMonitorOptions) {
    }

    async start(): Promise<void> {
        if (this.started || this.disposed) {
            return;
        }
        this.started = true;
        try {
            const api = await this.options.getApi();
            if (!api || this.disposed) {
                return;
            }
            for (const repository of api.repositories || []) {
                this.watchRepository(repository);
            }
            this.apiDisposables.push(api.onDidOpenRepository(repository => {
                this.watchRepository(repository);
                this.options.onDidChange();
            }));
            this.apiDisposables.push(api.onDidCloseRepository(repository => {
                this.unwatchRepository(repository);
                this.options.onDidChange();
            }));
        } catch (error) {
            if (!this.disposed) {
                this.options.onError?.(error);
            }
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const disposable of this.apiDisposables.splice(0)) {
            disposable.dispose();
        }
        for (const disposable of this.repositoryDisposables.values()) {
            disposable.dispose();
        }
        this.repositoryDisposables.clear();
    }

    private watchRepository(repository: GitRepositoryLike): void {
        if (this.disposed || this.repositoryDisposables.has(repository)
            || !repository?.state || typeof repository.state.onDidChange !== 'function') {
            return;
        }
        this.repositoryDisposables.set(
            repository,
            repository.state.onDidChange(() => this.options.onDidChange())
        );
    }

    private unwatchRepository(repository: GitRepositoryLike): void {
        this.repositoryDisposables.get(repository)?.dispose();
        this.repositoryDisposables.delete(repository);
    }
}
