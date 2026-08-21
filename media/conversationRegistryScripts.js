(function () {
    'use strict';

    // Conversation viewer plugin registry (MOD-DASHBOARD-SHELL, webview
    // manifest): one declared namespace that the conversation feature scripts
    // register into and the viewer consumes. Replaces the per-feature
    // window.__agentPivotConversation* globals.
    window.__agentPivotConversation = window.__agentPivotConversation || {};
}());
