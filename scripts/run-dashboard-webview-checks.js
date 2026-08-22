'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const vm = require('vm');
const CleanCSS = require('clean-css');
const sass = require('sass');
const dashboardErrorContent = require('../out/dashboard/errorContent');
let workspaceConfigurationResolver = () => ({ marker: 'agent-pivot-configuration' });
const configurationReads = [];
const vscodeConfigurationFixture = {
    workspace: {
        getConfiguration(section, scope) {
            configurationReads.push([section, scope]);
            return workspaceConfigurationResolver(section, scope);
        },
    },
};
const originalConfigurationLoad = Module._load;
Module._load = function loadWithVscodeConfigurationFixture(request, parent, isMain) {
    if (request === 'vscode') return vscodeConfigurationFixture;
    return originalConfigurationLoad.call(this, request, parent, isMain);
};
const dashboardConfiguration = require('../out/configuration');
Module._load = originalConfigurationLoad;
const dashboardStartup = require('../out/dashboard/startup');
const { DashboardStartupController, settleMigration } = require('../out/dashboard/startupController');
const { DashboardLifecycleController } = require('../out/dashboard/lifecycleController');
const { DashboardCommandRegistration } = require('../out/dashboard/commandRegistration');
const activeTerminalFileReference = require('../out/dashboard/activeTerminalFileReference');
const dashboardWebviewOptions = require('../out/dashboard/webviewOptions');
const { GroupCollapseController } = require('../out/dashboard/groupCollapseController');
const { DashboardRuntimeController } = require('../out/dashboard/runtimeController');
const { AddProjectsFromFolderController } = require('../out/projects/addProjectsFromFolderController');
const { FavoriteProjectController } = require('../out/projects/favoriteProjectController');
const { GroupCommandController } = require('../out/projects/groupCommandController');
const { queryGroupName } = require('../out/projects/groupPrompts');
const { ProjectOrderController } = require('../out/projects/projectOrderController');
const { ProjectRemovalController } = require('../out/projects/projectRemovalController');
const { buildWorkspaceDashboardSearchCatalog } = require('../out/webview/dashboardViewModel');
const { inputPaths: dashboardBundleInputPaths } = require('./build-dashboard-webview-bundle');
const AsyncFunction = Object.getPrototypeOf(async function () { return undefined; }).constructor;

const root = path.join(__dirname, '..');
const dashboardScriptPath = path.join(root, 'src', 'webview', 'webviewDashboardScripts.js');
const skillPanelScriptPath = path.join(
    root, 'src', 'webview', 'webviewSkillPanelScripts.js'
);
const projectsPanelScriptPath = path.join(
    root, 'src', 'webview', 'webviewProjectsPanelScripts.js'
);
const dashboardValidationScriptPath = path.join(
    root, 'src', 'webview', 'webviewDashboardValidationScripts.js'
);
const dashboardSearchScriptPath = path.join(
    root, 'src', 'webview', 'webviewDashboardSearchScripts.js'
);
const dashboardProjectsPanelScriptPath = path.join(
    root, 'src', 'webview', 'webviewDashboardProjectsPanelScripts.js'
);
const dashboardAiPanelScriptPath = path.join(
    root, 'src', 'webview', 'webviewDashboardAiPanelScripts.js'
);
const projectScriptPath = path.join(root, 'src', 'webview', 'webviewProjectScripts.js');
const aiSessionViewStateScriptPath = path.join(
    root, 'src', 'webview', 'webviewAiSessionViewStateScripts.js'
);
const workspaceUpdateScriptPath = path.join(
    root, 'src', 'webview', 'webviewWorkspaceUpdateScripts.js'
);
const projectCollapseScriptPath = path.join(
    root, 'src', 'webview', 'webviewProjectCollapseScripts.js'
);
const projectContextMenuScriptPath = path.join(
    root, 'src', 'webview', 'webviewProjectContextMenuScripts.js'
);
const projectAiUpdateScriptPath = path.join(
    root, 'src', 'webview', 'webviewProjectAiUpdateScripts.js'
);
const aiSessionControlsScriptPath = path.join(
    root, 'src', 'webview', 'webviewProjectAiSessionControlsScripts.js'
);

function readProjectWebviewSource() {
    return [
        aiSessionViewStateScriptPath,
        workspaceUpdateScriptPath,
        projectCollapseScriptPath,
        projectContextMenuScriptPath,
        projectAiUpdateScriptPath,
        aiSessionControlsScriptPath,
        projectScriptPath,
    ].map(scriptPath => fs.readFileSync(scriptPath, 'utf8')).join('\n');
}

function readDashboardWebviewSource() {
    return [
        skillPanelScriptPath,
        projectsPanelScriptPath,
        dashboardValidationScriptPath,
        dashboardSearchScriptPath,
        dashboardProjectsPanelScriptPath,
        dashboardAiPanelScriptPath,
        dashboardScriptPath,
    ].map(scriptPath => fs.readFileSync(scriptPath, 'utf8')).join('\n');
}
const promptScriptPath = path.join(root, 'src', 'webview', 'webviewPromptScripts.js');
const scrollStateScriptPath = path.join(root, 'src', 'webview', 'webviewScrollStateScripts.js');
const extensionHostPath = path.join(root, 'src', 'dashboard.ts');

function compileDashboardStyles(source) {
    return sass.compileString(source, {
        loadPaths: [path.join(root, 'media'), path.join(root, 'node_modules')],
        style: 'expanded',
    }).css;
}

function extractFunctionBody(source, functionName) {
    const start = source.indexOf(`function ${functionName}(`);
    assert.ok(start >= 0, `Missing function ${functionName}`);
    const braceStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = braceStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(braceStart + 1, index);
    }
    throw new Error(`Unterminated function ${functionName}`);
}

function extractAsyncArrowPropertyBody(source, propertyName) {
    const signature = `${propertyName}: async () => {`;
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `Missing async property ${propertyName}`);
    const braceStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = braceStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(braceStart + 1, index);
    }
    throw new Error(`Unterminated async property ${propertyName}`);
}

function extractHtmlElementBody(source, openingTag) {
    const start = source.indexOf(openingTag);
    assert.ok(start >= 0, `Missing HTML element ${openingTag}`);
    const tagNameMatch = openingTag.match(/^<([a-z][\w-]*)\b/i);
    assert.ok(tagNameMatch, `Invalid HTML opening tag ${openingTag}`);
    const tagName = tagNameMatch[1];
    const openingTagEnd = source.indexOf('>', start);
    assert.ok(openingTagEnd >= 0, `Unterminated HTML opening tag ${openingTag}`);
    const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    tagPattern.lastIndex = openingTagEnd + 1;
    let depth = 1;
    let match;
    while ((match = tagPattern.exec(source))) {
        if (match[0].startsWith('</')) {
            depth -= 1;
            if (depth === 0) return source.slice(openingTagEnd + 1, match.index);
        } else if (!match[0].endsWith('/>')) {
            depth += 1;
        }
    }
    throw new Error(`Unterminated HTML element ${openingTag}`);
}

function extractDirectHtmlChildOpeningTags(source) {
    const children = [];
    const tagPattern = /<\/?([a-z][\w-]*)\b[^>]*>/gi;
    let depth = 0;
    let match;
    while ((match = tagPattern.exec(source))) {
        const tag = match[0];
        if (tag.startsWith('</')) {
            depth -= 1;
        } else {
            if (depth === 0) children.push(tag);
            if (!tag.endsWith('/>')) depth += 1;
        }
    }
    assert.strictEqual(depth, 0, 'HTML fragment must contain balanced child elements');
    return children;
}

function extractCssRule(source, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`(^|\\n)\\s*${escapedSelector}\\s*\\{`, 'm'));
    assert.ok(match, `Missing CSS rule ${selector}`);
    const start = match.index + match[0].lastIndexOf(selector);
    const braceStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = braceStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(braceStart + 1, index);
    }
    throw new Error(`Unterminated CSS rule ${selector}`);
}

function extractCssRules(source, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selectorPattern = new RegExp(`(^|\\n)\\s*${escapedSelector}\\s*\\{`, 'gm');
    const rules = [];
    let match;
    while ((match = selectorPattern.exec(source))) {
        const braceStart = source.indexOf('{', match.index);
        let depth = 0;
        for (let index = braceStart; index < source.length; index += 1) {
            if (source[index] === '{') depth += 1;
            if (source[index] === '}') depth -= 1;
            if (depth === 0) {
                rules.push(source.slice(braceStart + 1, index));
                selectorPattern.lastIndex = index + 1;
                break;
            }
        }
    }
    assert.ok(rules.length > 0, `Missing CSS rules ${selector}`);
    return rules;
}

function extractCssRulesContainingSelector(source, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selectorPattern = new RegExp(`(^|\\n)[^{}]*${escapedSelector}(?![\\w-])[^{}]*\\{`, 'gm');
    const rules = [];
    let match;
    while ((match = selectorPattern.exec(source))) {
        const braceStart = source.indexOf('{', match.index);
        let depth = 0;
        for (let index = braceStart; index < source.length; index += 1) {
            if (source[index] === '{') depth += 1;
            if (source[index] === '}') depth -= 1;
            if (depth === 0) {
                rules.push(source.slice(braceStart + 1, index));
                selectorPattern.lastIndex = index + 1;
                break;
            }
        }
    }
    assert.ok(rules.length > 0, `Missing CSS rules containing ${selector}`);
    return rules;
}

function extractCompiledCssRulesContainingSelector(source, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selectorPattern = new RegExp(`${escapedSelector}(?![\\w-])`);
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    const rules = [];
    let match;
    while ((match = rulePattern.exec(source))) {
        const selectors = match[1].split(',').map(value => value.trim()).filter(Boolean);
        if (selectors.some(value => selectorPattern.test(value))) {
            rules.push({ selectors, body: match[2] });
        }
    }
    assert.ok(rules.length > 0, `Missing compiled CSS rules containing ${selector}`);
    return rules;
}

