'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const {
    buildWorkspaceDashboardSearchCatalog,
} = require('../../../out/webview/dashboardViewModel');
const { getDashboardWebviewOptions } = require('../../../out/dashboard/webviewOptions');

const root = path.join(__dirname, '..', '..', '..');
const dashboardSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDashboardScripts.js'), 'utf8');
const generatedDashboardSource = fs.readFileSync(path.join(root, 'media', 'webviewDashboardScripts.js'), 'utf8');
const skillPanelSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewSkillPanelScripts.js'), 'utf8');
const generatedSkillPanelSource = fs.readFileSync(path.join(root, 'media', 'webviewSkillPanelScripts.js'), 'utf8');
const projectsPanelSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectsPanelScripts.js'), 'utf8');
const generatedProjectsPanelSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectsPanelScripts.js'), 'utf8');
const dashboardValidationSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDashboardValidationScripts.js'), 'utf8');
const generatedDashboardValidationSource = fs.readFileSync(path.join(root, 'media', 'webviewDashboardValidationScripts.js'), 'utf8');
const dashboardSearchSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDashboardSearchScripts.js'), 'utf8');
const generatedDashboardSearchSource = fs.readFileSync(path.join(root, 'media', 'webviewDashboardSearchScripts.js'), 'utf8');
const dashboardProjectsPanelSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDashboardProjectsPanelScripts.js'), 'utf8');
const generatedDashboardProjectsPanelSource = fs.readFileSync(path.join(root, 'media', 'webviewDashboardProjectsPanelScripts.js'), 'utf8');
const dashboardAiPanelSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDashboardAiPanelScripts.js'), 'utf8');
const generatedDashboardAiPanelSource = fs.readFileSync(path.join(root, 'media', 'webviewDashboardAiPanelScripts.js'), 'utf8');
const dashboardVmSource = `${skillPanelSource}\n${projectsPanelSource}\n${dashboardValidationSource}\n${dashboardSearchSource}\n${dashboardProjectsPanelSource}\n${dashboardAiPanelSource}\n${dashboardSource}`;
const projectSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectScripts.js'), 'utf8');
const generatedProjectSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectScripts.js'), 'utf8');
const viewStateSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewAiSessionViewStateScripts.js'), 'utf8');
const generatedViewStateSource = fs.readFileSync(path.join(root, 'media', 'webviewAiSessionViewStateScripts.js'), 'utf8');
const workspaceUpdateSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewWorkspaceUpdateScripts.js'), 'utf8');
const generatedWorkspaceUpdateSource = fs.readFileSync(path.join(root, 'media', 'webviewWorkspaceUpdateScripts.js'), 'utf8');
const projectCollapseSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectCollapseScripts.js'), 'utf8');
const generatedProjectCollapseSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectCollapseScripts.js'), 'utf8');
const projectContextMenuSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectContextMenuScripts.js'), 'utf8');
const generatedProjectContextMenuSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectContextMenuScripts.js'), 'utf8');
const projectAiUpdateSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectAiUpdateScripts.js'), 'utf8');
const generatedProjectAiUpdateSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectAiUpdateScripts.js'), 'utf8');
const aiSessionControlsSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectAiSessionControlsScripts.js'), 'utf8');
const generatedAiSessionControlsSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectAiSessionControlsScripts.js'), 'utf8');
const groupFormSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewGroupFormScripts.js'), 'utf8');
const projectVmSource = `${viewStateSource}\n${workspaceUpdateSource}\n${projectCollapseSource}\n${projectContextMenuSource}\n${projectAiUpdateSource}\n${groupFormSource}\n${aiSessionControlsSource}\n${projectSource}`;
const scrollStateSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewScrollStateScripts.js'), 'utf8');
const promptProtocolSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewPromptProtocolScripts.js'), 'utf8');
const generatedPromptProtocolSource = fs.readFileSync(path.join(root, 'media', 'webviewPromptProtocolScripts.js'), 'utf8');
const promptSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewPromptScripts.js'), 'utf8');
const generatedPromptPath = path.join(root, 'media', 'webviewPromptScripts.js');
const dndSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDnDScripts.js'), 'utf8');
const NOW = '2026-07-23T00:00:00.000Z';

function toPlain(value) {
    return JSON.parse(JSON.stringify(value));
}

function createClassList(initial = []) {
    const values = new Set(initial);
    return {
        add: value => values.add(value),
        remove: value => values.delete(value),
        contains: value => values.has(value),
        toggle(value, force) {
            if (force === undefined ? !values.has(value) : force) values.add(value);
            else values.delete(value);
            return values.has(value);
        },
    };
}

function createElement(id = '') {
    const attributes = new Map();
    const listeners = {};
    return {
        id,
        hidden: false,
        innerHTML: '',
        children: [],
        classList: createClassList(),
        addEventListener(type, listener) {
            listeners[type] = listener;
        },
        dispatch(type, event = {}) {
            return listeners[type] && listeners[type](event);
        },
        getAttribute(name) {
            return attributes.has(name) ? attributes.get(name) : null;
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
        },
        removeAttribute(name) {
            attributes.delete(name);
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        contains: () => false,
        focus() {},
    };
}

function createSearchElement(tagName = 'div') {
    const element = createElement();
    element.tagName = tagName.toUpperCase();
    element.dataset = {};
    element.className = '';
    element.textContent = '';
    element.appendChild = child => {
        element.children.push(child);
        return child;
    };
    element.removeChild = child => {
        element.children.splice(element.children.indexOf(child), 1);
    };
    Object.defineProperty(element, 'firstChild', {
        get: () => element.children[0] || null,
    });
    element.classList = {
        add(value) {
            const classes = new Set(element.className.split(/\s+/).filter(Boolean));
            classes.add(value);
            element.className = Array.from(classes).join(' ');
        },
        remove(value) {
            const classes = new Set(element.className.split(/\s+/).filter(Boolean));
            classes.delete(value);
            element.className = Array.from(classes).join(' ');
        },
        toggle(value, force) {
            if (force) this.add(value);
            else this.remove(value);
        },
        contains: value => element.className.split(/\s+/).includes(value),
    };
    return element;
}

function makeCatalog(suffix = '') {
    return {
        version: 3,
        sessions: [{
            key: `codex:c${suffix}`, searchText: `dashboard session ${suffix}`,
            workspaceId: 'current', workspaceNavigationIdentity: 'navigation:current',
            workspaceName: 'Dashboard', action: 'reveal-workspace-session',
            provider: 'codex', sessionId: `c${suffix}`, name: 'Session',
        }],
        worktrees: [],
        openWorkspaces: [{
            key: `workspace:navigation:${suffix}`, navigationIdentity: `navigation:${suffix}`,
            searchText: `dashboard open ${suffix}`, workspaceId: 'current',
            name: 'Dashboard', description: '1 folder', action: 'show-current-workspace', current: true,
        }],
        savedProjects: [],
        todos: [],
    };
}

function makeAiSessionPresentation(projectionRevision) {
    return {
        type: 'ai-session-presentation-state',
        version: 1,
        projectionRevision,
        workspaceScopeIdentity: null,
        workspaceNavigationIdentity: null,
        attentionCount: 0,
        activeAttentionCount: 0,
        runningSessionCount: 0,
        runningCardAnimation: 'current',
        runningIconAnimation: 'current',
        revealFocused: false,
        focusedTarget: null,
        attentionSessions: [],
        sessions: [],
    };
}

function makeAiSessionsUpdatedMessage(projectionRevision, overrides = {}) {
    return {
        type: 'ai-sessions-updated',
        version: 3,
        sequence: projectionRevision,
        projectionRevision,
        generatedAt: NOW,
        currentWorkspaceCount: 1,
        html: '<div class="open-current-workspace-group"></div>',
        searchCatalog: makeCatalog(),
        presentation: makeAiSessionPresentation(projectionRevision),
        ...overrides,
    };
}

function makePromptSnapshot(revision = 0) {
    return {
        version: 1,
        revision,
        selectedPromptId: null,
        prompts: [],
    };
}

function makeAiPanelHtml(revision, surfaceCount = 1) {
    const surfaces = Array.from({ length: surfaceCount }, () =>
        `<div data-prompt-surface data-prompt-revision="${revision}"></div>`
    ).join('');
    return `<div data-ai-panel>${surfaces}</div>`;
}

function makeWorkspaceCard(overrides = {}) {
    const kind = overrides.kind || 'current';
    return {
        id: overrides.id || (kind === 'current' ? 'current' : 'navigation'),
        kind,
        workspaceKind: 'singleFolder',
        showSaveAction: false,
        runningSessionCount: 0,
        navigationIdentity: overrides.navigationIdentity || `navigation:${kind}`,
        scopeIdentity: overrides.scopeIdentity || `scope:${kind}`,
        name: overrides.name || (kind === 'current' ? 'Current' : 'Other'),
        environment: 'local',
        environmentLabel: 'Local',
        color: overrides.color || '#00aacc',
        roots: [{ id: `root:${kind}`, name: overrides.rootName || 'work', ordinal: 0 }],
        attentionCount: overrides.attentionCount || 0,
        ...(overrides.aiSessions ? { aiSessions: overrides.aiSessions } : {}),
    };
}

function createDashboardHarness({
    initialTab = 'open',
    initialSearchQuery = '',
    synchronousFrames = true,
    onProjectsMounted,
    onActiveTabChanged,
} = {}) {
    const openButton = createElement('dashboard-tab-open-button');
    openButton.setAttribute('data-dashboard-tab', 'open');
    const projectsButton = createElement('dashboard-tab-projects-button');
    projectsButton.setAttribute('data-dashboard-tab', 'projects');
    const aiButton = createElement('dashboard-tab-ai-button');
    aiButton.setAttribute('data-dashboard-tab', 'ai');
    const openPanel = createElement('dashboard-tab-open');
    const projectsPanel = createElement('dashboard-tab-projects');
    const aiPanel = createElement('dashboard-panel-ai');
    const projectsLoading = createElement();
    const aiLoading = createElement();
    let promptSubtabSelections = 0;
    const promptSubtab = {
        click() {
            promptSubtabSelections += 1;
        },
    };
    projectsPanel.querySelector = selector => selector === '.dashboard-projects-loading'
        ? projectsLoading
        : null;
    aiPanel.querySelector = selector => selector === '.dashboard-ai-loading'
        ? aiLoading
        : selector === '#ai-tab-prompts'
            ? promptSubtab
            : null;
    aiPanel.querySelectorAll = selector => {
        if (selector !== '[data-prompt-surface]') return [];
        return Array.from(aiPanel.innerHTML.matchAll(
            /<[^>]*\bdata-prompt-surface(?:\s|=|>)[^>]*>/g
        )).map(match => {
            const surface = createElement();
            const revision = match[0].match(/\bdata-prompt-revision="([^"]*)"/);
            if (revision) surface.setAttribute('data-prompt-revision', revision[1]);
            return surface;
        });
    };
    const tablist = createElement();
    const collapseButton = createElement();
    collapseButton.disabled = false;
    const searchResults = createSearchElement();
    searchResults.id = 'dashboard-search-results';
    const catalogElement = { textContent: JSON.stringify(makeCatalog()) };
    const elements = {
        'dashboard-tab-open': openPanel,
        'dashboard-tab-projects': projectsPanel,
        'dashboard-panel-ai': aiPanel,
        'dashboard-search-results': searchResults,
        'dashboard-search-catalog': catalogElement,
    };
    const storage = new Map([['agentPivot.activeDashboardTab', initialTab]]);
    const messages = [];
    const frames = [];
    const timers = [];
    const windowListeners = {};
    const promptMounts = [];
    const promptRefreshes = [];
    let nextTimerId = 1;
    const context = {
        document: {
            activeElement: null,
            body: { classList: createClassList() },
            createElement: createSearchElement,
            getElementById: id => elements[id] || null,
            querySelector: selector => selector === '[role="tablist"]'
                ? tablist
                : selector === '[data-action="toggle-all-groups"]'
                    ? collapseButton
                    : null,
            querySelectorAll: selector => selector === '[data-dashboard-tab]'
                ? [openButton, projectsButton, aiButton]
                : [],
        },
        sessionStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
        },
        window: {
            scrollY: 0,
            scrollTo: (_x, y) => { context.window.scrollY = y; },
            addEventListener: (type, listener) => { windowListeners[type] = listener; },
            __agentPivotPrompts: {
                mount(root, message) {
                    promptMounts.push({ root, html: root.innerHTML, message });
                    return true;
                },
                applyRefresh(message) {
                    promptRefreshes.push(message);
                    return true;
                },
            },
        },
        requestAnimationFrame(callback) {
            if (synchronousFrames) callback();
            else frames.push(callback);
        },
        setTimeout(callback) {
            const timer = { id: nextTimerId, callback, cancelled: false };
            nextTimerId += 1;
            timers.push(timer);
            return timer.id;
        },
        clearTimeout(timerId) {
            const timer = timers.find(candidate => candidate.id === timerId);
            if (timer) timer.cancelled = true;
        },
    };
    vm.runInNewContext(dashboardVmSource, context);
    const controller = context.initDashboard({
        initialSearchQuery,
        postMessage: message => messages.push(message),
        onProjectsMounted,
        onActiveTabChanged,
    });
    return {
        context,
        controller,
        messages,
        frames,
        runNextTimer() {
            let timer;
            do {
                timer = timers.shift();
            } while (timer && timer.cancelled);
            if (timer) timer.callback();
            return Boolean(timer);
        },
        storage,
        windowListeners,
        openButton,
        projectsButton,
        aiButton,
        openPanel,
        projectsPanel,
        aiPanel,
        projectsLoading,
        aiLoading,
        collapseButton,
        promptMounts,
        promptRefreshes,
        get promptSubtabSelections() {
            return promptSubtabSelections;
        },
        searchResults,
    };
}

