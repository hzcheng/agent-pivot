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
const dashboardTodoPanelSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDashboardTodoPanelScripts.js'), 'utf8');
const generatedDashboardTodoPanelSource = fs.readFileSync(path.join(root, 'media', 'webviewDashboardTodoPanelScripts.js'), 'utf8');
const dashboardAiPanelSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDashboardAiPanelScripts.js'), 'utf8');
const generatedDashboardAiPanelSource = fs.readFileSync(path.join(root, 'media', 'webviewDashboardAiPanelScripts.js'), 'utf8');
const dashboardVmSource = `${skillPanelSource}\n${projectsPanelSource}\n${dashboardValidationSource}\n${dashboardSearchSource}\n${dashboardProjectsPanelSource}\n${dashboardTodoPanelSource}\n${dashboardAiPanelSource}\n${dashboardSource}`;
const projectSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectScripts.js'), 'utf8');
const generatedProjectSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectScripts.js'), 'utf8');
const viewStateSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewAiSessionViewStateScripts.js'), 'utf8');
const generatedViewStateSource = fs.readFileSync(path.join(root, 'media', 'webviewAiSessionViewStateScripts.js'), 'utf8');
const workspaceUpdateSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewWorkspaceUpdateScripts.js'), 'utf8');
const generatedWorkspaceUpdateSource = fs.readFileSync(path.join(root, 'media', 'webviewWorkspaceUpdateScripts.js'), 'utf8');
const todoGroupSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewTodoGroupScripts.js'), 'utf8');
const generatedTodoGroupSource = fs.readFileSync(path.join(root, 'media', 'webviewTodoGroupScripts.js'), 'utf8');
const projectCollapseSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectCollapseScripts.js'), 'utf8');
const generatedProjectCollapseSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectCollapseScripts.js'), 'utf8');
const todoControlSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewTodoControlScripts.js'), 'utf8');
const generatedTodoControlSource = fs.readFileSync(path.join(root, 'media', 'webviewTodoControlScripts.js'), 'utf8');
const projectContextMenuSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectContextMenuScripts.js'), 'utf8');
const generatedProjectContextMenuSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectContextMenuScripts.js'), 'utf8');
const projectAiUpdateSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectAiUpdateScripts.js'), 'utf8');
const generatedProjectAiUpdateSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectAiUpdateScripts.js'), 'utf8');
const aiSessionControlsSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewProjectAiSessionControlsScripts.js'), 'utf8');
const generatedAiSessionControlsSource = fs.readFileSync(path.join(root, 'media', 'webviewProjectAiSessionControlsScripts.js'), 'utf8');
const projectVmSource = `${viewStateSource}\n${workspaceUpdateSource}\n${todoGroupSource}\n${projectCollapseSource}\n${todoControlSource}\n${projectContextMenuSource}\n${projectAiUpdateSource}\n${aiSessionControlsSource}\n${projectSource}`;
const scrollStateSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewScrollStateScripts.js'), 'utf8');
const promptProtocolSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewPromptProtocolScripts.js'), 'utf8');
const generatedPromptProtocolSource = fs.readFileSync(path.join(root, 'media', 'webviewPromptProtocolScripts.js'), 'utf8');
const promptSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewPromptScripts.js'), 'utf8');
const generatedPromptPath = path.join(root, 'media', 'webviewPromptScripts.js');
const todoRenderSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewTodoRenderScripts.js'), 'utf8');
const generatedTodoRenderSource = fs.readFileSync(path.join(root, 'media', 'webviewTodoRenderScripts.js'), 'utf8');
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
        todos: [{
            key: `todo:t${suffix}`, todoId: `t${suffix}`, groupId: 'group-a',
            searchText: `ship todo ${suffix}`, title: 'Ship TODO', groupTitle: 'Planning',
            priority: 'high', completed: false, notesSearchText: 'Release notes',
        }],
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
    onTodoMounted,
    onTodoRefresh,
    onActiveTabChanged,
} = {}) {
    const openButton = createElement('dashboard-tab-open-button');
    openButton.setAttribute('data-dashboard-tab', 'open');
    const projectsButton = createElement('dashboard-tab-projects-button');
    projectsButton.setAttribute('data-dashboard-tab', 'projects');
    const todoButton = createElement('dashboard-tab-todo-button');
    todoButton.setAttribute('data-dashboard-tab', 'todo');
    const aiButton = createElement('dashboard-tab-ai-button');
    aiButton.setAttribute('data-dashboard-tab', 'ai');
    const openPanel = createElement('dashboard-tab-open');
    const projectsPanel = createElement('dashboard-tab-projects');
    const todoPanel = createElement('dashboard-tab-todo');
    const aiPanel = createElement('dashboard-panel-ai');
    const projectsLoading = createElement();
    const todoLoading = createElement();
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
    todoPanel.querySelector = selector => selector === '.dashboard-todo-loading'
        ? todoLoading
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
        'dashboard-tab-todo': todoPanel,
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
                ? [openButton, projectsButton, todoButton, aiButton]
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
        onTodoMounted,
        onTodoRefresh,
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
        todoButton,
        aiButton,
        openPanel,
        projectsPanel,
        todoPanel,
        aiPanel,
        projectsLoading,
        todoLoading,
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
    })], makeCatalog().todos);

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
    assert.deepEqual(catalog.todos, makeCatalog().todos);
});

test('TODO-TODO-SEARCH-RESULT-RENDERING-001 locks catalog v3 section order and actions', () => {
    const harness = createDashboardHarness();
    assert.deepEqual(toPlain(harness.context.normalizeDashboardSearchCatalog({
        ...makeCatalog(), version: 2,
    })), {
        version: 3, sessions: [], worktrees: [], openWorkspaces: [], savedProjects: [], todos: [],
    });
    const catalog = {
        version: 3,
        sessions: [{
            searchText: 'match',
            name: 'Session',
            provider: 'codex',
            sessionId: 'session',
            workspaceId: 'current',
            workspaceNavigationIdentity: 'navigation:current',
            workspaceName: 'Current',
        }],
        worktrees: [{
            searchText: 'match', name: 'feature/topic', workspaceId: 'current',
            workspaceNavigationIdentity: 'navigation:current', repositoryKey: '/repo/.git',
            canonicalWorktreePath: '/repo/topic', activity: 'idle', sessionCount: 1,
        }],
        openWorkspaces: [{
            searchText: 'match',
            name: 'Current',
            workspaceId: 'current',
            navigationIdentity: 'navigation:current',
            current: true,
        }, {
            searchText: 'match',
            name: 'Other',
            workspaceId: 'other',
            navigationIdentity: 'navigation:other',
            current: false,
        }],
        savedProjects: [{
            searchText: 'match',
            name: 'Saved',
            projectId: 'saved',
            groupLabels: ['WORK'],
        }],
        todos: [{
            searchText: 'match',
            title: 'TODO',
            todoId: 'todo',
            groupId: 'group',
            groupTitle: 'Planning',
            priority: 'high',
            completed: false,
        }],
    };
    const sections = harness.context.filterDashboardCatalog(catalog, 'match');
    assert.deepEqual(toPlain(sections.map(section => section.title)), [
        'AI SESSIONS',
        'WORKTREES',
        'OPEN WORKSPACES',
        'SAVED PROJECTS',
        'TODO RESULTS',
    ]);

    harness.context.renderDashboardSearchResults(harness.searchResults, sections);
    const actions = harness.searchResults.children.flatMap(section =>
        section.children.slice(1).map(result => result.dataset.searchAction)
    );
    assert.deepEqual(actions, [
        'reveal-workspace-session',
        'reveal-workspace-worktree',
        'show-current-workspace',
        'switch-open-workspace',
        'open-saved-project',
        'show-todo',
    ]);
});