function cssRuleIncludesDeclaration(rule, declaration) {
    const escapedDeclaration = declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[;{}\\n])\\s*${escapedDeclaration}`).test(rule);
}

function cssRuleIncludesTopLevelDeclaration(rule, declaration) {
    let depth = 0;
    let topLevelRule = '';
    for (const character of rule) {
        if (character === '{') {
            depth += 1;
        } else if (character === '}') {
            depth -= 1;
        } else if (depth === 0) {
            topLevelRule += character;
        }
    }
    return cssRuleIncludesDeclaration(topLevelRule, declaration);
}

function makeDashboardCatalog() {
    return {
        version: 3,
        sessions: [{
            key: 'codex:c1', searchText: 'fix dashboard codex c1', workspaceId: 'workspace-current',
            workspaceNavigationIdentity: 'navigation-current', workspaceName: 'Dashboard Workspace',
            provider: 'codex', sessionId: 'c1', name: 'Fix dashboard', active: true,
            action: 'reveal-workspace-session',
        }],
        worktrees: [],
        openWorkspaces: [{
            key: 'workspace:navigation-current', navigationIdentity: 'navigation-current',
            searchText: 'dashboard workspace local app api', workspaceId: 'workspace-current',
            name: 'Dashboard Workspace', description: '2 folders', environmentLabel: 'Local',
            action: 'show-current-workspace', current: true,
        }],
        savedProjects: [{
            key: 'saved:/work/dashboard', identity: '/work/dashboard', searchText: 'dashboard tools',
            projectId: 'saved', name: 'Dashboard', description: 'Saved',
            action: 'open-saved', groupLabels: ['FAVORITES', 'TOOLS'],
        }],
        todos: [],
    };
}

function makeUpdatedDashboardCatalog() {
    const catalog = makeDashboardCatalog();
    return {
        ...catalog,
        sessions: catalog.sessions.concat({
            key: 'kimi:k1', searchText: 'review dashboard kimi k1', workspaceId: 'workspace-current',
            workspaceNavigationIdentity: 'navigation-current', workspaceName: 'Dashboard Workspace',
            provider: 'kimi', sessionId: 'k1', name: 'Review dashboard',
            action: 'reveal-workspace-session',
        }),
    };
}

function makeWorkspaceDashboardCatalog() {
    return {
        version: 3,
        sessions: [{
            key: 'codex:c1', searchText: 'fix dashboard codex c1', workspaceId: 'workspace-current',
            workspaceNavigationIdentity: 'navigation-current', workspaceName: 'Dashboard Workspace',
            provider: 'codex', sessionId: 'c1', name: 'Fix dashboard', active: true,
            action: 'reveal-workspace-session',
        }],
        worktrees: [],
        openWorkspaces: [{
            key: 'workspace:navigation-current', navigationIdentity: 'navigation-current',
            searchText: 'dashboard workspace local app api', workspaceId: 'workspace-current',
            name: 'Dashboard Workspace', description: '2 folders', environmentLabel: 'Local',
            action: 'show-current-workspace', current: true,
        }, {
            key: 'workspace:navigation-other', navigationIdentity: 'navigation-other',
            searchText: 'other workspace ssh other', workspaceId: 'workspace-other',
            name: 'Other Workspace', description: '1 folder', environmentLabel: 'SSH',
            action: 'switch-open-workspace', current: false,
        }],
        savedProjects: makeDashboardCatalog().savedProjects,
        todos: [],
    };
}

function runDashboardUpdateMessageChecks() {
    const previousModuleLoad = Module._load;
    let dashboardUpdateMessages;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return {};
            }
            return previousModuleLoad.call(this, request, parent, isMain);
        };
        dashboardUpdateMessages = require('../out/dashboard/webviewUpdateMessages');
    } finally {
        Module._load = previousModuleLoad;
    }
    const workspaceCard = makeWorkspaceCardFixture(3);
    const makePresentation = projectionRevision => ({
        type: 'ai-session-presentation-state', version: 1, projectionRevision,
        workspaceScopeIdentity: 'scope-dashboard',
        workspaceNavigationIdentity: 'navigation-current',
        attentionCount: 0, activeAttentionCount: 0, runningSessionCount: 0,
        runningCardAnimation: 'current', runningIconAnimation: 'current',
        revealFocused: false, focusedTarget: null, attentionSessions: [], sessions: [],
    });
    const aiMessage = dashboardUpdateMessages.buildAiSessionsUpdatedMessage({
        groups: [],
        cards: [workspaceCard],
        sequence: 7,
        generatedAt: '2026-07-17T00:00:00.000Z',
        runningCardAnimation: 'custom',
        runningIconAnimation: 'halo',
        presentation: makePresentation(7),
    });
    const navigationCard = {
        ...makeWorkspaceCardFixture(2),
        id: 'workspace-other',
        kind: 'navigation',
        navigationIdentity: 'navigation-other',
        scopeIdentity: 'scope-other',
        name: 'Other Workspace',
        environment: 'ssh',
        environmentLabel: 'SSH',
        aiSessions: undefined,
    };
    const openWorkspacesMessage = dashboardUpdateMessages.buildOpenWorkspacesUpdatedMessage({
        groups: [],
        cards: [workspaceCard, navigationCard],
        collapsed: false,
        semanticRevision: 'b'.repeat(64),
        projectionRevision: 1,
        otherWindowsStatus: 'ready',
        runningCardAnimation: 'breath',
        runningIconAnimation: 'custom',
        presentation: makePresentation(1),
    });
    const workspaceSearchCatalog = buildWorkspaceDashboardSearchCatalog([], [workspaceCard]);

    assert.strictEqual(aiMessage.version, 3);
    assert.strictEqual(aiMessage.projectionRevision, 7);
    assert.strictEqual(aiMessage.presentation.projectionRevision, 7);
    assert.strictEqual(aiMessage.currentWorkspaceCount, 1);
    // Empty-window clause: a zero-root current card renders no .workspace-card
    // in the current group, so the incremental channel must declare 0 —
    // declaring 1 splits declared/rendered and force-refreshes every watcher
    // update for empty windows.
    const emptyWindowMessage = dashboardUpdateMessages.buildAiSessionsUpdatedMessage({
        groups: [],
        cards: [{ ...workspaceCard, roots: [] }],
        sequence: 8,
        generatedAt: '2026-07-17T00:00:00.000Z',
        presentation: makePresentation(8),
    });
    assert.strictEqual(emptyWindowMessage.currentWorkspaceCount, 0,
        'a zero-root (empty-window) current card is not renderable and must not be declared');
    assert.ok(!emptyWindowMessage.html.includes('data-current-workspace'),
        'the empty-window session surface must not claim current-session identity');
    const presentationMessage = require('../out/aiSessions/presentationMessage');
    assert.strictEqual(presentationMessage.getRenderedCurrentWorkspaceNavigationIdentity([
        { kind: 'current', navigationIdentity: 'empty-window', roots: [] },
    ]), null,
    'an unrendered (zero-root) current placeholder owns no presentation identity');
    assert.strictEqual(presentationMessage.getRenderedCurrentWorkspaceNavigationIdentity([
        { kind: 'current', navigationIdentity: 'navigation-dashboard', roots: workspaceCard.roots },
    ]), 'navigation-dashboard',
    'a rendered current card keeps owning the presentation identity');
    assert.strictEqual(aiMessage.searchCatalog.version, 3);
    assert.deepStrictEqual(aiMessage.searchCatalog.openWorkspaces.map(item => item.current), [true]);
    assert.ok(aiMessage.html.includes('data-current-workspace'));
    assert.ok(aiMessage.html.includes('data-session-icon-fx="halo"'),
        'AI session incremental updates must use the configured running icon animation');
    assert.ok(aiMessage.html.includes('data-session-fx="custom"'),
        'AI session incremental updates must preserve the independent running card animation');
    assert.strictEqual(workspaceSearchCatalog.version, 3);
    assert.deepStrictEqual(workspaceSearchCatalog.openWorkspaces.map(item => item.current), [true]);
    assert.deepStrictEqual(workspaceSearchCatalog.sessions.map(item => item.action), ['reveal-workspace-session']);
    assert.strictEqual(openWorkspacesMessage.type, 'open-workspaces-updated');
    assert.strictEqual(openWorkspacesMessage.version, 4);
    assert.strictEqual(openWorkspacesMessage.presentation.projectionRevision, 1);
    assert.strictEqual(openWorkspacesMessage.windowRowCount, 2);
    assert.strictEqual(openWorkspacesMessage.currentWindowRowCount, 1);
    assert.strictEqual(openWorkspacesMessage.navigationWindowRowCount, 1);
    assert.strictEqual(openWorkspacesMessage.currentDetailCount, 1);
    assert.strictEqual(openWorkspacesMessage.searchCatalog.version, 3);
    assert.strictEqual(openWorkspacesMessage.otherWindowsStatus, 'ready');
    assert.deepStrictEqual(
        openWorkspacesMessage.searchCatalog.openWorkspaces.map(item => item.action),
        ['show-current-workspace', 'switch-open-workspace'],
    );
    assert.ok(openWorkspacesMessage.html.includes('WINDOWS'));
    assert.strictEqual(openWorkspacesMessage.html.includes('OPEN WINDOWS'), false);
    assert.strictEqual(openWorkspacesMessage.html.includes('OTHER WINDOWS'), false);
    assert.ok(openWorkspacesMessage.html.includes('data-session-icon-fx="custom"'),
        'open-workspace incremental updates must use the configured running icon animation');
    assert.ok(openWorkspacesMessage.html.includes('data-session-fx="breath"'),
        'open-workspace incremental updates must preserve the independent running card animation');
}

function makeWorkspaceCardFixture(rootCount) {
    const roots = [
        { id: 'root-app', name: 'App', ordinal: 0 },
        { id: 'root-api', name: 'API', ordinal: 1 },
        { id: 'root-docs', name: 'Docs', ordinal: 2 },
    ].slice(0, rootCount);
    return {
        id: 'workspace-dashboard',
        kind: 'current',
        workspaceKind: 'savedMultiRoot',
        showSaveAction: false,
        runningSessionCount: 0,
        navigationIdentity: 'navigation-dashboard',
        scopeIdentity: 'scope-dashboard',
        name: 'Dashboard',
        environment: 'local',
        environmentLabel: 'Local',
        roots,
        attentionCount: 1,
        aiSessions: {
            workspaceScopeIdentity: 'scope-dashboard',
            workspaceNavigationIdentity: 'navigation-dashboard',
            activeProvider: 'codex',
            expanded: true,
            providers: [
                { id: 'codex', label: 'Codex', count: 1 },
                { id: 'kimi', label: 'Kimi', count: 0 },
                { id: 'claude', label: 'Claude', count: 0 },
            ],
            sessionsByProvider: {
                codex: [{
                    id: 'session-api', name: 'API work', provider: 'codex',
                    primaryRootId: 'root-api', primaryRootLabel: 'API',
                }],
                kimi: [],
                claude: [],
            },
            unavailableProviders: [],
            aiSessionCount: 1,
            attentionCount: 0,
            defaultTab: 'sessions',
            activeSessions: [{
                key: 'codex:session-api', provider: 'codex', sessionId: 'session-api', name: 'API work',
                executionState: 'running', focused: false, needsAttention: false, pending: false,
                backend: 'vscode', attached: true, primaryRootId: 'root-api', primaryRootLabel: 'API',
            }],
            activeSessionCount: 1,
            activeAttentionCount: 0,
        },
    };
}

function runWorkspaceCardRenderingChecks() {
    const previousModuleLoad = Module._load;
    let webviewContent;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return {};
            return previousModuleLoad.call(this, request, parent, isMain);
        };
        webviewContent = require('../out/webview/webviewContent');
    } finally {
        Module._load = previousModuleLoad;
    }
    const webviewAiSessionContent = require('../out/webview/webviewAiSessionContent');
    const icons = require('../out/webviewIcons');

    const emptyHtml = webviewContent.getOpenSessionSurfaceContent(null, false);
    assert.strictEqual((emptyHtml.match(/class="workspace-card/g) || []).length, 0);

    const emptyRootsHtml = webviewContent.getOpenSessionSurfaceContent(makeWorkspaceCardFixture(0), false);
    assert.strictEqual((emptyRootsHtml.match(/class="workspace-card/g) || []).length, 0,
        'a non-null invalid zero-root snapshot must render the empty current-workspace state');

    const collapsedSingleCard = makeWorkspaceCardFixture(1);
    collapsedSingleCard.aiSessions.expanded = false;
    const singleHtml = webviewContent.getOpenSessionSurfaceContent(collapsedSingleCard, false);
    assert.strictEqual((singleHtml.match(/class="workspace-card/g) || []).length, 0);
    assert.strictEqual((singleHtml.match(/class="codex-sessions"/g) || []).length, 1);
    assert.ok(singleHtml.includes('class="open-session-surface"'));
    assert.ok(singleHtml.includes('data-current-workspace'));
    assert.strictEqual(singleHtml.includes('class="ai-session-root-chip"'), false,
        'single-root workspaces must not repeat the only root on every session row');
    assert.ok(singleHtml.includes('class="codex-sessions" data-ai-session-region'),
        'the existing AI Sessions root must define the non-toggle click boundary');
    assert.strictEqual(singleHtml.includes('class="current-window-indicator"'), false,
        'the dedicated CURRENT WINDOW card must not duplicate the OPEN WINDOWS marker');
    assert.strictEqual(singleHtml.includes('data-action="toggle-open-workspace-pin"'), false,
        'Pin belongs to the WINDOWS list projection, not the lifted session surface');
    assert.strictEqual(singleHtml.includes('workspace-card-summary'), false,
        'the click boundary must not add a summary wrapper that could alter card layout');
    const coloredCurrentCard = makeWorkspaceCardFixture(1);
    coloredCurrentCard.color = '#123456';
    const coloredCurrentHtml = webviewContent.getOpenSessionSurfaceContent(coloredCurrentCard, false);
    assert.strictEqual(coloredCurrentHtml.includes('--project-color:'), false,
        'the lifted session surface does not inherit workspace-card color chrome');
    assert.ok(singleHtml.includes('class="project-codex-badge"'),
        'the lifted session surface renders its AI session summary badge directly');
    assert.strictEqual(singleHtml.includes('data-codex-expanded'), false,
        'the lifted session surface is permanently available, not collapsible');
    assert.strictEqual(singleHtml.includes('current-card-expanded'), false,
        'the retired current-card fit class must not be rendered');

    const runningCard = makeWorkspaceCardFixture(1);
    runningCard.aiSessions.activeSessions.push(
        {
            key: 'codex:session-starting', provider: 'codex', sessionId: 'session-starting', name: 'Starting',
            executionState: 'starting', focused: false, needsAttention: false, pending: true,
            backend: 'vscode', attached: true,
        },
        {
            key: 'codex:session-stopped', provider: 'codex', sessionId: 'session-stopped', name: 'Stopped',
            executionState: 'stopped', focused: false, needsAttention: false, pending: false,
            backend: 'vscode', attached: true,
        },
    );
    const orbitHtml = webviewContent.getOpenSessionSurfaceContent(runningCard, false, 'orbit');
    assert.ok(orbitHtml.includes('class="project-session-fx open-session-surface-fx" data-session-fx="orbit"'));
    assert.ok(orbitHtml.includes('data-session-fx="orbit"'));

    for (const animation of [
        'current',
        'sweep',
        'orbit',
        'halo',
        'ripple',
        'breath',
        'custom',
    ]) {
        const animationHtml = webviewContent.getOpenSessionSurfaceContent(runningCard, false, animation);
        assert.ok(animationHtml.includes(`data-session-fx="${animation}"`),
            `the current workspace card must accept the ${animation} running animation`);
        assert.ok(animationHtml.includes('open-session-surface-fx'));
    }
    const noneHtml = webviewContent.getOpenSessionSurfaceContent(runningCard, false, 'none');
    assert.strictEqual(noneHtml.includes('project-session-fx'), false,
        'none suppresses the optional surface animation layer');
    const invalidHtml = webviewContent.getOpenSessionSurfaceContent(runningCard, false, 'invalid');
    assert.ok(invalidHtml.includes('data-session-fx="current"'),
        'an invalid animation value must fail safely to current');

    const idleCard = makeWorkspaceCardFixture(1);
    idleCard.aiSessions.activeSessions = runningCard.aiSessions.activeSessions.filter(
        session => session.executionState !== 'running'
    );
    const idleHtml = webviewContent.getOpenSessionSurfaceContent(idleCard, false, 'halo');
    assert.strictEqual(idleHtml.includes('project-session-fx'), false,
        'starting and stopped sessions must not activate the surface animation');
    assert.strictEqual(idleHtml.includes('data-session-fx'), false);
    const unhydratedCard = makeWorkspaceCardFixture(1);
    delete unhydratedCard.aiSessions;
    unhydratedCard.attentionCount = 0;
    const unhydratedHtml = webviewContent.getOpenSessionSurfaceContent(unhydratedCard, false);
    assert.strictEqual((unhydratedHtml.match(/class="codex-sessions"/g) || []).length, 1,
        'a current card must keep one AI module while hydration is temporarily unavailable');
    assert.strictEqual(unhydratedHtml.includes('data-has-ai-session-badge'), false);

    const multiHtml = webviewContent.getOpenSessionSurfaceContent(makeWorkspaceCardFixture(3), false);
    assert.strictEqual((multiHtml.match(/class="workspace-card/g) || []).length, 0);
    assert.strictEqual((multiHtml.match(/class="codex-sessions"/g) || []).length, 1);
    assert.strictEqual(multiHtml.includes('class="workspace-root-tags"'), false);
    assert.strictEqual(multiHtml.includes('class="workspace-root-tag"'), false);
    assert.ok(multiHtml.includes('data-primary-root-id="root-api"'));
    assert.ok(multiHtml.includes('class="ai-session-root-chip"'));
    assert.ok(multiHtml.includes('class="ai-session-create-split-button"'),
        'the AI sessions header renders the split create button');
    assert.ok(multiHtml.includes('data-action="create-ai-session-quick"'));
    assert.ok(multiHtml.includes('data-provider="codex"'),
        'the quick-create button carries the active provider');
    assert.ok(multiHtml.includes('aria-label="New Codex session"'),
        'the quick-create button announces the provider it will launch');
    assert.ok(multiHtml.includes('data-action="create-ai-session-dropdown"'),
        'the split button keeps a dropdown entry for other providers');
    assert.ok(multiHtml.includes('data-tooltip="New Codex session"'),
        'the quick-create button names its provider in the fast tooltip');

    const captionSurface = {
        id: 'project-caption',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        activeAiSessionTab: 'sessions',
        codexSessions: [],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [],
        quickCreateProfile: 'deepseek',
    };
    const captionHtml = webviewAiSessionContent.getAiSessionsDiv(captionSurface);
    assert.ok(captionHtml.includes('aria-label="New Codex session with profile deepseek"'),
        'the quick button announces the effective profile');
    assert.ok(captionHtml.includes('data-tooltip="New Codex session with profile deepseek"'),
        'the quick button tooltip shows the provider and profile');

    const kimiCaptionHtml = webviewAiSessionContent.getAiSessionsDiv({
        ...captionSurface,
        activeAiSessionProvider: 'kimi',
        quickCreateProfile: 'deepseek',
    });
    assert.ok(kimiCaptionHtml.includes('data-tooltip="New Kimi session"'),
        'a non-codex provider never carries the codex profile');
    assert.ok(!kimiCaptionHtml.includes('ai-session-create-caption'),
        'no visible caption crowds the toolbar row');
    assert.ok(kimiCaptionHtml.includes('aria-label="New Kimi session"'));

    const rememberedHtml = webviewAiSessionContent.getAiSessionsDiv({
        ...captionSurface,
        activeAiSessionProvider: 'codex',
        quickCreateProvider: 'kimi',
        quickCreateProfile: 'deepseek',
    });
    assert.ok(rememberedHtml.includes('data-action="create-ai-session-quick" data-provider="kimi"'),
        'the quick button follows the remembered provider, not the list filter');
    assert.ok(rememberedHtml.includes('data-tooltip="New Kimi session"'),
        'the quick button tooltip follows the remembered provider');
    assert.ok(rememberedHtml.includes('data-active-ai-session-provider="codex"'),
        'the session list filter keeps its own primary provider');

    const escapingHtml = webviewAiSessionContent.getAiSessionsDiv({
        ...captionSurface,
        quickCreateProfile: 'x"<script>"',
    });
    assert.ok(!escapingHtml.includes('<script>'),
        'the caption and labels escape profile text');
    assert.ok(escapingHtml.includes('x&quot;&lt;script&gt;&quot;'));
    assert.strictEqual(multiHtml.includes('data-action="create-ai-session"'), false,
        'the header split button replaces the bare create action');

    const createDropdownHtml = webviewAiSessionContent.getAiSessionCreateDropdown();
    assert.ok(createDropdownHtml.includes('id="aiSessionCreateDropdown"'),
        'the create dropdown menu exists for the split button arrow');
    for (const provider of ['codex', 'kimi', 'claude']) {
        assert.ok(
            createDropdownHtml.includes(`data-action="create-ai-session-quick" data-provider="${provider}"`),
            `the create dropdown offers a quick ${provider} entry`
        );
    }
    assert.ok(createDropdownHtml.includes('data-action="create-ai-session"'),
        'the create dropdown keeps the full interactive entry');
    assert.strictEqual(multiHtml.includes('data-action="open-new-session-in"'), false);
    assert.strictEqual(multiHtml.includes('data-action="new-session-in"'), false);
    assert.strictEqual(multiHtml.includes('data-action="selected-project"'), false);
    assert.strictEqual(multiHtml.includes('data-project-navigation'), false);
    assert.strictEqual(multiHtml.includes('data-has-save-action'), false);

    const untitledWorkspaceCard = makeWorkspaceCardFixture(3);
    untitledWorkspaceCard.workspaceKind = 'untitledMultiRoot';
    untitledWorkspaceCard.showSaveAction = true;
    const untitledWorkspaceHtml = webviewContent.getOpenSessionSurfaceContent(
        untitledWorkspaceCard,
        false,
    );
    assert.strictEqual(untitledWorkspaceHtml.includes('data-has-save-action'), false,
        'workspace save chrome belongs to the WINDOWS row, not the session surface');
    assert.strictEqual(untitledWorkspaceHtml.includes('data-action="save-current-workspace"'), false);
    const projectActionMessages = [];
    const triggerProjectAction = new Function(
        'target',
        'projectId',
        'window',
        extractFunctionBody(readProjectWebviewSource(), 'onTriggerProjectAction'),
    );
    assert.strictEqual(triggerProjectAction({
        closest: selector => selector === '[data-action]'
            ? { getAttribute: attribute => attribute === 'data-action' ? 'save-current-workspace' : null }
            : null,
    }, untitledWorkspaceCard.id, {
        vscode: { postMessage: message => projectActionMessages.push(message) },
    }), true);
    assert.deepStrictEqual(projectActionMessages, [{
        type: 'save-current-workspace',
        projectId: untitledWorkspaceCard.id,
    }], 'the save badge must use its dedicated workspace-only host route');
    const unregisteredSavedWorkspace = makeWorkspaceCardFixture(3);
    unregisteredSavedWorkspace.showSaveAction = true;
    const unregisteredSavedWorkspaceHtml = webviewContent.getOpenSessionSurfaceContent(
        unregisteredSavedWorkspace,
        false,
    );
    assert.strictEqual(unregisteredSavedWorkspaceHtml.includes('data-action="save-current-workspace"'), false);

    const devContainerCard = makeWorkspaceCardFixture(1);
    devContainerCard.environment = 'devContainer';
    devContainerCard.environmentLabel = 'Dev Container';
    const devContainerHtml = webviewContent.getOpenSessionSurfaceContent(devContainerCard, false);
    assert.strictEqual(devContainerHtml.includes(icons.container), false,
        'workspace metadata is represented by the WINDOWS row, not the session surface');
    assert.strictEqual(devContainerHtml.includes('class="workspace-root-tags"'), false);
    assert.strictEqual(devContainerHtml.includes('class="workspace-root-tag"'), false);

    const outsideWorkspaceCard = makeWorkspaceCardFixture(3);
    outsideWorkspaceCard.aiSessions.sessionsByProvider.codex[0].primaryRootId = undefined;
    outsideWorkspaceCard.aiSessions.sessionsByProvider.codex[0].primaryRootLabel = 'Outside workspace';
    outsideWorkspaceCard.aiSessions.activeSessions[0].primaryRootId = undefined;
    outsideWorkspaceCard.aiSessions.activeSessions[0].primaryRootLabel = 'Outside workspace';
    const outsideWorkspaceHtml = webviewContent.getOpenSessionSurfaceContent(outsideWorkspaceCard, false);
    assert.strictEqual((outsideWorkspaceHtml.match(/>Outside workspace<\/span>/g) || []).length, 2,
        'history and active rows must render the removed-root continuity chip');

    const navigationCard = {
        ...makeWorkspaceCardFixture(1),
        id: 'workspace-other',
        kind: 'navigation',
        navigationIdentity: 'navigation-other',
        scopeIdentity: 'scope-other',
        name: 'App [Dev Container: Existing Dockerfile]',
        environment: 'devContainer',
        environmentLabel: 'Dev Container',
        runningSessionCount: 2,
        color: '#abcdef',
        aiSessions: runningCard.aiSessions,
    };
    const workspaceHtml = webviewContent.getOpenWorkspacesGroupContent(
        [makeWorkspaceCardFixture(3), navigationCard],
        'ready',
        'custom',
    );
    // The switcher replaces the dual CURRENT WINDOW / OPEN WINDOWS groups.
    assert.ok(workspaceHtml.includes('data-group-id="open-window-switcher"'));
    assert.strictEqual(workspaceHtml.includes('CURRENT WINDOW'), false);
    assert.strictEqual(workspaceHtml.includes('OPEN WINDOWS'), false);
    assert.strictEqual(workspaceHtml.includes('current-window-indicator'), false);
    assert.strictEqual(workspaceHtml.includes('open-tab-split-resizer'), false);
    const navigationRowStart = workspaceHtml.indexOf('data-id="workspace-other"');
    assert.ok(navigationRowStart !== -1, 'the navigation window row is rendered in the switcher');
    const navigationRow = workspaceHtml.slice(
        workspaceHtml.lastIndexOf('<div class="open-window-row', navigationRowStart),
        workspaceHtml.indexOf('data-action="retry-open-window-navigation"', navigationRowStart) + 80,
    );
    assert.ok(navigationRow.includes('data-workspace-navigation-identity="navigation-other"'));
    assert.ok(navigationRow.includes('data-window-kind="navigation"'));
    assert.ok(navigationRow.includes('<span class="open-window-name">App</span>'),
        'window rows must not repeat VS Code remote window decorations in their name');
    assert.ok(navigationRow.includes('open-window-env-chip">Dev Container<'),
        'remote windows carry the environment chip');
    assert.ok(navigationRow.includes('aria-label="Focus window: App'),
        'non-current rows announce the focus jump');
    assert.ok(navigationRow.includes('>●2</span>'),
        'running sessions show in the fixed running slot');
    assert.ok(navigationRow.includes('aria-label="Pin Window" aria-pressed="false"'));
    // 隐私：导航行不携带 session 级细节。
    for (const privateDetail of [
        'data-ai-session-total-count',
        'data-ai-session-attention-count',
        'Codex',
        'Kimi',
        'Claude',
        'codex-sessions',
        'data-session-id',
        'data-workspace-root-id',
    ]) {
        assert.strictEqual(navigationRow.includes(privateDetail), false,
            `window switcher rows must omit ${privateDetail}`);
    }
    // 当前行：恒标记本窗口、主按钮不跳转、pin 仍在。
    const currentRowStart = workspaceHtml.indexOf('open-window-row-current');
    assert.ok(currentRowStart !== -1, 'the current window row is rendered in the switcher');
    const currentRow = workspaceHtml.slice(
        currentRowStart - 200,
        workspaceHtml.indexOf('data-action="open-window-menu"', currentRowStart) + 500,
    );
    assert.ok(currentRow.includes('aria-current="true"'));
    assert.ok(currentRow.includes('aria-disabled="true"'));
    assert.ok(currentRow.includes('aria-label="Current window:'));
    assert.ok(currentRow.includes('data-action="toggle-open-workspace-pin"'));
    assert.strictEqual(currentRow.includes('open-window-env-chip'), false,
        'local windows do not carry an environment chip');
    assert.strictEqual(currentRow.includes('Local'), false);
    // PR-D：CHATS/ALL 已从 current-detail 卡片提升为一级 OPEN surface。
    assert.ok(workspaceHtml.includes('data-open-session-surface'));
    assert.strictEqual(workspaceHtml.includes('class="workspace-card'), false,
        'the lifted OPEN surface must not wrap sessions in a workspace-card element');
    assert.strictEqual((workspaceHtml.match(/data-current-workspace/g) || []).length, 1,
        'only the lifted OPEN session surface owns current-session behavior');
    assert.ok(workspaceHtml.includes('data-open-workspace-pin-live-region'));

    const pinnedWindowHtml = webviewContent.getOpenWorkspacesGroupContent([{
        ...navigationCard,
        pinned: true,
    }]);
    assert.ok(pinnedWindowHtml.includes(
        'class="open-window-pin active" data-action="toggle-open-workspace-pin" title="Unpin Window" aria-label="Unpin Window" aria-pressed="true"'
    ));

    const untitledNavigationHtml = webviewContent.getOpenWorkspacesGroupContent([{
        ...navigationCard,
        workspaceKind: 'untitledMultiRoot',
    }]);
    assert.strictEqual(untitledNavigationHtml.includes('data-action="save-current-workspace"'), false,
        'navigation window rows must never expose a save action');

    const updateRequiredHtml = webviewContent.getOpenWorkspacesGroupContent(
        [makeWorkspaceCardFixture(3)],
        'update-required',
    );
    assert.ok(updateRequiredHtml.includes('data-other-windows-status="update-required"'));
    assert.ok(updateRequiredHtml.includes('Update the Agent Pivot UI Bridge'));
    assert.ok(updateRequiredHtml.includes('data-action="open-bridge-extension"'),
        'the bridge mismatch state must include an actionable upgrade control');
    // bridge 未就绪：当前行置顶，其余行禁用。
    const firstRowIndex = updateRequiredHtml.indexOf('open-window-row-current');
    const navRowIndex = updateRequiredHtml.indexOf('data-window-kind="navigation"');
    assert.ok(firstRowIndex !== -1 && (navRowIndex === -1 || firstRowIndex < navRowIndex),
        'the current row stays on top while the bridge is not ready');
    assert.ok(updateRequiredHtml.includes('data-open-window-switcher-status'),
        'the bridge state renders inside the fixed switcher status slot');
    assert.ok(updateRequiredHtml.includes('data-action="create-ai-session-quick"'),
        'the local current workspace quick-create action must remain enabled during bridge degradation');

    const projectSource = readProjectWebviewSource();
    const consistencyBody = extractFunctionBody(projectSource, 'isWorkspaceUpdateDomConsistent');
    assert.ok(consistencyBody.includes('currentWorkspaceCount'));
    assert.strictEqual(/rootCount|sessionCount|aiSessionCount/.test(consistencyBody), false,
        'current-card DOM consistency must not equate card count with roots or sessions');
    const stateBody = extractFunctionBody(projectSource, 'getWorkspaceUpdateDomState');
    assert.ok(stateBody.includes('[data-open-session-surface]'));
    assert.ok(stateBody.includes('data-workspace-scope-identity'));
    assert.strictEqual(/workspace-root|codex-session-row/.test(stateBody), false);

    const preservedOtherNavigationCard = {
        matches: selector => selector === '.workspace-card[data-other-workspace]',
        textContent: 'Other Workspace · SSH · 2 folders',
    };
    const preservedOtherWindowsGroup = {
        matches: selector => selector === '.open-other-windows-group',
        children: [preservedOtherNavigationCard],
        querySelector: selector => selector === '.workspace-card[data-other-workspace]'
            ? preservedOtherNavigationCard
            : null,
    };
    const replacementSurface = {
        matches: selector => selector === '[data-open-session-surface]',
        hasAttribute: attribute => attribute === 'data-current-workspace'
            || attribute === 'data-workspace-scope-identity',
        querySelectorAll: () => [],
    };
    let mountedCurrentSurface;
    let successfulWrapper;
    const replaceableCurrentSurface = {
        matches: selector => selector === '[data-open-session-surface]',
        hasAttribute: attribute => attribute === 'data-current-workspace'
            || attribute === 'data-workspace-scope-identity',
        replaceWith: replacement => {
            const currentIndex = successfulWrapper.children.indexOf(replaceableCurrentSurface);
            assert.notStrictEqual(currentIndex, -1, 'the fake session surface must be mounted before replacement');
            successfulWrapper.children.splice(currentIndex, 1, replacement);
            mountedCurrentSurface = replacement;
        },
    };
    successfulWrapper = {
        children: [preservedOtherWindowsGroup, replaceableCurrentSurface],
        querySelector(selector) {
            if (selector === '[data-open-session-surface]') {
                return this.children.find(node => node.matches?.(selector)) || null;
            }
            if (selector === '.open-other-windows-group') {
                return this.children.find(node => node.matches?.(selector)) || null;
            }
            if (selector === '.workspace-card[data-other-workspace]') {
                return this.querySelector('.open-other-windows-group')?.querySelector(selector) || null;
            }
            return null;
        },
        querySelectorAll: () => [],
    };
    const successfulContext = {
        document: {
            querySelector: selector => selector === '.sticky-groups-wrapper' ? successfulWrapper : null,
            createElement: () => ({
                children: [replacementSurface],
                firstElementChild: replacementSurface,
                set innerHTML(_value) {},
            }),
        },
        window: {},
    };
    vm.runInNewContext(projectSource, successfulContext);
    assert.strictEqual(successfulContext.applyWorkspaceUpdate({
        type: 'workspace-updated', version: 2, currentWorkspaceCount: 1,
        html: '<div data-open-session-surface data-current-workspace data-workspace-scope-identity></div>',
    }), true);
    assert.strictEqual(mountedCurrentSurface, replacementSurface,
        'a valid session-surface update must replace the current surface');
    assert.deepStrictEqual(successfulWrapper.children, [preservedOtherWindowsGroup, replacementSurface],
        'a session-surface update must preserve the real WINDOWS switcher sibling');
    assert.strictEqual(successfulWrapper.querySelector('.open-other-windows-group'), preservedOtherWindowsGroup,
        'the same OTHER WINDOWS node must remain mounted');
    assert.strictEqual(
        successfulWrapper.querySelector('.workspace-card[data-other-workspace]'),
        preservedOtherNavigationCard,
        'the same other-window navigation card must survive current-group replacement',
    );
    assert.ok(preservedOtherNavigationCard.textContent.includes('Other Workspace · SSH · 2 folders'),
        'the surviving navigation card must retain its content');

    const stableCardId = '__currentWorkspace-stable-scope';
    let persistedState = {};
    const vscodeApi = {
        getState: () => persistedState,
        setState: state => { persistedState = state; },
    };
    function makeTabSurface(cardId) {
        const attributes = {};
        const sessionSection = { setAttribute: (name, value) => { attributes[name] = value; } };
        const tabs = ['active', 'sessions'].map(tab => {
            const values = { 'data-ai-session-tab': tab };
            return {
                getAttribute: name => values[name] || null,
                setAttribute: (name, value) => { values[name] = value; },
            };
        });
        const panels = ['active', 'sessions'].map(tab => ({
            getAttribute: name => name === 'data-ai-session-panel' ? tab : null,
            toggleAttribute: (name, enabled) => { attributes[`${tab}:${name}`] = enabled; },
        }));
        return {
            attributes,
            getAttribute: name => name === 'data-id' ? cardId : null,
            querySelector: selector => selector === '.codex-sessions' ? sessionSection : null,
            querySelectorAll: selector => selector === '[data-ai-session-tab]'
                ? tabs
                : selector === '[data-ai-session-panel]' ? panels : [],
        };
    }
    const untitledSurface = makeTabSurface(stableCardId);
    const savedSurface = makeTabSurface(stableCardId);
    const stateContext = { document: {}, window: {} };
    vm.runInNewContext(projectSource, stateContext);
    const zeroRootSessionSurface = {
        matches: selector => selector === '[data-open-session-surface]',
        hasAttribute: () => false,
        querySelectorAll: () => [],
    };
    assert.strictEqual(stateContext.isWorkspaceUpdateDomConsistent({ currentWorkspaceCount: 0 }, zeroRootSessionSurface), true,
        'a zero-root resolver message must be DOM-consistent with an empty session surface');
    assert.strictEqual(stateContext.isWorkspaceUpdateDomConsistent({ currentWorkspaceCount: 1 }, zeroRootSessionSurface), false,
        'the incremental consistency guard must reject a declared 1/rendered 0 split');
    stateContext.writeAiSessionTabState(vscodeApi, stableCardId, 'chats');
    stateContext.restoreAiSessionTabsFromState({
        querySelectorAll: () => [savedSurface],
    }, vscodeApi);
    assert.strictEqual(savedSurface.attributes['data-selected-ai-session-tab'], 'chats',
        'CHATS tab state must survive untitled-to-saved navigation identity changes');
    stateContext.writeAiSessionTabState(vscodeApi, stableCardId, 'all');
    stateContext.restoreAiSessionTabsFromState({
        querySelectorAll: () => [untitledSurface],
    }, vscodeApi);
    assert.strictEqual(untitledSurface.attributes['data-selected-ai-session-tab'], 'all',
        'ALL tab state must remain keyed by the stable scope-owned card ID');
}

function createSearchResultElement(tagName) {
    const element = {
        tagName: String(tagName || '').toUpperCase(),
        children: [],
        dataset: {},
        attributes: {},
        className: '',
        textContent: '',
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        removeChild(child) {
            this.children.splice(this.children.indexOf(child), 1);
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
    };
    Object.defineProperty(element, 'firstChild', {
        get: () => element.children[0] || null,
    });
    element.classList = {
        add: value => {
            const classes = new Set(element.className.split(/\s+/).filter(Boolean));
            classes.add(value);
            element.className = Array.from(classes).join(' ');
        },
        toggle: (value, force) => {
            const classes = new Set(element.className.split(/\s+/).filter(Boolean));
            if (force) classes.add(value);
            else classes.delete(value);
            element.className = Array.from(classes).join(' ');
        },
        contains: value => element.className.split(/\s+/).includes(value),
    };
    return element;
}

function runErrorContentChecks() {
    const html = dashboardErrorContent.getErrorContent(new Error('<script>alert("x")</script>'));
    assert.ok(html.includes('Agent Pivot could not render this view.'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
    assert.strictEqual(html.includes('<script>alert("x")</script>'), false);

    assert.strictEqual(
        dashboardErrorContent.escapeHtml(`<&>"'`),
        '&lt;&amp;&gt;&quot;&#39;'
    );
}