function loadWebviewModules(options = {}) {
    const vscode = createFakeVscode({});
    vscode.Uri = {
        file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }),
    };
    const contentPath = require.resolve('../../../out/webview/webviewContent');
    if (options.fresh) {
        delete require.cache[contentPath];
    }
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return {
            content: require('../../../out/webview/webviewContent'),
            updateMessages: require('../../../out/dashboard/webviewUpdateMessages'),
        };
    } finally {
        Module._load = previousLoad;
    }
}

const webviewModules = loadWebviewModules();

test('WEBVIEW-DASHBOARD-SEARCH-CATALOG-001 / WORKTREE-PRESENTATION-001 publishes catalog v3 worktrees while de-duplicating saved paths', () => {
    const catalog = buildWorkspaceDashboardSearchCatalog([{
        id: 'tools', groupName: 'TOOLS', projects: [
            { id: 'saved', name: 'Dashboard', path: '/work/dashboard', favorite: true },
            { id: 'duplicate', name: 'Dashboard copy', path: '/work/dashboard/' },
            { id: 'other', name: 'Other', path: '/work/other' },
        ],
    }], [makeWorkspaceCard({
        id: 'open',
        name: 'Dashboard',
        navigationIdentity: 'navigation:dashboard',
        aiSessions: {
            sessionsByProvider: { codex: [{
                id: 'c1', name: 'Fix dashboard',
                worktreeKey: {
                    repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/topic',
                },
            }] },
            worktrees: [{
                kind: 'ready',
                git: {
                    key: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/topic' },
                    branchRef: 'refs/heads/feature/topic', head: 'a'.repeat(40),
                    isMain: false, isBare: false, health: 'normal', headKind: 'branch',
                },
                activity: 'idle', sessions: [], authority: {
                    canInput: false, canFocus: false, canStop: false, canResume: true,
                    canArchive: false, canTakeControl: false, liveOwnerAvailable: false,
                },
            }],
            activeSessions: [], unavailableProviders: [], activeProvider: 'codex', expanded: true,
        },
    })]);

    assert.deepEqual(catalog.sessions.map(item => item.key), ['codex:c1']);
    assert.equal(catalog.sessions[0].worktreeName, 'feature/topic');
    assert.match(catalog.sessions[0].searchText, /feature\/topic/);
    assert.equal(catalog.version, 3);
    assert.deepEqual(catalog.worktrees.map(item => ({
        action: item.action, name: item.name, path: item.canonicalWorktreePath,
    })), [{
        action: 'reveal-workspace-worktree', name: 'feature/topic', path: '/repo/topic',
    }]);
    assert.deepEqual(catalog.savedProjects.map(item => item.projectId), ['saved', 'other']);
    assert.deepEqual(catalog.savedProjects[0].groupLabels, ['FAVORITES', 'TOOLS']);
});

test('WEBVIEW-WEBVIEW-OPTIONS-001 enables scripts and limits local resources to media', () => {
    const options = getDashboardWebviewOptions('/extension', value => ({ path: value }));
    assert.deepEqual(options, {
        enableScripts: true,
        localResourceRoots: [{ path: path.join('/extension', 'media') }],
    });
});

test('OPEN-WINDOW-SWITCHER-UI-001 WEBVIEW-CURRENT-WORKSPACE-RENDERING-001 WEBVIEW-DISPLAY-001 renders WINDOWS switcher rows above the lifted session surface', () => {
    const html = webviewModules.content.getOpenWorkspacesGroupContent([
        makeWorkspaceCard({
            id: 'current',
            aiSessions: {
                sessionsByProvider: { codex: [{ id: 'c1', name: 'Session' }] },
                activeSessions: [], unavailableProviders: [], activeProvider: 'codex', expanded: true,
            },
        }),
        makeWorkspaceCard({ id: 'navigation', kind: 'navigation', name: 'Other' }),
    ], 'ready');

    // ① The switcher group leads; the CHATS/ALL surface follows directly.
    const switcherStart = html.indexOf('open-window-switcher-group');
    const currentStart = html.indexOf('<div class="open-session-surface"');
    assert.ok(switcherStart >= 0, 'the window switcher group must render');
    assert.ok(currentStart > switcherStart,
        'the lifted session surface follows the window switcher');
    const switcherSection = html.slice(0, currentStart);
    assert.match(switcherSection, /class="group open-window-switcher-group" role="list"/);
    assert.match(switcherSection, /data-other-windows-status="ready"/);
    assert.match(switcherSection, /data-open-window-switcher-status/);
    assert.match(switcherSection, /data-open-window-switcher-list/);
    assert.match(switcherSection, /data-open-workspace-pin-live-region/);
    assert.equal((switcherSection.match(/class="group-title-text">WINDOWS</g) || []).length, 1,
        'the switcher owns the single WINDOWS group title');

    // ② One single-line row per window with the fixed slot structure.
    const rowTags = Array.from(html.matchAll(
        /<div class="open-window-row[^"]*"[^>]*>/g
    )).map(match => match[0]);
    assert.equal(rowTags.length, 2);
    const currentRowTag = rowTags.find(tag => /data-id="current"/.test(tag));
    const navigationRowTag = rowTags.find(tag => /data-id="navigation"/.test(tag));
    assert.ok(currentRowTag && navigationRowTag, 'both windows render one row each');
    assert.match(currentRowTag, /data-window-kind="current"/);
    assert.match(currentRowTag, /data-workspace-navigation-identity="navigation:current"/);
    assert.match(navigationRowTag, /data-window-kind="navigation"/);
    assert.match(navigationRowTag, /data-workspace-navigation-identity="navigation:navigation"/);
    assert.equal((html.match(/class="open-window-indicator"/g) || []).length, 2);
    assert.equal((html.match(/class="open-window-running"/g) || []).length, 2);
    assert.equal((html.match(/class="open-window-attention"/g) || []).length, 2);
    assert.equal((html.match(/data-action="focus-open-window"/g) || []).length, 2);
    assert.equal((html.match(/data-action="toggle-open-workspace-pin"/g) || []).length, 2);
    assert.equal((html.match(/data-action="open-window-menu"/g) || []).length, 2);
    assert.equal((html.match(/data-action="retry-open-window-navigation" hidden/g) || []).length, 2);
    assert.match(html, /aria-label="Current window: Current" aria-disabled="true" aria-current="true"/);
    assert.match(html, /aria-label="Focus window: Other"/);

    // ③ The lifted surface owns the current session identity directly.
    const currentSection = html.slice(currentStart);
    assert.match(currentSection, /class="open-session-surface"/);
    assert.doesNotMatch(currentSection, /class="workspace-card/,
        'the lifted surface must not retain a current-detail card wrapper');
    assert.match(currentSection, /data-current-workspace/);
    assert.match(currentSection, /data-workspace-scope-identity/);
    assert.equal((currentSection.match(/class="codex-sessions"/g) || []).length, 1);

    // ④ The retired dual-group chrome is gone for good.
    assert.equal(html.includes('CURRENT WINDOW'), false);
    assert.equal(html.includes('OPEN WINDOWS'), false);
    assert.equal(html.includes('CURRENT WORKSPACE'), false);
    assert.equal(html.includes('OTHER WINDOWS'), false);
    assert.doesNotMatch(html, /current-window-indicator/);
    assert.doesNotMatch(html, /open-tab-split-resizer/);
    assert.doesNotMatch(html, /open-other-windows-group/);
    assert.doesNotMatch(html, /data-open-workspace-list-card/);
    assert.doesNotMatch(html, /data-open-workspace-current/);
    assert.doesNotMatch(html, /data-workspace-navigation(?!-identity)/);
    assert.equal(html.includes('Leaked'), false);
});

test('OPEN-WINDOW-SWITCHER-UI-001 renders saved project names for single-root window cards', () => {
    const html = webviewModules.content.getOpenWorkspacesGroupContent([
        makeWorkspaceCard({
            id: 'current',
            name: 'agent-pivot',
            rootName: 'vscode-dashboard',
        }),
        makeWorkspaceCard({
            id: 'navigation',
            kind: 'navigation',
            name: 'reddb project',
            rootName: 'reddb',
        }),
    ], 'ready');

    const rowNames = Array.from(html.matchAll(
        /<span class="open-window-name">([^<]+)<\/span>/g
    )).map(match => match[1]);
    assert.deepEqual(rowNames, ['agent-pivot', 'reddb project'],
        'every window renders its disambiguated name in the switcher row');
    assert.match(html, /data-open-session-surface data-id="current"/,
        'the current window owns one direct CHATS/ALL surface');
    assert.doesNotMatch(html, /<h2 class="project-header">/,
        'the retired current-detail header is not rendered');
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-002 renders a pinned-first selected-provider history list', () => {
    const html = webviewModules.content.getOpenWorkspacesGroupContent([
        makeWorkspaceCard({
            aiSessions: {
                activeProvider: 'kimi',
                selectedProviders: ['kimi', 'codex', 'claude'],
                providers: [
                    { id: 'kimi', label: 'Kimi', count: 2 },
                    { id: 'codex', label: 'Codex', count: 2 },
                    { id: 'claude', label: 'Claude', count: 1 },
                ],
                sessionsByProvider: {
                    kimi: [
                        { id: 'k-pin', name: 'Kimi pinned', provider: 'kimi', pinned: true },
                        { id: 'k-new', name: 'Kimi new', provider: 'kimi' },
                    ],
                    codex: [
                        { id: 'c-pin', name: 'Codex pinned', provider: 'codex', pinned: true },
                        { id: 'c-new', name: 'Codex new', provider: 'codex' },
                    ],
                    claude: [{ id: 'a-new', name: 'Claude new', provider: 'claude' }],
                },
                unavailableProviders: [],
                expanded: true,
                defaultTab: 'sessions',
                activeSessions: [],
            },
        }),
    ], 'ready');

    assert.match(html, /data-selected-ai-session-providers="kimi,codex,claude"/);
    assert.match(html, /data-active-ai-session-provider="kimi"/);
    assert.match(html, /data-ai-provider-menu-trigger/);
    assert.match(html, /aria-controls="ai-session-provider-menu-current"/);
    assert.match(html, /id="ai-session-provider-menu-current"/);
    assert.match(html, />3 providers<\/button>/);
    assert.match(html, /role="menuitemcheckbox"/);
    assert.match(html, /aria-checked="true"/);
    assert.ok(html.indexOf('k-pin') < html.indexOf('c-pin'));
    assert.ok(html.indexOf('c-pin') < html.indexOf('k-new'));
    assert.ok(html.indexOf('k-new') < html.indexOf('c-new'));
    assert.ok(html.indexOf('c-new') < html.indexOf('a-new'));
    assert.doesNotMatch(html, /ai-session-provider-section/);
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-002 summarizes one or two selected providers and retains legacy provider summaries', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'legacy-providers',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex', 'claude'],
        codexSessions: [{ id: 'codex-history', name: 'Codex history', provider: 'codex' }],
        kimiSessions: [],
        claudeSessions: [{ id: 'claude-history', name: 'Claude history', provider: 'claude' }],
        activeAiSessions: [],
    });

    assert.match(html, /data-active-ai-session-provider="codex"/);
    assert.match(html, />Codex \+ Claude<\/button>/);
    assert.match(html, /aria-controls="ai-session-provider-menu-legacy-providers"/);
    assert.match(html, /id="ai-session-provider-menu-legacy-providers"/);
    assert.match(html, /data-provider="codex"[\s\S]*?ai-session-provider-count">1/);
    assert.match(html, /data-provider="claude"[\s\S]*?ai-session-provider-count">1/);
});

