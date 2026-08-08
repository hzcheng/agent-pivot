'use strict';

import * as vscode from 'vscode';
import type { AttentionQueue } from './attentionQueue';
import { formatAttentionStatusBar } from './attentionQueue';

export interface AttentionStatusBarController {
    refresh(queue: AttentionQueue): void;
    dispose(): void;
}

/**
 * Owns the single Agent Pivot status bar entry for the attention queue. The
 * item stays hidden while nothing needs attention (or attention is disabled)
 * and only reassigns VS Code item properties when the presentation actually
 * changes, so refresh can safely fire on every attention state transition.
 */
export function createAttentionStatusBarController(options: {
    isEnabled: () => boolean;
    command: string;
    nowMs: () => number;
}): AttentionStatusBarController {
    const item = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right
    );
    item.command = options.command;
    let visible = false;
    let lastText: string | undefined;
    let lastTooltip: string | undefined;
    return {
        refresh(queue: AttentionQueue): void {
            const presentation = options.isEnabled()
                ? formatAttentionStatusBar(queue, options.nowMs)
                : { text: '', tooltip: '' };
            if (!presentation.text) {
                if (visible) {
                    item.hide();
                    visible = false;
                }
                return;
            }
            if (presentation.text !== lastText) {
                item.text = presentation.text;
                lastText = presentation.text;
            }
            if (presentation.tooltip !== lastTooltip) {
                item.tooltip = presentation.tooltip;
                lastTooltip = presentation.tooltip;
            }
            if (!visible) {
                item.show();
                visible = true;
            }
        },
        dispose(): void {
            item.dispose();
        },
    };
}
