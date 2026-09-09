'use strict';

import { randomBytes } from 'crypto';
import * as path from 'path';
import { getFileTransferContent } from './webviewFileTransferContent';
import type { ManagedRemoteManagementSnapshot } from '../projects/managedRemote/managementController';

interface FileTransferEditorWebview {
    cspSource: string;
    asWebviewUri(resource: unknown): { toString(): string };
}

/**
 * Renders the File Transfer workbench editor. It deliberately reuses the
 * dashboard bundle: the transfer interaction remains one implementation while
 * Projects becomes the entry point rather than another sidebar tab.
 */
export function getFileTransferEditorContent(
    context: {
        extensionPath: string;
        createFileUri?: (filePath: string) => unknown;
    },
    webview: FileTransferEditorWebview,
    managedRemoteSnapshot?: ManagedRemoteManagementSnapshot,
): string {
    const nonce = randomBytes(16).toString('base64');
    const revision = randomBytes(8).toString('hex');
    const mediaUri = (name: string): string => webview.asWebviewUri(
        context.createFileUri
            ? context.createFileUri(path.join(context.extensionPath, 'media', name))
            : path.join(context.extensionPath, 'media', name),
    ).toString();
    const stylesPath = `${mediaUri('styles.css')}?v=${revision}`;
    const dashboardBundlePath = `${mediaUri('webviewDashboardBundle.js')}?v=${revision}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" type="text/css" href="${stylesPath}">
    <title>File Transfer</title>
</head>
<body class="preload file-transfer-editor">
    <main class="dashboard-content file-transfer-editor-content">
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel file-transfer-editor-panel" role="main" aria-label="File Transfer">
            ${getFileTransferContent(managedRemoteSnapshot)}
        </section>
    </main>
    <script src="${dashboardBundlePath}"></script>
    <script nonce="${nonce}">
        (function () {
            window.vscode = acquireVsCodeApi();
            try {
                sessionStorage.setItem('agentPivot.activeDashboardTab', 'file-transfer');
            } catch (_error) {
                // The editor still starts in File Transfer when storage is unavailable.
            }
            window.onload = function () {
                window.__agentPivotFileTransfer = initDashboard({
                    enabledTabs: ['file-transfer'],
                    postMessage: function (message) { return window.vscode.postMessage(message); },
                });
            };
        })();
    </script>
</body>
</html>`;
}