function makeWorkspaceConfiguration(values, inspectedKeys = Object.keys(values), fallbackValues = {}) {
    return {
        get: (key, defaultValue) => Object.prototype.hasOwnProperty.call(values, key)
            ? values[key]
            : (Object.prototype.hasOwnProperty.call(fallbackValues, key) ? fallbackValues[key] : defaultValue),
        inspect: key => inspectedKeys.includes(key)
            ? { globalValue: Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined }
            : undefined,
        update: () => 'primary-update',
        passthrough: 'primary-passthrough',
    };
}

function runConfigurationChecks() {
    const config = makeWorkspaceConfiguration({ customCss: '.agent-pivot{}' });
    const scope = { uri: 'fixture://workspace' };
    workspaceConfigurationResolver = () => config;
    configurationReads.length = 0;

    assert.strictEqual(dashboardConfiguration.getAgentPivotConfiguration(scope), config);
    assert.deepStrictEqual(configurationReads, [['agentPivot', scope]]);
}

function runStartupChecks() {
    assert.strictEqual(dashboardStartup.shouldOpenAgentPivotOnStartup({
        reopenReason: 1,
        openOnStartup: 'never',
        workspaceName: 'project',
        visibleEditorLanguageIds: ['typescript'],
    }), true);
    assert.strictEqual(dashboardStartup.shouldOpenAgentPivotOnStartup({
        openOnStartup: 'always',
        workspaceName: 'project',
        visibleEditorLanguageIds: ['typescript'],
    }), true);
    assert.strictEqual(dashboardStartup.shouldOpenAgentPivotOnStartup({
        openOnStartup: 'never',
        workspaceName: '',
        visibleEditorLanguageIds: [],
    }), false);
    assert.strictEqual(dashboardStartup.shouldOpenAgentPivotOnStartup({
        openOnStartup: 'empty workspace',
        workspaceName: '',
        visibleEditorLanguageIds: [],
    }), true);
    assert.strictEqual(dashboardStartup.shouldOpenAgentPivotOnStartup({
        openOnStartup: 'empty workspace',
        workspaceName: '',
        visibleEditorLanguageIds: ['code-runner-output'],
    }), true);
    assert.strictEqual(dashboardStartup.shouldOpenAgentPivotOnStartup({
        openOnStartup: 'empty workspace',
        workspaceName: 'project',
        visibleEditorLanguageIds: [],
    }), false);
    assert.strictEqual(dashboardStartup.shouldOpenAgentPivotOnStartup({
        openOnStartup: 'empty workspace',
        workspaceName: '',
        visibleEditorLanguageIds: ['typescript'],
    }), false);
}

