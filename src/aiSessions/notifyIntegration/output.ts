'use strict';

import * as vscode from 'vscode';

export interface NotifyOutput {
    log(line: string): void;
    show(): void;
    dispose(): void;
}

export function createNotifyOutputChannel(): NotifyOutput {
    const channel = vscode.window.createOutputChannel('Agent Pivot Notifications');
    return {
        log(line: string): void {
            channel.appendLine(`[${new Date().toISOString()}] ${line}`);
        },
        show(): void {
            channel.show(true);
        },
        dispose(): void {
            channel.dispose();
        },
    };
}
