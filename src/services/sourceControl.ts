'use strict';

import * as vscode from 'vscode';

interface GitRepository {
    rootUri: vscode.Uri;
    state: {
        onDidChange: (listener: () => void) => vscode.Disposable;
    };
}

interface GitExtensionApiV1 {
    repositories?: GitRepository[];
    openRepository(root: vscode.Uri): Promise<unknown>;
    onDidOpenRepository?: (
        listener: (repository: GitRepository) => void
    ) => vscode.Disposable;
}

function getGitApi(): GitExtensionApiV1 | undefined {
    const exports = vscode.extensions.getExtension('vscode.git')?.exports as
        { getAPI?: (version: number) => GitExtensionApiV1 | undefined }
        | undefined;
    const api = exports?.getAPI?.(1);
    return api && typeof api.openRepository === 'function' ? api : undefined;
}

export async function showWorktreeInSourceControl(
    worktreeRoot: string
): Promise<void> {
    let exists = true;
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(worktreeRoot));
    } catch (_error) {
        exists = false;
    }
    if (!exists) {
        void vscode.window.showWarningMessage(
            `Worktree path no longer exists: ${worktreeRoot}`
        );
        return;
    }
    const gitApi = getGitApi();
    if (!gitApi) {
        void vscode.window.showWarningMessage(
            'The built-in Git extension is unavailable; '
                + 'cannot show the worktree in Source Control.'
        );
        return;
    }
    await gitApi.openRepository(vscode.Uri.file(worktreeRoot));
    await vscode.commands.executeCommand('workbench.view.scm');
}

/**
 * Subscribes to Git state changes for the given worktree paths
 * (changes-panel PRD §5.4: the Git extension's state event is the P0
 * refresh channel — it covers commits, staging, and working-tree edits).
 * Repositories unknown to the Git extension are opened first so their
 * state events reach us; capability gaps degrade to no events, and the
 * telemetry-cycle fallback still applies.
 */
export function watchRepositories(
    worktreePaths: readonly string[],
    onChange: () => void
): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    const gitApi = getGitApi();
    if (!gitApi || !Array.isArray(gitApi.repositories)) {
        return new vscode.Disposable(() => undefined);
    }
    const wanted = new Set(worktreePaths.map(normalizePath));
    const subscribed = new Set<string>();
    let disposed = false;

    const subscribe = (repository: GitRepository) => {
        const root = normalizePath(repository.rootUri.fsPath);
        if (!wanted.has(root) || subscribed.has(root)
            || typeof repository.state?.onDidChange !== 'function') {
            return;
        }
        subscribed.add(root);
        disposables.push(repository.state.onDidChange(() => onChange()));
    };

    for (const repository of gitApi.repositories) {
        subscribe(repository);
    }
    if (gitApi.onDidOpenRepository) {
        disposables.push(gitApi.onDidOpenRepository(subscribe));
    }
    for (const worktreePath of worktreePaths) {
        const root = normalizePath(worktreePath);
        if (subscribed.has(root)) {
            continue;
        }
        void Promise.resolve(gitApi.openRepository(vscode.Uri.file(worktreePath)))
            .then(repository => {
                if (disposed || !repository) {
                    return;
                }
                subscribe(repository as GitRepository);
            })
            .catch(() => undefined);
    }
    return new vscode.Disposable(() => {
        disposed = true;
        for (const disposable of disposables.splice(0)) {
            disposable.dispose();
        }
    });
}

function normalizePath(candidatePath: string): string {
    return candidatePath.replace(/[\\/]+$/u, '');
}
