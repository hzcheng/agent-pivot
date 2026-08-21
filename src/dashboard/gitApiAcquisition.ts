'use strict';

import * as vscode from 'vscode';
import type { GitApiLike } from '../worktrees';

/**
 * Acquires the built-in vscode.git API for worktree monitoring. Lives in the
 * shell (not the worktree module) because it touches the host extension API;
 * the worktree module stays loadable without vscode.
 */
export async function getVsCodeGitApiForWorktreeMonitoring(): Promise<GitApiLike | undefined> {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) {
        return undefined;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    const api = (exports as { getAPI?: (version: number) => unknown } | undefined)
        ?.getAPI?.(1) as GitApiLike | undefined;
    return api && Array.isArray(api.repositories)
        && typeof api.onDidOpenRepository === 'function'
        && typeof api.onDidCloseRepository === 'function'
        ? api
        : undefined;
}
