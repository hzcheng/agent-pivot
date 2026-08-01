'use strict';

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { AiSessionProviderId } from '../../models';
import { CONVERSATION_COMMENT_LIMITS } from './comments';
import type { ConversationCommentSnapshot } from './commentStore';
import type { ConversationBookmarkSnapshot } from './bookmarkStore';
import { renderConversationTelemetry } from './conversationTelemetryController';
import {
    CONVERSATION_LIMITS,
    ConversationTelemetry,
} from './types';
import type { ConversationViewerPageMessage } from './viewer';
import type { ConversationViewerTarget } from './viewerTarget';

export interface ConversationViewerDocumentOptions {
    panel: vscode.WebviewPanel;
    target: ConversationViewerTarget;
    mediaUri: (fileName: string) => vscode.Uri;
    commentSnapshot: ConversationCommentSnapshot;
    bookmarkSnapshot: ConversationBookmarkSnapshot;
    telemetrySnapshot: ConversationTelemetry | undefined;
    subscriptionGeneration: number;
    initialPage?: ConversationViewerPageMessage;
    initialStatus?: string;
}

export function renderConversationViewerDocument(
    options: ConversationViewerDocumentOptions
): string {
    const panel = options.panel;
    const target = options.target;
    const initialPage = options.initialPage;
    const initialStatus = options.initialStatus ?? '';
    const nonce = randomBytes(16).toString('base64');
    const stylesheet = panel.webview.asWebviewUri(
        options.mediaUri('conversationViewer.css')
    );
    const telemetryStylesheet = panel.webview.asWebviewUri(
        options.mediaUri('conversationTelemetry.css')
    );
    const purify = panel.webview.asWebviewUri(
        options.mediaUri('purify.min.js')
    );
    const mermaid = panel.webview.asWebviewUri(
        options.mediaUri('mermaid.min.js')
    );
    const readingAnchorScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationReadingAnchorScripts.js')
    );
    const mermaidScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationMermaidScripts.js')
    );
    const outlineScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationOutlineScripts.js')
    );
    const telemetryScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationTelemetryScripts.js')
    );
    const commentsScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationCommentsScripts.js')
    );
    const sidebarScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationSidebarScripts.js')
    );
    const reconcileScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationReconcileScripts.js')
    );
    const script = panel.webview.asWebviewUri(
        options.mediaUri('conversationViewerScripts.js')
    );
    const duplicateId = target.duplicateDisplayName
        ? ` · ${target.sessionId.toLocaleLowerCase().slice(0, 8)}`
        : '';
    const initialPageAttribute = initialPage
        ? ` data-initial-page="${escapeAttribute(JSON.stringify(initialPage))}"`
        : '';
    const commentStateAttribute = ` data-initial-comments="${escapeAttribute(
        JSON.stringify(options.commentSnapshot)
    )}"`;
    const bookmarkStateAttribute = ` data-initial-bookmarks="${escapeAttribute(
        JSON.stringify(options.bookmarkSnapshot)
    )}"`;
    const targetAttribute = ` data-conversation-target="${escapeAttribute(
        JSON.stringify({
            projectId: target.projectId,
            provider: target.provider,
            sessionId: target.sessionId,
        })
    )}"`;
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src https: blob:; style-src ${escapeAttribute(
            panel.webview.cspSource
        )}; script-src 'nonce-${escapeAttribute(nonce)}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${escapeAttribute(stylesheet.toString())}">
    <link rel="stylesheet"
        href="${escapeAttribute(telemetryStylesheet.toString())}">
    <title>AI Conversation</title>