test('WORKTREE-GROUPING-UI-001 renders Worktree and Chats with worktree status rows', () => {
    const frontendKey = {
        repositoryKey: '/repos/frontend/.git',
        canonicalWorktreePath: '/managed/frontend-feature',
    };
    const idleKey = {
        repositoryKey: '/repos/frontend/.git',
        canonicalWorktreePath: '/managed/frontend-idle',
    };
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'worktree-groups',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        activeAiSessionTab: 'sessions',
        codexSessions: [{
            id: 'feature-session',
            name: 'Feature session',
            provider: 'codex',
            updatedAt: '2026-08-13T00:00:00.000Z',
            worktreeKey: frontendKey,
        }],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [{
            key: 'codex:live-session',
            provider: 'codex',
            sessionId: 'live-session',
            name: 'Live session',
            executionState: 'running',
            backend: 'vscode',
            attached: true,
            worktreeKey: frontendKey,
        }],
        quickCreateProvider: 'codex',
        worktrees: [
            {
                kind: 'ready',
                git: {
                    key: idleKey,
                    branchRef: 'refs/heads/feature/idle',
                    head: 'b'.repeat(40),
                    isMain: false,
                    isBare: false,
                    health: 'locked',
                    headKind: 'branch',
                },
                activity: 'idle',
                sessions: [],
                authority: {
                    canInput: false, canFocus: false, canStop: false,
                    canResume: true, canArchive: false, canTakeControl: false,
                    liveOwnerAvailable: false,
                },
            },
            {
                kind: 'ready',
                git: {
                    key: frontendKey,
                    branchRef: 'refs/heads/feature/auth',
                    head: 'a'.repeat(40),
                    isMain: false,
                    isBare: false,
                    health: 'normal',
                    headKind: 'branch',
                },
                activity: 'attention',
                sessions: [],
                authority: {
                    canInput: false, canFocus: false, canStop: false,
                    canResume: true, canArchive: true, canTakeControl: false,
                    liveOwnerAvailable: false,
                },
            },
        ],
        truncatedWorktreeCount: 2,
    });

    // M2 结构：无 surface tab；CHATS（tree）/ ALL 两个 tab，tree 面板承载
    // 全部 worktree 管理面，ALL 面板承载历史。
    assert.match(html, /data-ai-session-tab="chats"/);
    assert.match(html, /data-ai-session-tab="all"/);
    assert.match(html, /data-selected-ai-session-tab="all"/);
    assert.match(html, /data-chats-view-mode="tree"/);
    assert.doesNotMatch(html, /data-ai-session-surface-tab|data-selected-ai-session-surface/);
    assert.doesNotMatch(html, /data-ai-session-grouping-select/);
    assert.equal((html.match(/data-session-id="feature-session"/g) || []).length, 1,
        'history sessions stay in ALL only');
    const treePanel = html.match(
        /data-ai-session-panel="chats"[\s\S]*?data-ai-session-panel="all"/
    )[0];
    assert.match(treePanel, /data-session-id="live-session"/,
        'the CHATS tree lists the live session under its group');
    assert.doesNotMatch(treePanel, /data-session-id="feature-session"/,
        'the CHATS tree never duplicates history sessions');
    assert.match(html, /data-worktree-activity="attention"/);
    assert.ok(html.indexOf('feature/idle') < html.indexOf('feature/auth'),
        'status changes retain the stable snapshot order instead of moving attention worktrees');
    assert.match(html, /feature\/idle[\s\S]*?locked[\s\S]*?\(no active sessions\)/);
    assert.match(html, /2 more worktrees not shown/);
    assert.match(html, /data-action="toggle-ai-session-worktree"/);
    assert.match(html, /aria-label="feature\/auth, 1 session, needs attention"/);
    assert.doesNotMatch(html, /data-action="create-isolated-session"/,
        'no standalone New-worktree button: creation lives in the row menus');
    assert.match(treePanel, /data-action="ai-session-worktree-menu"/,
        'each worktree row exposes one unified actions menu');
    assert.doesNotMatch(treePanel, /ai-session-create-split-button/,
        'the retired global session create cluster is gone');
    assert.match(treePanel, /data-action="create-ai-session-quick"/,
        'each worktree create target exposes a quick-create action');
    assert.match(treePanel, /data-action="open-ai-session-preset-menu"/,
        'each worktree create target exposes a preset-menu action');
    assert.doesNotMatch(html, /ai-session-module-header/,
        'the retired module header must not render');
    const toolbar = html.match(/ai-session-chats-toolbar[\s\S]*?ai-session-tab-panel/)[0];
    assert.ok(toolbar.indexOf('data-ai-session-tab="chats"') >= 0
        && toolbar.indexOf('data-ai-session-tab="all"') >= 0
        && toolbar.indexOf('data-action="create-ai-session-quick"') === -1,
        'the CHATS/ALL toolbar contains tabs only');
    assert.match(toolbar, /data-action="toggle-chats-view-menu"/,
        'the CHATS tab pair carries the view-menu trigger');
});

test('WORKTREE-GROUPS-UI-001 renders merge eligibility on the unified actions menu trigger', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'merge-menu-coverage',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        activeAiSessionTab: 'chats',
        codexSessions: [], kimiSessions: [], claudeSessions: [], activeAiSessions: [],
        worktreeGroups: [{
            kind: 'group', groupId: 'merge-source', displayName: 'merge-source', revision: 1,
            activity: 'idle', sessions: [], chips: [], hasDetachedMembers: false,
            needsPrimarySelection: false, canCreateSession: true,
            mergeCandidateGroupIds: ['merge-target'],
            members: [{
                memberId: 'member-1', repositoryKey: '/repo/.git', repositoryLabel: 'repo',
                branchName: 'merge-source', path: '/repo/.worktrees/merge-source',
                status: 'ready', isPrimary: true,
                worktreeKey: {
                    repositoryKey: '/repo/.git',
                    canonicalWorktreePath: '/repo/.worktrees/merge-source',
                },
            }],
        }],
    });

    assert.match(html, /data-group-id="merge-source"[\s\S]*?data-can-merge="true"/,
        'eligible groups pass merge availability to their actions menu trigger');
    assert.match(html, /data-action="ai-session-worktree-menu"/,
        'the row keeps its unified actions menu trigger');
    assert.doesNotMatch(html, /class="ai-session-worktree-merge"/,
        'merge is not rendered as a standalone row button');
});

test('WORKTREE-GROUPS-UI-001 moves group repository names into the header tooltip', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'repository-tooltip-coverage',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        activeAiSessionTab: 'chats',
        codexSessions: [], kimiSessions: [], claudeSessions: [], activeAiSessions: [],
        worktreeGroups: [{
            kind: 'group', groupId: 'repository-tooltip-group', displayName: 'fix-login', revision: 1,
            activity: 'idle', sessions: [],
            chips: [{ label: 'alpha', title: 'alpha' }, { label: 'beta', title: 'beta' }],
            hasDetachedMembers: false, needsPrimarySelection: false, canCreateSession: true,
            mergeCandidateGroupIds: [],
            members: [{
                memberId: 'member-1', repositoryKey: '/repo/.git', repositoryLabel: 'alpha',
                branchName: 'fix-login', path: '/repo/.worktrees/fix-login',
                status: 'ready', isPrimary: true,
                worktreeKey: {
                    repositoryKey: '/repo/.git',
                    canonicalWorktreePath: '/repo/.worktrees/fix-login',
                },
            }],
        }],
    });

    assert.match(html, /data-tooltip="Repositories:\nalpha\nbeta"/,
        'the group header tooltip provides every repository name');
    assert.match(html, /aria-label="fix-login, 0 sessions, idle, repositories: alpha, beta"/,
        'the same names remain accessible without hover');
    assert.doesNotMatch(html, /ai-session-repo-chip/,
        'repository chips no longer occupy the single-line header');
});

test('WORKTREE-GROUPING-UI-001 renders the host-persisted view tab without a restore flip', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'view-state-memory',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        codexSessions: [], kimiSessions: [], claudeSessions: [], activeAiSessions: [],
        worktrees: [],
        windowViewState: { tab: 'all', chatsViewMode: 'tree' },
    });
    assert.match(html, /data-selected-ai-session-tab="all"/,
        'authoritative HTML must carry the selected tab so replacements never flip it');
    assert.match(html, /data-ai-session-tab="all"[^>]*aria-selected="true"/);
    assert.match(html, /data-ai-session-panel="chats"[^>]*hidden/);
    assert.match(html, /data-ai-session-panel="all"(?![^>]*hidden)/);
});

test('WORKTREE-GROUPING-UI-001 renders a persisted recency-sorted CHATS list with branch chips', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'view-state-list',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        codexSessions: [], kimiSessions: [], claudeSessions: [],
        windowViewState: { tab: 'chats', chatsViewMode: 'list' },
        worktrees: [{
            kind: 'ready', activity: 'active', sessions: [], authority: {},
            git: {
                key: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/.worktrees/fix-login' },
                branchRef: 'refs/heads/agent-pivot/fix-login', head: 'abc12345',
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            },
        }],
        activeAiSessions: [
            {
                key: 'codex:older', provider: 'codex', sessionId: 'older', name: 'Older',
                executionState: 'running', focused: false, needsAttention: false, pending: false,
                backend: 'vscode', attached: true, updatedAt: '2026-07-20T00:00:00.000Z',
            },
            {
                key: 'codex:newer', provider: 'codex', sessionId: 'newer', name: 'Newer',
                executionState: 'running', focused: false, needsAttention: false, pending: false,
                backend: 'vscode', attached: true, updatedAt: '2026-07-22T00:00:00.000Z',
                worktreeKey: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/.worktrees/fix-login' },
            },
        ],
    });
    assert.match(html, /data-chats-view-mode="list"/);
    assert.match(html, /ai-session-chats-list-panel/);
    assert.ok(html.indexOf('Newer') < html.indexOf('Older'),
        'list mode orders active sessions by most recent activity');
    assert.match(html, /agent-pivot\/fix-login/);
    assert.match(html, />Current<\/span>/,
        'keyless active sessions keep an explicit Current chip');
    assert.match(html, /aria-checked="false"[^>]*data-view-mode="tree"/);
    assert.match(html, /aria-checked="true"[^>]*data-view-mode="list"/);
});

test('WORKTREE-GROUPING-UI-001 keeps Current as the create target when no worktrees exist', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'flat-default',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        codexSessions: [], kimiSessions: [], claudeSessions: [], activeAiSessions: [],
        worktrees: [],
    });
    assert.match(html, /data-selected-ai-session-tab="chats"/);
    assert.match(html, /data-ai-session-panel="chats"/);
    assert.match(html, /data-ai-session-panel="all"/);
    // Current remains available as the inline creation target even in an
    // otherwise empty non-Git workspace.
    assert.match(html, /ai-session-worktree-anchor/);
    assert.match(html, /data-action="create-ai-session-quick"/);
    assert.match(html, /data-action="open-ai-session-preset-menu"/);
    assert.match(html, /data-action="select-ai-session-tab" data-tab="all"/);
    assert.doesNotMatch(html, /data-ai-session-grouping-select/);
});

test('WORKTREE-PROVISIONING-UI-001 renders authoritative progress, retry, and cancel controls', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'provisioning-worktrees',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        activeAiSessionTab: 'sessions',
        codexSessions: [], kimiSessions: [], claudeSessions: [], activeAiSessions: [],
        worktrees: [{
            kind: 'provisioning', operationId: 'operation-active', repositoryKey: '/repo/.git',
            taskName: 'Fix <login>', proposedPath: '/repo/.agent-pivot/worktrees/fix-login',
            stage: 'creating', completedSteps: [], retryable: false, cancellable: true,
        }, {
            kind: 'provisioning', operationId: 'operation-failed', repositoryKey: '/repo/.git',
            taskName: 'Repair setup', proposedPath: '/repo/.agent-pivot/worktrees/repair-setup',
            stage: 'failed', completedSteps: ['worktree'], retryable: true,
            cancellable: false, errorCode: 'setup-failed',
        }],
        worktreeSnapshotRevision: 1,
        worktreeRepositoryCount: 1,
    });

    assert.doesNotMatch(html, /data-action="create-isolated-session"/,
        'no standalone New-worktree button: creation lives in the row menus');
    assert.match(html, /data-provisioning-operation-id="operation-active"/);
    assert.match(html, /Creating worktree/);
    assert.match(html, /Fix &lt;login&gt;/);
    assert.match(html, /data-action="cancel-isolated-session" data-operation-id="operation-active"/);
    assert.match(html, /data-action="retry-isolated-session" data-operation-id="operation-failed"/);
    assert.match(html, /data-action="dismiss-isolated-session" data-operation-id="operation-failed"/,
        'a failed row always offers dismiss');
    assert.match(html, /the setup command failed/,
        'the row explains the failure in plain language');
});

test('WORKTREE-GROUPING-UI-001 renders distinct no-repository and bare-repository empty states', () => {
    const base = {
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        codexSessions: [], kimiSessions: [], claudeSessions: [], activeAiSessions: [],
        worktreeSnapshotRevision: 1,
    };
    const noRepository = webviewModules.content.getAiSessionsDiv({
        ...base,
        id: 'no-repository',
        worktrees: [],
        worktreeRepositoryCount: 0,
        bareWorktreeCount: 0,
    });
    assert.match(noRepository, /No git repository found in this workspace\./);

    const bareRepository = webviewModules.content.getAiSessionsDiv({
        ...base,
        id: 'bare-repository',
        worktreeRepositoryCount: 1,
        bareWorktreeCount: 1,
        worktrees: [{
            kind: 'ready',
            git: {
                key: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo' },
                head: '', isMain: true, isBare: true, health: 'normal', headKind: 'unknown',
            },
            activity: 'idle', sessions: [], authority: {},
        }],
    });
    assert.match(bareRepository, /No linked worktrees/);
    assert.doesNotMatch(bareRepository, /data-worktree-repository-key=/);
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 renders one named availability summary alongside available provider rows', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'mixed-availability',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex', 'claude'],
        providers: [
            { id: 'codex', label: 'Codex', count: 1 },
            { id: 'kimi', label: 'Kimi', count: 0 },
            { id: 'claude', label: 'Claude', count: 0, unavailable: true },
        ],
        codexSessions: [{ id: 'codex-history', name: 'Codex history', provider: 'codex' }],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [],
    });

    assert.equal((html.match(/class="ai-session-availability-summary"/g) || []).length, 1);
    assert.match(
        html,
        /class="ai-session-availability-summary" role="status"[\s\S]*?Claude/
    );
    assert.match(html, /data-session-id="codex-history"/);
    assert.doesNotMatch(html, /ai-session-provider-section/);
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 renders one availability summary for an all-unavailable empty selection', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'all-unavailable',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex', 'claude'],
        providers: [
            { id: 'codex', label: 'Codex', count: 0, unavailable: true },
            { id: 'kimi', label: 'Kimi', count: 0 },
            { id: 'claude', label: 'Claude', count: 0, unavailable: true },
        ],
        codexSessions: [],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [],
    });

    assert.equal((html.match(/class="ai-session-availability-summary"/g) || []).length, 1);
    assert.match(
        html,
        /class="ai-session-availability-summary" role="status"[\s\S]*?Codex[\s\S]*?Claude/
    );
    assert.match(html, /No selected AI sessions yet/);
    assert.equal(
        (html.match(/Selected AI session history is unavailable in this environment/g) || []).length,
        0
    );
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-MENU-001 keeps the generated provider-menu controller boundary exact', () => {
    assert.equal(generatedAiSessionControlsSource, aiSessionControlsSource);
    assert.match(aiSessionControlsSource, /function getSelectedAiSessionProviders\(projectDiv\)/);
    assert.match(aiSessionControlsSource, /function submitAiSessionProviderSelection\(projectDiv, providers\)/);
    assert.match(aiSessionControlsSource, /type: 'select-ai-session-providers'/);
    assert.match(aiSessionControlsSource, /function applyAiSessionProviderSelectionResult\(message\)/);
    assert.match(aiSessionControlsSource, /message\.type !== 'ai-session-provider-selection-result'/);
    assert.match(aiSessionControlsSource, /requestId: requestId/);
    assert.match(aiSessionControlsSource, /selectedProviders: providers/);
    assert.match(aiSessionControlsSource, /pendingAiSessionProviderSelectionProjectId/);
    assert.match(aiSessionControlsSource, /pendingAiSessionProviderSelectionRequestId/);
    assert.match(
        fs.readFileSync(path.join(root, 'src', 'dashboard', 'messageHandlers.ts'), 'utf8'),
        /e\.selectedProviders,\s*e\.requestId,\s*e\.version/
    );
    assert.doesNotMatch(projectSource, /type: 'select-ai-session-provider'/);
    assert.doesNotMatch(aiSessionControlsSource, /type: 'select-ai-session-provider'/);
});