test('WEBVIEW-DASHBOARD-UPDATE-MESSAGE-001 preserves TODO catalog entries in incremental messages', () => {
    const todoSearchItems = makeCatalog().todos;
    const cards = [makeWorkspaceCard()];
    const presentation = {
        type: 'ai-session-presentation-state', version: 1, projectionRevision: 1,
        workspaceScopeIdentity: null, workspaceNavigationIdentity: null,
        attentionCount: 0, activeAttentionCount: 0, runningSessionCount: 0,
        runningCardAnimation: 'current', runningIconAnimation: 'current',
        revealFocused: false, focusedTarget: null, attentionSessions: [], sessions: [],
    };
    const openMessage = webviewModules.updateMessages.buildOpenWorkspacesUpdatedMessage({
        groups: [], cards: [], collapsed: false,
        semanticRevision: 'revision', projectionRevision: 1,
        otherWindowsStatus: 'ready', todoSearchItems, presentation,
    });
    const sessionsMessage = webviewModules.updateMessages.buildAiSessionsUpdatedMessage({
        groups: [], cards: [], sequence: 7, generatedAt: NOW,
        cards, todoSearchItems,
        presentation: { ...presentation, projectionRevision: 7 },
    });
    assert.deepEqual(openMessage.searchCatalog.todos, todoSearchItems);
    assert.deepEqual(sessionsMessage.searchCatalog.todos, todoSearchItems);
});

test('WEBVIEW-WEBVIEW-OPTIONS-001 enables scripts and limits local resources to media', () => {
    const options = getDashboardWebviewOptions('/extension', value => ({ path: value }));
    assert.deepEqual(options, {
        enableScripts: true,
        localResourceRoots: [{ path: path.join('/extension', 'media') }],
    });
});

test('OPEN-ALL-WINDOWS-LIST-001 WEBVIEW-CURRENT-WORKSPACE-RENDERING-001 WEBVIEW-DISPLAY-001 keeps CURRENT WINDOW and duplicates its compact projection in OPEN WINDOWS', () => {
    const config = { get: (_key, fallback) => fallback };
    const html = webviewModules.content.getOpenWorkspacesGroupContent([
        makeWorkspaceCard({
            id: 'current',
            aiSessions: {
                sessionsByProvider: { codex: [{ id: 'c1', name: 'Session' }] },
                activeSessions: [], unavailableProviders: [], activeProvider: 'codex', expanded: true,
            },
        }),
        makeWorkspaceCard({ id: 'navigation', kind: 'navigation', name: 'Other' }),
    ], false, 'ready');

    const currentTags = Array.from(html.matchAll(
        /<div class="[^"]*project[^"]*"[^>]*data-id="current"[^>]*>/g
    )).map(match => match[0]);
    const navigationTag = html.match(/<div class="[^"]*project[^"]*"[^>]*data-id="navigation"[^>]*>/)[0];
    assert.equal(currentTags.length, 2);
    const currentDetailTag = currentTags.find(tag => /data-current-workspace/.test(tag));
    const currentOpenListTag = currentTags.find(tag => /data-open-workspace-current/.test(tag));
    assert.match(currentDetailTag, /data-workspace-scope-identity/);
    assert.match(currentOpenListTag, /data-open-workspace-list-card/);
    assert.doesNotMatch(currentOpenListTag, /data-current-workspace/);
    assert.doesNotMatch(navigationTag, /data-current-workspace/);
    assert.match(navigationTag, /data-open-workspace-list-card/);
    assert.match(navigationTag, /data-workspace-navigation/);
    assert.match(navigationTag, /data-readonly-project/);
    assert.equal((html.match(/CURRENT WINDOW/g) || []).length, 1);
    assert.equal((html.match(/OPEN WINDOWS/g) || []).length, 1);
    assert.equal(html.includes('CURRENT WORKSPACE'), false);
    assert.equal(html.includes('OTHER WINDOWS'), false);
    assert.match(html, /class="current-window-indicator"/);
    assert.equal((html.match(/data-action="toggle-open-workspace-pin"/g) || []).length, 2);
    assert.equal((html.match(/class="codex-sessions"/g) || []).length, 1);
    assert.equal(html.includes('Leaked'), false);
});