</head>
<body data-auto-scroll-threshold="${CONVERSATION_LIMITS.autoScrollThresholdPx}"
    data-mermaid-src="${escapeAttribute(mermaid.toString())}"
    data-subscription-generation="${options.subscriptionGeneration}"${initialPageAttribute}${commentStateAttribute}${bookmarkStateAttribute}${targetAttribute}>
    <header class="conversation-header">
        <div class="conversation-identity">
            <strong>${escapeHtml(providerLabel(target.provider))}</strong>
            <span>${escapeHtml(target.displayName + duplicateId)}</span>
        </div>
        <span data-conversation-position>Input 0 of 0</span>
        <nav class="conversation-navigation" aria-label="Conversation navigation">
            <button type="button" data-action="previous">Previous</button>
            <button type="button" data-action="next">Next</button>
            <button type="button" data-action="latest">Latest</button>
            <button type="button" data-action="toggle-outline"
                aria-controls="conversation-sidebar"
                aria-expanded="true">Outline (0)</button>
            <button type="button" data-action="toggle-comments"
                aria-controls="conversation-sidebar"
                aria-expanded="false">Comments (0)</button>
            <button type="button" data-action="close">Close</button>
        </nav>
    </header>
    ${renderConversationTelemetry(options.telemetrySnapshot)}
    <div class="conversation-status" data-conversation-status aria-live="polite">${escapeHtml(
        initialStatus
    )}</div>
    <div class="conversation-workspace">
        <main class="conversation-scroll" data-conversation-scroll tabindex="0">
            <div class="conversation-messages" data-conversation-messages></div>
        </main>
        <div class="conversation-comments-resizer" data-comments-resizer
            role="separator" aria-label="Resize side panel"
            aria-orientation="vertical" aria-valuemin="192"
            aria-valuemax="420" aria-valuenow="240" tabindex="0"></div>
        <aside id="conversation-sidebar"
            class="conversation-sidebar" data-conversation-sidebar
            aria-label="Conversation side panel">
            <div class="conversation-sidebar-tabs" role="tablist"
                aria-label="Conversation side panel">
                <button type="button" role="tab" data-sidebar-tab="outline"
                    id="conversation-outline-tab"
                    aria-controls="conversation-outline-panel"
                    aria-selected="true">Outline</button>
                <button type="button" role="tab" data-sidebar-tab="comments"
                    id="conversation-comments-tab"
                    aria-controls="conversation-comments-panel"
                    aria-selected="false">Comments</button>
                <button type="button" class="conversation-sidebar-close"
                    data-sidebar-close aria-label="Close side panel"
                    title="Close side panel">×</button>
            </div>
            <section id="conversation-outline-panel"
                class="conversation-outline" data-conversation-outline
                role="tabpanel" aria-labelledby="conversation-outline-tab">
                <div class="conversation-outline-header">
                    <div>
                        <strong>Conversation outline</strong>
                        <span data-outline-summary>No inputs yet</span>
                    </div>
                    <span data-outline-count aria-label="0 inputs">0</span>
                </div>
                <label class="conversation-outline-search-label"
                    for="conversation-outline-search">Search inputs</label>
                <input id="conversation-outline-search" type="search"
                    data-outline-search placeholder="Search user inputs">
                <button type="button" class="conversation-outline-bookmarks-only"
                    data-outline-bookmarks-only aria-pressed="false">
                    ☆ Bookmarks
                </button>
                <p class="conversation-outline-partial"
                    data-outline-partial hidden>
                    Showing the newest inputs available in this Session.
                </p>
                <ol class="conversation-outline-list"
                    data-outline-list></ol>
                <p class="conversation-outline-empty"
                    data-outline-empty hidden>No inputs match this search.</p>
            </section>
            <section id="conversation-comments-panel"
                class="conversation-comments" data-conversation-comments
                role="tabpanel" aria-labelledby="conversation-comments-tab"
                hidden>
                <div class="conversation-comments-header">
                    <div class="conversation-comments-heading">
                        <strong>Review comments</strong>
                        <span data-comment-summary>No comments yet</span>
                    </div>
                    <div class="conversation-comments-header-actions">
                        <button type="button" data-comment-action="new"
                            title="Add a note about this Session">+ Note</button>
                        <span data-comment-count aria-label="0 comments">0</span>
                    </div>
                </div>
                <div class="conversation-comment-composer"
                    data-comment-composer hidden>
                    <blockquote data-comment-selection></blockquote>
                    <label for="conversation-comment-input">Comment</label>
                    <textarea id="conversation-comment-input" data-comment-input
                        rows="3" maxlength="${CONVERSATION_COMMENT_LIMITS.maxCommentGraphemes}"
                        aria-keyshortcuts="Control+Enter Meta+Enter"
                        placeholder="What should the AI address?"></textarea>
                    <div class="conversation-comment-actions">
                        <button type="button"
                            data-comment-action="cancel-add">Cancel</button>
                        <button type="button"
                            data-comment-action="confirm-add"
                            title="Add comment (Ctrl+Enter or Cmd+Enter)">Add comment</button>
                    </div>
                </div>
                <div class="conversation-comment-list"
                    data-comment-list></div>
                <p class="conversation-comment-empty" data-comment-empty>
                    Select text to comment on it, or add a Session note.
                </p>
                <div class="conversation-comments-toolbar"
                    data-comments-toolbar role="group"
                    aria-label="Comment actions">
                    <button class="conversation-comments-clear" type="button"
                        data-comment-action="clearSent"
                        title="Clear comments added to the session input"
                        disabled>Clear added</button>
                    <button class="conversation-comments-clear" type="button"
                        data-comment-action="clearResolved"
                        title="Clear resolved comments"
                        disabled>Clear resolved</button>
                    <button class="conversation-comments-clear conversation-comments-clear-all"
                        type="button" data-comment-action="clearAll"
                        title="Clear all comments" disabled>Clear all</button>
                    <button class="conversation-comments-send" type="button"
                        data-comment-action="send" disabled
                        title="Add open comments to the session input">Add open comments to session input</button>
                </div>
            </section>
        </aside>
    </div>
    <button class="conversation-add-comment" type="button"
        data-add-comment hidden>Add comment</button>
    <button class="new-response" type="button" data-new-response hidden>New response content</button>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        purify.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        readingAnchorScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        mermaidScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        outlineScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        telemetryScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        commentsScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        sidebarScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        reconcileScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        script.toString()
    )}"></script>
</body>
</html>`;
}

function providerLabel(provider: AiSessionProviderId): string {
    return provider === 'codex' ? 'Codex' : provider === 'kimi' ? 'Kimi' : 'Claude';
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function escapeAttribute(value: string): string {
    return escapeHtml(value);
}
