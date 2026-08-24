'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
    SELF,
    OTHER,
    createCommandRegistry,
    createFakeClock,
    createSyntheticOpenWorkspaceStore,
    flushAsync,
    loadWithFakeVscode,
    makeAggregate,
    makeRecord,
    makeRegistration,
} = require('../../contract/openProjects/helpers');
const { projectOpenWorkspaceCards } = require('../../../out/openWorkspaces/projection');
const { createOpenWorkspacePinSnapshot } = require('../../../out/openWorkspaces/pinProtocol');
const { OpenWorkspaceCoordinator } = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceCoordinator');

const OpenWorkspaceBridgeClient = loadWithFakeVscode(
    '../../../out/openWorkspaces/bridgeClient'
).default;

const repositoryRoot = path.join(__dirname, '..', '..', '..');
const projectWebviewSource = fs.readFileSync(path.join(
    repositoryRoot,
    'src', 'webview', 'webviewProjectScripts.js'
), 'utf8');
const viewStateWebviewSource = fs.readFileSync(path.join(
    repositoryRoot,
    'src', 'webview', 'webviewAiSessionViewStateScripts.js'
), 'utf8');
const workspaceUpdateWebviewSource = fs.readFileSync(path.join(
    repositoryRoot,
    'src', 'webview', 'webviewWorkspaceUpdateScripts.js'
), 'utf8');
const projectCollapseWebviewSource = fs.readFileSync(path.join(
    repositoryRoot,
    'src', 'webview', 'webviewProjectCollapseScripts.js'
), 'utf8');
const projectContextMenuWebviewSource = fs.readFileSync(path.join(
    repositoryRoot,
    'src', 'webview', 'webviewProjectContextMenuScripts.js'
), 'utf8');
const projectAiUpdateWebviewSource = fs.readFileSync(path.join(
    repositoryRoot,
    'src', 'webview', 'webviewProjectAiUpdateScripts.js'
), 'utf8');
const aiSessionControlsWebviewSource = fs.readFileSync(path.join(
    repositoryRoot,
    'src', 'webview', 'webviewProjectAiSessionControlsScripts.js'
), 'utf8');
const filterWebviewSource = fs.readFileSync(path.join(
    repositoryRoot,
    'src', 'webview', 'webviewFilterScripts.js'
), 'utf8');

function hasClassTokens(value, ...tokens) {
    return tokens.every(token => value.split(/\s+/).includes(token));
}

function createClassList() {
    const values = new Set();
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

function createOpenWorkspaceUpdateVm(wrapper, catalogs) {
    const document = {
        activeElement: null,
        body: {
            classList: createClassList(),
            style: { setProperty: () => undefined },
        },
        querySelector: selector => {
            if (selector === '.sticky-groups-wrapper') return wrapper;
            if (selector === '.sticky-groups-wrapper .open-window-switcher-group[data-other-windows-status]'
                && wrapper.innerHTML.includes('open-window-switcher-group')) {
                const status = wrapper.innerHTML.match(/data-other-windows-status="([^"]*)"/);
                return { getAttribute: () => status ? status[1] : null };
            }
            return null;
        },
        querySelectorAll: selector => {
            const projectTags = Array.from(wrapper.innerHTML.matchAll(/<div class="([^"]*)"[^>]*data-id=[^>]*>/g))
                .filter(match => hasClassTokens(match[1], 'project', 'steward-item-card'))
                .map(match => match[0]);
            if (selector.includes('[data-current-workspace][data-workspace-scope-identity]')) {
                return projectTags.filter(tag => tag.includes('data-current-workspace')
                    && tag.includes('data-workspace-scope-identity')).map(() => ({}));
            }
            if (selector.includes('[data-open-window-row][data-workspace-navigation-identity]')) {
                return Array.from(wrapper.innerHTML.matchAll(/<div [^>]*data-open-window-row[^>]*>/g))
                    .map(match => match[0])
                    .map(tag => ({
                        getAttribute(name) {
                            const match = tag.match(new RegExp(`${name}="([^"]*)"`));
                            return match ? match[1] : null;
                        },
                    }));
            }
            return [];
        },
    };
    const context = {
        document,
        normalizeDashboardSearchCatalog: value => value
            && value.version === 3
            && Array.isArray(value.sessions)
            && Array.isArray(value.worktrees)
            && Array.isArray(value.openWorkspaces)
            && Array.isArray(value.savedProjects)
            && Array.isArray(value.todos)
            ? value
            : { version: 3, sessions: [], worktrees: [], openWorkspaces: [], savedProjects: [], todos: [] },
        window: {
            __agentPivotDashboard: {
                replaceSearchCatalog: catalog => catalogs.push(catalog),
            },
        },
    };
    vm.runInNewContext(viewStateWebviewSource, context, {
        filename: 'webviewAiSessionViewStateScripts.js',
    });
    vm.runInNewContext(workspaceUpdateWebviewSource, context, {
        filename: 'webviewWorkspaceUpdateScripts.js',
    });
    vm.runInNewContext(projectCollapseWebviewSource, context, {
        filename: 'webviewProjectCollapseScripts.js',
    });
    vm.runInNewContext(projectContextMenuWebviewSource, context, {
        filename: 'webviewProjectContextMenuScripts.js',
    });
    vm.runInNewContext(projectAiUpdateWebviewSource, context, {
        filename: 'webviewProjectAiUpdateScripts.js',
    });
    vm.runInNewContext(aiSessionControlsWebviewSource, context, {
        filename: 'webviewProjectAiSessionControlsScripts.js',
    });
    vm.runInNewContext(projectWebviewSource, context, {
        filename: 'webviewProjectScripts.js',
    });
    return context;
}