test('OPEN-ALL-WINDOWS-LIST-001 renders saved project names for single-root window cards', () => {
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
    ], false, 'ready');

    const renderedNames = Array.from(html.matchAll(
        /<h2 class="project-header">([^<]+)<\/h2>/g
    )).map(match => match[1]);
    assert.deepEqual(renderedNames, ['agent-pivot', 'agent-pivot', 'reddb project']);
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
    ], false, 'ready');

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

    assert.match(html, /data-ai-session-surface-tab="worktree"/);
    assert.match(html, /data-ai-session-surface-tab="chats"/);
    assert.match(html, /data-selected-ai-session-surface="chats"/);
    assert.doesNotMatch(html, /data-ai-session-grouping-select/);
    assert.equal((html.match(/data-session-id="feature-session"/g) || []).length, 1,
        'history sessions stay in Chats All only');
    const worktreeMarkup = html.match(
        /data-ai-session-surface-panel="worktree"[\s\S]*?data-ai-session-surface-panel="chats"/
    )[0];
    assert.match(worktreeMarkup, /data-session-id="live-session"/,
        'the Worktree surface lists the live session under its group');
    assert.doesNotMatch(worktreeMarkup, /data-session-id="feature-session"/,
        'the Worktree surface never duplicates history sessions');
    assert.match(html, /data-worktree-activity="attention"/);
    assert.ok(html.indexOf('feature/auth') < html.indexOf('feature/idle'),
        'attention worktrees render first while stable snapshot order breaks ties');
    assert.match(html, /feature\/idle[\s\S]*?locked[\s\S]*?\(no active sessions\)/);
    assert.match(html, /2 more worktrees not shown/);
    assert.match(html, /data-action="toggle-ai-session-worktree"/);
    assert.match(html, /aria-label="feature\/auth, 1 session, needs attention"/);
    const worktreePanel = html.match(
        /data-ai-session-surface-panel="worktree"[\s\S]*?data-ai-session-surface-panel="chats"/
    )[0];
    const chatsPanel = html.match(
        /data-ai-session-surface-panel="chats"[\s\S]*?ai-session-live-region/
    )[0];
    const surfaceBar = html.match(/ai-session-surface-bar[\s\S]*?data-ai-session-surface-panel/)[0];
    assert.match(surfaceBar, /data-action="create-isolated-session"/,
        'New Worktree creation lives on the surface bar next to the tabs');
    assert.doesNotMatch(worktreePanel, /data-action="create-isolated-session"/);
    assert.match(worktreePanel, /data-action="ai-session-worktree-menu"/,
        'each worktree row exposes one unified actions menu');
    assert.doesNotMatch(chatsPanel, /data-action="create-isolated-session"/);
    assert.match(chatsPanel, /data-action="create-ai-session-quick"/,
        'session creation belongs to the Chats surface');
    assert.doesNotMatch(worktreePanel, /ai-session-create-split-button/,
        'the global session create cluster must stay out of the Worktree surface');
    assert.doesNotMatch(html, /ai-session-module-header/,
        'the retired module header must not render');
    const chatsToolbar = chatsPanel.match(/ai-session-chats-toolbar[\s\S]*?ai-session-tab-panel/)[0];
    assert.ok(chatsToolbar.indexOf('data-ai-session-tab') >= 0
        && chatsToolbar.indexOf('data-action="create-ai-session-quick"') >= 0,
        'the Active/All tabs and the create actions share one chats toolbar row');
});

test('WORKTREE-GROUPING-UI-001 renders the host-remembered surface without a restore flip', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'surface-memory',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        codexSessions: [], kimiSessions: [], claudeSessions: [], activeAiSessions: [],
        worktrees: [],
        selectedSurface: 'worktree',
    });
    assert.match(html, /data-selected-ai-session-surface="worktree"/,
        'authoritative HTML must carry the selected surface so replacements never flip it');
    assert.match(html, /data-ai-session-surface-tab="worktree" aria-selected="true"/);
    assert.match(html, /data-ai-session-surface-panel="chats"[^>]*hidden/);
});

test('WORKTREE-GROUPING-UI-001 keeps Chats available when no worktrees exist', () => {
    const html = webviewModules.content.getAiSessionsDiv({
        id: 'flat-default',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        codexSessions: [], kimiSessions: [], claudeSessions: [], activeAiSessions: [],
        worktrees: [],
    });
    assert.match(html, /data-selected-ai-session-surface="chats"/);
    assert.match(html, /data-ai-session-surface-panel="worktree"/);
    assert.match(html, /data-ai-session-surface-panel="chats"/);
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

    assert.match(html, /data-action="create-isolated-session"[^>]*disabled/);
    assert.match(html, /data-provisioning-operation-id="operation-active"/);
    assert.match(html, /Creating worktree/);
    assert.match(html, /Fix &lt;login&gt;/);
    assert.match(html, /data-action="cancel-isolated-session" data-operation-id="operation-active"/);
    assert.match(html, /data-action="retry-isolated-session" data-operation-id="operation-failed"/);
    assert.match(html, /setup-failed/);
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
    assert.equal(generatedDashboardTodoPanelSource, dashboardTodoPanelSource);
    assert.equal(generatedDashboardAiPanelSource, dashboardAiPanelSource);
    assert.equal(generatedDashboardSource, dashboardSource);
});

