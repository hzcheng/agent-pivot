'use strict';

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { AiSessionProviderId } from '../../models';
import { CONVERSATION_COMMENT_LIMITS } from './comments';
import type { ConversationCommentSnapshot } from './commentStore';
import type { ProjectCommentSnapshot } from './projectCommentStore';
import type { ConversationBookmarkSnapshot } from './bookmarkStore';
import { renderConversationTelemetry } from './conversationTelemetryController';
import {
    ConversationSessionStatus,
    ConversationSessionStatusKind,
    formatConversationSessionStatusLabel,
    sanitizeConversationSessionStatus,
} from './sessionStatusController';
import {
    CONVERSATION_LIMITS,
    ConversationTelemetry,
} from './types';
import type { ConversationViewerPageMessage } from './viewer';
import type { ConversationViewerTarget } from './viewerTarget';

const CONVERSATION_COMMENT_ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>';
const CONVERSATION_COMMENT_ICON_DOT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>';
const CONVERSATION_COMMENT_ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CONVERSATION_COMMENT_ICON_COMMENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/></svg>';
const CONVERSATION_COMMENT_ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>';
const CONVERSATION_COMMENT_ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg>';
const CONVERSATION_COMMENT_ICON_ERASER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>';
const CONVERSATION_COMMENT_ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
const CONVERSATION_COMMENT_ICON_BOOKMARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/></svg>';
const CONVERSATION_COMMENT_ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
const CONVERSATION_COMMENT_ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CONVERSATION_NAV_ICON_PREVIOUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const CONVERSATION_NAV_ICON_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const CONVERSATION_NAV_ICON_LATEST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>';
const CONVERSATION_NAV_ICON_SIDEBAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>';
const CONVERSATION_SESSION_NAV_ICON_PREVIOUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 18-6-6 6-6"/><path d="M7 6v12"/></svg>';
const CONVERSATION_SESSION_NAV_ICON_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 18 6-6-6-6"/><path d="M17 6v12"/></svg>';
const CONVERSATION_FIND_ICON_PREVIOUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
const CONVERSATION_FIND_ICON_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CONVERSATION_FIND_ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>';