test('ACTIVE-SESSION-CONVERSATION-OPEN-001 posts an open request for a focused active session in the generated controller', () => {
    assert.equal(generatedProjectSource, projectSource);
    assert.match(projectSource, /type: 'open-active-ai-session-conversation'/);
    assert.match(
        projectSource,
        /hasAttribute\('data-session-focused'\)[\s\S]{0,400}open-active-ai-session-conversation/
    );
    assert.doesNotMatch(
        projectSource,
        /toggleConversation|toggleActiveAiSessionConversation/
    );
    assert.doesNotMatch(
        projectSource,
        /request-ai-session-conversation-outline|cancel-ai-session-conversation/
    );
    assert.doesNotMatch(projectSource, /ai-session-conversation-outline-result/);
    assert.doesNotMatch(
        projectSource,
        /data-conversation-expanded|ai-session-conversation-marker/
    );
});

test('WEBVIEW-AI-PROMPT-ASSET-001 keeps the generated Prompt controller byte-identical to source', () => {
    assert.ok(fs.existsSync(generatedPromptPath), 'missing media/webviewPromptScripts.js');
    assert.equal(fs.readFileSync(generatedPromptPath, 'utf8'), promptSource);
    assert.equal(generatedPromptProtocolSource, promptProtocolSource);
});

test('WEBVIEW-WEBVIEW-CONTENT-001 keeps the generated Dashboard controller byte-identical to source', () => {
    assert.equal(generatedSkillPanelSource, skillPanelSource);
    assert.equal(generatedProjectsPanelSource, projectsPanelSource);
    assert.equal(generatedDashboardValidationSource, dashboardValidationSource);
    assert.equal(generatedDashboardSearchSource, dashboardSearchSource);
    assert.equal(generatedDashboardProjectsPanelSource, dashboardProjectsPanelSource);
    assert.equal(generatedDashboardAiPanelSource, dashboardAiPanelSource);
    assert.equal(generatedDashboardSource, dashboardSource);
});

test('ACTIVE-SESSION-ICON-ANIMATION-001 renders effects only for running Active Session rows', () => {
    const surface = {
        id: 'active-session-icons',
        activeAiSessionProvider: 'codex',
        activeAiSessionTab: 'active',
        codexSessions: [{ id: 'history', name: 'History', provider: 'codex' }],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [
            {
                key: 'codex:running', provider: 'codex', sessionId: 'running', name: 'Running',
                executionState: 'running', backend: 'vscode', attached: true,
            },
            {
                key: 'codex:starting', provider: 'codex', sessionId: 'starting', name: 'Starting',
                executionState: 'starting', backend: 'vscode', attached: true,
            },
            {
                key: 'codex:stopped', provider: 'codex', sessionId: 'stopped', name: 'Stopped',
                executionState: 'stopped', backend: 'vscode', attached: true,
            },
        ],
    };
    const getRow = (html, sessionId) => html.match(new RegExp(
        `<div class="codex-session-row active-ai-session-row"[^>]*data-session-id="${sessionId}"[^>]*>`
    ))[0];

    const custom = webviewModules.content.getAiSessionsDiv(surface, {
        runningIconAnimation: 'custom',
    });
    assert.match(getRow(custom, 'running'), /data-session-icon-fx="custom"/);
    assert.doesNotMatch(getRow(custom, 'starting'), /data-session-icon-fx/);
    assert.doesNotMatch(getRow(custom, 'stopped'), /data-session-icon-fx/);
    const historyRow = custom.match(/<div class="codex-session-row"[^>]*data-session-id="history"[^>]*>/)[0];
    assert.doesNotMatch(historyRow, /data-session-icon-fx|active-ai-session-row/);

    const invalid = webviewModules.content.getAiSessionsDiv(surface, {
        runningIconAnimation: 'invalid',
    });
    assert.match(getRow(invalid, 'running'), /data-session-icon-fx="current"/);
    const none = webviewModules.content.getAiSessionsDiv(surface, {
        runningIconAnimation: 'none',
    });
    assert.match(getRow(none, 'running'), /data-session-icon-fx="none"/);
});

test('CUSTOM-RUNNING-IMAGE-001 full render injects user artwork as CSS variables', () => {
    const os = require('node:os');
    const {
        clearRunningAnimationImageCache,
    } = require('../../../out/webview/runningAnimationImages');
    clearRunningAnimationImageCache();
    const tinySvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>';
    const imagePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'custom-fx-')), 'mark.svg');
    fs.writeFileSync(imagePath, tinySvg);
    const expectedDataUri = `data:image/svg+xml;base64,${Buffer.from(tinySvg).toString('base64')}`;

    const renderWith = configValues => webviewModules.content.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test', asWebviewUri: uri => uri.toString() },
        [{ id: 'saved', groupName: 'Saved', projects: [{ id: 'hidden', name: 'Hidden', path: '/hidden' }] }],
        {
            config: {
                get: (key, fallback) => Object.prototype.hasOwnProperty.call(configValues, key)
                    ? configValues[key]
                    : fallback,
            },
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
        },
        true,
        [makeWorkspaceCard({
            aiSessions: {
                activeProvider: 'codex', expanded: true, sessionsByProvider: { codex: [] },
                activeSessions: [{
                    key: 'codex:full-render', provider: 'codex', sessionId: 'full-render', name: 'Full render',
                    executionState: 'running', backend: 'vscode', attached: true,
                }],
            },
        })],
        'ready',
    );

    const customHtml = renderWith({
        aiSessionRunningCardAnimation: 'custom',
        aiSessionRunningCardCustomImage: imagePath,
        aiSessionRunningIconAnimation: 'custom',
        aiSessionRunningIconCustomImage: imagePath,
    });
    assert.match(customHtml, /data-session-fx="custom"/,
        'a running workspace card must use the custom effect when the image resolves');
    assert.match(customHtml, /data-session-icon-fx="custom"/,
        'a running Active Session row must use the custom effect when the image resolves');
    assert.ok(customHtml.includes(`--agent-pivot-running-card-image: url("${expectedDataUri}")`),
        'the card image must be injected as a data URI CSS variable');
    assert.ok(customHtml.includes(`--agent-pivot-running-icon-image: url("${expectedDataUri}")`),
        'the icon image must be injected as a data URI CSS variable');

    const fallbackHtml = renderWith({
        aiSessionRunningCardAnimation: 'custom',
        aiSessionRunningCardCustomImage: '/definitely/missing.svg',
        aiSessionRunningIconAnimation: 'custom',
        aiSessionRunningIconCustomImage: '',
    });
    assert.match(fallbackHtml, /data-session-fx="current"/,
        'custom without a readable image must fall back to the current animation');
    assert.ok(!fallbackHtml.includes('--agent-pivot-running-card-image'),
        'no image variable may be emitted when the image cannot be resolved');
    assert.ok(!fallbackHtml.includes('data-session-icon-fx="custom"'),
        'custom without a readable icon image must fall back to the current animation');
});

test('ACTIVE-SESSION-FULL-RENDER-TRANSACTION-001 embeds a safe complete presentation in the full document', () => {
    const presentation = {
        type: 'ai-session-presentation-state',
        version: 1,
        projectionRevision: 9,
        workspaceScopeIdentity: 'scope:full-render',
        workspaceNavigationIdentity: 'navigation:full-render',
        attentionCount: 1,
        activeAttentionCount: 1,
        runningSessionCount: 0,
        runningCardAnimation: 'current',
        runningIconAnimation: 'current',
        revealFocused: false,
        focusedTarget: { provider: 'codex', sessionId: 'full-render' },
        attentionSessions: [{
            sessionKey: 'codex:full-render',
            eventIds: ['event-a', 'event</script><script>hostile'],
        }],
        sessions: [{
            provider: 'codex',
            sessionId: 'full-render',
            executionState: 'stopped',
            focused: true,
            needsAttention: true,
            conflict: false,
            eventIds: ['event-a', 'event</script><script>hostile'],
        }],
    };
    const html = webviewModules.content.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test', asWebviewUri: uri => uri.toString() },
        [],
        {
            config: { get: (_key, fallback) => fallback },
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
        },
        true,
        [],
        'ready',
        3,
        presentation,
    );

    assert.match(
        html,
        /<script id="dashboard-ai-session-presentation" type="application\/json">/
    );
    assert.match(html, /"projectionRevision":9/);
    assert.match(html, /event\\u003c\/script\\u003e\\u003cscript\\u003ehostile/);
    assert.doesNotMatch(html, /event<\/script><script>hostile/);
});

test('RUNTIME-TMUX-WEBVIEW-EXPERIENCE-001 renders semantic tmux, direct, stale, attached, and conflict controls', () => {
    const base = {
        id: 'p', name: 'App', path: '/work/app', activeAiSessionTab: 'active',
        codexSessions: [{ id: 's1', name: 'One', active: true }], kimiSessions: [], claudeSessions: [],
    };
    const runtime = {
        key: 'codex:s1', provider: 'codex', sessionId: 's1', name: 'One', executionState: 'running',
        status: 'running', focused: false, needsAttention: false, pending: false,
        backend: 'tmux', tmuxLayout: 'project', attached: false, stale: true,
    };
    const tmuxRow = webviewModules.content.getAiSessionsDiv({ ...base, activeAiSessions: [runtime] });
    assert.match(tmuxRow, /data-session-backend="tmux"/);
    assert.match(tmuxRow, /data-tmux-layout="project"/);
    assert.match(tmuxRow, /data-session-attached="false"/);
    assert.match(tmuxRow, /data-action="open-ai-session-context-menu"/);
    assert.match(tmuxRow, /Managed tmux runtime/);
    assert.doesNotMatch(tmuxRow, /data-action="detach-ai-session-terminal"/);
    assert.doesNotMatch(tmuxRow, /data-action="stop-ai-session-runtime"/);
    assert.match(tmuxRow, /Runtime status is stale/);

    const directRow = webviewModules.content.getAiSessionsDiv({ ...base, activeAiSessions: [{
        ...runtime, backend: 'vscode', tmuxLayout: undefined, attached: true, stale: false,
    }] });
    assert.match(directRow, /data-action="open-ai-session-context-menu"/);
    assert.match(directRow, /Direct VS Code terminal/);
    assert.doesNotMatch(directRow, /data-action="close-ai-session-terminal"/);
    assert.doesNotMatch(directRow, /data-action="detach-ai-session-terminal"/);

    const conflictRow = webviewModules.content.getAiSessionsDiv({ ...base, activeAiSessions: [{
        ...runtime, status: 'conflict', conflict: true, stale: false,
    }] });
    assert.match(conflictRow, /Runtime conflict/);
    assert.doesNotMatch(conflictRow, /data-action="(?:close|detach)-ai-session-terminal"/);
    assert.doesNotMatch(conflictRow, /data-action="stop-ai-session-runtime"/);
});

test('WEBVIEW-FAVORITE-RENDERING-001 renders favorites in explicit order before saved groups', () => {
    const html = webviewModules.content.getProjectsPanelContent([{
        id: 'group', groupName: 'Work', collapsed: false,
        projects: [
            { id: 'favorite-a', name: 'A', path: '/a', favorite: true, favoriteOrder: 1 },
            { id: 'favorite-b', name: 'B', path: '/b', favorite: true, favoriteOrder: 0 },
            { id: 'plain', name: 'Plain', path: '/plain' },
        ],
    }], {
        config: { get: (_key, fallback) => fallback },
        otherStorageHasData: false,
    });
    const ids = Array.from(html.matchAll(/<div class="[^"]*project steward-item-card[^"]*"[^>]*data-id="([^"]+)"/g))
        .map(match => match[1]);
    assert.deepEqual(ids, ['favorite-b', 'favorite-a', 'favorite-a', 'favorite-b', 'plain']);
});

test('WEBVIEW-RESOURCE-RECOVERY-001 gives every rendered document fresh versioned asset URLs', () => {
    const render = () => webviewModules.content.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test', asWebviewUri: uri => uri.toString() },
        [],
        {
            config: { get: (_key, fallback) => fallback },
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: true },
            otherStorageHasData: false,
        },
        true,
    );
    const first = render();
    const second = render();
    const freshModules = loadWebviewModules({ fresh: true });
    const afterReactivation = freshModules.content.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test', asWebviewUri: uri => uri.toString() },
        [],
        {
            config: { get: (_key, fallback) => fallback },
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: true },
            otherStorageHasData: false,
        },
        true,
    );
    const revisionPattern = /file:\/\/\/extension\/media\/styles\.css\?stewardAssetRevision=([a-z0-9]+-\d+)/;
    const firstRevision = first.match(revisionPattern);
    const secondRevision = second.match(revisionPattern);
    const reactivatedRevision = afterReactivation.match(revisionPattern);

    assert.ok(firstRevision, 'stylesheet URL must carry a document-scoped asset revision');
    assert.ok(secondRevision, 'refreshed stylesheet URL must carry an asset revision');
    assert.ok(reactivatedRevision, 'reactivated stylesheet URL must carry an asset revision');
    assert.notEqual(firstRevision[1], secondRevision[1],
        'a refreshed document must not reuse a possibly failed cached asset URL');
    assert.notEqual(firstRevision[1], reactivatedRevision[1],
        'a new extension activation must not restart asset URLs at a cached revision');
    for (const asset of ['webviewDashboardBundle.js']) {
        assert.match(first, new RegExp(
            `file:\\/\\/\\/extension\\/media\\/${asset.replace(/\./g, '\\.')}\\?stewardAssetRevision=${firstRevision[1]}`
        ), `${asset} must share the document asset revision`);
    }
});