function createFilterVm(input, { documentFocused = false } = {}) {
    const context = {
        document: {
            body: { classList: createClassList() },
            hasFocus: () => documentFocused,
            getElementById: id => id === 'filter' ? input : { addEventListener: () => undefined },
            querySelectorAll: () => [],
        },
        requestAnimationFrame: callback => callback(),
        sessionStorage: {
            getItem: () => '',
            setItem: () => undefined,
        },
        window: {
            addEventListener: () => undefined,
        },
    };
    vm.runInNewContext(filterWebviewSource, context, {
        filename: 'webviewFilterScripts.js',
    });
    return context;
}

test('ARCH-COORDINATOR-WIRING-001 carries sequenced publications through the bridge into dashboard cards', async t => {
    const clock = createFakeClock(1000);
    const commands = createCommandRegistry();
    const store = createSyntheticOpenWorkspaceStore();
    const aggregates = [];
    let fireWatcher;
    const coordinator = new OpenWorkspaceCoordinator('/synthetic-open-project-root', {
        now: () => clock.nowMs,
        setInterval: clock.setInterval,
        clearInterval: clock.clearInterval,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        createStore: () => store,
        deliverAggregate: aggregate => commands.execute(
            '_agentPivotOpenWorkspaces.workspace.aggregate',
            aggregate
        ),
    });
    commands.register('_agentPivotOpenWorkspaces.bridge.publish', raw => coordinator.publish(raw));
    commands.register('_agentPivotOpenWorkspaces.bridge.unregister', raw => coordinator.unregister(raw));
    commands.register('_agentPivotOpenWorkspaces.bridge.handshake', () => ({
        accepted: true,
        protocolVersion: 5,
        bridgeExtensionVersion: '0.1.4',
        capabilities: {
            workspaces: true,
            atomicReplace: true,
            focusLeases: true,
            authoritativeUris: true,
            uiHostNavigation: true,
            savedProjectNavigation: true,
            workspacePins: true,
            stableOpenOrder: true,
        },
        pinSnapshot: createOpenWorkspacePinSnapshot([]),
    }));

    const client = new OpenWorkspaceBridgeClient(
        makeRecord({ name: 'Current', uri: '/work/current' }),
        aggregate => aggregates.push(aggregate),
        error => { throw error; },
        {
            instanceId: SELF,
            now: () => clock.nowMs,
            registerCommand: commands.register,
            executeCommand: commands.execute,
            setInterval: clock.setInterval,
            clearInterval: clock.clearInterval,
        }
    );
    t.after(() => coordinator.dispose());
    await flushAsync();

    clock.advanceBy(1000);
    await client.publish(makeRecord({ name: 'Current', uri: '/work/current' }), true);
    store.seed(makeRegistration(OTHER, 1500, 'vscode-remote://ssh-remote+host/work/shared'));
    fireWatcher();
    await flushAsync();

    const publications = commands.calls.filter(call =>
        call.command === '_agentPivotOpenWorkspaces.bridge.publish'
    );
    assert.deepEqual(publications.map(call => call.argument.sequence), [1, 2]);
    assert.equal(publications[1].argument.followsFocusEvent, true);
    assert.equal(aggregates.at(-1).registrations[0].lastFocusedAtMs, 2000);

    const cards = projectOpenWorkspaceCards(
        makeRecord({ name: 'Current', uri: '/work/current' }),
        aggregates.at(-1),
        SELF
    );
    assert.deepEqual(cards.map(card => card.name), ['Shared']);
    assert.equal(cards[0].kind, 'navigation');
});