export interface ConversationViewerDocumentOptions {
    panel: vscode.WebviewPanel;
    target: ConversationViewerTarget;
    mediaUri: (fileName: string) => vscode.Uri;
    commentSnapshot: ConversationCommentSnapshot;
    projectCommentSnapshot: ProjectCommentSnapshot;
    bookmarkSnapshot: ConversationBookmarkSnapshot;
    telemetrySnapshot: ConversationTelemetry | undefined;
    sessionStatusSnapshot?: ConversationSessionStatus;
    sessionStatusRequestId?: number;
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
    const registryScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationRegistryScripts.js')
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
    const changesScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationChangesScripts.js')
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
    const findScript = panel.webview.asWebviewUri(
        options.mediaUri('conversationFindScripts.js')
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
    const projectCommentStateAttribute = ` data-initial-project-comments="${escapeAttribute(
        JSON.stringify(options.projectCommentSnapshot)
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
    const restoreTargetAttribute = ` data-conversation-restore-target="${escapeAttribute(
        JSON.stringify({
            projectId: target.projectId,
            provider: target.provider,
            sessionId: target.sessionId,
            interactionId: target.interactionId,
            ...(target.subagent ? { subagentId: target.subagent.id } : {}),
        })
    )}"`;
    const sessionStatus = sanitizeConversationSessionStatus(
        options.sessionStatusSnapshot
    );
    const sessionStatusRequestId = Number.isSafeInteger(
        options.sessionStatusRequestId
    ) && (options.sessionStatusRequestId as number) >= 0
        ? options.sessionStatusRequestId
        : 0;
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
    data-session-status-request-id="${sessionStatusRequestId}"
    data-subscription-generation="${options.subscriptionGeneration}"${initialPageAttribute}${commentStateAttribute}${projectCommentStateAttribute}${bookmarkStateAttribute}${targetAttribute}${restoreTargetAttribute}>
    <header class="conversation-header">
        <div class="conversation-identity">
            <span data-conversation-workspace-name>${escapeHtml(
                target.workspaceName || ''
            )}</span>
            <span class="conversation-identity-separator"
                data-conversation-task-separator aria-hidden="true"${target.taskName ? '' : ' hidden'}>·</span>
            <span data-conversation-task-name${target.taskName ? '' : ' hidden'}>${escapeHtml(
                target.taskName || ''
            )}</span>
            <span class="conversation-identity-separator" aria-hidden="true">·</span>
            <button type="button" class="conversation-display-name-button"
                data-conversation-display-name data-action="rename-session"
                title="Rename session" aria-label="Rename session">${escapeHtml(
                target.displayName + duplicateId
            )}</button>
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
    ${renderConversationTelemetry(
        options.telemetrySnapshot,
        options.target.provider,
        options.sessionStatusSnapshot?.currentSessionKind
    )}
    <div class="conversation-status" data-conversation-status aria-live="polite">${escapeHtml(
        initialStatus
    )}</div>
    <div class="conversation-subagent-banner" data-subagent-banner hidden>
        Viewing subagent <strong data-subagent-banner-label></strong>
        <button type="button" data-action="close-subagent">Back to conversation</button>
    </div>
    <div class="conversation-follow-notice" data-conversation-notice
        role="status" hidden>
        <span data-conversation-notice-text></span>
        <button class="conversation-icon-button" type="button"
            data-notice-close title="Dismiss"
            aria-label="Dismiss">${CONVERSATION_FIND_ICON_CLOSE}</button>
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
        <div class="conversation-session-nav-layer">
            <button class="conversation-session-nav conversation-session-nav-previous"
                type="button" data-session-nav="previous"
                title="Previous window"
                aria-label="Previous window">${CONVERSATION_SESSION_NAV_ICON_PREVIOUS}</button>
            <div class="conversation-session-status" data-conversation-session-status
                role="group" aria-label="AI session status in this window">
                ${renderSessionStatusDot('running', sessionStatus.runningSessionsLocal)}
                ${renderSessionStatusDot('attention', sessionStatus.attentionSessionsLocal)}
                ${renderSessionStatusDot('idle', sessionStatus.idleSessionsLocal)}
            </div>
            <button class="conversation-session-nav conversation-session-nav-next"
                type="button" data-session-nav="next"
                title="Next window"
                aria-label="Next window">${CONVERSATION_SESSION_NAV_ICON_NEXT}</button>
        </div>
        <div class="conversation-find" data-conversation-find hidden>
            <label class="conversation-find-field">
                <svg viewBox="0 0 16 16" width="13" height="13"
                    aria-hidden="true" fill="none" stroke="currentColor"
                    stroke-width="1.35">
                    <circle cx="6.8" cy="6.8" r="4.1"></circle>
                    <path d="m9.8 9.8 3.1 3.1"></path>
                </svg>
                <input id="conversation-find-input" type="search"
                    data-find-input placeholder="Find in conversation"
                    aria-label="Find in conversation" autocomplete="off">
            </label>
            <span class="conversation-find-count" data-find-count
                role="status"></span>
            <button class="conversation-icon-button" type="button"
                data-find-previous title="Previous match (Shift+Enter)"
                aria-label="Previous match (Shift+Enter)">${CONVERSATION_FIND_ICON_PREVIOUS}</button>
            <button class="conversation-icon-button" type="button"
                data-find-next title="Next match (Enter)"
                aria-label="Next match (Enter)">${CONVERSATION_FIND_ICON_NEXT}</button>
            <button class="conversation-icon-button" type="button"
                data-find-close title="Close (Escape)"
                aria-label="Close (Escape)">${CONVERSATION_FIND_ICON_CLOSE}</button>
        </div>
        <div class="conversation-comments-resizer" data-comments-resizer
            role="separator" aria-label="Resize side panel"
            aria-orientation="vertical" aria-valuemin="192"
            aria-valuemax="420" aria-valuenow="240" tabindex="0" hidden></div>
        <aside id="conversation-sidebar"
            class="conversation-sidebar" data-conversation-sidebar
            aria-label="Conversation side panel" hidden>
            <section id="conversation-outline-panel"
                class="conversation-outline" data-conversation-outline
                role="region" aria-label="Outline">
                <div class="conversation-outline-toolbar">
                    <label class="conversation-outline-search-field">
                        <svg viewBox="0 0 16 16" width="14" height="14"
                            aria-hidden="true" fill="none"
                            stroke="currentColor" stroke-width="1.35">
                            <circle cx="6.8" cy="6.8" r="4.1"></circle>
                            <path d="m9.8 9.8 3.1 3.1"></path>
                        </svg>
                        <input id="conversation-outline-search" type="search"
                            data-outline-search placeholder="Search inputs"
                            aria-label="Search user inputs">
                    </label>
                    <button type="button"
                        class="conversation-outline-bookmarks-only"
                        data-outline-bookmarks-only aria-pressed="false"
                        aria-label="Show bookmarked inputs only, 0 bookmarks"
                        title="Show bookmarked inputs only">
                        <svg viewBox="0 0 16 16" width="14" height="14"
                            aria-hidden="true" fill="none"
                            stroke="currentColor" stroke-width="1.25"
                            stroke-linejoin="round">
                            <path d="m8 1.8 1.85 3.76 4.15.6-3 2.92.71 4.13L8 11.26l-3.71 1.95L5 9.08 2 6.16l4.15-.6z"></path>
                        </svg>
                        <span data-outline-bookmark-count>0</span>
                    </button>
                    <button type="button"
                        class="conversation-outline-sort"
                        data-outline-sort data-order="newest"
                        aria-label="Show oldest inputs first"
                        title="Show oldest inputs first">
                        <svg viewBox="0 0 16 16" width="14" height="14"
                            aria-hidden="true" fill="none"
                            stroke="currentColor" stroke-width="1.25"
                            stroke-linecap="round" stroke-linejoin="round">
                            <path d="M2.5 3.5h6M2.5 7.5h4M2.5 11.5h2"></path>
                            <path d="M11.5 2.5v10M9.5 10.5l2 2 2-2"></path>
                        </svg>
                    </button>
                    <span data-outline-summary hidden aria-hidden="true"></span>
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
                role="region" aria-label="Comments"
                hidden>
                <!-- Hidden anchors keep an adjacent-generation Viewer script
                     (which still gates on the v1 stacked-section DOM) from
                     disabling the whole Comments module after this document
                     switches to tabs. They carry no v2 layout or behavior. -->
                <span hidden data-comments-section-sash></span>
                <span hidden data-project-comments-count></span>
                <span hidden data-session-comments-count></span>
                <div class="conversation-comments-tabs" role="tablist"
                    aria-label="Comments scope" data-comments-tabs>
                    <button type="button" class="conversation-comments-tab"
                        id="conversation-comments-tab-session"
                        role="tab" data-comments-tab="session"
                        aria-selected="true"
                        aria-controls="conversation-comments-pane-session"
                        title="Session comments"
                        aria-label="Session comments">Session<span
                            class="conversation-comments-tab-count"
                            data-comments-tab-count="session"></span></button>
                    <button type="button" class="conversation-comments-tab"
                        id="conversation-comments-tab-workspace"
                        role="tab" data-comments-tab="workspace"
                        aria-selected="false" tabindex="-1"
                        aria-controls="conversation-comments-pane-workspace"
                        title="Workspace notes"
                        aria-label="Workspace notes">Workspace<span
                            class="conversation-comments-tab-count"
                            data-comments-tab-count="workspace"></span></button>
                </div>
                <div class="conversation-comments-body" data-comments-body>
                    <section class="conversation-comments-pane"
                        id="conversation-comments-pane-workspace"
                        role="tabpanel" data-comments-panel="workspace"
                        aria-labelledby="conversation-comments-tab-workspace">
                    <div class="conversation-comments-section-header"
                        data-project-comments-header>
                        <button class="conversation-comment-icon-button conversation-comments-section-add"
                            type="button"
                            data-project-comment-action="open-composer"
                            title="Add a workspace note"
                            aria-label="Add a workspace note">${CONVERSATION_COMMENT_ICON_PLUS}</button>
                        <button class="conversation-comment-icon-button"
                            type="button"
                            data-project-comment-action="send-all" disabled
                            title="Send open notes to the session input"
                            aria-label="Send open notes to the session input">${CONVERSATION_COMMENT_ICON_SEND}</button>
                        <button class="conversation-comment-icon-button"
                            type="button"
                            data-project-comment-action="clear-done" disabled
                            title="Clear done notes"
                            aria-label="Clear done notes">${CONVERSATION_COMMENT_ICON_ERASER}</button>
                        <button class="conversation-comment-icon-button danger conversation-comments-clear-all"
                            type="button"
                            data-project-comment-action="clear-all" disabled
                            title="Clear all notes"
                            aria-label="Clear all notes">${CONVERSATION_COMMENT_ICON_TRASH}</button>
                    </div>
                    <section class="conversation-project-comments"
                        data-project-comments
                        data-project-comments-content
                        aria-label="Workspace notes">
                        <div class="conversation-project-comment-composer"
                            data-project-comment-composer hidden>
                            <div class="conversation-project-comment-source"
                                data-project-comment-source hidden>
                                <span class="conversation-project-comment-source-label"
                                    data-project-comment-source-label></span>
                                <button class="conversation-comment-icon-button"
                                    type="button"
                                    data-project-comment-action="clear-source"
                                    title="Detach the quoted source"
                                    aria-label="Detach the quoted source">${CONVERSATION_COMMENT_ICON_X}</button>
                                <blockquote data-project-comment-source-quote></blockquote>
                            </div>
                            <label for="conversation-project-comment-input">Workspace note</label>
                            <textarea id="conversation-project-comment-input"
                                data-project-comment-input rows="2"
                                maxlength="${CONVERSATION_COMMENT_LIMITS.maxCommentGraphemes}"
                                aria-keyshortcuts="Control+Enter Meta+Enter"
                                placeholder="Jot down a bug, idea, or todo…"></textarea>
                            <div class="conversation-project-comment-composer-row">
                                <span class="conversation-project-comment-draft-tags"
                                    data-project-comment-draft-tags></span>
                                <button class="conversation-project-comment-tag-add"
                                    type="button"
                                    data-project-comment-action="add-draft-tag"
                                    title="Add tag"
                                    aria-label="Add tag">+</button>
                                <span class="conversation-project-comment-composer-spacer"></span>
                                <div class="conversation-comment-actions">
                                    <button class="conversation-comment-icon-button"
                                        type="button"
                                        data-project-comment-action="cancel-add"
                                        title="Cancel (Esc)"
                                        aria-label="Cancel (Esc)">${CONVERSATION_COMMENT_ICON_X}</button>
                                    <button class="conversation-comment-icon-button"
                                        type="button"
                                        data-project-comment-action="add"
                                        title="Add project note (Ctrl+Enter or Cmd+Enter)"
                                        aria-label="Add project note (Ctrl+Enter or Cmd+Enter)"
                                        disabled>${CONVERSATION_COMMENT_ICON_CHECK}</button>
                                </div>
                            </div>
                        </div>
                        <div class="conversation-comment-list conversation-project-comment-list"
                            data-project-comment-list></div>
                        <p class="conversation-project-comment-empty"
                            data-project-comment-empty hidden>
                            No workspace notes yet.
                        </p>
                    </section>
                    </section>
                    <section class="conversation-comments-pane"
                        id="conversation-comments-pane-session"
                        role="tabpanel" data-comments-panel="session"
                        aria-labelledby="conversation-comments-tab-session">
                    <div class="conversation-comments-section-header conversation-comments-section-header-session"
                        data-session-comments-header>
                        <button class="conversation-comment-icon-button conversation-comments-section-add"
                            type="button" data-comment-action="new"
                            title="Add a note about this Session"
                            aria-label="Add a note about this Session">${CONVERSATION_COMMENT_ICON_PLUS}</button>
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
                    <div class="conversation-comments-section-content conversation-comments-session-region"
                        data-session-comments-content>
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
                    </section>
                </div>
                <div class="conversation-comments-filter-bar"
                    data-comments-filter-bar role="group"
                    aria-label="Filter comments and notes" hidden></div>
            </section>
            <section id="conversation-subagents-panel"
                class="conversation-subagents" data-conversation-subagents
                role="region" aria-label="Subagents"
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
            <section id="conversation-changes-panel"
                class="conversation-changes" data-conversation-changes
                role="region" aria-label="Changes"
                hidden>
                <div class="conversation-changes-header">
                    <div class="conversation-changes-repo-row">
                        <button type="button"
                            class="conversation-icon-button"
                            data-changes-prev
                            data-tooltip="Previous repository"
                            aria-label="Previous repository"
                            hidden><svg viewBox="0 0 16 16" width="13" height="13"
                                aria-hidden="true" fill="none"
                                stroke="currentColor" stroke-width="1.3"
                                stroke-linecap="round" stroke-linejoin="round">
                                <path d="M10 3.5 5.5 8l4.5 4.5"/></svg>
                        </button>
                        <span class="conversation-changes-repo-title conversation-changes-tooltip-target"
                            data-changes-repo-title tabindex="0"
                            hidden></span>
                        <div class="conversation-changes-repo-picker"
                            data-changes-repo-picker hidden>
                            <span class="conversation-changes-repo-label
                                conversation-changes-tooltip-target"
                                data-changes-repo-label><span
                                    class="conversation-changes-repo-name"
                                    data-changes-repo-name></span><span
                                    class="conversation-changes-repo-affordance"
                                    aria-hidden="true">▾</span></span>
                            <select class="conversation-changes-member-select"
                                data-changes-member-select
                                aria-label="Worktree to inspect"></select>
                        </div>
                        <span class="conversation-changes-outside"
                            data-changes-outside hidden>Outside workspace</span>
                        <span class="conversation-changes-position"
                            data-changes-position hidden></span>
                        <button type="button"
                            class="conversation-icon-button"
                            data-changes-next
                            data-tooltip="Next repository"
                            aria-label="Next repository"
                            hidden><svg viewBox="0 0 16 16" width="13" height="13"
                                aria-hidden="true" fill="none"
                                stroke="currentColor" stroke-width="1.3"
                                stroke-linecap="round" stroke-linejoin="round">
                                <path d="M6 3.5l4.5 4.5L6 12.5"/></svg>
                        </button>
                    </div>
                    <div class="conversation-changes-branch-row">
                        <button type="button"
                            class="conversation-icon-button"
                            data-changes-open-scm
                            data-tooltip="Open in Source Control"
                            aria-label="Open in Source Control"
                            ><svg viewBox="0 0 16 16" width="13" height="13"
                                aria-hidden="true" fill="none"
                                stroke="currentColor" stroke-width="1.3"
                                stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="4" cy="3.3" r="1.4"/>
                                <circle cx="4" cy="12.7" r="1.4"/>
                                <circle cx="10" cy="5" r="1.4"/>
                                <path d="M4 4.7v6.6"/>
                                <path d="M4 10.3c0-2.1 1.9-3.5 4.5-3.9"/></svg>
                        </button>
                        <span class="conversation-changes-branch
                                conversation-changes-tooltip-target"
                            data-changes-branch tabindex="0"><span
                            class="conversation-changes-branch-name"><span
                                class="conversation-changes-branch-prefix"
                                data-changes-branch-prefix></span><span
                                class="conversation-changes-branch-tail"
                                data-changes-branch-tail></span></span></span>
                    </div>
                    <span class="conversation-changes-live" data-changes-live
                        aria-live="polite"></span>
                </div>
                <button type="button"
                    class="conversation-changes-cross-member"
                    data-changes-cross-member hidden><span
                        data-changes-cross-member-summary></span><span
                        class="conversation-changes-cross-member-go"
                        data-changes-cross-member-go></span></button>
                <div class="conversation-changes-actions"
                    data-changes-actions>
                    <div class="conversation-changes-subtabs"
                        data-changes-subtabs role="tablist"
                        aria-label="Changes view">
                        <button type="button" role="tab"
                            class="conversation-changes-subtab"
                            id="conversation-changes-tab-files"
                            data-changes-subtab="files"
                            aria-selected="true"
                            aria-controls="conversation-changes-files-view"
                            >Files</button>
                        <button type="button" role="tab"
                            class="conversation-changes-subtab"
                            id="conversation-changes-tab-commits"
                            data-changes-subtab="commits"
                            aria-selected="false" tabindex="-1"
                            aria-controls="conversation-changes-commits-view"
                            >Commits</button>
                    </div>
                    <div class="conversation-changes-fold">
                        <button type="button"
                            class="conversation-icon-button"
                            data-changes-fold-toggle
                            data-tooltip="Collapse all"
                            aria-label="Collapse all"
                            disabled><svg viewBox="0 0 16 16" width="13" height="13"
                                aria-hidden="true" fill="none"
                                stroke="currentColor" stroke-width="1.3"
                                stroke-linecap="round" stroke-linejoin="round">
                                <path data-fold-icon="collapse"
                                    d="M3.5 10 8 5.5l4.5 4.5"/>
                                <path data-fold-icon="expand"
                                    d="M3.5 6 8 10.5 12.5 6" style="display:none"/></svg>
                        </button>
                        <button type="button"
                            class="conversation-icon-button"
                            data-changes-refresh
                            data-tooltip="Refresh"
                            aria-label="Refresh"
                            ><svg viewBox="0 0 16 16" width="13" height="13"
                                aria-hidden="true" fill="none"
                                stroke="currentColor" stroke-width="1.3"
                                stroke-linecap="round" stroke-linejoin="round">
                                <path d="M13.4 8a5.4 5.4 0 1 1-1.5-3.7"/>
                                <path d="M13.6 2.1v2.6h-2.6"/></svg>
                        </button>
                        <button type="button"
                            class="conversation-icon-button"
                            data-changes-review
                            data-tooltip="Review changes"
                            aria-label="Review changes"
                            hidden><svg viewBox="0 0 16 16" width="13" height="13"
                                aria-hidden="true" fill="none"
                                stroke="currentColor" stroke-width="1.3"
                                stroke-linecap="round" stroke-linejoin="round">
                                <path d="M2.5 8s2-3.5 5.5-3.5S13.5 8 13.5 8
                                    11.5 11.5 8 11.5 2.5 8 2.5 8Z"/>
                                <circle cx="8" cy="8" r="1.6"/></svg>
                        </button>
                    </div>
                </div>
                <div class="conversation-changes-files-view"
                    data-changes-files-view
                    id="conversation-changes-files-view"
                    role="tabpanel"
                    aria-labelledby="conversation-changes-tab-files">
                <div class="conversation-changes-working"
                    data-changes-working>
                    <div data-changes-groups></div>
                    <p class="conversation-changes-empty"
                        data-changes-empty hidden>No changes</p>
                </div>
                </div>
                <div class="conversation-changes-commits-view"
                    data-changes-commits-view
                    id="conversation-changes-commits-view"
                    role="tabpanel"
                    aria-labelledby="conversation-changes-tab-commits"
                    hidden>
                    <p class="conversation-changes-commits-notice"
                        data-changes-commits-notice hidden></p>
                    <div class="conversation-changes-commits-list"
                        data-changes-commits-list role="tree"
                        aria-label="Commits"></div>
                    <p class="conversation-changes-empty"
                        data-changes-commits-empty
                        hidden>No commits since start</p>
                    <p class="conversation-changes-commits-loading"
                        data-changes-commits-loading
                        hidden>Loading commits…</p>
                    <div class="conversation-changes-commits-error"
                        data-changes-commits-error hidden>
                        <span data-changes-commits-error-text
                            >Failed to load commits</span>
                        <button type="button"
                            class="conversation-changes-action"
                            data-changes-commits-retry>Retry</button>
                    </div>
                    <button type="button"
                        class="conversation-changes-action
                            conversation-changes-commits-more"
                        data-changes-commits-more hidden>Load more</button>
                    <button type="button"
                        class="conversation-changes-action"
                        data-changes-commits-full
                        hidden>Show full branch history</button>
                </div>
                <p class="conversation-changes-unavailable"
                    data-changes-unavailable hidden></p>
            </section>
        </aside>
    </div>
    <div class="conversation-add-comment" data-add-comment hidden>
        <button class="conversation-comment-icon-button" type="button"
            data-comment-selection-action="comment" title="Add comment"
            aria-label="Add comment">${CONVERSATION_COMMENT_ICON_COMMENT}</button>
        <button class="conversation-comment-icon-button" type="button"
            data-comment-selection-action="project"
            title="Save selection as a project note"
            aria-label="Save selection as a project note">${CONVERSATION_COMMENT_ICON_BOOKMARK}</button>
        <button class="conversation-comment-icon-button accent" type="button"
            data-comment-selection-action="send"
            title="Send selection to the active terminal"
            aria-label="Send selection to the active terminal">${CONVERSATION_COMMENT_ICON_SEND}</button>
    </div>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        purify.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        registryScript.toString()
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
        changesScript.toString()
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
        findScript.toString()
    )}"></script>
    <script nonce="${escapeAttribute(nonce)}" src="${escapeAttribute(
        script.toString()
    )}"></script>
</body>
</html>`;
}

function renderSessionStatusDot(
    kind: ConversationSessionStatusKind,
    localCount: number
): string {
    const label = formatConversationSessionStatusLabel(kind, localCount);
    return `<button type="button"
        class="conversation-session-status-dot conversation-session-status-${kind}${localCount > 0 && kind !== 'idle'
        ? ' conversation-session-status-active'
        : ''}"
        data-session-status-${kind} data-session-status-cycle="${kind}"
        title="${escapeAttribute(label)}"
        aria-label="${escapeAttribute(label)}"${localCount > 0
        ? ''
        : ' disabled'}><span
        class="conversation-session-status-count"
        data-session-status-${kind}-count>${localCount}</span></button>`;
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