test('WEBVIEW-SINGLE-BOOT-ASSET-001 loads dashboard startup code through one versioned request', () => {
    const html = webviewModules.content.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test', asWebviewUri: uri => uri.toString() },
        [],
        {
            config: { get: (_key, fallback) => fallback },
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: true },
            otherStorageHasData: false,
        },
        true,
    );
    const externalScripts = Array.from(html.matchAll(/<script src="([^"]+)"><\/script>/g));

    assert.equal(externalScripts.length, 1,
        'remote Webviews must not serialize startup behind many cache-busted resource requests');
    assert.match(externalScripts[0][1],
        /\/media\/webviewDashboardBundle\.js\?stewardAssetRevision=/);
});

test('WEBVIEW-AI-DASHBOARD-001 restores AI and lazily mounts one correlated authoritative panel', () => {
    const harness = createDashboardHarness({ initialTab: 'ai' });
    const aiRequests = harness.messages.filter(message => message.type === 'request-ai-panel');
    assert.equal(aiRequests.length, 1);
    const aiRequest = aiRequests[0];
    assert.equal(aiRequest.type, 'request-ai-panel');
    assert.equal(aiRequest.version, 1);
    assert.equal(typeof aiRequest.requestId, 'string');
    assert.ok(aiRequest.requestId.length > 0);
    assert.equal(aiRequest.target, 'global-prompt-library');
    assert.equal(harness.controller.getActiveTab(), 'ai');
    assert.equal(harness.storage.get('agentPivot.activeDashboardTab'), 'ai');
    assert.equal(harness.controller.getAiState(), 'loading');
    assert.equal(harness.collapseButton.disabled, true);

    const content = {
        type: 'ai-panel-content',
        version: 1,
        authoritySequence: 1,
        requestId: aiRequest.requestId,
        target: 'global-prompt-library',
        snapshot: makePromptSnapshot(),
        html: makeAiPanelHtml(0),
    };
    assert.equal(harness.controller.applyAiPanelMessage({
        ...content,
        requestId: `${aiRequest.requestId}-stale`,
    }), false);
    assert.equal(harness.controller.applyAiPanelMessage({
        ...content,
        target: 'another-library',
    }), false);
    assert.equal(harness.controller.applyAiPanelMessage({
        ...content,
        snapshot: { ...content.snapshot, revision: -1 },
    }), false);
    assert.equal(harness.aiPanel.innerHTML, '');
    assert.deepEqual(harness.promptMounts, []);

    assert.equal(harness.controller.applyAiPanelMessage(content), true);
    assert.equal(harness.aiPanel.innerHTML, content.html);
    assert.equal(harness.controller.getAiState(), 'mounted');
    assert.equal(harness.promptMounts.length, 1);
    assert.equal(harness.promptMounts[0].root, harness.aiPanel);
    assert.equal(harness.promptMounts[0].html, content.html);
    assert.equal(harness.promptMounts[0].message.authoritySequence, 1);
    assert.deepEqual(toPlain(harness.promptMounts[0].message.snapshot), content.snapshot);

    harness.controller.activateTab('open');
    harness.controller.activateTab('ai');
    assert.equal(harness.messages.filter(message => message.type === 'request-ai-panel').length, 1);
});

test('WEBVIEW-AI-DASHBOARD-001 supports mouse and roving Arrow/Home/End top-level tab navigation', () => {
    const harness = createDashboardHarness();
    let prevented = 0;

    harness.aiButton.dispatch('click');
    assert.equal(harness.controller.getActiveTab(), 'ai');
    assert.equal(harness.collapseButton.disabled, true);

    harness.openButton.dispatch('keydown', {
        key: 'ArrowLeft',
        preventDefault: () => { prevented += 1; },
    });
    assert.equal(harness.aiButton.classList.contains('focused'), false);
    harness.aiButton.focus = () => harness.aiButton.classList.add('focused');
    harness.openButton.dispatch('keydown', {
        key: 'ArrowLeft',
        preventDefault: () => { prevented += 1; },
    });
    assert.equal(harness.aiButton.classList.contains('focused'), true);

    harness.openButton.focus = () => harness.openButton.classList.add('focused');
    harness.projectsButton.dispatch('keydown', {
        key: 'Home',
        preventDefault: () => { prevented += 1; },
    });
    assert.equal(harness.openButton.classList.contains('focused'), true);

    harness.aiButton.classList.remove('focused');
    harness.projectsButton.dispatch('keydown', {
        key: 'End',
        preventDefault: () => { prevented += 1; },
    });
    assert.equal(harness.aiButton.classList.contains('focused'), true);
    assert.equal(prevented, 4);
    assert.equal(harness.context.getAdjacentDashboardTab('projects', 'ArrowRight'), 'ai');
    assert.equal(harness.context.getAdjacentDashboardTab('ai', 'ArrowRight'), 'open');
    assert.equal(harness.context.getAdjacentDashboardTab('projects', 'Home'), 'open');
    assert.equal(harness.context.getAdjacentDashboardTab('projects', 'End'), 'ai');
});

test('WEBVIEW-AI-DASHBOARD-001 keeps AI retryable when coherent Prompt mounting fails', async t => {
    const cases = [
        ['missing controller', makeAiPanelHtml(0), null, 0],
        ['mount returns false', makeAiPanelHtml(0), () => false, 1],
        ['missing surface', '<div data-ai-panel></div>', () => true, 0],
        ['duplicate surfaces', makeAiPanelHtml(0, 2), () => true, 0],
        ['mismatched surface revision', makeAiPanelHtml(1), () => true, 0],
    ];

    for (const [name, html, mount, expectedMounts] of cases) {
        await t.test(name, () => {
            const harness = createDashboardHarness({ initialTab: 'ai' });
            const request = harness.messages[0];
            let mountCalls = 0;
            harness.context.window.__agentPivotPrompts = mount === null
                ? undefined
                : {
                    mount(root, message) {
                        mountCalls += 1;
                        return mount(root, message);
                    },
                };

            assert.equal(harness.controller.applyAiPanelMessage({
                type: 'ai-panel-content',
                version: 1,
                authoritySequence: 1,
                requestId: request.requestId,
                target: 'global-prompt-library',
                snapshot: makePromptSnapshot(),
                html,
            }), false);
            assert.equal(mountCalls, expectedMounts);
            assert.equal(harness.controller.getAiState(), 'unloaded');
            assert.match(harness.aiLoading.textContent, /temporarily unavailable/i);
            assert.equal(harness.aiLoading.hidden, false);
            assert.equal(harness.runNextTimer(), false, 'failed mount must cancel its recovery timer');

            harness.controller.activateTab('ai');
            assert.equal(harness.messages.length, 2);
            assert.notEqual(harness.messages[1].requestId, request.requestId);
        });
    }
});

test('WEBVIEW-AI-DASHBOARD-001 installs one revision-matched Prompt surface before marking AI mounted', () => {
    const harness = createDashboardHarness({ initialTab: 'ai' });
    const request = harness.messages[0];
    const html = makeAiPanelHtml(0);
    let observed = null;
    harness.context.window.__agentPivotPrompts = {
        mount(root, message) {
            observed = {
                html: root.innerHTML,
                state: harness.controller.getAiState(),
                authoritySequence: message.authoritySequence,
            };
            return true;
        },
    };

    assert.equal(harness.controller.applyAiPanelMessage({
        type: 'ai-panel-content',
        version: 1,
        authoritySequence: 1,
        requestId: request.requestId,
        target: 'global-prompt-library',
        snapshot: makePromptSnapshot(),
        html,
    }), true);
    assert.deepEqual(observed, {
        html,
        state: 'loading',
        authoritySequence: 1,
    });
    assert.equal(harness.controller.getAiState(), 'mounted');
    assert.equal(harness.runNextTimer(), false);
});

test('WEBVIEW-AI-DASHBOARD-001 queues only the newest Prompt refresh until lazy AI mount succeeds', () => {
    const harness = createDashboardHarness({ initialTab: 'ai' });
    const request = harness.messages[0];
    const refreshAt = authoritySequence => ({
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence,
        target: 'global-prompt-library',
        snapshot: makePromptSnapshot(authoritySequence),
        html: `<div data-prompt-surface data-prompt-revision="${authoritySequence}"></div>`,
    });
    const refresh2 = refreshAt(2);
    const refresh3 = refreshAt(3);

    harness.windowListeners.message({
        data: { ...refreshAt(99), target: 'another-library' },
    });
    harness.windowListeners.message({ data: refresh2 });
    harness.windowListeners.message({ data: refresh3 });
    harness.windowListeners.message({ data: refresh2 });
    assert.deepEqual(
        harness.promptRefreshes,
        [],
        'Prompt refreshes must wait until the Prompt controller has a mounted root'
    );

    assert.equal(harness.controller.applyAiPanelMessage({
        type: 'ai-panel-content',
        version: 1,
        authoritySequence: 1,
        requestId: request.requestId,
        target: 'global-prompt-library',
        snapshot: makePromptSnapshot(),
        html: makeAiPanelHtml(0),
    }), true);
    assert.equal(harness.controller.getAiState(), 'mounted');
    assert.equal(harness.promptMounts.length, 1);
    assert.equal(harness.promptMounts[0].message.authoritySequence, 1);
    assert.deepEqual(toPlain(harness.promptRefreshes), [refresh3]);
});

test('WEBVIEW-AI-DASHBOARD-001 retains a queued Prompt refresh across a failed mount retry', () => {
    const harness = createDashboardHarness({ initialTab: 'ai' });
    const firstRequest = harness.messages[0];
    const promptController = harness.context.window.__agentPivotPrompts;
    const refresh = {
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 3,
        target: 'global-prompt-library',
        snapshot: makePromptSnapshot(3),
        html: '<div data-prompt-surface data-prompt-revision="3"></div>',
    };
    harness.windowListeners.message({ data: refresh });
    harness.context.window.__agentPivotPrompts = {
        mount() {
            return false;
        },
    };

    assert.equal(harness.controller.applyAiPanelMessage({
        type: 'ai-panel-content',
        version: 1,
        authoritySequence: 1,
        requestId: firstRequest.requestId,
        target: 'global-prompt-library',
        snapshot: makePromptSnapshot(),
        html: makeAiPanelHtml(0),
    }), false);
    assert.deepEqual(harness.promptRefreshes, []);

    harness.controller.activateTab('ai');
    const retryRequest = harness.messages[1];
    harness.context.window.__agentPivotPrompts = promptController;
    assert.equal(harness.controller.applyAiPanelMessage({
        type: 'ai-panel-content',
        version: 1,
        authoritySequence: 2,
        requestId: retryRequest.requestId,
        target: 'global-prompt-library',
        snapshot: makePromptSnapshot(),
        html: makeAiPanelHtml(0),
    }), true);
    assert.deepEqual(toPlain(harness.promptRefreshes), [refresh]);
});

test('WEBVIEW-AI-DASHBOARD-001 receives select-dashboard-tab and delegates external Prompt refreshes while preserving the search catalog', () => {
    const harness = createDashboardHarness();
    harness.controller.replaceSearchCatalog(makeCatalog('prompt-refresh'));
    harness.controller.setSearchQuery('prompt-refresh');
    const searchBefore = JSON.stringify(toPlain(harness.searchResults.children));

    harness.windowListeners.message({
        data: {
            type: 'select-dashboard-tab',
            version: 1,
            tab: 'ai',
            aiSubtab: 'prompts',
        },
    });
    assert.equal(harness.controller.getActiveTab(), 'ai');
    assert.equal(harness.controller.isSearchActive(), false);
    const aiRequest = harness.messages.find(message => message.type === 'request-ai-panel');
    assert.ok(aiRequest);
    assert.equal(harness.controller.applyAiPanelMessage({
        type: 'ai-panel-content',
        version: 1,
        authoritySequence: 1,
        requestId: aiRequest.requestId,
        target: 'global-prompt-library',
        snapshot: makePromptSnapshot(),
        html: makeAiPanelHtml(0),
    }), true);
    assert.equal(harness.promptSubtabSelections, 1);

    harness.windowListeners.message({
        data: {
            type: 'select-dashboard-tab',
            version: 1,
            tab: 'ai',
            aiSubtab: 'prompts',
        },
    });
    assert.equal(harness.promptSubtabSelections, 2);

    const refresh = {
        type: 'prompt-panel-updated',
        version: 1,
        authoritySequence: 2,
        target: 'global-prompt-library',
        snapshot: makePromptSnapshot(1),
        html: '<div data-prompt-surface data-prompt-revision="1"></div>',
    };
    harness.windowListeners.message({ data: refresh });
    assert.deepEqual(toPlain(harness.promptRefreshes), [refresh]);

    harness.controller.setSearchQuery('prompt-refresh');
    assert.equal(JSON.stringify(toPlain(harness.searchResults.children)), searchBefore);
});

test('WORKTREE-QUICK-SWITCH-001 receives an exact host reveal request and activates OPEN', () => {
    const harness = createDashboardHarness({ initialTab: 'ai' });
    const reveals = [];
    harness.context.window.__agentPivotRevealWorkspaceWorktree = (...args) => reveals.push(args);
    harness.controller.setSearchQuery('topic');

    harness.windowListeners.message({ data: {
        type: 'reveal-workspace-worktree-requested',
        version: 1,
        navigationIdentity: 'navigation-1',
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo/topic',
    } });

    assert.equal(harness.controller.getActiveTab(), 'open');
    assert.equal(harness.controller.isSearchActive(), false);
    assert.deepEqual(toPlain(reveals), [[
        'navigation-1', '/repo/.git', '/repo/topic',
    ]]);

    harness.windowListeners.message({ data: {
        type: 'reveal-workspace-worktree-requested',
        version: 2,
        navigationIdentity: 'navigation-2',
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo/ignored',
    } });
    harness.windowListeners.message({ data: {
        type: 'reveal-workspace-worktree-requested',
        version: 1,
        navigationIdentity: 'navigation-3',
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo/extra-key',
        unexpected: true,
    } });
    assert.equal(reveals.length, 1);
});

