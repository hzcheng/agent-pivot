function createDashboardAiPanel(injected) {
    injected = injected || {};
    var options = injected.options;
    var panels = injected.panels;
    var scheduleTimeout = injected.scheduleTimeout;
    var cancelTimeout = injected.cancelTimeout;
    var panelRequestTimeoutMs = injected.panelRequestTimeoutMs;
    var showPanelLoading = injected.showPanelLoading;
    var showPanelUnavailable = injected.showPanelUnavailable;
    var restoreScroll = injected.restoreScroll;
    var replaceSearchCatalog = injected.replaceSearchCatalog;
    var getActiveTab = injected.getActiveTab;
    var getSearchQuery = injected.getSearchQuery;
    var getPendingScrollRestoreTab = injected.getPendingScrollRestoreTab;
    var setPendingScrollRestoreTab = injected.setPendingScrollRestoreTab;
    var skillPanel = injected.skillPanel;
    var getPendingSkillReveal = injected.getPendingSkillReveal;
    var setPendingSkillReveal = injected.setPendingSkillReveal;

    var aiState = 'unloaded';
    var aiRequestId = null;
    var aiRequestAttempts = 0;
    var aiRequestTimer = null;
    var aiRequestSequence = 0;
    var issuedAiRequestIds = new Set();
    var pendingAiSubtab = null;
    var pendingPromptRefresh = null;

    function scheduleAiRequestTimeout(requestId) {
        if (!scheduleTimeout) {
            return;
        }
        if (aiRequestTimer !== null) {
            cancelTimeout(aiRequestTimer);
        }
        aiRequestTimer = scheduleTimeout(function () {
            aiRequestTimer = null;
            if (aiState !== 'loading' || requestId !== aiRequestId) {
                return;
            }
            aiState = 'unloaded';
            if (aiRequestAttempts < 2 && getActiveTab() === 'ai' && !getSearchQuery()) {
                ensureAiPanel();
                return;
            }
            showPanelUnavailable('ai');
        }, panelRequestTimeoutMs);
    }

    function createFreshAiRequestId() {
        aiRequestSequence += 1;
        var randomId = '';
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                randomId = crypto.randomUUID();
            }
        } catch (_error) {
            randomId = '';
        }
        if (!randomId) {
            randomId = Date.now().toString(36)
                + '-' + Math.random().toString(36).slice(2);
        }
        var requestId = randomId + '-' + aiRequestSequence.toString(36);
        while (issuedAiRequestIds.has(requestId)) {
            aiRequestSequence += 1;
            requestId = randomId + '-' + aiRequestSequence.toString(36);
        }
        issuedAiRequestIds.add(requestId);
        return requestId;
    }

    function ensureAiPanel() {
        if (aiState !== 'unloaded') {
            return;
        }
        aiState = 'loading';
        aiRequestAttempts += 1;
        aiRequestId = createFreshAiRequestId();
        showPanelLoading('ai');
        options.postMessage({
            type: 'request-ai-panel',
            version: 1,
            requestId: aiRequestId,
            target: 'global-prompt-library',
        });
        scheduleAiRequestTimeout(aiRequestId);
    }

    function failAiPanelMount(previousHtml) {
        if (aiRequestTimer !== null) {
            cancelTimeout(aiRequestTimer);
            aiRequestTimer = null;
        }
        panels.ai.innerHTML = previousHtml;
        aiState = 'unloaded';
        aiRequestAttempts = 0;
        showPanelUnavailable('ai');
        return false;
    }

    function getInstalledPromptSurface(message) {
        if (!panels.ai
            || typeof panels.ai.querySelectorAll !== 'function'
            || !message
            || !message.snapshot) {
            return null;
        }
        var surfaces = Array.from(panels.ai.querySelectorAll('[data-prompt-surface]'));
        if (surfaces.length !== 1 || typeof surfaces[0].getAttribute !== 'function') {
            return null;
        }
        var revisionValue = surfaces[0].getAttribute('data-prompt-revision');
        if (typeof revisionValue !== 'string' || !/^(0|[1-9]\d*)$/.test(revisionValue)) {
            return null;
        }
        var revision = Number(revisionValue);
        return Number.isSafeInteger(revision) && revision === message.snapshot.revision
            ? surfaces[0]
            : null;
    }

    function applyAiPanelMessage(message) {
        if (!validateAiPanelMessage(message)
            || aiState !== 'loading'
            || message.requestId !== aiRequestId
            || !panels.ai) {
            return false;
        }

        var previousHtml = panels.ai.innerHTML;
        try {
            panels.ai.innerHTML = message.html;
        } catch (_error) {
            return failAiPanelMount(previousHtml);
        }
        if (!getInstalledPromptSurface(message)
            || !window.__agentPivotPrompts
            || typeof window.__agentPivotPrompts.mount !== 'function') {
            return failAiPanelMount(previousHtml);
        }
        try {
            if (window.__agentPivotPrompts.mount(panels.ai, message) !== true) {
                return failAiPanelMount(previousHtml);
            }
        } catch (_error) {
            return failAiPanelMount(previousHtml);
        }
        if (aiRequestTimer !== null) {
            cancelTimeout(aiRequestTimer);
            aiRequestTimer = null;
        }
        aiRequestAttempts = 0;
        aiState = 'mounted';
        drainPendingPromptRefresh();
        applyPendingAiSubtab();
        skillPanel.applySkillAgentFilter();
        if (getPendingSkillReveal()) {
            var revealDir = getPendingSkillReveal();
            setPendingSkillReveal(null);
            skillPanel.revealSkillCard(revealDir);
        }
        if (getPendingScrollRestoreTab() === 'ai') {
            setPendingScrollRestoreTab(null);
            if (getActiveTab() === 'ai' && !getSearchQuery()) {
                restoreScroll('ai');
            }
        }
        return true;
    }

    function applyPendingAiSubtab() {
        if (pendingAiSubtab !== 'prompts'
            || aiState !== 'mounted'
            || !panels.ai
            || typeof panels.ai.querySelector !== 'function') {
            return false;
        }
        var promptTab = panels.ai.querySelector('#ai-tab-prompts');
        if (!promptTab || typeof promptTab.click !== 'function') {
            return false;
        }
        pendingAiSubtab = null;
        promptTab.click();
        return true;
    }

    function applyPromptPanelUpdatedMessage(message) {
        if (!validatePromptPanelUpdatedMessage(message)) {
            return false;
        }
        if (aiState !== 'mounted') {
            if (pendingPromptRefresh
                && message.authoritySequence <= pendingPromptRefresh.authoritySequence) {
                return false;
            }
            pendingPromptRefresh = message;
            return true;
        }
        if (!window.__agentPivotPrompts
            || typeof window.__agentPivotPrompts.applyRefresh !== 'function') {
            return false;
        }
        return window.__agentPivotPrompts.applyRefresh(message) === true;
    }

    function drainPendingPromptRefresh() {
        var refresh = pendingPromptRefresh;
        pendingPromptRefresh = null;
        return refresh ? applyPromptPanelUpdatedMessage(refresh) : false;
    }

    return {
        ensureAiPanel: ensureAiPanel,
        applyAiPanelMessage: applyAiPanelMessage,
        applyPendingAiSubtab: applyPendingAiSubtab,
        applyPromptPanelUpdatedMessage: applyPromptPanelUpdatedMessage,
        setPendingAiSubtab: subtab => { pendingAiSubtab = subtab; },
        getAiState: () => aiState,
    };
}