function runWebviewOptionsChecks() {
    const options = dashboardWebviewOptions.getDashboardWebviewOptions('/extensions/agent-pivot', value => ({ uri: value }));
    assert.strictEqual(options.enableScripts, true);
    assert.deepStrictEqual(options.localResourceRoots, [{ uri: path.join('/extensions/agent-pivot', 'media') }]);
}

async function runGroupCollapseControllerChecks() {
    const updates = [];
    const groups = new Map([
        ['group-a', { id: 'group-a', groupName: 'A', collapsed: false }],
        ['group-b', { id: 'group-b', groupName: 'B', collapsed: true }],
    ]);
    const projectServiceUpdates = [];
    const controller = new GroupCollapseController({
        state: {
            get: key => key === 'favoritesGroupCollapsed' ? true : undefined,
            update: async (key, value) => { updates.push([key, value]); },
        },
        projectService: {
            getGroup: groupId => groups.get(groupId) || null,
            updateGroup: async (groupId, group) => { projectServiceUpdates.push([groupId, { ...group }]); },
        },
    });

    assert.strictEqual(controller.getFavoritesCollapsed(), true);

    await controller.collapseGroup('__favorites', true);
    await controller.collapseGroup('group-a');
    await controller.collapseGroup('group-b', false);
    await controller.collapseGroup('missing-group', true);

    // The OPEN tab window switcher is not collapsible by design; the legacy
    // __openWorkspaces key is gone and such ids fall through to the project
    // service like any unknown group.
    assert.deepStrictEqual(updates, [
        ['favoritesGroupCollapsed', true],
    ]);
    assert.deepStrictEqual(projectServiceUpdates, [
        ['group-a', { id: 'group-a', groupName: 'A', collapsed: true }],
        ['group-b', { id: 'group-b', groupName: 'B', collapsed: false }],
    ]);
}

async function runGroupPromptChecks() {
    const calls = [];
    const groupName = await queryGroupName(
        {
            showInputBox: async options => {
                calls.push(options);
                return 'Renamed Group';
            },
        },
        'Existing Group'
    );
    assert.strictEqual(groupName, 'Renamed Group');
    assert.strictEqual(calls[0].value, 'Existing Group');
    assert.deepStrictEqual(calls[0].valueSelection, [0, 'Existing Group'.length]);
    assert.strictEqual(calls[0].placeHolder, 'Group Name');
    assert.strictEqual(calls[0].ignoreFocusOut, true);
    assert.strictEqual(calls[0].validateInput(''), 'A Group Name must be provided.');
    assert.strictEqual(calls[0].validateInput('Group'), '');

    await assert.rejects(
        () => queryGroupName({ showInputBox: async () => undefined }),
        /CanceledByUser/
    );
}