test('OPEN-OPEN-PROJECT-INCREMENTAL-RENDERING-001 excludes the current card and deduplicates peer windows by focus order', () => {
    const remoteUri = 'vscode-remote://dev-container%2Btarget/work/shared';
    const aggregate = makeAggregate([
        makeRegistration('2'.repeat(32), 2000, remoteUri),
        makeRegistration(OTHER, 3000, remoteUri),
        makeRegistration(SELF, 4000, '/work/current'),
    ]);

    const cards = projectOpenWorkspaceCards(
        makeRecord({ name: 'Current', uri: '/work/current' }),
        aggregate,
        SELF
    );

    assert.deepEqual(cards.map(card => card.name), ['Shared']);
    assert.equal(cards[0].kind, 'navigation');
    assert.equal(cards[0].navigationIdentity, makeRecord({ uri: remoteUri }).navigationIdentity);
});

test('OPEN-OPEN-PROJECT-INCREMENTAL-RENDERING-001 applies consistent updates and rolls back DOM that loses peer cards', () => {
    const wrapper = { innerHTML: '<div>old</div>' };
    const catalogs = [];
    const context = createOpenWorkspaceUpdateVm(wrapper, catalogs);
    assert.equal(typeof context.applyOpenWorkspacesUpdate, 'function');
    const catalog = {
        version: 3,
        sessions: [],
        worktrees: [],
        openWorkspaces: [
            { workspaceId: 'current', action: 'show-current-workspace' },
            { workspaceId: 'other-a', action: 'switch-open-workspace' },
            { workspaceId: 'other-b', action: 'switch-open-workspace' },
        ],
        savedProjects: [], todos: [],
    };
    const switcherRow = (id, kind, identity) =>
        `<div class="open-window-row${kind === 'current' ? ' open-window-row-current' : ''}" role="listitem"`
        + ` data-open-window-row data-id="${id}" data-workspace-navigation-identity="${identity}"`
        + ` data-window-kind="${kind}"></div>`;
    const validHtml = [
        '<div class="group open-window-switcher-group" role="list" data-group-id="open-window-switcher" data-other-windows-status="ready">',
        '<div class="open-window-switcher-list" data-open-window-switcher-list>',
        switcherRow('current', 'current', 'navigation-current'),
        switcherRow('other-a', 'navigation', 'navigation-a'),
        switcherRow('other-b', 'navigation', 'navigation-b'),
        '</div></div>',
        '<div class="group open-current-workspace-group"><div class="workspace-card project steward-item-card" data-id="current" data-current-workspace data-workspace-scope-identity="scope"></div></div>',
    ].join('');
    const openUpdate = (semanticRevision, html) => ({
        type: 'open-workspaces-updated',
        version: 4,
        semanticRevision,
        projectionRevision: 1,
        windowRowCount: 3,
        currentWindowRowCount: 1,
        navigationWindowRowCount: 2,
        currentDetailCount: 1,
        otherWindowsStatus: 'ready',
        html,
        searchCatalog: catalog,
    });

    assert.equal(context.applyOpenWorkspacesUpdate(openUpdate('valid', validHtml)), true);

    const attentionHtml = validHtml.replace(
        'data-id="other-a"',
        'data-id="other-a" data-attention-count="1"'
    );
    assert.equal(context.applyOpenWorkspacesUpdate(openUpdate('attention-only', attentionHtml)), true);

    const runningHtml = attentionHtml.replace(
        'data-id="other-b"',
        'data-id="other-b" data-running-session-count="2"'
    );
    assert.equal(context.applyOpenWorkspacesUpdate(openUpdate('running-only', runningHtml)), true);
    assert.equal(catalogs.length, 3);

    const duplicateIdentityHtml = runningHtml.replace(
        'data-workspace-navigation-identity="navigation-b"',
        'data-workspace-navigation-identity="navigation-a"'
    );
    assert.equal(context.applyOpenWorkspacesUpdate(
        openUpdate('duplicate-navigation', duplicateIdentityHtml)
    ), false);
    assert.equal(wrapper.innerHTML, runningHtml);

    assert.equal(context.applyOpenWorkspacesUpdate(openUpdate(
        'lost-peer',
        '<div class="group open-current-workspace-group"><div class="workspace-card project steward-item-card" data-id="current" data-current-workspace data-workspace-scope-identity="scope"></div></div>'
    )), false);
    assert.equal(wrapper.innerHTML, runningHtml);
});