test('WEBVIEW-TODO-RENDER-001 keeps the generated TODO renderer byte-identical to source', () => {
    assert.equal(generatedTodoRenderSource, todoRenderSource);
    assert.match(todoRenderSource, /function createTodoRenderer\(options\)/);
    assert.match(todoRenderSource, /function renderTodoBody\(todo\)/);
    assert.match(todoRenderSource, /function renderListSurface\(\)/);
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
            todoSearchItems: makeCatalog().todos,
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
            todoSearchItems: [],
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
    assert.match(tmuxRow, /data-action="stop-ai-session-runtime"/);
    assert.doesNotMatch(tmuxRow, /data-action="detach-ai-session-terminal"/);
    assert.match(tmuxRow, /Runtime status is stale/);

    const directRow = webviewModules.content.getAiSessionsDiv({ ...base, activeAiSessions: [{
        ...runtime, backend: 'vscode', tmuxLayout: undefined, attached: true, stale: false,
    }] });
    assert.match(directRow, /data-action="close-ai-session-terminal"/);
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

test('WEBVIEW-WEBVIEW-CONTENT-001 renders OPEN PROJECTS TODO and lazy AI tab shells', () => {
    const config = {
        get: (key, fallback) => key === 'aiSessionRunningIconAnimation'
            ? 'halo'
            : fallback,
    };
    const runningCard = makeWorkspaceCard({
        aiSessions: {
            activeProvider: 'codex', expanded: true, sessionsByProvider: { codex: [] },
            activeSessions: [{
                key: 'codex:full-render', provider: 'codex', sessionId: 'full-render', name: 'Full render',
                executionState: 'running', backend: 'vscode', attached: true,
            }],
        },
    });
    const html = webviewModules.content.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test', asWebviewUri: uri => uri.toString() },
        [{ id: 'saved', groupName: 'Saved', projects: [{ id: 'hidden', name: 'Hidden', path: '/hidden' }] }],
        {
            config,
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
            todoSearchItems: makeCatalog().todos,
        },
        true,
        [runningCard],
        'ready',
    );
    for (const tab of ['open', 'projects', 'todo']) {
        assert.match(html, new RegExp(`data-dashboard-tab="${tab}"`));
        assert.match(html, new RegExp(`id="dashboard-tab-${tab}"`));
    }
    assert.match(html, /data-dashboard-tab="ai"/);
    assert.match(html, /id="dashboard-panel-ai"/);
    assert.match(html, /class="dashboard-tab-list" role="tablist" aria-label="Agent Pivot views"/);
    for (const [tab, label] of [
        ['open', 'Open'],
        ['projects', 'Projects'],
        ['todo', 'Todo'],
        ['ai', 'AI'],
    ]) {
        assert.match(
            html,
            new RegExp(
                `data-dashboard-tab="${tab}"[^>]*aria-label="${label}"[^>]*title="${label}"[^>]*>`
                + `\\s*<span class="dashboard-tab-icon" aria-hidden="true">[\\s\\S]*?<\\/span>`
                + `\\s*<span class="dashboard-tab-label">${label.toUpperCase()}<\\/span>`
            )
        );
    }
    assert.match(html, /data-session-icon-fx="halo"/);
    const cspMatch = html.match(/Content-Security-Policy"\s+content="([^"]+)"/);
    assert.ok(cspMatch, 'dashboard document must declare a Content Security Policy');
    const csp = cspMatch[1];
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /img-src \*/, 'dashboard CSP must not allow arbitrary image sources');
    assert.match(csp, /img-src test data: https:/);
    const scriptSrc = csp.match(/script-src ([^;]+)/)[1];
    assert.doesNotMatch(scriptSrc, /unsafe-inline/,
        'dashboard CSP script-src must not allow inline scripts');
    const nonceMatch = scriptSrc.match(/'nonce-([^']+)'/);
    assert.ok(nonceMatch, 'dashboard CSP script-src must be nonce-scoped');
    const scriptTags = html.match(/<script\b[^>]*>/g) || [];
    for (const tag of scriptTags) {
        if (tag.includes('type="application/json"') || tag.includes('src=')) {
            continue;
        }
        assert.ok(tag.includes(`nonce="${nonceMatch[1]}"`),
            `inline script tag must carry the CSP nonce: ${tag}`);
    }
    assert.doesNotMatch(html, /\son(?:load|click|error|input|change)=/,
        'dashboard document must not use inline event handlers');
    assert.match(html, /id="dashboard-search-catalog"/);
    assert.match(html, /webviewDashboardBundle\.js/);
    assert.ok(
        html.indexOf('webviewDashboardBundle.js') < html.indexOf('window.onload'),
        'the complete Dashboard runtime must load before the lazy panels can mount'
    );
    assert.match(html, /initTodos\(/);
    assert.equal(html.includes('data-id="hidden"'), false);
    assert.match(html, /data-id="current"/);
    assert.match(
        html,
        /onProjectsMounted: panel => \{\s*fitProjectHeaders\(panel\);\s*disposeDnD\(panel\);\s*initDnD\(panel\);/,
        'Projects-only replacement must rebuild DnD bindings for the new cards'
    );
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

test('WEBVIEW-DASHBOARD-UPDATE-MESSAGE-001 SESSION-CONTROLLER-001 preserves OPEN PROJECTS and TODO mounted tab state', () => {
    const harness = createDashboardHarness();
    harness.context.window.scrollY = 12;
    harness.controller.activateTab('projects');
    assert.deepEqual(toPlain(harness.messages), [
        { type: 'request-projects-panel', version: 1, requestId: 1 },
    ]);
    assert.equal(harness.controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '<p>projects</p>',
    }), true);
    harness.controller.activateTab('todo');
    assert.equal(harness.controller.applyTodoPanelMessage({
        type: 'todo-panel-content', version: 1, requestId: 1, html: '<p>todo</p>',
    }), true);
    harness.controller.activateTab('open');
    harness.controller.replaceSearchCatalog(makeCatalog('next'));

    assert.equal(harness.controller.getActiveTab(), 'open');
    assert.equal(harness.projectsPanel.innerHTML, '<p>projects</p>');
    assert.equal(harness.todoPanel.innerHTML, '<p>todo</p>');
    harness.controller.activateTab('projects');
    harness.controller.activateTab('todo');
    assert.equal(harness.messages.filter(message => message.type === 'request-projects-panel').length, 1);
    assert.equal(harness.messages.filter(message => message.type === 'request-todo-panel').length, 1);
    assert.equal(harness.storage.get('agentPivot.activeDashboardTab'), 'todo');
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
    harness.todoButton.dispatch('keydown', {
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
    assert.equal(harness.context.getAdjacentDashboardTab('todo', 'ArrowRight'), 'ai');
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
        getAttribute: name => name === 'data-ai-session-tab' ? 'sessions' : null,
        setAttribute: () => undefined,
    };
    const panel = {
        getAttribute: name => name === 'data-ai-session-panel' ? 'sessions' : null,
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
        selector === '.workspace-card[data-workspace-navigation-identity]' ? [workspace] : [];

    assert.equal(harness.context.window.__agentPivotRevealWorkspaceWorktree(
        'navigation-1', '/repo/.git', '/repo/topic'
    ), true);
    assert.equal(sectionAttributes.get('data-selected-ai-session-surface'), 'worktree',
        'revealing a worktree selects the Worktree surface');
    assert.equal(headerAttributes.get('aria-expanded'), 'true');
    assert.equal(groupAttributes.has('data-worktree-collapsed'), false);
    assert.equal(listAttributes.has('hidden'), false);
    assert.equal(focused, true);
    assert.equal(harness.getWebviewState().aiSessionSurfaces['workspace-1'], 'worktree');
    assert.ok(harness.messages.some(message =>
        message.type === 'select-ai-session-surface'
        && message.projectId === 'workspace-1' && message.surface === 'worktree'),
        'the reveal reports the surface selection for authoritative re-renders');
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
    for (const tab of ['projects', 'todo']) {
        const harness = createDashboardHarness({ initialTab: tab });
        const requestType = `request-${tab}-panel`;
        const getState = tab === 'projects'
            ? harness.controller.getProjectsState
            : harness.controller.getTodoState;
        const applyMessage = tab === 'projects'
            ? harness.controller.applyProjectsPanelMessage
            : harness.controller.applyTodoPanelMessage;

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
        const loading = tab === 'projects' ? harness.projectsLoading : harness.todoLoading;
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
    harness.todoPanel.innerHTML = '<p>todo-state</p>';
    harness.openPanel.innerHTML = '<p>open-state</p>';
    harness.context.window.scrollY = 73;
    const openIdentity = harness.openPanel;
    const todoIdentity = harness.todoPanel;

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
    assert.equal(harness.todoPanel, todoIdentity);
    assert.equal(harness.openPanel.innerHTML, '<p>open-state</p>');
    assert.equal(harness.todoPanel.innerHTML, '<p>todo-state</p>');
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

test('PROJECT-INCREMENTAL-REFRESH-001 ignores stale window messages without requesting a full refresh', () => {
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
    assert.equal(harness.context.getAdjacentDashboardTab('todo', 'ArrowRight'), 'ai');
    assert.equal(harness.context.validateProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '',
    }), true);
    assert.equal(harness.context.validateProjectsPanelMessage({
        type: 'projects-panel-content', version: 2, requestId: 1, html: '',
    }), false);
    assert.equal(harness.context.validateTodoPanelMessage({
        type: 'todo-panel-content', version: 1, requestId: 1, html: '',
    }), true);
    assert.equal(harness.context.validateTodoPanelMessage({
        type: 'todo-panel-content', version: 2, requestId: 1, html: '',
    }), false);

    harness.context.window.scrollY = 41;
    harness.controller.activateTab('projects');
    harness.context.window.scrollY = 17;
    harness.controller.activateTab('todo');
    harness.context.window.scrollY = 9;
    harness.controller.activateTab('open');
    assert.equal(harness.controller.getScrollPosition('open'), 41);
    assert.equal(harness.controller.getScrollPosition('projects'), 17);
    assert.equal(harness.controller.getScrollPosition('todo'), 9);
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

    assert.equal(harness.controller.applyTodoPanelMessage({
        type: 'todo-panel-content', version: 1, requestId: 2, html: '<p>future todo</p>',
    }), false);
    assert.equal(harness.controller.applyTodoPanelMessage({
        type: 'todo-panel-content', version: 1, requestId: 1, html: '<p>current todo</p>',
    }), true);
    assert.equal(harness.controller.applyTodoPanelMessage({
        type: 'todo-panel-content', version: 1, requestId: 1, html: '<p>stale todo</p>',
    }), false);
    assert.equal(harness.todoPanel.innerHTML, '<p>current todo</p>');
});

test('WEBVIEW-DASHBOARD-SEARCH-CATALOG-001 accepts the migrated TODO catalog with the lazy panel', () => {
    const harness = createDashboardHarness({ initialTab: 'todo' });
    assert.equal(harness.controller.applyTodoPanelMessage({
        type: 'todo-panel-content',
        version: 1,
        requestId: 1,
        html: '<p>todo</p>',
        searchCatalog: makeCatalog('lazy'),
    }), true);
    harness.controller.setSearchQuery('lazy');
    const todoSection = harness.searchResults.children.find(section =>
        section.dataset.sectionType === 'todo'
    );

    assert.equal(todoSection.children[1].dataset.todoId, 'tlazy');
});

test('TODO-AUTHORITATIVE-REFRESH-STATE-001 routes supported mounted snapshots without replacing TODO markup and falls back once otherwise', () => {
    const mounted = [];
    const refreshed = [];
    const validSnapshot = {
        version: 1,
        showCompleted: false,
        data: { version: 1, groups: [], todos: [] },
    };
    const harness = createDashboardHarness({
        initialTab: 'todo',
        onTodoMounted: (panel, message) => mounted.push({ panel, message }),
        onTodoRefresh: (panel, message) => {
            refreshed.push({ panel, message });
            const snapshot = message.snapshot;
            return Boolean(snapshot
                && snapshot.version === 1
                && typeof snapshot.showCompleted === 'boolean'
                && snapshot.data
                && snapshot.data.version === 1
                && Array.isArray(snapshot.data.groups)
                && Array.isArray(snapshot.data.todos));
        },
    });
    assert.equal(harness.controller.applyTodoPanelMessage({
        type: 'todo-panel-content',
        version: 1,
        requestId: 1,
        html: '<div class="todo-panel">mounted</div>',
        snapshot: validSnapshot,
        searchCatalog: makeCatalog('mounted'),
    }), true);
    const mountedHtml = harness.todoPanel.innerHTML;

    assert.equal(harness.controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<div class="todo-panel">replacement must not install</div>',
        snapshot: validSnapshot,
        searchCatalog: makeCatalog('refresh'),
    }), true);
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].panel, harness.todoPanel);
    assert.equal(mounted.length, 1);
    assert.equal(harness.todoPanel.innerHTML, mountedHtml);
    harness.controller.setSearchQuery('refresh');
    assert.equal(harness.searchResults.children.find(section =>
        section.dataset.sectionType === 'todo'
    ).children[1].dataset.todoId, 'trefresh');

    assert.equal(harness.controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<div class="todo-panel">fallback</div>',
        snapshot: { version: 2 },
        searchCatalog: makeCatalog('fallback'),
    }), true);
    assert.equal(refreshed.length, 2);
    assert.equal(mounted.length, 2);
    assert.equal(harness.todoPanel.innerHTML, '<div class="todo-panel">fallback</div>');

    assert.equal(harness.controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<div class="todo-panel">malformed fallback</div>',
        snapshot: { version: 1 },
        searchCatalog: makeCatalog('malformed'),
    }), true);
    assert.equal(refreshed.length, 3);
    assert.equal(mounted.length, 3);
    assert.equal(harness.todoPanel.innerHTML, '<div class="todo-panel">malformed fallback</div>');

    assert.equal(harness.controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<div class="todo-panel">missing fallback</div>',
        searchCatalog: makeCatalog('missing'),
    }), true);
    assert.equal(refreshed.length, 3);
    assert.equal(mounted.length, 4);
    assert.equal(harness.todoPanel.innerHTML, '<div class="todo-panel">missing fallback</div>');
});