async function runGroupCommandControllerChecks() {
    const groups = new Map([['group-a', { id: 'group-a', groupName: 'Old' }]]);
    const actions = [];
    const errors = [];
    let nextPrompt = 'New Group';
    let nextConfirmation = 'Remove';
    const controller = new GroupCommandController({
        projectService: {
            addGroup: async groupName => actions.push(['add', groupName]),
            getGroup: groupId => groups.get(groupId) || null,
            updateGroup: async (groupId, group) => actions.push(['update', groupId, { ...group }]),
            removeGroup: async groupId => actions.push(['remove', groupId]),
        },
        promptGroupName: async defaultText => {
            actions.push(['prompt', defaultText || null]);
            if (nextPrompt instanceof Error) {
                throw nextPrompt;
            }
            return nextPrompt;
        },
        confirmRemoveGroup: async groupName => {
            actions.push(['confirm', groupName]);
            return nextConfirmation;
        },
        showErrorMessage: message => errors.push(message),
        refreshAfterMutation: () => actions.push(['refresh']),
        userCanceledToken: 'CanceledByUser',
    });

    await controller.addGroup();
    await controller.editGroup('group-a');
    await controller.removeGroup('group-a');
    await controller.removeGroup('missing');
    assert.deepStrictEqual(actions, [
        ['prompt', null],
        ['add', 'New Group'],
        ['refresh'],
        ['prompt', 'Old'],
        ['update', 'group-a', { id: 'group-a', groupName: 'New Group' }],
        ['refresh'],
        ['confirm', 'New Group'],
        ['remove', 'group-a'],
        ['refresh'],
    ]);

    nextPrompt = new Error('CanceledByUser');
    await controller.addGroup();
    assert.strictEqual(actions.filter(action => action[0] === 'refresh').length, 3);

    nextPrompt = new Error('boom');
    await assert.rejects(() => controller.editGroup('group-a'), /boom/);
    assert.deepStrictEqual(errors.slice(-1), ['An error occured while editing the group.']);

    nextConfirmation = undefined;
    await controller.removeGroup('group-a');
    assert.strictEqual(actions.filter(action => action[0] === 'remove').length, 1);
}

async function runAddProjectsFromFolderControllerChecks() {
    const actions = [];
    const errors = [];
    let selectedFolders = [{ fsPath: '/work/tools' }];
    let foldersInSelectedPath = ['/work/tools/api', '/work/tools/web'];
    const controller = new AddProjectsFromFolderController({
        getCurrentWorkspacePath: () => '/work/current',
        parsePathAsUri: value => ({ uri: value }),
        showOpenDialog: async options => {
            actions.push(['dialog', options.defaultUri, options.openLabel]);
            return selectedFolders;
        },
        getFolders: async folderPath => {
            actions.push(['get-folders', folderPath]);
            if (foldersInSelectedPath instanceof Error) {
                throw foldersInSelectedPath;
            }
            return foldersInSelectedPath;
        },
        addGroup: async groupName => {
            actions.push(['add-group', groupName]);
            return { id: 'group-tools' };
        },
        addProject: async (project, groupId) => actions.push(['add-project', project.name, project.path, project.color, project.isGitRepo, groupId]),
        getRandomColor: () => '#abcdef',
        isFolderGitRepo: folder => folder.endsWith('/api'),
        showErrorMessage: message => errors.push(message),
        refreshAfterMutation: () => actions.push(['refresh']),
        userCanceledToken: 'CanceledByUser',
    });

    await controller.addProjectsFromFolder();
    assert.deepStrictEqual(actions, [
        ['dialog', { uri: '/work/current' }, 'Select Folder containing Projects'],
        ['get-folders', '/work/tools'],
        ['add-group', 'tools'],
        ['add-project', 'api', '/work/tools/api', '#abcdef', true, 'group-tools'],
        ['add-project', 'web', '/work/tools/web', '#abcdef', false, 'group-tools'],
        ['refresh'],
    ]);

    selectedFolders = [];
    await controller.addProjectsFromFolder();
    assert.strictEqual(actions.filter(action => action[0] === 'refresh').length, 1);

    selectedFolders = [{ fsPath: '/work/broken' }];
    foldersInSelectedPath = new Error('boom');
    await assert.rejects(() => controller.addProjectsFromFolder(), /boom/);
    assert.deepStrictEqual(errors.slice(-1), ['An error occured while adding the projects.']);
}

async function runFavoriteProjectControllerChecks() {
    let groups = [{
        id: 'group-a',
        groupName: 'A',
        projects: [
            { id: 'a', name: 'A', favorite: true, favoriteOrder: 0 },
            { id: 'b', name: 'B' },
        ],
    }];
    const saved = [];
    const actions = [];
    const controller = new FavoriteProjectController({
        getGroups: () => groups,
        saveGroups: async nextGroups => {
            saved.push(nextGroups);
            groups = nextGroups;
        },
        refreshAfterMutation: () => actions.push('refresh'),
    });

    await controller.toggleProjectFavorite('b');
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0][0].projects.find(project => project.id === 'b').favorite, true);
    assert.deepStrictEqual(saved[0][0].projects.filter(project => project.favorite).map(project => project.id), ['a', 'b']);
    assert.deepStrictEqual(actions, ['refresh']);

    await controller.toggleProjectFavorite('missing');
    assert.strictEqual(saved.length, 1);
    assert.deepStrictEqual(actions, ['refresh']);

    await controller.reorderFavoriteProjects(['b', 'a']);
    assert.strictEqual(saved.length, 2);
    assert.deepStrictEqual(
        saved[1][0].projects.filter(project => project.favorite).sort((left, right) => left.favoriteOrder - right.favoriteOrder).map(project => project.id),
        ['b', 'a']
    );
    assert.deepStrictEqual(actions, ['refresh', 'refresh']);
}

async function runProjectOrderControllerChecks() {
    const groups = [
        {
            id: 'group-a',
            groupName: 'A',
            projects: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }],
        },
        {
            id: 'group-b',
            groupName: 'B',
            projects: [{ id: 'b1', name: 'B1' }],
        },
    ];
    const saved = [];
    const informationMessages = [];
    const actions = [];
    const controller = new ProjectOrderController({
        getGroups: () => groups,
        saveGroups: async nextGroups => saved.push(nextGroups),
        showInformationMessage: message => informationMessages.push(message),
        refreshAfterMutation: () => actions.push('refresh'),
    });

    await controller.reorderGroups(null);
    assert.deepStrictEqual(informationMessages, ['Invalid Argument passed to Reordering Projects.']);
    assert.deepStrictEqual(saved, []);
    assert.deepStrictEqual(actions, []);

    await controller.reorderGroups([
        { groupId: 'group-b', projectIds: ['b1', 'a1'] },
        { groupId: 'missing-group', projectIds: ['a2', 'missing-project'] },
    ]);
    assert.strictEqual(saved.length, 1);
    assert.deepStrictEqual(saved[0].map(group => ({
        id: group.id,
        groupName: group.groupName,
        projectIds: group.projects.map(project => project.id),
    })), [
        { id: 'group-b', groupName: 'B', projectIds: ['b1', 'a1'] },
        { id: saved[0][1].id, groupName: 'Group #2', projectIds: ['a2'] },
    ]);
    assert.deepStrictEqual(actions, ['refresh']);
}

async function runProjectRemovalControllerChecks() {
    const projects = new Map([['project-a', { id: 'project-a', name: 'Alpha' }]]);
    const actions = [];
    let nextConfirmation = 'Remove';
    const controller = new ProjectRemovalController({
        getProject: projectId => projects.get(projectId) || null,
        confirmRemoveProject: async projectName => {
            actions.push(['confirm', projectName]);
            return nextConfirmation;
        },
        removeProject: async projectId => actions.push(['remove', projectId]),
        refreshAfterMutation: () => actions.push(['refresh']),
    });

    await controller.removeProject('project-a');
    await controller.removeProject('missing');
    nextConfirmation = undefined;
    await controller.removeProject('project-a');

    assert.deepStrictEqual(actions, [
        ['confirm', 'Alpha'],
        ['remove', 'project-a'],
        ['refresh'],
        ['confirm', 'Alpha'],
    ]);
}