test('WORKTREE-QUICK-SWITCH-001 reveals, expands, and persists the selected worktree group', () => {
    const harness = createProjectVm();
    const sectionAttributes = new Map();
    const section = {
        getAttribute: name => sectionAttributes.get(name) || null,
        setAttribute: (name, value) => sectionAttributes.set(name, String(value)),
    };
    const select = { value: 'flat' };
    const liveRegion = { textContent: '' };
    const listAttributes = new Set(['hidden']);
    const list = { toggleAttribute: (name, enabled) => enabled ? listAttributes.add(name) : listAttributes.delete(name) };
    const groupAttributes = new Set(['data-worktree-collapsed']);
    const group = {
        getAttribute: name => name === 'data-worktree-repository-key' ? '/repo/.git'
            : name === 'data-worktree-path' ? '/repo/topic' : null,
        hasAttribute: name => groupAttributes.has(name),
        toggleAttribute: (name, enabled) => enabled ? groupAttributes.add(name) : groupAttributes.delete(name),
        querySelector: selector => selector === '.ai-session-worktree-header' ? header
            : selector === '.ai-session-worktree-session-list' ? list : null,
    };
    const headerAttributes = new Map([['aria-expanded', 'false']]);
    let focused = false;
    const header = {
        closest: selector => selector === '.ai-session-worktree-group' ? group : null,
        getAttribute: name => headerAttributes.get(name) || null,
        setAttribute: (name, value) => headerAttributes.set(name, String(value)),
        removeAttribute: () => undefined,
        focus: () => { focused = true; },
        scrollIntoView: () => undefined,
        addEventListener: () => undefined,
    };
    const tab = {
        getAttribute: name => name === 'data-ai-session-tab' ? 'chats' : null,
        setAttribute: () => undefined,
    };
    const panel = {
        getAttribute: name => name === 'data-ai-session-panel' ? 'chats' : null,
        toggleAttribute: () => undefined,
    };
    const workspace = {
        getAttribute: name => name === 'data-workspace-navigation-identity' ? 'navigation-1'
            : name === 'data-id' ? 'workspace-1' : null,
        hasAttribute: name => name === 'data-codex-expanded',
        querySelector: selector => selector === '.codex-sessions' ? section
            : selector === '[data-ai-session-grouping-select]' ? select
                : selector === '[data-ai-session-live-region]' ? liveRegion : null,
        querySelectorAll: selector => selector === '[data-ai-session-tab]' ? [tab]
            : selector === '[data-ai-session-panel]' ? [panel]
                : selector === '.ai-session-worktree-group' ? [group]
                    : selector.includes('data-worktree-collapsed')
                        ? (groupAttributes.has('data-worktree-collapsed') ? [group] : [])
                        : selector.includes('.ai-session-worktree-group') ? [group] : [],
    };
    harness.context.document.querySelectorAll = selector =>
        selector === '[data-open-session-surface][data-workspace-navigation-identity]' ? [workspace] : [];

    assert.equal(harness.context.window.__agentPivotRevealWorkspaceWorktree(
        'navigation-1', '/repo/.git', '/repo/topic'
    ), true);
    assert.equal(sectionAttributes.get('data-selected-ai-session-tab'), 'chats',
        'revealing a worktree selects the CHATS tree tab');
    assert.equal(headerAttributes.get('aria-expanded'), 'true');
    assert.equal(groupAttributes.has('data-worktree-collapsed'), false);
    assert.equal(listAttributes.has('hidden'), false);
    assert.equal(focused, true);
    assert.equal(harness.getWebviewState().aiSessionTabs['workspace-1'], 'chats');
    assert.ok(harness.messages.some(message =>
        message.type === 'select-ai-session-view-tab'
        && message.projectId === 'workspace-1' && message.tab === 'chats'),
        'the reveal persists the tab selection for authoritative re-renders');
});

test('WEBVIEW-AI-DASHBOARD-001 retries AI with fresh opaque identities and unlocks later retries', () => {
    const harness = createDashboardHarness({ initialTab: 'ai' });
    const first = harness.messages[0];
    assert.equal(harness.runNextTimer(), true);
    const second = harness.messages[1];
    assert.equal(second.type, 'request-ai-panel');
    assert.notEqual(second.requestId, first.requestId);
    assert.equal(typeof second.requestId, 'string');

    assert.equal(harness.runNextTimer(), true);
    assert.equal(harness.controller.getAiState(), 'unloaded');
    assert.match(harness.aiLoading.textContent, /temporarily unavailable/i);

    harness.controller.activateTab('ai');
    const third = harness.messages[2];
    assert.equal(third.type, 'request-ai-panel');
    assert.notEqual(third.requestId, second.requestId);
    assert.equal(harness.controller.applyAiPanelMessage({
        type: 'ai-panel-content',
        version: 1,
        authoritySequence: 1,
        requestId: third.requestId,
        target: 'global-prompt-library',
        snapshot: makePromptSnapshot(),
        html: makeAiPanelHtml(0),
    }), true);
    assert.equal(harness.controller.getAiState(), 'mounted');
});

test('WEBVIEW-LAZY-PANEL-RECOVERY-001 retries one missing response and unlocks later tab retries', () => {
    for (const tab of ['projects']) {
        const harness = createDashboardHarness({ initialTab: tab });
        const requestType = `request-${tab}-panel`;
        const getState = harness.controller.getProjectsState;
        const applyMessage = harness.controller.applyProjectsPanelMessage;

        assert.deepEqual(toPlain(harness.messages), [{
            type: requestType,
            version: 1,
            requestId: 1,
        }]);
        assert.equal(getState(), 'loading');

        assert.equal(harness.runNextTimer(), true);
        assert.deepEqual(toPlain(harness.messages.at(-1)), {
            type: requestType,
            version: 1,
            requestId: 2,
        });
        assert.equal(getState(), 'loading');

        assert.equal(harness.runNextTimer(), true);
        assert.equal(getState(), 'unloaded');
        const loading = harness.projectsLoading;
        assert.match(loading.textContent, /temporarily unavailable/i);

        harness.controller.activateTab(tab);
        assert.deepEqual(toPlain(harness.messages.at(-1)), {
            type: requestType,
            version: 1,
            requestId: 3,
        });
        assert.equal(applyMessage({
            type: `${tab}-panel-content`,
            version: 1,
            requestId: 3,
            html: `<p>${tab}</p>`,
        }), true);
        assert.equal(getState(), 'mounted');
        assert.match(loading.textContent, /^Loading /);
    }
});

test('PROJECT-INCREMENTAL-REFRESH-001 replaces only Projects and rejects stale updates', () => {
    const harness = createDashboardHarness({ initialTab: 'projects' });
    assert.equal(harness.controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '<p>initial</p>',
    }), true);
    harness.openPanel.innerHTML = '<p>open-state</p>';
    harness.context.window.scrollY = 73;
    const openIdentity = harness.openPanel;

    assert.equal(harness.controller.applyProjectsPanelUpdatedMessage({
        type: 'projects-panel-updated',
        version: 1,
        sequence: 2,
        mode: 'replace',
        html: '<p>updated projects</p>',
        searchCatalog: makeCatalog('projects'),
        groupOrders: [],
        favoriteProjectIds: [],
    }), true);
    assert.equal(harness.projectsPanel.innerHTML, '<p>updated projects</p>');
    assert.equal(harness.openPanel, openIdentity);
    assert.equal(harness.openPanel.innerHTML, '<p>open-state</p>');
    assert.equal(harness.controller.getActiveTab(), 'projects');
    assert.equal(harness.context.window.scrollY, 73);

    assert.equal(harness.controller.applyProjectsPanelUpdatedMessage({
        type: 'projects-panel-updated',
        version: 1,
        sequence: 1,
        mode: 'replace',
        html: '<p>stale</p>',
        searchCatalog: makeCatalog('stale'),
        groupOrders: [],
        favoriteProjectIds: [],
    }), false);
    assert.equal(harness.projectsPanel.innerHTML, '<p>updated projects</p>');
});

test('PROJECT-INCREMENTAL-REFRESH-001 preserves matching drag DOM and replaces a mismatched order', () => {
    const harness = createDashboardHarness({ initialTab: 'projects' });
    assert.equal(harness.controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '<p>dragged</p>',
    }), true);
    const projects = ['project-b', 'project-a'].map(id => ({
        getAttribute: name => name === 'data-id' ? id : null,
    }));
    const favorites = ['project-a'].map(id => ({
        getAttribute: name => name === 'data-id' ? id : null,
    }));
    const group = {
        getAttribute: name => name === 'data-group-id' ? 'work' : null,
        querySelectorAll: selector => selector.includes('.project[data-id]') ? projects : [],
    };
    const favoritesGroup = {
        querySelectorAll: selector => selector === '.project[data-id]' ? favorites : [],
    };
    harness.projectsPanel.querySelectorAll = selector => (
        selector.includes('.groups-wrapper > .group') ? [group] : []
    );
    harness.projectsPanel.querySelector = selector => (
        selector === '.group[data-system-group="__favorites"]' ? favoritesGroup : null
    );

    assert.equal(harness.controller.applyProjectsPanelUpdatedMessage({
        type: 'projects-panel-updated',
        version: 1,
        sequence: 1,
        mode: 'preserve-order',
        html: '<p>authoritative</p>',
        searchCatalog: makeCatalog('matching'),
        groupOrders: [{ groupId: 'work', projectIds: ['project-b', 'project-a'] }],
        favoriteProjectIds: ['project-a'],
    }), true);
    assert.equal(harness.projectsPanel.innerHTML, '<p>dragged</p>');

    assert.equal(harness.controller.applyProjectsPanelUpdatedMessage({
        type: 'projects-panel-updated',
        version: 1,
        sequence: 2,
        mode: 'preserve-order',
        html: '<p>authoritative fallback</p>',
        searchCatalog: makeCatalog('mismatch'),
        groupOrders: [{ groupId: 'work', projectIds: ['project-a', 'project-b'] }],
        favoriteProjectIds: ['project-a'],
    }), true);
    assert.equal(harness.projectsPanel.innerHTML, '<p>authoritative fallback</p>');
});

test('WEBVIEW-PROJECTS-PANEL-SCROLL-001 captures semantic Projects state and ignores stale post-fit restoration', () => {
    assert.match(projectsPanelSource, /function getProjectScrollItemKey\(project\)/);
    assert.match(projectsPanelSource, /function captureProjectsPanelState\(panel\)/);
    assert.match(projectsPanelSource, /windowScrollY:\s*window\.scrollY/);
    assert.match(projectsPanelSource, /itemSelector:\s*'\.project\[data-id\]'/);
    assert.match(projectsPanelSource, /getKey:\s*getProjectScrollItemKey/);
    assert.match(projectsPanelSource, /focus\(\{ preventScroll: true \}\)/);
    assert.match(dashboardProjectsPanelSource, /projectsPanelReplacementGeneration/);
    assert.match(
        dashboardProjectsPanelSource,
        /replacementGeneration !== projectsPanelReplacementGeneration/
    );
});

test('WEBVIEW-DASHBOARD-UPDATE-MESSAGE-001 PROJECT-INCREMENTAL-REFRESH-001 ignores stale window messages without requesting a full refresh', () => {
    const harness = createDashboardHarness({ initialTab: 'projects' });
    harness.controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '<p>initial</p>',
    });
    const update = {
        type: 'projects-panel-updated',
        version: 1,
        sequence: 2,
        mode: 'replace',
        html: '<p>current</p>',
        searchCatalog: makeCatalog('current'),
        groupOrders: [],
        favoriteProjectIds: [],
    };
    harness.windowListeners.message({ data: update });
    harness.windowListeners.message({ data: { ...update, sequence: 1, html: '<p>stale</p>' } });

    assert.equal(harness.projectsPanel.innerHTML, '<p>current</p>');
    assert.deepEqual(toPlain(harness.messages.filter(
        message => message.type === 'request-full-refresh'
    )), []);
});

test('SESSION-CONTROLLER-001 validates lazy responses and preserves independent background-tab scroll state', () => {
    const harness = createDashboardHarness();
    assert.equal(harness.context.normalizeDashboardTab('unknown'), 'open');
    assert.equal(harness.context.getAdjacentDashboardTab('open', 'ArrowLeft'), 'ai');
    assert.equal(harness.context.getAdjacentDashboardTab('projects', 'ArrowRight'), 'ai');
    assert.equal(harness.context.validateProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '',
    }), true);
    assert.equal(harness.context.validateProjectsPanelMessage({
        type: 'projects-panel-content', version: 2, requestId: 1, html: '',
    }), false);
    harness.context.window.scrollY = 41;
    harness.controller.activateTab('projects');
    harness.context.window.scrollY = 9;
    harness.controller.activateTab('open');
    assert.equal(harness.controller.getScrollPosition('open'), 41);
    assert.equal(harness.controller.getScrollPosition('projects'), 9);
    assert.equal(harness.context.window.scrollY, 41);

    assert.equal(harness.controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 2, html: '<p>future</p>',
    }), false);
    assert.equal(harness.controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '<p>current</p>',
    }), true);
    assert.equal(harness.controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '<p>stale</p>',
    }), false);
    assert.equal(harness.projectsPanel.innerHTML, '<p>current</p>');

});