test('TODO-AUTHORITATIVE-REFRESH-STATE-001 fallback restores show-completed focus with preventScroll and preserves window scroll', () => {
    const harness = createDashboardHarness({
        initialTab: 'todo',
        onTodoRefresh: () => false,
    });
    assert.equal(harness.controller.applyTodoPanelMessage({
        type: 'todo-panel-content',
        version: 1,
        requestId: 1,
        html: '<div class="todo-panel">mounted</div>',
        searchCatalog: makeCatalog('mounted'),
    }), true);
    const oldToggle = createElement();
    oldToggle.setAttribute('data-action', 'todo-toggle-show-completed');
    const replacementToggle = createElement();
    let focusOptions = null;
    replacementToggle.setAttribute('data-action', 'todo-toggle-show-completed');
    replacementToggle.focus = options => {
        focusOptions = options;
        harness.context.document.activeElement = replacementToggle;
        if (!options || options.preventScroll !== true) {
            harness.context.window.scrollY = 0;
        }
    };
    harness.todoPanel.contains = candidate => candidate === oldToggle;
    harness.todoPanel.querySelector = selector =>
        selector === '[data-action="todo-toggle-show-completed"]'
            ? replacementToggle
            : null;
    harness.context.document.activeElement = oldToggle;
    harness.context.window.scrollY = 73;

    assert.equal(harness.controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<div class="todo-panel">fallback</div>',
        snapshot: { version: 2 },
        searchCatalog: makeCatalog('fallback'),
    }), true);
    assert.deepEqual(toPlain(focusOptions), { preventScroll: true });
    assert.equal(harness.context.document.activeElement, replacementToggle);
    assert.equal(harness.context.window.scrollY, 73);
});