async function runDashboardRuntimeControllerChecks() {
    const commands = [];
    const refreshes = [];
    const diagnostics = [];
    const published = [];
    const posted = [];
    const colorSyncs = [];
    const errors = [];
    const projects = [{ id: 'project-a', path: '/work/a' }];
    let visible = true;
    let focusFails = true;
    const baseOptions = {
        isVisible: () => visible,
        refreshProvider: () => refreshes.push('refresh'),
        logDashboardDiagnostic: event => diagnostics.push(event),
        executeCommand: (command, ...args) => {
            commands.push([command, ...args]);
            if (command.endsWith('.focus') && focusFails) {
                focusFails = false;
                return Promise.reject(new Error('focus failed once'));
            }
            return Promise.resolve();
        },
        viewType: 'agent-pivot.views.sidebar',
        publishOpenWorkspace: () => published.push('open-workspace'),
        getCurrentSavedProject: () => projects[0],
        syncProjectColorToCurrentWindow: project => {
            colorSyncs.push(project);
            return Promise.resolve();
        },
        postMessage: message => {
            posted.push(message);
            return Promise.resolve(true);
        },
        logError: (message, error) => errors.push([message, error?.message]),
    };
    const controller = new DashboardRuntimeController(baseOptions);

    controller.refresh('manual');
    assert.deepStrictEqual(refreshes, ['refresh']);
    assert.deepStrictEqual(diagnostics, [{ event: 'full-refresh', reason: 'manual' }]);

    visible = false;
    controller.refresh('hidden');
    assert.deepStrictEqual(refreshes, ['refresh']);

    visible = true;
    await controller.showAgentPivot();
    assert.deepStrictEqual(published, ['open-workspace']);
    assert.deepStrictEqual(commands, [
        ['workbench.view.extension.agentPivot'],
        ['agent-pivot.views.sidebar.focus'],
        ['agent-pivot.views.sidebar.focus'],
    ]);
    assert.deepStrictEqual(diagnostics.slice(-1), [{ event: 'full-refresh', reason: 'show-agent-pivot' }]);

    await controller.openSettings();
    assert.deepStrictEqual(commands[commands.length - 1], ['workbench.action.openSettings', '@ext:hzcheng.agent-pivot']);

    controller.postBatchArchiveCompletion({ type: 'ai-session-batch-archive-completed', projectId: 'p', provider: 'codex', status: 'finished' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(posted.map(message => message.type), [
        'ai-session-batch-archive-completed',
    ]);

    controller.applyProjectColorToCurrentWindow();
    controller.applyProjectColorToCurrentWindow({ id: 'save', showSaveAction: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(colorSyncs, [projects[0], { id: 'save', showSaveAction: true }]);

    controller.refreshAfterMutation();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(colorSyncs, [projects[0], { id: 'save', showSaveAction: true }, projects[0]]);
    assert.deepStrictEqual(diagnostics.slice(-1), [{ event: 'full-refresh', reason: 'project-mutation' }]);
    assert.deepStrictEqual(published, ['open-workspace', 'open-workspace']);

    const failingController = new DashboardRuntimeController({
        ...baseOptions,
        syncProjectColorToCurrentWindow: () => Promise.reject(new Error('color failed')),
        postMessage: () => Promise.reject(new Error('post failed')),
    });
    failingController.applyProjectColorToCurrentWindow(projects[0]);
    failingController.postBatchArchiveCompletion({ type: 'ai-session-batch-archive-completed', projectId: 'p', provider: 'codex', status: 'finished' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(errors.slice(-2).map(item => item[0]), [
        'Failed to apply project color to current window.',
        'Failed to post batch AI session archive completion.',
    ]);

    const syncThrowErrors = [];
    const syncThrowController = new DashboardRuntimeController({
        ...baseOptions,
        executeCommand: () => { throw new Error('command threw'); },
        syncProjectColorToCurrentWindow: () => { throw new Error('color threw'); },
        postMessage: () => { throw new Error('post threw'); },
        logError: (message, error) => syncThrowErrors.push([message, error?.message]),
    });
    await syncThrowController.revealAgentPivotDashboard();
    syncThrowController.applyProjectColorToCurrentWindow(projects[0]);
    syncThrowController.postBatchArchiveCompletion({ type: 'ai-session-batch-archive-completed', projectId: 'p', provider: 'codex', status: 'finished' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(syncThrowErrors, [
        ['Failed to apply project color to current window.', 'color threw'],
        ['Failed to post batch AI session archive completion.', 'post threw'],
    ]);
}

async function runDashboardStartupControllerChecks() {
    const extensionChecks = [];
    const publications = [];
    const informationMessages = [];
    const colorApplications = [];
    const reopenUpdates = [];
    let migrated = true;
    let showAgentPivotCalls = 0;
    let reopenReason = 0;
    let workspaceName = 'workspace';
    let visibleEditorLanguageIds = ['typescript'];
    const stewardInfos = {
        relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
        config: { openOnStartup: 'never' },
    };
    const migrationResult = projectsMigrated => ({
        projects: { migrated: projectsMigrated },
    });
    const controller = new DashboardStartupController({
        stewardInfos,
        relevantExtensions: {
            remoteSSH: 'ms-vscode-remote.remote-ssh',
            remoteContainers: 'ms-vscode-remote.remote-containers',
        },
        isExtensionInstalled: extensionId => {
            extensionChecks.push(extensionId);
            return extensionId.endsWith('remote-ssh');
        },
        migrateDataIfNeeded: async () => migrationResult(migrated),
        refreshDashboard: () => undefined,
        publishOpenWorkspace: () => publications.push('published'),
        showInformationMessage: message => informationMessages.push(message),
        showAgentPivot: () => { showAgentPivotCalls += 1; },
        applyProjectColorToCurrentWindow: () => colorApplications.push('applied'),
        getReopenReason: () => reopenReason,
        updateReopenReason: value => reopenUpdates.push(value),
        reopenNoneValue: 0,
        getWorkspaceName: () => workspaceName,
        getVisibleEditorLanguageIds: () => visibleEditorLanguageIds,
    });

    await controller.checkDataMigration();
    assert.deepStrictEqual(publications, ['published']);
    assert.strictEqual(informationMessages.length, 1);
    assert.strictEqual(showAgentPivotCalls, 0);

    migrated = false;
    await controller.checkDataMigration(true);
    assert.deepStrictEqual(publications, ['published']);
    assert.strictEqual(showAgentPivotCalls, 0);

    migrated = true;
    await controller.checkDataMigration(true);
    assert.deepStrictEqual(publications, ['published', 'published']);
    assert.strictEqual(showAgentPivotCalls, 1);

    reopenReason = 1;
    await controller.startUp();
    assert.deepStrictEqual(extensionChecks, [
        'ms-vscode-remote.remote-ssh',
        'ms-vscode-remote.remote-containers',
    ]);
    assert.deepStrictEqual(stewardInfos.relevantExtensionsInstalls, { remoteSSH: true, remoteContainers: false });
    assert.deepStrictEqual(colorApplications, ['applied']);
    assert.deepStrictEqual(reopenUpdates, [0]);
    assert.strictEqual(showAgentPivotCalls, 2);

    reopenReason = 0;
    workspaceName = '';
    visibleEditorLanguageIds = ['code-runner-output'];
    stewardInfos.config = { openOnStartup: 'empty workspace' };
    await controller.startUp();
    assert.strictEqual(showAgentPivotCalls, 3);

    const startupOrdering = [];
    const orderedController = new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: async () => {
            startupOrdering.push('project-migration');
            return migrationResult(true);
        },
        afterProjectMigrationSucceeded: async () => {
            startupOrdering.push('pending-workspace-save');
        },
        refreshDashboard: () => startupOrdering.push('refresh'),
        publishOpenWorkspace: () => startupOrdering.push('publish'),
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        logError: () => undefined,
        showAgentPivot: () => undefined,
        applyProjectColorToCurrentWindow: () => startupOrdering.push('color'),
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });
    await orderedController.startUp();
    assert.deepStrictEqual(startupOrdering, [
        'project-migration', 'refresh', 'publish', 'pending-workspace-save', 'color',
    ], 'pending workspace save completion must run once after successful project migration');

    const failedProjectMigration = new Error('project migration failed');
    const failedProjectOrdering = [];
    const failedProjectController = new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: async () => ({
            projects: { migrated: false, error: failedProjectMigration },
        }),
        afterProjectMigrationSucceeded: async () => {
            failedProjectOrdering.push('pending-workspace-save');
        },
        refreshDashboard: () => undefined,
        publishOpenWorkspace: () => undefined,
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        logError: () => undefined,
        showAgentPivot: () => undefined,
        applyProjectColorToCurrentWindow: () => failedProjectOrdering.push('color'),
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });
    await failedProjectController.startUp();
    assert.deepStrictEqual(failedProjectOrdering, ['color'],
        'project migration failure must retain pending intent while allowing the remaining startup behavior');

    const migrationErrors = [];
    const migrationLogs = [];
    const retryPublications = [];
    const retryRefreshes = [];
    let rejectMigration;
    let migrationAttempts = 0;
    const rejectedMigration = new Promise((_resolve, reject) => { rejectMigration = reject; });
    const failureController = new DashboardStartupController({
        stewardInfos,
        relevantExtensions: {
            remoteSSH: 'ms-vscode-remote.remote-ssh',
            remoteContainers: 'ms-vscode-remote.remote-containers',
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: () => {
            migrationAttempts += 1;
            return migrationAttempts === 1
                ? rejectedMigration
                : Promise.resolve(migrationResult(true));
        },
        refreshDashboard: () => retryRefreshes.push('refreshed'),
        publishOpenWorkspace: () => retryPublications.push('published'),
        showInformationMessage: () => undefined,
        showErrorMessage: message => migrationErrors.push(message),
        logError: (message, error) => migrationLogs.push([message, error]),
        showAgentPivot: () => undefined,
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });
    const failedCheck = failureController.checkDataMigration();
    const startupMigrationFailure = new Error('project migration write failed');
    rejectMigration(startupMigrationFailure);
    await failedCheck;
    assert.strictEqual(migrationErrors.length, 1,
        'migration failure must be visible to the user');
    assert.ok(migrationErrors[0].includes('project migration write failed'));
    assert.deepStrictEqual(migrationLogs,
        [['Failed to migrate Agent Pivot data.', startupMigrationFailure]],
        'migration failure must be logged without escaping as an unhandled rejection');
    assert.deepStrictEqual(retryPublications, []);
    assert.deepStrictEqual(retryRefreshes, []);

    await failureController.checkDataMigration();
    assert.strictEqual(migrationAttempts, 2);
    assert.deepStrictEqual(retryRefreshes, ['refreshed'],
        'a successful migration retry must resend the full dashboard catalog');
    assert.deepStrictEqual(retryPublications, ['published'],
        'a successful retry must resume post-migration publication');
}

async function runDashboardLifecycleControllerChecks() {
    const events = [];
    const controller = new DashboardLifecycleController({
        checkDataMigration: async openStewardAfterMigrate => events.push(['migrate', openStewardAfterMigrate]),
        applyProjectColorToCurrentWindow: () => events.push(['color']),
        refresh: reason => events.push(['refresh', reason]),
        publishOpenWorkspace: followsFocusEvent => events.push(['publish', followsFocusEvent]),
        evaluateAiSessionAttention: () => events.push(['attention']),
    });
    const makeConfigurationEvent = affectedSections => ({
        affectsConfiguration: section => affectedSections.some(affectedSection =>
            affectedSection === section || affectedSection.startsWith(`${section}.`)),
    });

    await controller.handleConfigurationChanged(makeConfigurationEvent(['agentPivot.storeProjectsInSettings']));
    assert.deepStrictEqual(events, [
        ['migrate', false],
        ['color'],
        ['refresh', 'configuration-changed'],
        ['publish', undefined],
    ]);

    events.length = 0;
    await controller.handleConfigurationChanged(makeConfigurationEvent(['agentPivot']));
    assert.deepStrictEqual(events, [
        ['color'],
        ['refresh', 'configuration-changed'],
        ['publish', undefined],
    ]);

    events.length = 0;
    await controller.handleConfigurationChanged(makeConfigurationEvent(['unrelated']));
    assert.deepStrictEqual(events, []);

    const lifecycleControllerSource = fs.readFileSync(
        path.join(root, 'src', 'dashboard', 'lifecycleController.ts'),
        'utf8',
    );
    assert.ok(lifecycleControllerSource.includes("'aiSessionRunningIconAnimation'"),
        'the icon setting must be included in the Agent Pivot configuration key list');
    assert.ok(lifecycleControllerSource.includes('AGENT_PIVOT_CONFIG_SECTION'),
        'the lifecycle controller must centralize the Agent Pivot configuration section');
    await controller.handleConfigurationChanged(makeConfigurationEvent([
        'agentPivot.aiSessionRunningIconAnimation',
    ]));
    assert.deepStrictEqual(events, [
        ['color'],
        ['refresh', 'configuration-changed'],
        ['publish', undefined],
    ]);

    events.length = 0;
    controller.handleWorkspaceFoldersChanged();
    assert.deepStrictEqual(events, [
        ['color'],
        ['refresh', 'workspace-folders-changed'],
        ['publish', undefined],
    ]);

    events.length = 0;
    controller.handleWindowStateChanged({ focused: true });
    assert.deepStrictEqual(events, [
        ['publish', true],
        ['attention'],
    ]);

    events.length = 0;
    controller.handleWindowStateChanged({ focused: false });
    assert.deepStrictEqual(events, [
        ['attention'],
    ]);
}

async function runDashboardCommandRegistrationChecks() {
    const registered = [];
    const subscriptions = [];
    const calls = [];
    const handlerNames = [
        'open',
        'addProject',
        'saveProject',
        'removeProject',
        'editProjects',
        'addGroup',
        'removeGroup',
        'addProjectsFromFolder',
        'addFileToActiveTerminal',
        'insertPromptToActiveTerminal',
        'migrateSkillsToCentral',
        'changeGlobalSkillsLocation',
        'openCurrentAiSessionConversation',
        'seekLatestConversationInteraction',
        'previousActiveSession',
        'nextActiveSession',
        'nextAttentionSession',
        'nextRunningSession',
        'switchToAiSession',
        'switchWorktreeOrSession',
        'toggleLastAiSession',
        'switchToOpenWindow',
    ];
    const registration = new DashboardCommandRegistration({
        registerCommand: (command, callback) => {
            const disposable = { command, dispose: () => undefined };
            registered.push([command, callback]);
            return disposable;
        },
        pushSubscription: disposable => subscriptions.push(disposable),
        openWhileUnavailable: () => calls.push('boot-open'),
    });

    registration.register();

    assert.deepStrictEqual(registered.map(([command]) => command), [
        'agentPivot.open',
        'agentPivot.addProject',
        'agentPivot.saveProject',
        'agentPivot.removeProject',
        'agentPivot.editProjects',
        'agentPivot.addGroup',
        'agentPivot.removeGroup',
        'agentPivot.addProjectsFromFolder',
        'agentPivot.addFileToActiveTerminal',
        'agentPivot.insertPromptToActiveTerminal',
        'agentPivot.migrateSkillsToCentral',
        'agentPivot.changeGlobalSkillsLocation',
        'agentPivot.openCurrentAiSessionConversation',
        'agentPivot.seekLatestConversationInteraction',
        'agentPivot.previousActiveSession',
        'agentPivot.nextActiveSession',
        'agentPivot.nextAttentionSession',
        'agentPivot.nextRunningSession',
        'agentPivot.switchToAiSession',
        'agentPivot.switchWorktreeOrSession',
        'agentPivot.toggleLastAiSession',
        'agentPivot.switchToOpenWindow',
    ]);
    assert.deepStrictEqual(subscriptions.map(disposable => disposable.command), registered.map(([command]) => command));

    await registered[0][1]();
    await assert.rejects(registered[1][1](), /Agent Pivot is still starting/);
    assert.deepStrictEqual(calls, ['boot-open']);

    assert.strictEqual(registration.stage(1, Object.fromEntries(
        handlerNames.map(name => [name, async () => calls.push(name)])
    )), true);
    assert.strictEqual(registration.activate(1), true);
    for (const [, callback] of registered) {
        await callback();
    }

    assert.deepStrictEqual(calls, [
        'boot-open',
        'open',
        'addProject',
        'saveProject',
        'removeProject',
        'editProjects',
        'addGroup',
        'removeGroup',
        'addProjectsFromFolder',
        'addFileToActiveTerminal',
        'insertPromptToActiveTerminal',
        'migrateSkillsToCentral',
        'changeGlobalSkillsLocation',
        'openCurrentAiSessionConversation',
        'seekLatestConversationInteraction',
        'previousActiveSession',
        'nextActiveSession',
        'nextAttentionSession',
        'nextRunningSession',
        'switchToAiSession',
        'switchWorktreeOrSession',
        'toggleLastAiSession',
        'switchToOpenWindow',
    ]);

    registration.dispose();
    await assert.rejects(registered[0][1](), /Agent Pivot is not available/);
}

async function runActiveTerminalFileReferenceChecks() {
    const sent = [];
    const warnings = [];
    let terminalShowCalls = 0;
    const terminal = {
        sendText: (text, addNewLine) => sent.push([text, addNewLine]),
        show: () => { terminalShowCalls += 1; },
    };
    const controller = new activeTerminalFileReference.ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => ({
            document: { uri: { scheme: 'file', fsPath: '/repo/src/dashboard.ts' } },
            selection: {
                isEmpty: false,
                start: { line: 9 },
                end: { line: 14 },
            },
        }),
        getActiveTerminal: () => terminal,
        asRelativePath: uri => uri.fsPath.replace('/repo/', ''),
        showWarningMessage: message => warnings.push(message),
    });

    assert.strictEqual(activeTerminalFileReference.formatFileReference('src/dashboard.ts', null), 'src/dashboard.ts');
    assert.strictEqual(activeTerminalFileReference.formatFileReference('src/dashboard.ts', { startLine: 10, endLine: 10 }), 'src/dashboard.ts:10');
    assert.strictEqual(activeTerminalFileReference.formatFileReference('src/dashboard.ts', { startLine: 10, endLine: 15 }), 'src/dashboard.ts:10-15');
    assert.deepStrictEqual(activeTerminalFileReference.getPrimarySelectionLineRange({
        isEmpty: false,
        start: { line: 14 },
        end: { line: 9 },
    }), { startLine: 10, endLine: 15 });

    await controller.addFileToActiveTerminal();
    assert.deepStrictEqual(sent, [['src/dashboard.ts:10-15', false]]);
    assert.strictEqual(terminalShowCalls, 1);
    assert.deepStrictEqual(warnings, []);

    const emptySelectionController = new activeTerminalFileReference.ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => ({
            document: { uri: { scheme: 'file', fsPath: '/repo/src/models.ts' } },
            selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
        }),
        getActiveTerminal: () => terminal,
        asRelativePath: uri => uri.fsPath.replace('/repo/', ''),
        showWarningMessage: message => warnings.push(message),
    });
    await emptySelectionController.addFileToActiveTerminal();
    assert.deepStrictEqual(sent[1], ['src/models.ts', false]);
    assert.strictEqual(terminalShowCalls, 2);

    const remoteFileController = new activeTerminalFileReference.ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => ({
            document: { uri: { scheme: 'vscode-remote', fsPath: '/repo/src/remote.ts', path: '/repo/src/remote.ts' } },
            selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
        }),
        getActiveTerminal: () => terminal,
        asRelativePath: uri => uri.path.replace('/repo/', ''),
        showWarningMessage: message => warnings.push(message),
    });
    await remoteFileController.addFileToActiveTerminal();
    assert.deepStrictEqual(sent[2], ['src/remote.ts', false]);
    assert.strictEqual(terminalShowCalls, 3);

    const missingTerminalController = new activeTerminalFileReference.ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => ({
            document: { uri: { scheme: 'file', fsPath: '/repo/src/models.ts' } },
            selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
        }),
        getActiveTerminal: () => null,
        asRelativePath: uri => uri.fsPath.replace('/repo/', ''),
        showWarningMessage: message => warnings.push(message),
    });
    await missingTerminalController.addFileToActiveTerminal();
    assert.ok(warnings.includes('No active terminal to receive the file reference.'));
    assert.strictEqual(sent.length, 3);
    assert.strictEqual(terminalShowCalls, 3);

    const untitledController = new activeTerminalFileReference.ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => ({
            document: { uri: { scheme: 'untitled', fsPath: '' } },
            selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
        }),
        getActiveTerminal: () => terminal,
        asRelativePath: uri => uri.fsPath,
        showWarningMessage: message => warnings.push(message),
    });
    await untitledController.addFileToActiveTerminal();
    assert.ok(warnings.includes('Open a saved file before adding it to the active terminal.'));
    assert.strictEqual(sent.length, 3);
    assert.strictEqual(terminalShowCalls, 3);
}

