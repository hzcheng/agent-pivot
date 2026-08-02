'use strict';

import * as vscode from 'vscode';

interface GitExtensionApiV1 {
    openRepository(root: vscode.Uri): Promise<unknown>;
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