test('OPEN-WORKSPACE-PIN-WEBVIEW-001 waits for authoritative markup before changing pin state', () => {
    const wrapper = { innerHTML: '<div>old</div>' };
    const context = createOpenWorkspaceUpdateVm(wrapper, []);
    const cardId = '__openWorkspaceNavigation-' + 'a'.repeat(24);
    const attributes = new Map([['aria-pressed', 'false']]);
    const row = {
        getAttribute: name => name === 'data-id' ? cardId : null,
        querySelector: () => null,
    };
    const button = {
        getAttribute: name => attributes.has(name) ? attributes.get(name) : null,
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: name => attributes.delete(name),
        closest: selector => selector === '[data-open-window-row]' ? row : null,
    };
    const announcements = [];
    const region = {
        set textContent(value) { announcements.push(value); },
    };
    const posted = [];
    context.window.vscode = { postMessage: message => posted.push(message) };
    context.document.querySelector = selector =>
        selector === '[data-open-workspace-pin-live-region]' ? region : null;
    context.document.querySelectorAll = selector =>
        selector.includes('[data-action="toggle-open-workspace-pin"]') ? [button] : [];

    context.requestOpenWorkspacePin(button, cardId);

    assert.equal(attributes.get('aria-pressed'), 'false',
        'the webview must not optimistically flip persistent pin state');
    assert.equal(attributes.get('aria-disabled'), 'true');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].pinned, true);

    context.completeOpenWorkspacePin({
        type: 'open-workspace-pin-result',
        version: 1,
        requestId: posted[0].requestId,
        cardId,
        pinned: true,
        success: true,
    });
    assert.equal(attributes.get('aria-pressed'), 'false');
    assert.equal(attributes.get('aria-disabled'), 'true',
        'an acknowledgement alone must not clear pending state');

    attributes.set('aria-pressed', 'true');
    context.reconcilePendingOpenWorkspacePins(context.document);
    assert.equal(attributes.has('aria-disabled'), false);
    assert.equal(context.pendingOpenWorkspacePins.size, 0);
    assert.equal(announcements.at(-1), 'Window pinned.');
});

test('WEBVIEW-WEBVIEW-REFRESH-FOCUS-001 only focuses default search when the Webview already owns focus', () => {
    const calls = [];
    const input = {
        value: '',
        parentElement: { classList: createClassList() },
        focus: () => calls.push('focus'),
        blur: () => calls.push('blur'),
        select: () => calls.push('select'),
        addEventListener: () => undefined,
    };
    const backgroundContext = createFilterVm(input);
    assert.equal(typeof backgroundContext.initFiltering, 'function');

    backgroundContext.initFiltering(true, {
        isSearchActive: () => false,
        setSearchQuery: () => undefined,
    });
    assert.deepEqual(calls, []);

    const focusedContext = createFilterVm(input, { documentFocused: true });
    focusedContext.initFiltering(true, {
        isSearchActive: () => false,
        setSearchQuery: () => undefined,
    });
    assert.deepEqual(calls, ['focus', 'select']);
});