function createClassList(initialValues = []) {
    const values = new Set(initialValues);
    return {
        add: value => values.add(value),
        remove: value => values.delete(value),
        toggle: (value, force) => force === undefined
            ? (values.has(value) ? (values.delete(value), false) : (values.add(value), true))
            : (force ? values.add(value) : values.delete(value), force),
        contains: value => values.has(value),
    };
}

function createElement(id) {
    const attributes = new Map();
    const listeners = {};
    return {
        id,
        hidden: false,
        innerHTML: '',
        classList: createClassList(),
        addEventListener: (type, listener) => { listeners[type] = listener; },
        dispatch: (type, event = {}) => listeners[type] && listeners[type](event),
        focus: () => undefined,
        getAttribute: name => attributes.get(name) || null,
        setAttribute: (name, value) => attributes.set(name, String(value)),
    };
}

function runControllerChecks(source) {
    const openButton = createElement('dashboard-tab-open-button');
    openButton.setAttribute('data-dashboard-tab', 'open');
    const projectsButton = createElement('dashboard-tab-projects-button');
    projectsButton.setAttribute('data-dashboard-tab', 'projects');
    const openPanel = createElement('dashboard-tab-open');
    const projectsPanel = createElement('dashboard-tab-projects');
    const searchResults = createSearchResultElement('div');
    const searchResultListeners = {};
    searchResults.id = 'dashboard-search-results';
    searchResults.hidden = false;
    searchResults.addEventListener = (type, listener) => { searchResultListeners[type] = listener; };
    searchResults.dispatch = (type, event = {}) => searchResultListeners[type] && searchResultListeners[type](event);
    const elements = {
        'dashboard-tab-open': openPanel,
        'dashboard-tab-projects': projectsPanel,
        'dashboard-search-results': searchResults,
    };
    const messages = [];
    const storage = new Map([['agentPivot.activeDashboardTab', 'open']]);
    const windowListeners = {};
    const context = {
        document: {
            body: { classList: createClassList() },
            createElement: createSearchResultElement,
            getElementById: id => elements[id] || null,
            querySelectorAll: selector => selector === '[data-dashboard-tab]'
                ? [openButton, projectsButton]
                : [],
        },
        sessionStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
        },
        window: {
            scrollY: 11,
            scrollTo: (_x, y) => { context.window.scrollY = y; },
            addEventListener: (type, listener) => { windowListeners[type] = listener; },
        },
        requestAnimationFrame: callback => callback(),
    };
    vm.runInNewContext(source, context);

    assert.strictEqual(context.normalizeDashboardTab('projects'), 'projects');
    assert.strictEqual(context.normalizeDashboardTab('invalid'), 'open');
    assert.strictEqual(context.getAdjacentDashboardTab('open', 'ArrowRight'), 'projects');
    assert.strictEqual(context.getAdjacentDashboardTab('projects', 'ArrowRight'), 'ai');
    assert.strictEqual(context.getAdjacentDashboardTab('ai', 'ArrowLeft'), 'projects');
    assert.strictEqual(context.getAdjacentDashboardTab('projects', 'ArrowLeft'), 'open');
    assert.strictEqual(context.validateProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 2, html: '<div></div>',
    }), true);
    assert.strictEqual(context.validateProjectsPanelMessage({
        type: 'projects-panel-content', version: 2, requestId: 2, html: '<div></div>',
    }), false);
    assert.strictEqual(context.globToDashboardRegex('dash*').test('dashboard'), true);
    assert.strictEqual(context.globToDashboardRegex('data?').test('data1'), true);
    const workspaceSections = context.filterDashboardCatalog(makeWorkspaceDashboardCatalog(), 'dashboard');
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(workspaceSections.map(section => section.title))),
        ['AI SESSIONS', 'OPEN WORKSPACES', 'SAVED PROJECTS']
    );
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(workspaceSections.map(section => section.id))),
        ['ai-sessions', 'open-workspaces', 'saved-projects']
    );
    assert.strictEqual(context.filterDashboardCatalog(makeWorkspaceDashboardCatalog(), 'missing').length, 0);
    const legacyTodoCatalog = makeWorkspaceDashboardCatalog();
    legacyTodoCatalog.todos = [{ key: 'legacy', searchText: 'legacy todo' }];
    assert.strictEqual(context.normalizeDashboardSearchCatalog(legacyTodoCatalog), legacyTodoCatalog);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(
            context.filterDashboardCatalog(legacyTodoCatalog, 'legacy').map(section => section.id)
        )),
        [],
        'legacy v3 TODO entries stay schema-valid but are no longer rendered as search results'
    );
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(context.normalizeDashboardSearchCatalog(null))),
        { version: 3, sessions: [], worktrees: [], openWorkspaces: [], savedProjects: [], todos: [] }
    );
    assert.strictEqual(
        context.normalizeDashboardSearchCatalog(makeWorkspaceDashboardCatalog()).version,
        3
    );
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(context.normalizeDashboardSearchCatalog({
            ...makeDashboardCatalog(),
            openWorkspaces: null,
        }))),
        { version: 3, sessions: [], worktrees: [], openWorkspaces: [], savedProjects: [], todos: [] },
        'a malformed v3 catalog must fail closed'
    );
    const state = {
        activeTab: 'projects',
        searchQuery: 'dash',
        scrollPositions: { open: 12, projects: 34, ai: 56 },
        catalog: makeDashboardCatalog(),
    };
    const nextState = context.replaceDashboardSearchCatalogState(state, makeUpdatedDashboardCatalog());
    assert.strictEqual(nextState.activeTab, 'projects');
    assert.strictEqual(nextState.searchQuery, 'dash');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(nextState.scrollPositions)), { open: 12, projects: 34, ai: 56 });
    assert.notStrictEqual(nextState.catalog, state.catalog);

    let mounted = 0;
    const controller = context.initDashboard({
        postMessage: message => messages.push(message),
        onProjectsMounted: panel => {
            assert.strictEqual(panel, projectsPanel);
            mounted += 1;
        },
    });
    assert.strictEqual(controller.getActiveTab(), 'open');
    assert.strictEqual(openPanel.hidden, false);
    assert.strictEqual(projectsPanel.hidden, true);
    assert.strictEqual(openButton.getAttribute('aria-selected'), 'true');
    assert.strictEqual(projectsButton.getAttribute('tabindex'), '-1');

    context.window.scrollY = 37;
    controller.activateTab('projects');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [
        { type: 'request-projects-panel', version: 1, requestId: 1 },
    ]);
    assert.strictEqual(controller.getProjectsState(), 'loading');
    assert.strictEqual(controller.getScrollPosition('open'), 37);
    controller.ensureProjectsPanel();
    assert.strictEqual(messages.length, 1, 'PROJECTS must be requested only once while loading');
    assert.strictEqual(controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 0, html: '<div>stale</div>',
    }), false);
    assert.strictEqual(projectsPanel.innerHTML, '');
    controller.activateTab('open');
    const openScrollBeforeResponse = context.window.scrollY;
    assert.strictEqual(controller.applyProjectsPanelMessage({
        type: 'projects-panel-content', version: 1, requestId: 1, html: '<div>projects</div>',
    }), true);
    assert.strictEqual(context.window.scrollY, openScrollBeforeResponse, 'background PROJECTS mount must not move OPEN scroll');
    assert.strictEqual(projectsPanel.innerHTML, '<div>projects</div>');
    assert.strictEqual(controller.getProjectsState(), 'mounted');
    assert.strictEqual(mounted, 1);
    controller.ensureProjectsPanel();
    assert.strictEqual(messages.length, 1, 'mounted PROJECTS must not be requested again');
    assert.strictEqual(typeof windowListeners.message, 'function');

    storage.set('agentPivot.activeDashboardTab', 'projects');
    const searchMessages = [];
    const workspaceRevealCalls = [];
    context.window.__agentPivotRevealWorkspaceSession = (...args) => workspaceRevealCalls.push(args);
    const workspaceSearchController = context.initDashboard({
        initialSearchQuery: 'dashboard',
        clearSearch: () => undefined,
        postMessage: message => searchMessages.push(message),
    });
    workspaceSearchController.replaceSearchCatalog(makeWorkspaceDashboardCatalog());
    const workspaceSessionSection = searchResults.children.find(section => section.dataset.sectionType === 'session');
    const workspaceSessionResult = workspaceSessionSection.children[1];
    assert.strictEqual(workspaceSessionResult.dataset.searchAction, 'reveal-workspace-session');
    assert.strictEqual(workspaceSessionResult.dataset.workspaceNavigationIdentity, 'navigation-current');
    workspaceSessionResult.closest = selector => selector === '.dashboard-search-result[data-search-action]'
        ? workspaceSessionResult
        : null;
    searchResults.dispatch('click', { target: workspaceSessionResult });
    assert.deepStrictEqual(workspaceRevealCalls, [[
        'navigation-current', 'codex', 'c1',
    ]], 'workspace session search must reveal its workspace row instead of resuming a root-owned session');
    assert.deepStrictEqual(searchMessages, [], 'workspace session reveal must not post a resume action');

}