function createProjectVm({
    querySelector,
    querySelectorAll,
    activeElement,
    activeTab = 'open',
    source = projectVmSource,
} = {}) {
    const documentListeners = {};
    const windowListeners = {};
    const messages = [];
    const initializationEvents = [];
    const replacedCatalogs = [];
    let webviewState = { unrelated: 'preserved' };
    const context = {
        CSS: { escape: value => String(value) },
        Node: { TEXT_NODE: 3 },
        normalizeDashboardSearchCatalog: value => value
            && value.version === 3
            && Array.isArray(value.sessions)
            && Array.isArray(value.worktrees)
            && Array.isArray(value.openWorkspaces)
            && Array.isArray(value.savedProjects)
            && Array.isArray(value.todos)
            ? value
            : { version: 3, sessions: [], worktrees: [], openWorkspaces: [], savedProjects: [], todos: [] },
        document: {
            activeElement: activeElement || null,
            body: {
                classList: createClassList(),
                style: { setProperty: () => undefined },
            },
            addEventListener: (type, listener) => { documentListeners[type] = listener; },
            getElementById: () => null,
            createElement: () => ({
                className: '',
                setAttribute: () => undefined,
                remove: () => undefined,
            }),
            querySelector: selector => querySelector ? querySelector(selector) : null,
            querySelectorAll: selector => querySelectorAll ? querySelectorAll(selector) : [],
        },
        window: {
            innerWidth: 1024,
            innerHeight: 768,
            __agentPivotReadyDocumentGeneration: 7,
            addEventListener: (type, listener) => {
                windowListeners[type] = listener;
                initializationEvents.push(`listener:${type}`);
            },
            requestAnimationFrame: callback => callback(),
            setTimeout: callback => callback(),
            vscode: {
                postMessage: message => {
                    messages.push(message);
                    initializationEvents.push(`message:${message.type}`);
                },
                getState: () => webviewState,
                setState: state => { webviewState = state; },
            },
            __agentPivotDashboard: {
                replaceSearchCatalog: catalog => replacedCatalogs.push(catalog),
                getActiveTab: () => activeTab,
            },
        },
    };
    vm.runInNewContext(scrollStateSource, context);
    vm.runInNewContext(source, context);
    context.initProjects();
    const initialMessages = messages.map(message => ({ ...message }));
    messages.length = 0;
    return {
        context,
        documentListeners,
        windowListeners,
        messages,
        initialMessages,
        initializationEvents,
        replacedCatalogs,
        getWebviewState: () => webviewState,
    };
}

function createCrossProviderBatchProject() {
    const attributes = new Map([['data-id', 'workspace-a']]);
    const region = createElement();
    region.setAttribute('data-active-ai-session-provider', 'codex');
    region.setAttribute('data-selected-ai-session-providers', 'codex,claude');
    const manageButton = createElement();
    const count = { textContent: '' };
    const archiveButton = { disabled: false };
    const liveRegion = { textContent: '' };
    const createRow = (provider, sessionId, { pinned = false, active = false } = {}) => ({
        getAttribute: name => name === 'data-session-provider' ? provider
            : name === 'data-session-id' ? sessionId : null,
        hasAttribute: name => (name === 'data-session-pinned' && pinned)
            || (name === 'data-session-active' && active),
        toggleAttribute: () => undefined,
        querySelector: () => null,
    });
    let rows = [
        createRow('codex', 'same'),
        createRow('claude', 'same'),
        createRow('codex', 'pinned', { pinned: true }),
        createRow('claude', 'active', { active: true }),
    ];
    return {
        getAttribute: name => attributes.get(name) || null,
        hasAttribute: name => attributes.has(name),
        setAttribute: (name, value) => attributes.set(name, String(value)),
        removeAttribute: name => attributes.delete(name),
        toggleAttribute(name, enabled) {
            if (enabled) attributes.set(name, '');
            else attributes.delete(name);
        },
        querySelector(selector) {
            if (selector === '[data-ai-session-region]') return region;
            if (selector === '[data-action="manage-ai-sessions"]') return manageButton;
            if (selector === '.ai-session-batch-count') return count;
            if (selector === '[data-action="archive-selected-ai-sessions"]') return archiveButton;
            if (selector === '[data-ai-session-live-region]') return liveRegion;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '.ai-session-history-panel .codex-session-row[data-session-id]') return rows;
            if (selector === '.ai-session-batch-actions button') return [];
            return [];
        },
        replaceRows(nextRows) {
            rows = nextRows.map(item => createRow(
                item.provider,
                item.sessionId,
                { pinned: item.pinned, active: item.active }
            ));
        },
        liveRegion,
    };
}

function assertCrossProviderBatchScope(source = projectVmSource) {
    const project = createCrossProviderBatchProject();
    const harness = createProjectVm({
        source,
        querySelectorAll: selector =>
            selector === '[data-open-session-surface][data-current-workspace][data-id]' ? [project] : [],
    });
    const targetFor = action => ({
        closest(selector) {
            if (selector === '.project' || selector === '.project[data-id]') return project;
            if (selector === `[data-action="${action}"]`) return { getAttribute: () => action };
            if (action === 'manage-ai-sessions'
                && selector === '[data-action="manage-ai-sessions"][data-provider]') {
                return { getAttribute: name => name === 'data-provider' ? 'codex' : 'manage-ai-sessions' };
            }
            return null;
        },
    });

    harness.documentListeners.click({ button: 0, target: targetFor('manage-ai-sessions') });
    assert.equal(project.hasAttribute('data-ai-session-managing'), true);
    harness.documentListeners.click({ button: 0, target: targetFor('select-unpinned-ai-sessions') });
    assert.deepEqual(
        toPlain(harness.context.window.__agentPivotBatchAiSessions.snapshot().selectedItems),
        [
            { provider: 'codex', sessionId: 'same' },
            { provider: 'claude', sessionId: 'same' },
        ]
    );
    harness.documentListeners.click({ button: 0, target: targetFor('archive-selected-ai-sessions') });
    assert.deepEqual(toPlain(harness.messages), [{
        type: 'archive-ai-sessions',
        version: 1,
        requestId: 1,
        projectId: 'workspace-a',
        items: [
            { provider: 'codex', sessionId: 'same' },
            { provider: 'claude', sessionId: 'same' },
        ],
    }]);

    const manager = harness.context.window.__agentPivotBatchAiSessions;
    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 2,
        projectId: 'workspace-a',
        status: 'finished',
    } });
    assert.equal(manager.snapshot().pending, true);
    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        requestId: 1,
        projectId: 'workspace-a',
        status: 'finished',
    } });
    assert.equal(manager.snapshot().pending, true);
    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 1,
        projectId: 'workspace-b',
        status: 'finished',
    } });
    assert.equal(manager.snapshot().pending, true);
    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 1,
        projectId: 'workspace-a',
        status: 'unknown',
    } });
    assert.equal(manager.snapshot().pending, true);

    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 1,
        projectId: 'workspace-a',
        status: 'cancelled',
    } });
    assert.equal(manager.snapshot().pending, false);
    assert.equal(manager.snapshot().selectedItems.length, 2);

    manager.submit();
    assert.equal(harness.messages[1].requestId, 2);
    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 1,
        projectId: 'workspace-a',
        status: 'finished',
    } });
    assert.equal(manager.snapshot().pending, true);
    assert.equal(manager.snapshot().projectId, 'workspace-a');
    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 2,
        projectId: 'workspace-a',
        status: 'finished',
    } });
    assert.equal(manager.snapshot().projectId, null);
}

test('PERSIST-MULTI-PROVIDER-BATCH-ARCHIVE-001 WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-002 archives visible unpinned inactive rows across selected providers', () => {
    assertCrossProviderBatchScope();
    assert.throws(() => assertCrossProviderBatchScope(
        projectVmSource.replace(
            'return JSON.stringify([provider, sessionId]);',
            'return sessionId;'
        )
    ));
    assert.throws(() => assertCrossProviderBatchScope(
        projectVmSource.replace(
            "message.type !== 'ai-session-batch-archive-completed'\n            || message.version !== 1",
            "message.type !== 'ai-session-batch-archive-completed'"
        )
    ));
});

test('PERSIST-MULTI-PROVIDER-BATCH-ARCHIVE-001 announces bounded aggregate outcomes without exposing session IDs', () => {
    const project = createCrossProviderBatchProject();
    const harness = createProjectVm({
        querySelectorAll: selector =>
            selector === '[data-open-session-surface][data-current-workspace][data-id]' ? [project] : [],
    });
    const manager = harness.context.window.__agentPivotBatchAiSessions;

    manager.enter('workspace-a');
    manager.toggle('codex', 'codex-sensitive-id');
    manager.toggle('claude', 'claude-sensitive-id');
    manager.submit();
    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 1,
        projectId: 'workspace-a',
        status: 'finished',
        result: {
            archived: [{ provider: 'codex', sessionId: 'codex-sensitive-id' }],
            running: [],
            missing: [],
            rejected: [],
            rejectedCount: 0,
            failed: [{ provider: 'claude', sessionId: 'claude-sensitive-id' }],
            malformedCount: 0,
        },
    } });
    assert.equal(project.liveRegion.textContent, 'Archived 1 AI session; 1 session failed.');
    assert.equal(project.liveRegion.textContent.includes('sensitive-id'), false);
    assert.equal(manager.snapshot().projectId, null);

    manager.enter('workspace-a');
    manager.toggle('codex', 'same');
    manager.submit();
    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 2,
        projectId: 'workspace-a',
        status: 'finished',
        result: {
            archived: new Array(101).fill({ provider: 'codex', sessionId: 'same' }),
            running: [],
            missing: [],
            rejected: [],
            rejectedCount: 0,
            failed: [],
            malformedCount: 0,
        },
    } });
    assert.equal(
        project.liveRegion.textContent,
        'Archive completed, but its result summary was unavailable.'
    );
    assert.equal(manager.snapshot().projectId, null);

    manager.enter('workspace-a');
    manager.toggle('codex', 'same');
    manager.submit();
    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 3,
        projectId: 'workspace-a',
        status: 'cancelled',
    } });
    assert.equal(project.liveRegion.textContent, 'Archive cancelled. No sessions were archived.');
    assert.equal(manager.snapshot().projectId, 'workspace-a');
    assert.equal(manager.snapshot().selectedItems.length, 1);

    manager.submit();
    harness.windowListeners.message({ data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 4,
        projectId: 'workspace-a',
        status: 'rejected',
    } });
    assert.equal(
        project.liveRegion.textContent,
        'Archive request was rejected. No sessions were archived.'
    );
    assert.equal(manager.snapshot().projectId, 'workspace-a');
    assert.equal(manager.snapshot().selectedItems.length, 1);
});

function assertBatchSelectionReconcilesAuthoritativeRows(source = projectVmSource) {
    const project = createCrossProviderBatchProject();
    const harness = createProjectVm({
        source,
        querySelectorAll: selector =>
            selector === '[data-open-session-surface][data-current-workspace][data-id]' ? [project] : [],
    });
    const manager = harness.context.window.__agentPivotBatchAiSessions;
    manager.enter('workspace-a');
    manager.toggle('codex', 'same');
    manager.toggle('codex', 'pinned');
    manager.toggle('claude', 'same');

    project.replaceRows([
        { provider: 'codex', sessionId: 'pinned', pinned: true },
        { provider: 'claude', sessionId: 'same', active: true },
    ]);
    harness.context.applyWorkspaceUpdate = () => true;
    harness.windowListeners.message({ data: makeAiSessionsUpdatedMessage(1, {
        searchCatalog: makeCatalog('batch-first'),
    }) });
    assert.deepEqual(toPlain(manager.snapshot().selectedItems), [
        { provider: 'codex', sessionId: 'pinned' },
    ]);

    manager.toggle('claude', 'same');
    manager.toggle('codex', 'removed');
    project.replaceRows([
        { provider: 'codex', sessionId: 'pinned', pinned: true },
        { provider: 'claude', sessionId: 'same', active: true },
    ]);
    harness.context.applyWorkspaceUpdate = () => true;
    harness.windowListeners.message({ data: makeAiSessionsUpdatedMessage(2, {
        searchCatalog: makeCatalog('batch-second'),
    }) });
    assert.deepEqual(toPlain(manager.snapshot().selectedItems), [
        { provider: 'codex', sessionId: 'pinned' },
    ]);

    manager.submit();
    assert.deepEqual(toPlain(harness.messages[harness.messages.length - 1].items), [
        { provider: 'codex', sessionId: 'pinned' },
    ]);
}

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-002 reconciles batch selection after authoritative replacements', () => {
    assertBatchSelectionReconcilesAuthoritativeRows();
    assert.throws(() => assertBatchSelectionReconcilesAuthoritativeRows(
        projectVmSource.replace(
            "&& !row.hasAttribute('data-session-active')",
            ''
        )
    ));
    assert.throws(() => assertBatchSelectionReconcilesAuthoritativeRows(
        projectVmSource.replace(
            'batchAiSessionManager.reconcileVisible(projectDiv);',
            ''
        )
    ));
});