test('TODO-TODO-SEARCH-RESULT-RENDERING-001 search reveal requests host data then focuses the mounted TODO', () => {
    const harness = createDashboardHarness({
        initialTab: 'todo',
        synchronousFrames: false,
        onTodoRefresh: (_panel, message) => Boolean(message.snapshot),
    });
    assert.equal(harness.controller.applyTodoPanelMessage({
        type: 'todo-panel-content', version: 1, requestId: 1, html: '<p>todo</p>',
    }), true);
    harness.controller.replaceSearchCatalog(makeCatalog('search'));
    harness.controller.setSearchQuery('ship');
    const todoSection = harness.searchResults.children.find(section => section.dataset.sectionType === 'todo');
    const todoResult = todoSection.children[1];
    todoResult.closest = selector => selector === '.dashboard-search-result[data-search-action]'
        ? todoResult
        : null;
    harness.searchResults.dispatch('click', { target: todoResult });
    while (harness.frames.length) harness.frames.shift()();

    assert.deepEqual(toPlain(harness.messages.filter(message => message.type === 'todo-reveal')), [{
        type: 'todo-reveal', todoId: 'tsearch', groupId: 'group-a',
    }]);

    let focused = 0;
    let openedTodoId = null;
    let openedCount = 0;
    harness.context.window.__agentPivotTodo = {
        openDetail(todoId) {
            openedTodoId = todoId;
            openedCount += 1;
            return true;
        },
    };
    const todoGroup = { classList: createClassList() };
    const todoItem = {
        isConnected: true,
        getAttribute: name => name === 'data-todo-id' ? 'tsearch' : null,
        setAttribute: () => undefined,
        removeAttribute: () => undefined,
        closest: selector => selector === '.todo-group' ? todoGroup : null,
        scrollIntoView: () => undefined,
        focus: () => {
            focused += 1;
            harness.context.document.activeElement = todoItem;
        },
        addEventListener: () => undefined,
    };
    harness.todoPanel.querySelectorAll = selector => selector === '.todo-item[data-todo-id]' ? [todoItem] : [];
    harness.controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<p>revealed</p>',
        snapshot: { version: 1 },
        searchCatalog: makeCatalog('search'),
    });
    while (harness.frames.length) harness.frames.shift()();
    assert.equal(openedTodoId, 'tsearch');
    assert.equal(openedCount, 1);
    assert.equal(focused, 0);

    openedTodoId = null;
    harness.searchResults.dispatch('click', { target: todoResult });
    while (harness.frames.length) harness.frames.shift()();
    harness.controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<p>fallback revealed</p>',
        searchCatalog: makeCatalog('search'),
    });
    while (harness.frames.length) harness.frames.shift()();
    assert.equal(openedTodoId, 'tsearch');
    assert.equal(openedCount, 2);
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
            selector === '.workspace-card[data-current-workspace][data-id]' ? [project] : [],
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
            selector === '.workspace-card[data-current-workspace][data-id]' ? [project] : [],
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
            selector === '.workspace-card[data-current-workspace][data-id]' ? [project] : [],
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
    assert.equal(context.normalizeAiSessionTab('active'), 'active');
    assert.equal(context.normalizeAiSessionTab('invalid'), 'sessions');
    assert.equal(context.getAdjacentAiSessionTab('active', 'ArrowRight'), 'sessions');
    assert.equal(context.getAdjacentAiSessionTab('sessions', 'ArrowLeft'), 'active');
    assert.equal(context.getAdjacentAiSessionTab('sessions', 'Home'), 'active');
    assert.equal(context.getAdjacentAiSessionTab('active', 'End'), 'sessions');

    context.writeAiSessionTabState(context.window.vscode, 'project-a', 'active');
    context.writeAiSessionTabState(context.window.vscode, 'project-b', 'invalid');
    assert.deepEqual(toPlain(context.readAiSessionTabState(context.window.vscode)), {
        'project-a': 'active', 'project-b': 'sessions',
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

    context.writeAiSessionSurfaceState(context.window.vscode, 'project-a', 'worktree');
    context.writeAiSessionSurfaceState(context.window.vscode, 'project-b', 'invalid');
    assert.deepEqual(toPlain(context.readAiSessionSurfaceState(context.window.vscode)), {
        'project-a': 'worktree', 'project-b': 'chats',
    });
    assert.equal(harness.getWebviewState().unrelated, 'preserved');

    const activeList = { scrollTop: 0, scrollHeight: 100, clientHeight: 40 };
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
    const tabs = [tab('active'), tab('sessions')];
    const panels = [panel('active', activeList), panel('sessions', historyList)];
    const project = {
        querySelector(selector) {
            if (selector === '.codex-sessions') return { setAttribute() {} };
            if (selector === '.ai-session-active-panel .codex-sessions-list') return activeList;
            if (selector === '.ai-session-history-panel .codex-sessions-list') return historyList;
            if (selector === '[data-ai-session-panel="active"]') return panels[0];
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
        activeAnchor: { scrollTop: 17, itemKey: null, itemOffset: 0 },
        historyAnchor: { scrollTop: 29, itemKey: null, itemOffset: 0 },
        restoreFocus: false,
    }, 'active');
    assert.equal(activeList.scrollTop, 17);
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
    assert.deepEqual(toPlain(context.getCollapseButtonState('open', [])), {
        disabled: true, collapsed: false, title: 'No open windows to collapse',
    });
    assert.equal(context.getCollapseButtonState('open', [false]).title, 'Collapse Open Windows');
    assert.equal(context.getCollapseButtonState('open', [true]).title, 'Expand Open Windows');
    assert.equal(context.getCollapseButtonState('projects', [false, true]).title, 'Collapse All Groups');
    assert.equal(context.getCollapseButtonState('todo', [true, true]).title, 'Expand TODO Groups');
    assert.deepEqual(toPlain(context.getCollapseButtonState('ai', [false])), {
        disabled: true, collapsed: false, title: 'No groups to collapse in AI',
    });
}

test('WEBVIEW-COLLAPSE-BUTTON-STATE-001 exposes disabled and exact action labels for each dashboard tab', () => {
    assertCollapseButtonBehavior(createProjectVm().context);
    const mutated = projectSource.replace('No open windows to collapse', 'Nothing to collapse');
    assert.throws(() => assertCollapseButtonBehavior(createProjectVm({ source: mutated }).context));
});

test('WEBVIEW-AI-DASHBOARD-001 keeps Collapse disabled across late Projects and TODO mounts while AI stays active', () => {
    const collapseButton = createElement();
    const selectedAiButton = createElement();
    selectedAiButton.setAttribute('data-dashboard-tab', 'ai');
    selectedAiButton.setAttribute('aria-selected', 'true');
    const openGroup = { classList: createClassList() };
    const todoGroup = { classList: createClassList() };
    const harness = createProjectVm({
        activeTab: 'ai',
        querySelector: selector => selector === '[data-action="toggle-all-groups"]'
            ? collapseButton
            : selector === '[data-dashboard-tab][aria-selected="true"]'
                ? selectedAiButton
                : null,
        querySelectorAll: selector => selector === '#dashboard-tab-open .open-other-windows-group[data-group-id]'
            ? [openGroup]
            : selector === '#dashboard-tab-todo .todo-group[data-todo-group-id]'
                ? [todoGroup]
                : [],
    });

    collapseButton.disabled = false;
    harness.context.window.__agentPivotSyncCollapseButton();
    assert.equal(collapseButton.disabled, true, 'late Projects mount must preserve AI state');
    assert.equal(collapseButton.getAttribute('aria-disabled'), 'true');
    assert.equal(collapseButton.getAttribute('title'), 'No groups to collapse in AI');

    collapseButton.disabled = false;
    harness.context.window.__agentPivotSyncCollapseButton('todo');
    assert.equal(collapseButton.disabled, true, 'late TODO update must use the active AI tab');
    assert.equal(collapseButton.getAttribute('aria-disabled'), 'true');
    assert.equal(collapseButton.getAttribute('title'), 'No groups to collapse in AI');

    harness.context.window.__agentPivotDashboard = null;
    collapseButton.disabled = false;
    harness.context.window.__agentPivotSyncCollapseButton();
    assert.equal(collapseButton.disabled, true, 'initial mount must read the selected AI tab element');
    assert.equal(collapseButton.getAttribute('title'), 'No groups to collapse in AI');
});

test('WEBVIEW-AI-DASHBOARD-001 and TODO-AUTHORITATIVE-REFRESH-STATE-001 preserve AI Collapse state after actual late Projects and TODO responses and updates', () => {
    const collapseButton = createElement();
    const projectVm = createProjectVm({
        querySelector: selector => selector === '[data-action="toggle-all-groups"]'
            ? collapseButton
            : null,
        querySelectorAll: selector => selector === '#dashboard-tab-open .open-other-windows-group[data-group-id]'
            || selector === '#dashboard-tab-projects .group[data-group-id]'
            || selector === '#dashboard-tab-todo .todo-group[data-todo-group-id]'
            ? [{ classList: createClassList() }]
            : [],
    });
    const syncCollapse = () => projectVm.context.window.__agentPivotSyncCollapseButton();
    const dashboard = createDashboardHarness({
        initialTab: 'projects',
        onProjectsMounted: syncCollapse,
        onTodoMounted: syncCollapse,
    });
    projectVm.context.window.__agentPivotDashboard = dashboard.controller;

    dashboard.controller.activateTab('ai');
    collapseButton.disabled = false;
    assert.equal(dashboard.controller.applyProjectsPanelMessage({
        type: 'projects-panel-content',
        version: 1,
        requestId: 1,
        html: '<div>late projects</div>',
    }), true);
    assert.equal(collapseButton.disabled, true);
    assert.equal(collapseButton.getAttribute('title'), 'No groups to collapse in AI');

    collapseButton.disabled = false;
    assert.equal(dashboard.controller.applyProjectsPanelUpdatedMessage({
        type: 'projects-panel-updated',
        version: 1,
        sequence: 1,
        mode: 'replace',
        html: '<div>late projects update</div>',
        searchCatalog: makeCatalog('late-projects'),
        groupOrders: [],
        favoriteProjectIds: [],
    }), true);
    assert.equal(collapseButton.disabled, true);
    assert.equal(collapseButton.getAttribute('title'), 'No groups to collapse in AI');

    dashboard.controller.activateTab('todo');
    dashboard.controller.activateTab('ai');
    collapseButton.disabled = false;
    assert.equal(dashboard.controller.applyTodoPanelMessage({
        type: 'todo-panel-content',
        version: 1,
        requestId: 1,
        html: '<div>late todos</div>',
        searchCatalog: makeCatalog('late-todos'),
    }), true);
    assert.equal(collapseButton.disabled, true);
    assert.equal(collapseButton.getAttribute('title'), 'No groups to collapse in AI');

    collapseButton.disabled = false;
    assert.equal(dashboard.controller.applyTodoPanelUpdatedMessage({
        type: 'todo-panel-updated',
        version: 1,
        html: '<div>late todo update</div>',
        searchCatalog: makeCatalog('late-todo-update'),
    }), true);
    assert.equal(collapseButton.disabled, true);
    assert.equal(collapseButton.getAttribute('title'), 'No groups to collapse in AI');
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
    assert.equal(harness.replacedCatalogs[0].todos[0].todoId, 'tnew');
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

function createTodoEditHarness() {
    const title = { value: 'Initial title', defaultValue: 'Initial title' };
    const notes = { value: 'Initial notes', defaultValue: 'Initial notes' };
    const priorities = ['high', 'medium', 'low'].map(value => ({
        value,
        checked: value === 'medium',
        defaultChecked: value === 'medium',
    }));
    const choices = priorities.map(input => ({
        classList: createClassList(input.checked ? ['active'] : []),
        querySelector: selector => selector === 'input[name="priority"]' ? input : null,
    }));
    const segment = { querySelectorAll: selector => selector === '.todo-priority-choice' ? choices : [] };
    const form = {
        hidden: false,
        reset() {
            title.value = title.defaultValue;
            notes.value = notes.defaultValue;
            priorities.forEach(input => { input.checked = input.defaultChecked; });
        },
        querySelector(selector) {
            if (selector === '[name="title"]') return title;
            if (selector === '[name="notes"]') return notes;
            if (selector === '.todo-priority-segment') return segment;
            return null;
        },
    };
    const list = {
        classList: createClassList(['has-editing-item']),
        style: { setProperty: () => undefined },
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
    };
    const expandButton = createElement();
    const item = {
        classList: createClassList(['editing', 'expanded']),
        attributes: new Map([['data-expanded-before-edit', 'false']]),
        offsetHeight: 58,
        getAttribute(name) {
            if (name === 'data-todo-id') return 'todo-a';
            return this.attributes.has(name) ? this.attributes.get(name) : null;
        },
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        removeAttribute(name) { this.attributes.delete(name); },
        querySelector(selector) {
            if (selector === '.todo-item-view') return { hidden: false };
            if (selector === '.todo-edit-form') return form;
            if (selector === '[data-action="todo-toggle-expanded"]') return expandButton;
            if (selector === '.todo-title-text') return { textContent: 'Initial title' };
            return null;
        },
        closest: selector => selector === '.todo-list' ? list : null,
        scrollIntoView: () => undefined,
    };
    return { title, notes, priorities, choices, form, list, item };
}

test('TODO-TODO-EDIT-RESET-INTERACTION-001 cancel restores rendered edit values and expansion state', () => {
    const edit = createTodoEditHarness();
    const harness = createProjectVm({
        querySelectorAll: selector => selector === '.todo-item[data-todo-id]' ? [edit.item] : [],
    });
    edit.title.value = 'Draft';
    edit.notes.value = 'Draft notes';
    edit.priorities[1].checked = false;
    edit.priorities[2].checked = true;
    const cancelAction = {
        getAttribute: name => name === 'data-todo-id' ? 'todo-a' : null,
    };
    const target = {
        closest: selector => selector === '[data-action="todo-cancel-edit"]' ? cancelAction : null,
    };

    harness.documentListeners.click({ button: 0, target });
    assert.equal(edit.title.value, 'Initial title');
    assert.equal(edit.notes.value, 'Initial notes');
    assert.deepEqual(edit.priorities.map(input => input.checked), [false, true, false]);
    assert.deepEqual(edit.choices.map(choice => choice.classList.contains('active')), [false, true, false]);
    assert.equal(edit.item.classList.contains('editing'), false);
    assert.equal(edit.item.classList.contains('expanded'), false);
    assert.equal(edit.item.getAttribute('data-expanded-before-edit'), null);
});

function createComposeForm() {
    const attributes = new Map();
    const controls = {
        title: { value: 'Draft todo' },
        notes: { value: 'Draft notes' },
        priority: { value: 'high', checked: true },
        groupId: { value: 'group-a' },
    };
    const submitAttributes = new Map();
    const submitButton = {
        disabled: false,
        getAttribute: name => submitAttributes.has(name) ? submitAttributes.get(name) : null,
        setAttribute: (name, value) => submitAttributes.set(name, String(value)),
        removeAttribute: name => submitAttributes.delete(name),
    };
    return {
        controls,
        submitButton,
        reset() {
            controls.title.value = '';
            controls.notes.value = '';
        },
        getAttribute: name => attributes.has(name) ? attributes.get(name) : null,
        setAttribute: (name, value) => attributes.set(name, String(value)),
        removeAttribute: name => attributes.delete(name),
        querySelector(selector) {
            if (selector === '[type="submit"]') return submitButton;
            const checked = selector.match(/^\[name="([^"]+)"\]:checked$/);
            if (checked) return controls[checked[1]] && controls[checked[1]].checked ? controls[checked[1]] : null;
            const named = selector.match(/^\[name="([^"]+)"\]$/);
            return named ? controls[named[1]] || null : null;
        },
    };
}

test('TODO-TODO-COMPOSE-PENDING-INTERACTION-001 locks rapid submits and settles failure acknowledgements', () => {
    const form = createComposeForm();
    const harness = createProjectVm({
        querySelector: selector => selector === '.todo-add-form[data-todo-request-id="1"]' ? form : null,
    });
    const event = {
        preventDefault: () => undefined,
        target: { closest: selector => selector === '.todo-add-form' ? form : null },
    };
    harness.documentListeners.submit(event);
    harness.documentListeners.submit(event);

    assert.deepEqual(toPlain(harness.messages), [{
        type: 'todo-add', requestId: 1, title: 'Draft todo', notes: 'Draft notes',
        priority: 'high', groupId: 'group-a',
    }]);
    assert.equal(form.submitButton.disabled, true);
    assert.equal(form.submitButton.getAttribute('aria-busy'), 'true');

    harness.windowListeners.message({ data: {
        type: 'todo-mutation-result', version: 1, requestId: 1, success: false,
    } });
    assert.equal(form.submitButton.disabled, false);
    assert.equal(form.submitButton.getAttribute('aria-busy'), null);
    assert.equal(form.controls.title.value, 'Draft todo');
});

test('TODO-TODO-COMPOSE-PENDING-INTERACTION-001 clears committed input when only panel refresh fails', () => {
    const form = createComposeForm();
    const harness = createProjectVm({
        querySelector: selector => selector === '.todo-add-form[data-todo-request-id="1"]' ? form : null,
    });
    harness.documentListeners.submit({
        preventDefault: () => undefined,
        target: { closest: selector => selector === '.todo-add-form' ? form : null },
    });
    harness.windowListeners.message({ data: {
        type: 'todo-mutation-result', version: 1, requestId: 1, success: true, panelRefreshed: false,
    } });
    assert.equal(form.submitButton.disabled, false);
    assert.equal(form.controls.title.value, '');
    assert.equal(form.controls.notes.value, '');
});

function createDndHarness({ projectContainers = [], todoGroups = [], todoLists = [], groupElements = [] } = {}) {
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
            __agentPivotTodo: {
                dispatch(action, payload) {
                    messages.push({ action, payload });
                },
            },
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
            if (selector === '.todo-groups') return todoGroups;
            if (selector === '.todo-list') return todoLists;
            if (selector === '.todo-groups > .todo-group[data-todo-group-id]') return groupElements;
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

test('TODO-TODO-ORDERING-INTERACTION-001 constrains TODO drag state and posts exact DOM order', () => {
    const todoGroupsContainer = { matches: selector => selector === '.todo-groups' };
    const todoList = {
        matches: selector => selector === '.todo-list',
        closest: selector => selector === '.todo-group[data-todo-group-id]'
            ? { getAttribute: () => 'group-a' }
            : null,
        querySelectorAll: () => [
            { getAttribute: () => 'todo-b' },
            { getAttribute: () => 'todo-a' },
        ],
    };
    const groupElements = ['group-b', 'group-a'].map(id => ({
        getAttribute: () => id,
    }));
    const harness = createDndHarness({
        todoGroups: [todoGroupsContainer],
        todoLists: [todoList],
        groupElements,
    });

    const todoGroupElement = { matches: selector => selector === '.todo-group' };
    const todoItemElement = { matches: selector => selector === '.todo-item' };
    const groupHandle = { closest: selector => selector === '[data-drag-todo-group]' ? {} : null };
    const itemHandle = {
        closest: selector => selector === '[data-drag-todo-item]' ? {} : null,
    };
    const ordinaryItemTarget = { closest: () => null };
    assert.equal(harness.context.canMoveTodoGroup(todoGroupElement, todoGroupsContainer, groupHandle), true);
    assert.equal(harness.context.canAcceptTodoGroup(todoGroupsContainer, todoGroupsContainer), true);
    assert.equal(harness.context.canMoveTodoItem(todoItemElement, todoList, itemHandle), true);
    assert.equal(harness.context.canMoveTodoItem(todoItemElement, todoList, ordinaryItemTarget), false);
    assert.equal(harness.context.canAcceptTodoItem(todoList, todoList), true);
    assert.equal(harness.context.canAcceptTodoItem({ matches: () => true }, todoList), false);
    assert.deepEqual(
        toPlain(harness.context.getTodoGroupIds({ querySelectorAll: () => groupElements })),
        ['group-b', 'group-a']
    );

    harness.context.initDnD(harness.rootElement);
    assert.equal(harness.drakes.length, 4);
    harness.drakes[2].handlers.drop();
    harness.drakes[3].handlers.drop({}, todoList, todoList);
    assert.deepEqual(toPlain(harness.messages), [
        { action: 'reorder-groups', payload: { groupIds: ['group-b', 'group-a'] } },
        { action: 'reorder-items', payload: { groupId: 'group-a', todoIds: ['todo-b', 'todo-a'] } },
    ]);

    harness.context.disposeDnD(harness.rootElement);
    assert.equal(harness.rootElement.__agentPivotDnDInitialized, undefined);
    assert.equal(harness.rootElement.__agentPivotDnD, undefined);
});
