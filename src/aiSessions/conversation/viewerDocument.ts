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

const CONVERSATION_COMMENT_ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>';
const CONVERSATION_COMMENT_ICON_DOT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>';
const CONVERSATION_COMMENT_ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CONVERSATION_COMMENT_ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>';
const CONVERSATION_COMMENT_ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg>';
const CONVERSATION_COMMENT_ICON_ERASER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>';
const CONVERSATION_COMMENT_ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
const CONVERSATION_NAV_ICON_PREVIOUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const CONVERSATION_NAV_ICON_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const CONVERSATION_NAV_ICON_LATEST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>';
const CONVERSATION_NAV_ICON_SIDEBAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>';

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
    const subagentsScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationSubagentsScripts.js')
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
        <nav class="conversation-navigation" aria-label="Conversation navigation">
            <button class="conversation-icon-button" type="button"
                data-action="previous" title="Previous"
                aria-label="Previous">${CONVERSATION_NAV_ICON_PREVIOUS}</button>
            <button class="conversation-icon-button" type="button"
                data-action="next" title="Next"
                aria-label="Next">${CONVERSATION_NAV_ICON_NEXT}</button>
            <button class="conversation-icon-button" type="button"
                data-action="latest" title="Latest"
                aria-label="Latest">${CONVERSATION_NAV_ICON_LATEST}</button>
            <button class="conversation-icon-button" type="button"
                data-action="toggle-sidebar" aria-controls="conversation-sidebar"
                aria-expanded="false" title="Show side panel"
                aria-label="Show side panel">${CONVERSATION_NAV_ICON_SIDEBAR}</button>
        </nav>
    </header>
    ${renderConversationTelemetry(options.telemetrySnapshot)}
    <div class="conversation-status" data-conversation-status aria-live="polite">${escapeHtml(
        initialStatus
    )}</div>
    <div class="conversation-subagent-banner" data-subagent-banner hidden>
        Viewing subagent <strong data-subagent-banner-label></strong>
        <button type="button" data-action="close-subagent">Back to conversation</button>
    </div>
    <div class="conversation-workspace" data-comments-open="false">
        <main class="conversation-scroll" data-conversation-scroll tabindex="0">
            <div class="conversation-messages" data-conversation-messages></div>
            <div class="conversation-working" data-conversation-working
                role="status" aria-live="polite" hidden>
                <span>Working</span>
                <span class="conversation-working-dots" aria-hidden="true">
                    <span class="conversation-working-dot"></span>
                    <span class="conversation-working-dot"></span>
                    <span class="conversation-working-dot"></span>
                </span>
            </div>
        </main>
        <div class="conversation-comments-resizer" data-comments-resizer
            role="separator" aria-label="Resize side panel"
            aria-orientation="vertical" aria-valuemin="192"
            aria-valuemax="420" aria-valuenow="240" tabindex="0" hidden></div>
        <aside id="conversation-sidebar"
            class="conversation-sidebar" data-conversation-sidebar
            aria-label="Conversation side panel" hidden>
            <div class="conversation-sidebar-tabs" role="tablist"
                aria-label="Conversation side panel">
                <button type="button" role="tab" data-sidebar-tab="outline"
                    id="conversation-outline-tab"
                    aria-controls="conversation-outline-panel"
                    aria-selected="true" aria-label="Outline" title="Outline">
                    <svg viewBox="0 0 16 16" width="14" height="14"
                        aria-hidden="true" fill="none" stroke="currentColor"
                        stroke-width="1.3"><path d="M2.5 4h11M2.5 8h7M2.5 12h9"/></svg>
                </button>
                <button type="button" role="tab" data-sidebar-tab="comments"
                    id="conversation-comments-tab"
                    aria-controls="conversation-comments-panel"
                    aria-selected="false" aria-label="Comments" title="Comments">
                    <svg viewBox="0 0 16 16" width="14" height="14"
                        aria-hidden="true" fill="none" stroke="currentColor"
                        stroke-width="1.3"><path d="M3 3.5h10a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H8l-3 2.2v-2.2H3a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/></svg>
                </button>
                <button type="button" role="tab" data-sidebar-tab="subagents"
                    id="conversation-subagents-tab"
                    aria-controls="conversation-subagents-panel"
                    aria-selected="false" aria-label="Subagents"
                    title="Subagents">
                    <svg viewBox="0 0 16 16" width="14" height="14"
                        aria-hidden="true" fill="none" stroke="currentColor"
                        stroke-width="1.3"><circle cx="8" cy="3.4" r="1.7"/><circle cx="3.4" cy="12.2" r="1.7"/><circle cx="12.6" cy="12.2" r="1.7"/><path d="M8 5.1v2.2M8 7.3l-3.3 3.2M8 7.3l3.3 3.2"/></svg>
                </button>
            </div>
            <section id="conversation-outline-panel"
                class="conversation-outline" data-conversation-outline
                role="tabpanel" aria-labelledby="conversation-outline-tab">
                <div class="conversation-outline-toolbar">
                    <input id="conversation-outline-search" type="search"
                        data-outline-search placeholder="Search user inputs"
                        aria-label="Search user inputs">
                    <button type="button"
                        class="conversation-outline-bookmarks-only"
                        data-outline-bookmarks-only aria-pressed="false"
                        title="Show bookmarked inputs only">☆ 0</button>
                    <span class="conversation-outline-summary"
                        data-outline-summary>No inputs yet</span>
                </div>
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
                <div class="conversation-comments-panelbar">
                    <button type="button" data-comment-action="new"
                        title="Add a note about this Session">+ Note</button>
                    <span class="conversation-comments-summary"
                        data-comment-summary>No comments yet</span>
                </div>
                <div class="conversation-comments-body" data-comments-body>
                    <div class="conversation-comment-composer"
                        data-comment-composer hidden>
                        <blockquote data-comment-selection></blockquote>
                        <label for="conversation-comment-input">Comment</label>
                        <textarea id="conversation-comment-input" data-comment-input
                            rows="3" maxlength="${CONVERSATION_COMMENT_LIMITS.maxCommentGraphemes}"
                            aria-keyshortcuts="Control+Enter Meta+Enter"
                            placeholder="What should the AI address?"></textarea>
                        <div class="conversation-comment-actions">
                            <button class="conversation-comment-icon-button"
                                type="button" data-comment-action="cancel-add"
                                title="Cancel (Esc)"
                                aria-label="Cancel (Esc)">${CONVERSATION_COMMENT_ICON_X}</button>
                            <button class="conversation-comment-icon-button"
                                type="button" data-comment-action="confirm-add"
                                title="Add comment (Ctrl+Enter or Cmd+Enter)"
                                aria-label="Add comment (Ctrl+Enter or Cmd+Enter)">${CONVERSATION_COMMENT_ICON_CHECK}</button>
                        </div>
                    </div>
                    <div class="conversation-comment-list"
                        data-comment-list></div>
                    <p class="conversation-comment-filter-empty"
                        data-comment-filter-empty hidden></p>
                    <p class="conversation-comment-empty" data-comment-empty>
                        Select text to comment on it, or add a Session note.
                    </p>
                </div>
                <div class="conversation-comments-toolbar"
                    data-comments-toolbar role="group" aria-label="Comment actions">
                    <div class="conversation-comments-filter" role="group"
                        aria-label="Filter comments">
                        <button class="conversation-comment-icon-button conversation-comments-filter-button"
                            type="button" data-comment-action="filter" data-comment-filter="all"
                            title="All comments" aria-label="All comments"
                            aria-pressed="true">${CONVERSATION_COMMENT_ICON_LIST}</button>
                        <button class="conversation-comment-icon-button conversation-comments-filter-button"
                            type="button" data-comment-action="filter" data-comment-filter="open"
                            title="Open only" aria-label="Open only"
                            aria-pressed="false">${CONVERSATION_COMMENT_ICON_DOT}</button>
                        <button class="conversation-comment-icon-button conversation-comments-filter-button"
                            type="button" data-comment-action="filter" data-comment-filter="done"
                            title="Done only" aria-label="Done only"
                            aria-pressed="false">${CONVERSATION_COMMENT_ICON_CHECK}</button>
                    </div>
                    <div class="conversation-comments-toolbar-actions">
                        <button class="conversation-comment-icon-button"
                            type="button" data-comment-action="send" disabled
                            title="Send open comments to the session input"
                            aria-label="Send open comments to the session input">${CONVERSATION_COMMENT_ICON_SEND}</button>
                        <button class="conversation-comment-icon-button" type="button"
                            data-comment-action="clearDone" disabled
                            title="Clear done comments"
                            aria-label="Clear done comments">${CONVERSATION_COMMENT_ICON_ERASER}</button>
                        <button class="conversation-comment-icon-button danger conversation-comments-clear-all"
                            type="button" data-comment-action="clearAll" disabled
                            title="Clear all comments"
                            aria-label="Clear all comments">${CONVERSATION_COMMENT_ICON_TRASH}</button>
                    </div>
                </div>
            </section>
            <section id="conversation-subagents-panel"
                class="conversation-subagents" data-conversation-subagents
                role="tabpanel" aria-labelledby="conversation-subagents-tab"
                hidden>
                <div class="conversation-subagents-header">
                    <label class="conversation-subagents-filter"
                        for="conversation-subagents-running-only">
                        <input id="conversation-subagents-running-only"
                            type="checkbox" data-subagents-running-only>
                        Running only
                    </label>
                    <span data-subagents-summary>No subagents yet</span>
                </div>
                <ol class="conversation-subagents-list"
                    data-subagents-list></ol>
                <p class="conversation-subagents-empty" data-subagents-empty
                    hidden>No subagents recorded for this Session.</p>
            </section>
        </aside>
    </div>
    <button class="conversation-add-comment" type="button"
        data-add-comment hidden>Add comment</button>
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
        subagentsScript.toString()
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