test('SESSION-CONTROLLER-001 preserves AI tab helpers, persisted state, and semantic list fallbacks', () => {
    const harness = createProjectVm();
    const context = harness.context;
    // M2 tab domain: CHATS (active set, tree view) / ALL; legacy values map.
    assert.equal(context.normalizeAiSessionTab('chats'), 'chats');
    assert.equal(context.normalizeAiSessionTab('all'), 'all');
    assert.equal(context.normalizeAiSessionTab('active'), 'chats');
    assert.equal(context.normalizeAiSessionTab('sessions'), 'all');
    assert.equal(context.normalizeAiSessionTab('invalid'), 'chats');
    assert.equal(context.getAdjacentAiSessionTab('chats', 'ArrowRight'), 'all');
    assert.equal(context.getAdjacentAiSessionTab('all', 'ArrowLeft'), 'chats');
    assert.equal(context.getAdjacentAiSessionTab('all', 'Home'), 'chats');
    assert.equal(context.getAdjacentAiSessionTab('chats', 'End'), 'all');

    context.writeAiSessionTabState(context.window.vscode, 'project-a', 'chats');
    context.writeAiSessionTabState(context.window.vscode, 'project-b', 'invalid');
    assert.deepEqual(toPlain(context.readAiSessionTabState(context.window.vscode)), {
        'project-a': 'chats', 'project-b': 'chats',
    });
    assert.equal(harness.getWebviewState().unrelated, 'preserved');

    const collapsedAttributes = new Set(['data-worktree-collapsed']);
    const collapseGroup = {
        getAttribute: name => name === 'data-worktree-repository-key' ? '/repo/.git'
            : name === 'data-worktree-path' ? '/repo/topic' : null,
        hasAttribute: name => collapsedAttributes.has(name),
    };
    const collapseProject = {
        getAttribute: name => name === 'data-id' ? 'project-a' : null,
        querySelectorAll: selector => selector.includes('data-worktree-collapsed')
            ? [collapseGroup] : [],
    };
    context.writeAiSessionWorktreeCollapseState(context.window.vscode, collapseProject);
    assert.deepEqual(toPlain(
        context.readAiSessionWorktreeCollapseState(context.window.vscode)
    ), {
        'project-a': ['["/repo/.git","/repo/topic",false]'],
    });
    assert.equal(harness.getWebviewState().unrelated, 'preserved');

    const chatsList = { scrollTop: 0, scrollHeight: 100, clientHeight: 40 };
    const historyList = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    const tab = id => {
        const attributes = new Map([['data-ai-session-tab', id]]);
        return {
            getAttribute: name => attributes.get(name) || null,
            setAttribute: (name, value) => attributes.set(name, String(value)),
            focus() {},
        };
    };
    const panel = (id, list) => {
        const attributes = new Map([['data-ai-session-panel', id]]);
        return {
            getAttribute: name => attributes.get(name) || null,
            toggleAttribute(name, force) {
                if (force) attributes.set(name, '');
                else attributes.delete(name);
                if (name === 'hidden') {
                    list.scrollHeight = force ? 0 : 100;
                    list.clientHeight = force ? 0 : 40;
                }
            },
            querySelector: () => null,
        };
    };
    const tabs = [tab('chats'), tab('all')];
    const panels = [panel('chats', chatsList), panel('all', historyList)];
    const project = {
        querySelector(selector) {
            if (selector === '.codex-sessions') return { setAttribute() {} };
            if (selector === '.ai-session-chats-panel .ai-session-worktree-list') return chatsList;
            if (selector === '.ai-session-history-panel .codex-sessions-list') return historyList;
            if (selector === '[data-ai-session-panel="chats"]') return panels[0];
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '[data-ai-session-tab]') return tabs;
            if (selector === '[data-ai-session-panel]') return panels;
            if (selector === '.codex-session-row') return [];
            return [];
        },
    };
    context.restoreAiSessionViewState(project, {
        chatsAnchor: { scrollTop: 17, itemKey: null, itemOffset: 0 },
        allAnchor: { scrollTop: 29, itemKey: null, itemOffset: 0 },
        restoreFocus: false,
    }, 'chats');
    assert.equal(chatsList.scrollTop, 17);
    assert.equal(historyList.scrollTop, 29);
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(tabs[1].getAttribute('aria-selected'), 'false');
});

test('WORKTREE-GROUPING-UI-001 moves keyboard focus among worktree headers', () => {
    const harness = createProjectVm();
    const focused = [];
    const panel = { querySelectorAll: () => headers };
    const headers = ['one', 'two', 'three'].map(name => ({
        name,
        closest: selector => selector === '[data-ai-session-panel]' ? panel
            : selector === '.ai-session-worktree-header' ? this : null,
        focus: () => focused.push(name),
    }));
    const eventFor = (header, key) => ({
        target: {
            closest: selector => selector === '.ai-session-worktree-header' ? header : null,
        },
        key,
        preventDefault: () => focused.push('prevented'),
    });

    harness.documentListeners.keydown(eventFor(headers[1], 'ArrowDown'));
    harness.documentListeners.keydown(eventFor(headers[0], 'ArrowUp'));
    harness.documentListeners.keydown(eventFor(headers[1], 'Home'));
    harness.documentListeners.keydown(eventFor(headers[1], 'End'));
    assert.deepEqual(focused, [
        'prevented', 'three',
        'prevented', 'three',
        'prevented', 'one',
        'prevented', 'three',
    ]);
});

test('OPEN-OPEN-PROJECT-INCREMENTAL-RENDERING-001 announces renderer readiness after installing the message listener', () => {
    const harness = createProjectVm();
    assert.deepEqual(toPlain(harness.initialMessages[0]), {
        type: 'open-workspaces-renderer-ready',
        version: 1,
        documentGeneration: 7,
    });
    assert.ok(
        harness.initializationEvents.indexOf('listener:message')
            < harness.initializationEvents.indexOf('message:open-workspaces-renderer-ready'),
        'the host handshake must not race ahead of the installed message listener',
    );
});

function assertCollapseButtonBehavior(context) {
    assert.deepEqual(toPlain(context.window.__agentPivotGetCollapseButtonState('open', [])), {
        disabled: true, collapsed: false, title: 'No open windows to collapse',
    });
    assert.equal(context.window.__agentPivotGetCollapseButtonState('open', [false]).title, 'Collapse Open Windows');
    assert.equal(context.window.__agentPivotGetCollapseButtonState('open', [true]).title, 'Expand Open Windows');
    assert.equal(context.window.__agentPivotGetCollapseButtonState('projects', [false, true]).title, 'Collapse All Groups');
    assert.deepEqual(toPlain(context.window.__agentPivotGetCollapseButtonState('ai', [false])), {
        disabled: true, collapsed: false, title: 'No groups to collapse in AI',
    });
}

test('WEBVIEW-GROUP-ACTIONS-001 keeps non-TODO group actions routed and persisted', () => {
    const harness = createProjectVm();
    const messages = harness.messages;
    messages.length = 0;
    const collapsed = createClassList();
    const group = {
        classList: collapsed,
        getAttribute(name) {
            return name === 'data-group-id' ? 'group-a' : null;
        },
    };
    const clickAction = action => harness.documentListeners.click({
        button: 0,
        target: {
            closest(selector) {
                if (selector === '.group') return group;
                if (selector === '[data-action]') {
                    return { getAttribute: () => action };
                }
                return null;
            },
        },
    });

    clickAction('add');
    clickAction('edit');
    clickAction('remove');
    clickAction('collapse');

    assert.deepEqual(toPlain(messages), [
        { type: 'add-project', groupId: 'group-a' },
        { type: 'edit-group', groupId: 'group-a', collapsed: false },
        { type: 'remove-group', groupId: 'group-a', collapsed: false },
        { type: 'collapse-group', groupId: 'group-a', collapsed: true },
    ]);
    assert.equal(collapsed.contains('collapsed'), true);
});

test('WEBVIEW-COLLAPSE-BUTTON-STATE-001 exposes disabled and exact action labels for each dashboard tab', () => {
    assertCollapseButtonBehavior(createProjectVm().context);
    const mutated = projectSource.replace('No open windows to collapse', 'Nothing to collapse');
    assert.throws(() => assertCollapseButtonBehavior(createProjectVm({ source: mutated }).context));
});

test('WEBVIEW-BATCH-AI-SESSION-WEBVIEW-001 rejects stale AI session update sequences', () => {
    const harness = createProjectVm();
    harness.context.applyWorkspaceUpdate = () => true;
    harness.windowListeners.message({ data: makeAiSessionsUpdatedMessage(2, {
        currentWorkspaceCount: 0,
        searchCatalog: makeCatalog('new'),
    }) });
    harness.windowListeners.message({ data: makeAiSessionsUpdatedMessage(1, {
        currentWorkspaceCount: 0,
        searchCatalog: makeCatalog('stale'),
    }) });

    assert.equal(harness.replacedCatalogs.length, 1);
    assert.deepEqual(harness.replacedCatalogs[0], makeCatalog('new'));
});

test('WEBVIEW-BATCH-AI-SESSION-WEBVIEW-001 requests full refresh when the workspace replacement is invalid', () => {
    const harness = createProjectVm();
    harness.context.applyWorkspaceUpdate = () => false;
    harness.windowListeners.message({ data: makeAiSessionsUpdatedMessage(1, {
        html: '<div class="invalid-workspace"></div>',
    }) });
    assert.deepEqual(toPlain(harness.messages), [{
        type: 'request-full-refresh', reason: 'invalid-ai-session-workspace-update',
    }]);
    assert.deepEqual(harness.replacedCatalogs, []);
});

test('WEBVIEW-BATCH-AI-SESSION-WEBVIEW-001 maps ctrl meta and middle-click project modifiers', () => {
    const project = {
        getAttribute: name => name === 'data-id' ? 'saved-project' : null,
        hasAttribute: () => false,
    };
    const target = {
        closest(selector) {
            return selector === '.project' || selector === '.project[data-id]' ? project : null;
        },
    };
    const harness = createProjectVm();
    harness.documentListeners.click({ button: 0, ctrlKey: true, metaKey: false, target });
    harness.documentListeners.click({ button: 0, ctrlKey: false, metaKey: true, target });
    harness.documentListeners.mousedown({ button: 1, ctrlKey: false, metaKey: false, target });

    assert.deepEqual(toPlain(harness.messages), [
        { type: 'selected-project', projectId: 'saved-project', projectOpenType: 3 },
        { type: 'selected-project', projectId: 'saved-project', projectOpenType: 3 },
        { type: 'selected-project', projectId: 'saved-project', projectOpenType: 1 },
    ]);
});

function createDndHarness({ projectContainers = [], groupElements = [] } = {}) {
    const drakes = [];
    const messages = [];
    const windowListeners = {};
    const context = {
        document: {
            body: { classList: createClassList() },
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        window: {
            addEventListener: (type, listener) => { windowListeners[type] = listener; },
            removeEventListener: () => undefined,
            vscode: { postMessage: message => messages.push(message) },
        },
        dragula(containers, options) {
            const handlers = {};
            const drake = {
                dragging: false,
                cancel: () => undefined,
                destroy: () => undefined,
                on(type, listener) {
                    handlers[type] = listener;
                    return drake;
                },
            };
            drakes.push({ containers, options, handlers, drake });
            return drake;
        },
        autoScroll: () => ({ destroy: () => undefined }),
    };
    vm.runInNewContext(dndSource, context);
    const rootElement = {
        querySelector: () => null,
        querySelectorAll(selector) {
            if (selector === '.group-list') return projectContainers;
            if (selector === '.groups-wrapper') return [{}];
            if (selector === '.groups-wrapper > [data-group-id]:not([data-virtual-group])') return groupElements;
            return [];
        },
    };
    return { context, rootElement, drakes, messages, windowListeners };
}

test('WEBVIEW-FAVORITE-DND-001 limits favorite drag to the same virtual container and posts exact order', () => {
    const favorites = {
        closest(selector) {
            if (selector === '[data-system-group="__favorites"]') return {};
            if (selector === '[data-virtual-group]') return {};
            return null;
        },
        querySelectorAll: () => [
            { getAttribute: () => 'favorite-b' },
            { getAttribute: () => 'favorite-a' },
        ],
    };
    const otherFavorites = { ...favorites };
    const ordinary = { closest: () => null };
    const draggable = { hasAttribute: () => false };
    const noDrag = { hasAttribute: name => name === 'data-nodrag' };
    const harness = createDndHarness({ projectContainers: [favorites, ordinary] });

    assert.equal(harness.context.canMoveProject(draggable, favorites), true);
    assert.equal(harness.context.canMoveProject(noDrag, favorites), false);
    assert.equal(harness.context.canAcceptProject(favorites, favorites), true);
    assert.equal(harness.context.canAcceptProject(otherFavorites, favorites), false);
    assert.equal(harness.context.canAcceptProject(ordinary, favorites), false);

    harness.context.initDnD(harness.rootElement);
    harness.context.initDnD(harness.rootElement);
    assert.equal(harness.rootElement.__agentPivotDnDInitialized, true);
    assert.equal(harness.drakes.length, 2);
    harness.drakes[0].handlers.drop({}, favorites, favorites);
    assert.deepEqual(toPlain(harness.messages), [{
        type: 'reordered-favorites', projectIds: ['favorite-b', 'favorite-a'],
    }]);
});

test('WORKTREE-GROUPS-UI-001 the anchor menu carries the main-checkout key only when unambiguous', () => {
    const base = {
        id: 'anchor-coverage',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        activeAiSessionTab: 'sessions',
        codexSessions: [], kimiSessions: [], claudeSessions: [], activeAiSessions: [],
        worktrees: [],
        worktreeSnapshotRevision: 1,
        worktreeRepositoryCount: 1,
    };
    const mainKey = { repositoryKey: '/repos/alpha/.git', canonicalWorktreePath: '/alpha/main' };
    const otherKey = { repositoryKey: '/repos/beta/.git', canonicalWorktreePath: '/beta/main' };
    const single = webviewModules.content.getAiSessionsDiv({
        ...base,
        worktreeAnchor: {
            entries: [{ repositoryLabel: 'alpha', branch: 'main' }],
            worktreeKeys: [mainKey],
            sessions: [],
            activity: 'idle',
        },
    });
    assert.match(single, /data-worktree-anchor="true"/);
    assert.match(single, /data-can-branch-create="true"/,
        'single-root anchors can seed New worktree from Current');
    assert.match(single, /data-worktree-repository-key="\/repos\/alpha\/\.git"/);
    const multi = webviewModules.content.getAiSessionsDiv({
        ...base,
        worktreeAnchor: {
            entries: [
                { repositoryLabel: 'alpha', branch: 'main' },
                { repositoryLabel: 'beta', branch: '1.0' },
            ],
            worktreeKeys: [mainKey, otherKey],
            sessions: [],
            activity: 'idle',
        },
    });
    assert.match(multi, /data-worktree-anchor="true"/);
    assert.match(multi, /data-can-branch-create="false"/,
        'multi-root anchors never guess a branch seed');
    assert.doesNotMatch(multi, /data-worktree-repository-key="\/repos\/alpha/,
        'no key leaks onto a multi-root anchor');
});