function runSourceContractChecks(source) {
    const projectSource = readProjectWebviewSource();
    assert.deepStrictEqual(
        fs.readFileSync(path.join(root, 'media', 'webviewScrollStateScripts.js')),
        fs.readFileSync(scrollStateScriptPath),
        'generated media/webviewScrollStateScripts.js must match its source byte-for-byte'
    );
    assert.deepStrictEqual(
        fs.readFileSync(path.join(root, 'media', 'webviewPromptProtocolScripts.js')),
        fs.readFileSync(path.join(root, 'src', 'webview', 'webviewPromptProtocolScripts.js')),
        'generated media/webviewPromptProtocolScripts.js must match its source byte-for-byte'
    );
    assert.deepStrictEqual(
        fs.readFileSync(path.join(root, 'media', 'webviewPromptScripts.js')),
        fs.readFileSync(promptScriptPath),
        'generated media/webviewPromptScripts.js must match its source byte-for-byte'
    );
    assert.deepStrictEqual(
        fs.readFileSync(path.join(root, 'media', 'webviewSkillPanelScripts.js')),
        fs.readFileSync(skillPanelScriptPath),
        'generated media/webviewSkillPanelScripts.js must match its source byte-for-byte'
    );
    assert.deepStrictEqual(
        fs.readFileSync(path.join(root, 'media', 'webviewProjectsPanelScripts.js')),
        fs.readFileSync(projectsPanelScriptPath),
        'generated media/webviewProjectsPanelScripts.js must match its source byte-for-byte'
    );
    const dndSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewDnDScripts.js'), 'utf8');
    const filterSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewFilterScripts.js'), 'utf8');
    const extensionHostSource = fs.readFileSync(extensionHostPath, 'utf8');
    const webviewContentSource = fs.readFileSync(path.join(root, 'src', 'webview', 'webviewContent.ts'), 'utf8');
    const stylesPath = path.join(root, 'media', 'styles.scss');
    const generatedStylesPath = path.join(root, 'media', 'styles.css');
    const styles = fs.readFileSync(stylesPath, 'utf8');
    assert.strictEqual(styles.includes('.workspace-root-tags'), false);
    assert.strictEqual(styles.includes('.workspace-root-tag'), false);
    assert.ok(styles.includes('@media (max-width: 280px)'));
    assert.ok(styles.includes('min-width: 0'));
    assert.ok(styles.includes('text-overflow: ellipsis'));
    assert.ok(styles.includes('overflow-x: hidden'));
    const compiledStyles = compileDashboardStyles(styles);
    const generatedStyles = fs.readFileSync(generatedStylesPath, 'utf8');
    const minifiedCompiledStyles = new CleanCSS({ rebaseTo: path.dirname(generatedStylesPath) }).minify({
        [generatedStylesPath]: { styles: compiledStyles },
    });
    assert.deepStrictEqual(minifiedCompiledStyles.errors, [], 'compiled dashboard styles must minify without errors');
    assert.deepStrictEqual(minifiedCompiledStyles.warnings, [], 'compiled dashboard styles must minify without warnings');
    assert.strictEqual(
        minifiedCompiledStyles.styles,
        generatedStyles,
        'generated media/styles.css must match compiled and minified media/styles.scss'
    );
    const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const updateMessagePath = path.join(root, 'src', 'dashboard', 'webviewUpdateMessages.ts');
    assert.ok(fs.existsSync(updateMessagePath));
    const updateMessages = fs.readFileSync(updateMessagePath, 'utf8');
    assert.ok(updateMessages.includes('export function buildOpenWorkspacesUpdatedMessage('));
    assert.ok(!updateMessages.includes('export function buildOpenProjectsUpdatedMessage('));
    assert.ok(updateMessages.includes('export function buildAiSessionsUpdatedMessage('));
    assert.ok(updateMessages.includes("type: 'open-workspaces-updated'"));
    assert.ok(!updateMessages.includes("type: 'open-projects-updated'"));
    assert.ok(updateMessages.includes("type: 'ai-sessions-updated'"));
    assert.ok(updateMessages.includes('version: 3'));
    assert.ok(!updateMessages.includes('WorkspaceUpdatedMessage'));
    assert.ok(!updateMessages.includes('buildWorkspaceUpdatedMessage'));
    const viewProviderPath = path.join(root, 'src', 'dashboard', 'viewProvider.ts');
    assert.ok(fs.existsSync(viewProviderPath));
    const viewProviderSource = fs.readFileSync(viewProviderPath, 'utf8');
    assert.ok(viewProviderSource.includes('export class AgentPivotViewProvider implements vscode.WebviewViewProvider'));
    assert.ok(viewProviderSource.includes('refresh()'));
    assert.ok(viewProviderSource.includes('postMessage(message: unknown)'));
    const routerPath = path.join(root, 'src', 'dashboard', 'messageRouter.ts');
    assert.ok(fs.existsSync(routerPath));
    const routerSource = fs.readFileSync(routerPath, 'utf8');
    assert.ok(routerSource.includes('export interface DashboardMessageHandlers'));
    assert.ok(routerSource.includes('handlers: Record<string, DashboardMessageHandler>'));
    assert.ok(routerSource.includes('createAiSession?: DashboardAiSessionCreateMessageHandler'));
    assert.ok(routerSource.includes('resumeAiSession?: DashboardAiSessionLaunchMessageHandler'));
    assert.ok(routerSource.includes('archiveAiSession?: DashboardAiSessionMessageHandler'));
    assert.ok(routerSource.includes('export function createDashboardMessageRouter('));
    assert.strictEqual(routerSource.includes('handleRawMessage'), false);

    assert.ok(source.includes("agentPivot.activeDashboardTab"));
    assert.ok(webviewContentSource.includes('class="group steward-section'));
    assert.ok(webviewContentSource.includes('class="group-title steward-section-header steward-group-header"'));
    assert.ok(webviewContentSource.includes('class="project steward-item-card"'));
    assert.ok(webviewContentSource.includes('class="project-border steward-item-accent"'));
    const dashboardBundleInputs = dashboardBundleInputPaths.join('\n');
    assert.ok(webviewContentSource.includes("'webviewDashboardBundle.js'"));
    assert.ok(dashboardBundleInputs.includes('webviewScrollStateScripts.js'));
    assert.ok(dashboardBundleInputs.includes('webviewSkillPanelScripts.js'));
    assert.ok(dashboardBundleInputs.includes('webviewProjectsPanelScripts.js'));
    assert.ok(
        dashboardBundleInputs.indexOf('webviewProjectsPanelScripts.js')
            < dashboardBundleInputs.indexOf('webviewDashboardScripts.js'),
        'the projects panel capture/restore helpers must load before the dashboard controller that calls them'
    );
    assert.ok(
        dashboardBundleInputs.indexOf('webviewDashboardValidationScripts.js') > -1
            && dashboardBundleInputs.indexOf('webviewDashboardValidationScripts.js')
                < dashboardBundleInputs.indexOf('webviewDashboardScripts.js')
            && dashboardBundleInputs.indexOf('webviewDashboardSearchScripts.js') > -1
            && dashboardBundleInputs.indexOf('webviewDashboardSearchScripts.js')
                < dashboardBundleInputs.indexOf('webviewDashboardScripts.js')
            && dashboardBundleInputs.indexOf('webviewDashboardProjectsPanelScripts.js') > -1
            && dashboardBundleInputs.indexOf('webviewDashboardProjectsPanelScripts.js')
                < dashboardBundleInputs.indexOf('webviewDashboardScripts.js')
            && dashboardBundleInputs.indexOf('webviewDashboardAiPanelScripts.js') > -1
            && dashboardBundleInputs.indexOf('webviewDashboardAiPanelScripts.js')
                < dashboardBundleInputs.indexOf('webviewDashboardScripts.js'),
        'the dashboard pure helpers and panel controllers must load before the dashboard controller that calls them'
    );
    assert.ok(
        dashboardBundleInputs.indexOf('webviewSkillPanelScripts.js')
            < dashboardBundleInputs.indexOf('webviewDashboardScripts.js'),
        'the skill panel controller must load before the dashboard controller that wires it'
    );
    assert.ok(
        dashboardBundleInputs.indexOf('webviewScrollStateScripts.js')
            < dashboardBundleInputs.indexOf('webviewProjectScripts.js'),
        'semantic scroll state must load before every domain Webview script'
    );
    assert.ok(source.includes("setAttribute('aria-selected'"));
    assert.ok(source.includes("setAttribute('tabindex'"));
    assert.ok(source.includes('scrollPositions'));
    assert.ok(source.includes('acceptedProjectsRequestId'));
    assert.ok(source.includes('pendingScrollRestoreTab'));
    const messageHandlersSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'dashboard', 'messageHandlers.ts'), 'utf8'
    );
    assert.ok(messageHandlersSource.includes("'request-projects-panel': async e =>"));
    assert.ok(extensionHostSource.includes('...dashboardMessageHandlers,'),
        'the dashboard spreads the extracted message handlers into the router');
    assert.ok(packageJson.includes('"agentPivot.maxVisibleProjectsPerGroup"'));
    assert.strictEqual(extensionHostSource.includes('function handleStewardMessage('), false);
    assert.ok(extensionHostSource.includes('getAiSessionProviderIds: () => getRegisteredAiSessionProviders().map(provider => provider.id)'));
    assert.ok(messageHandlersSource.includes("type: 'projects-panel-content'"));
    assert.ok(messageHandlersSource.includes('getProjectsPanelContent(projectService.getGroups(), getStewardInfos())'));
    assert.ok(extensionHostSource.includes('getStewardInfos: () => stewardInfos'),
        'the dashboard wires steward infos into the extracted panel handler');
    const panelStackSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'sections', 'panelStack.ts'), 'utf8');
    assert.ok(webviewContentSource.includes("'maxVisibleProjectsPerGroup',"));
    assert.ok(webviewContentSource.includes('DEFAULT_MAX_VISIBLE_PROJECTS_PER_GROUP = 5'));
    assert.ok(webviewContentSource.includes('--steward-max-visible-projects-per-group: ${maxVisibleProjectsPerGroup};'));
    const projectGroupListRule = extractCssRule(
        compiledStyles,
        'body.steward-sidebar #dashboard-tab-projects .group-list'
    );
    assert.ok(projectGroupListRule.includes('max-height: calc(var(--steward-max-visible-projects-per-group, 5) * 65px)'));
    assert.ok(projectGroupListRule.includes('overflow-y: auto'));
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"add-project\"]')"));
    assert.ok(projectSource.includes("e.target.closest('[data-action=\"import-from-other-storage\"]')"));
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
        + fs.readFileSync(path.join(root, 'docs', 'development-history.md'), 'utf8');
    assert.strictEqual((source.match(/type: 'request-projects-panel'/g) || []).length, 1);
    assert.ok(extractFunctionBody(source, 'ensureProjectsPanel').includes("type: 'request-projects-panel'"));
    assert.strictEqual(extractFunctionBody(source, 'renderSearchMode').includes('ensureProjectsPanel()'), false);
    assert.ok(source.includes("document.body.classList.toggle('dashboard-search-active'"));
}

async function runDashboardMessageRouterChecks() {
    const routerModule = require(path.join(root, 'out', 'dashboard', 'messageRouter.js'));
    const calls = [];
    const router = routerModule.createDashboardMessageRouter({
        getAiSessionProviderIds: () => ['codex', 'kimi', 'claude'],
        handlers: {
            'request-projects-panel': async message => {
                calls.push(['request-projects-panel', message.requestId]);
            },
            'selected-project': message => {
                calls.push(['selected-project', message.projectId]);
            },
        },
        createAiSession: message => {
            calls.push(['create-ai-session', message.projectId]);
        },
        createAiSessionQuick: message => {
            calls.push(['create-ai-session-quick', message.projectId, message.provider]);
        },
        resumeAiSession: (message, providerId, rootId) => {
            calls.push(['resume-ai-session', providerId, message.sessionId, rootId]);
        },
        archiveAiSession: (message, providerId) => {
            calls.push(['archive-ai-session', providerId, message.sessionId]);
        },
        saveCurrentWorkspace: message => {
            calls.push(['save-current-workspace', message.type, message.requestId]);
        },
    });

    await router(null);
    await router({});
    await router({ type: 'unknown-message' });
    assert.deepStrictEqual(calls, []);

    await router({ type: 'request-projects-panel', requestId: 7 });
    await router({ type: 'selected-project', projectId: 'project-a' });
    await router({ type: 'create-ai-session', projectId: 'workspace-a', rootId: 'root-api' });
    await router({ type: 'create-ai-session-quick', projectId: 'workspace-a', provider: 'kimi' });
    await router({ type: 'new-session-in', projectId: 'workspace-a' });
    await router({ type: 'new-session-in', projectId: 'workspace-a', rootId: 'root-api' });
    await router({ type: 'resume-ai-session', provider: 'codex', sessionId: 'c1' });
    await router({ type: 'resume-ai-session', provider: 'codex', sessionId: 'c2', rootId: 'root-web' });
    await router({ type: 'resume-ai-session', provider: 'unknown', sessionId: 'invalid' });
    await router({ type: 'resume-kimi-session', sessionId: 'k1' });
    await router({ type: 'archive-claude-session', sessionId: 'a1' });
    await router({ type: 'resume-unknown-session', sessionId: 'ignored' });
    await router({ type: 'save-current-workspace', requestId: 9 });
    await router({ type: 'save-project', projectId: '__currentWorkspace-transient-card-id' });

    assert.deepStrictEqual(calls, [
        ['request-projects-panel', 7],
        ['selected-project', 'project-a'],
        ['create-ai-session', 'workspace-a'],
        ['create-ai-session-quick', 'workspace-a', 'kimi'],
        ['resume-ai-session', 'codex', 'c1', null],
        ['resume-ai-session', 'codex', 'c2', 'root-web'],
        ['resume-ai-session', null, 'invalid', null],
        ['resume-ai-session', 'kimi', 'k1', null],
        ['archive-ai-session', 'claude', 'a1'],
        ['save-current-workspace', 'save-current-workspace', 9],
        ['save-current-workspace', 'save-project', undefined],
    ]);

    const genericSaveCalls = [];
    const routerWithoutSaveHandler = routerModule.createDashboardMessageRouter({
        handlers: {
            'save-current-workspace': message => genericSaveCalls.push(message.requestId),
        },
    });
    await routerWithoutSaveHandler({ type: 'save-current-workspace', requestId: 10 });
    await routerWithoutSaveHandler({ type: 'save-project', projectId: '__currentWorkspace-stale' });
    assert.deepStrictEqual(genericSaveCalls, [],
        'workspace save messages must remain reserved routes when their dedicated handler is unavailable');

}

async function main() {
    const source = readDashboardWebviewSource();
    runErrorContentChecks();
    runConfigurationChecks();
    runStartupChecks();
    runWebviewOptionsChecks();
    await runGroupCollapseControllerChecks();
    await runGroupPromptChecks();
    await runGroupCommandControllerChecks();
    await runAddProjectsFromFolderControllerChecks();
    await runFavoriteProjectControllerChecks();
    await runProjectOrderControllerChecks();
    await runProjectRemovalControllerChecks();
    await runDashboardRuntimeControllerChecks();
    await runDashboardStartupControllerChecks();
    await runDashboardLifecycleControllerChecks();
    await runDashboardCommandRegistrationChecks();
    await runActiveTerminalFileReferenceChecks();
    runDashboardUpdateMessageChecks();
    runWorkspaceCardRenderingChecks();
    runControllerChecks(source);
    runSourceContractChecks(source);
    await runDashboardMessageRouterChecks();
    console.log('Dashboard Webview checks passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
