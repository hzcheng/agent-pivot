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
            if (selector === '.sticky-groups-wrapper .open-other-windows-group[data-other-windows-status]'
                && wrapper.innerHTML.includes('data-other-windows-status="ready"')) {
                return { getAttribute: () => 'ready' };
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
            if (selector.includes('[data-open-workspace-list-card][data-workspace-navigation-identity]')) {
                return projectTags.filter(tag => tag.includes('data-open-workspace-list-card')
                    && tag.includes('data-workspace-navigation-identity')).map(tag => ({
                        hasAttribute(name) {
                            return new RegExp(`\\s${name}(?:\\s|=|>)`).test(tag);
                        },
                        getAttribute(name) {
                            const match = tag.match(new RegExp(`${name}="([^"]*)"`));
                            return match ? match[1] : null;
                        },
                    }));
            }
            if (selector.endsWith('.open-other-windows-group')) {
                return wrapper.innerHTML.includes('open-other-windows-group') ? [{}] : [];
            }
            return [];
        },
    };
    const context = {
        document,
        normalizeDashboardSearchCatalog: value => value
            && value.version === 2
            && Array.isArray(value.sessions)
            && Array.isArray(value.openWorkspaces)
            && Array.isArray(value.savedProjects)
            && Array.isArray(value.todos)
            ? value
            : { version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: [] },
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
    vm.runInNewContext(projectWebviewSource, context, {
        filename: 'webviewProjectScripts.js',
    });
    return context;
}

function createFilterVm(input) {
    const context = {
        document: {
            body: { classList: createClassList() },
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
        protocolVersion: 4,
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
        version: 2,
        sessions: [],
        openWorkspaces: [
            { workspaceId: 'current', action: 'show-current-workspace' },
            { workspaceId: 'other-a', action: 'switch-open-workspace' },
            { workspaceId: 'other-b', action: 'switch-open-workspace' },
        ],
        savedProjects: [],
        todos: [{ todoId: 'preserved' }],
    };
    const validHtml = [
        '<div class="group open-current-workspace-group"><div class="workspace-card project steward-item-card" data-id="current" data-current-workspace data-workspace-scope-identity="scope"></div></div>',
        '<div class="group open-other-windows-group" data-other-windows-status="ready">',
        '<div class="workspace-card project steward-item-card" data-id="current" data-open-workspace-list-card data-open-workspace-current data-workspace-navigation-identity="navigation-current"></div>',
        '<div class="workspace-card project steward-item-card" data-id="other-a" data-open-workspace-list-card data-workspace-navigation data-other-workspace data-workspace-navigation-identity="navigation-a"></div>',
        '<div class="workspace-card project steward-item-card" data-id="other-b" data-open-workspace-list-card data-workspace-navigation data-other-workspace data-workspace-navigation-identity="navigation-b"></div>',
        '</div>',
    ].join('');

    assert.equal(context.applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'valid',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        otherWindowsStatus: 'ready',
        html: validHtml,
        searchCatalog: catalog,
    }), true);
    assert.equal(catalogs[0].todos[0].todoId, 'preserved');

    const attentionHtml = validHtml.replace(
        'data-id="other-a"',
        'data-id="other-a" data-attention-count="1"'
    );
    assert.equal(context.applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'attention-only',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        otherWindowsStatus: 'ready',
        html: attentionHtml,
        searchCatalog: catalog,
    }), true);

    const runningHtml = attentionHtml.replace(
        'data-id="other-b"',
        'data-id="other-b" data-running-session-count="2"'
    );
    assert.equal(context.applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'running-only',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        otherWindowsStatus: 'ready',
        html: runningHtml,
        searchCatalog: catalog,
    }), true);
    assert.equal(catalogs.length, 3);
    assert.ok(catalogs.every(value => value.todos[0].todoId === 'preserved'));

    const duplicateIdentityHtml = runningHtml.replace(
        'data-workspace-navigation-identity="navigation-b"',
        'data-workspace-navigation-identity="navigation-a"'
    );
    assert.equal(context.applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'duplicate-navigation',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        otherWindowsStatus: 'ready',
        html: duplicateIdentityHtml,
        searchCatalog: catalog,
    }), false);
    assert.equal(wrapper.innerHTML, runningHtml);

    assert.equal(context.applyOpenWorkspacesUpdate({
        type: 'open-workspaces-updated',
        version: 2,
        semanticRevision: 'lost-peer',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        otherWindowsStatus: 'ready',
        html: '<div class="workspace-card project steward-item-card" data-id="current" data-current-workspace data-workspace-scope-identity="scope"></div>',
        searchCatalog: catalog,
    }), false);
    assert.equal(wrapper.innerHTML, runningHtml);
});

test('OPEN-WORKSPACE-PIN-WEBVIEW-001 waits for authoritative markup before changing pin state', () => {
    const wrapper = { innerHTML: '<div>old</div>' };
    const context = createOpenWorkspaceUpdateVm(wrapper, []);
    const cardId = '__openWorkspaceNavigation-' + 'a'.repeat(24);
    const attributes = new Map([['aria-pressed', 'false']]);
    const card = {
        getAttribute: name => name === 'data-id' ? cardId : null,
        querySelector: () => ({ textContent: 'Other window' }),
    };
    const button = {
        getAttribute: name => attributes.has(name) ? attributes.get(name) : null,
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: name => attributes.delete(name),
        closest: selector => selector === '.workspace-card' ? card : null,
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
        selector.includes('.project-pin-badge') ? [button] : [];

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

test('WEBVIEW-WEBVIEW-REFRESH-FOCUS-001 focuses active search on initialization without blurring editor focus', () => {
    const calls = [];
    const input = {
        value: '',
        parentElement: { classList: createClassList() },
        focus: () => calls.push('focus'),
        blur: () => calls.push('blur'),
        select: () => calls.push('select'),
        addEventListener: () => undefined,
    };
    const context = createFilterVm(input);
    assert.equal(typeof context.initFiltering, 'function');

    context.initFiltering(true, {
        isSearchActive: () => false,
        setSearchQuery: () => undefined,
    });

    assert.deepEqual(calls, ['focus', 'select']);
});
