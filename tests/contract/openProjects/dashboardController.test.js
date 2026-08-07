'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardStartupController } = require('../../../out/dashboard/startupController');
const {
    NEWER,
    OLDER,
    SELF,
    flushAsync,
    loadWithFakeVscode,
    makeAggregate,
    makeRecord,
    makeRegistration,
} = require('./helpers');
const {
    createOpenWorkspacePinSnapshot,
} = require('../../../out/openWorkspaces/pinProtocol');
const {
    OpenWorkspaceDashboardController,
} = loadWithFakeVscode('../../../out/openWorkspaces/dashboardController');

function createOptions(overrides = {}) {
    const currentWorkspace = makeRecord({ name: 'Current', uri: '/work/current' });
    return {
        getCurrentWorkspace: () => ({
            ...currentWorkspace,
            roots: currentWorkspace.roots.map(root => ({ ...root, hostPath: '/work/current' })),
        }),
        isWorkspaceSavedAsProject: () => true,
        getWorkspaceProjectColor: () => '',
        getCurrentWorkspaceAiSessions: () => null,
        getGroups: () => [],
        getTodoSearchItems: () => [{
            key: 'todo:open-workspaces',
            todoId: 'open-workspaces',
            groupId: 'release',
            title: 'Preserve OPEN catalog',
            groupTitle: 'Release',
            priority: 'high',
            completed: false,
            notesSearchText: '',
            searchText: 'preserve open catalog release high',
        }],
        getCollapsed: () => false,
        getRunningCardAnimation: () => undefined,
        getRunningIconAnimation: () => undefined,
        getAttentionAggregate: () => ({
            protocolVersion: 1,
            aggregateRevision: 'a'.repeat(64),
            generatedAtMs: 1,
            sessions: [],
        }),
        getBridgeInstanceId: () => SELF,
        postMessage: () => Promise.resolve(true),
        refresh: () => undefined,
        isVisible: () => true,
        logDiagnostic: () => undefined,
        logError: () => undefined,
        nowMs: () => 5000,
        ...overrides,
    };
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test('OPEN-OPEN-PROJECT-DASHBOARD-CONTROLLER-001 posts each semantic revision once with the complete search catalog', async () => {
    const posted = [];
    const diagnostics = [];
    const options = createOptions({
        postMessage: message => {
            posted.push(message);
            return Promise.resolve(true);
        },
        logDiagnostic: (source, event) => diagnostics.push([source, event]),
    });
    const controller = new OpenWorkspaceDashboardController(options);
    const first = makeAggregate([makeRegistration(SELF, 4000, '/work/current')], {
        semanticRevision: 'revision-1',
    });

    assert.equal(controller.setAggregate(first), true);
    assert.equal(controller.setAggregate({ ...first, observedAtMs: 6000 }), false);
    controller.postUpdated();
    controller.postUpdated();
    await flushAsync();

    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'open-workspaces-updated');
    assert.match(posted[0].semanticRevision, /^[a-f0-9]{64}$/);
    assert.equal(posted[0].searchCatalog.todos[0].todoId, 'open-workspaces');
    assert.ok(diagnostics.some(([, event]) => event.event === 'open-workspace-cards-build'));

    controller.setAggregate({ ...first, semanticRevision: 'revision-2' });
    controller.postUpdated();
    await flushAsync();
    assert.equal(posted.length, 2);
    assert.notEqual(posted[0].semanticRevision, posted[1].semanticRevision);
});

test('WEBVIEW-SIDEBAR-VISIBILITY-RETENTION-001 coalesces rapid OPEN revisions behind one delivery', async () => {
    const firstDelivery = createDeferred();
    const posted = [];
    let groups = [];
    const controller = new OpenWorkspaceDashboardController(createOptions({
        getGroups: () => groups,
        postMessage: message => {
            posted.push(message);
            return posted.length === 1 ? firstDelivery.promise : Promise.resolve(true);
        },
    }));

    controller.postUpdated();
    for (let iteration = 1; iteration <= 15; iteration += 1) {
        groups = [{
            id: 'work',
            groupName: `Work ${iteration}`,
            collapsed: false,
            projects: [{ id: 'saved', name: 'Saved', path: '/work/saved' }],
        }];
        controller.postUpdated();
    }

    assert.equal(posted.length, 1, 'an unresolved Webview delivery must bound the queue');
    firstDelivery.resolve(true);
    await flushAsync();

    assert.equal(posted.length, 2, 'only the latest hidden-epoch state is replayed');
    assert.deepEqual(posted[1].searchCatalog.savedProjects[0].groupLabels, ['Work 15']);
});

test('WEBVIEW-SIDEBAR-VISIBILITY-RETENTION-001 reuses one card projection across a burst of sidebar consumers', () => {
    let nowMs = 5_000;
    let hydrationCalls = 0;
    let savedAsProject = false;
    const controller = new OpenWorkspaceDashboardController(createOptions({
        isWorkspaceSavedAsProject: () => savedAsProject,
        getCurrentWorkspaceAiSessions: () => {
            hydrationCalls += 1;
            return null;
        },
        nowMs: () => nowMs,
    }));

    const first = controller.getCards();
    for (let iteration = 0; iteration < 20; iteration += 1) {
        assert.strictEqual(controller.getCards(), first);
    }
    assert.equal(hydrationCalls, 1,
        'parallel dashboard consumers must share one expensive session projection');

    savedAsProject = true;
    const savedProjection = controller.getCards();
    assert.notStrictEqual(savedProjection, first,
        'a semantic workspace change must invalidate the burst immediately');
    assert.equal(savedProjection[0].showSaveAction, false);
    assert.equal(hydrationCalls, 2);

    nowMs += 1_000;
    assert.notStrictEqual(controller.getCards(), savedProjection,
        'the burst cache must not become an authoritative long-lived snapshot');
    assert.equal(hydrationCalls, 3);
});

test('OPEN-ALL-WINDOWS-LIST-001 orders current and navigation cards together without focus-driven movement', () => {
    const current = makeRecord({ name: 'Current', uri: '/work/current' });
    const oldest = makeRecord({ name: 'Oldest', uri: '/work/oldest' });
    const newer = makeRecord({ name: 'Newer', uri: '/work/newer' });
    const controller = new OpenWorkspaceDashboardController(createOptions({
        getCurrentWorkspace: () => ({
            ...current,
            roots: current.roots.map(root => ({ ...root, hostPath: '/work/current' })),
        }),
    }));
    const aggregate = makeAggregate([
        makeRegistration(SELF, 9000, current.navigationUri, {
            openedAtMs: 3000,
            workspace: current,
        }),
        makeRegistration(OLDER, 8000, oldest.navigationUri, {
            openedAtMs: 1000,
            workspace: oldest,
        }),
        makeRegistration(NEWER, 7000, newer.navigationUri, {
            openedAtMs: 2000,
            workspace: newer,
        }),
    ]);

    controller.setAggregate(aggregate);
    const first = controller.getCards();
    assert.deepEqual(first.map(card => card.name), ['Oldest', 'Newer', 'Current']);
    assert.equal(first[2].kind, 'current');
    assert.equal(
        controller.getPinNavigationIdentity(first[2].id),
        current.navigationIdentity,
    );

    controller.setAggregate({
        ...aggregate,
        semanticRevision: 'focus-only-change',
        registrations: aggregate.registrations.map(registration => ({
            ...registration,
            lastFocusedAtMs: registration.instanceId === OLDER ? 20_000 : 1,
        })),
    });
    assert.deepEqual(controller.getCards().map(card => card.name), [
        'Oldest', 'Newer', 'Current',
    ]);

    controller.setPinSnapshot(createOpenWorkspacePinSnapshot([{
        protocolVersion: 1,
        navigationIdentity: current.navigationIdentity,
        pinnedAtMs: 500,
    }]));
    const pinned = controller.getCards();
    assert.deepEqual(pinned.map(card => card.name), ['Current', 'Oldest', 'Newer']);
    assert.equal(pinned[0].pinned, true);
});

test('OPEN-ALL-WINDOWS-LIST-001 prefers saved project names over window display names', () => {
    const current = makeRecord({ name: 'Current', uri: '/work/current' });
    const other = makeRecord({ name: 'Other', uri: '/work/other' });
    const unnamed = makeRecord({ name: 'Unnamed', uri: '/work/unnamed' });
    const controller = new OpenWorkspaceDashboardController(createOptions({
        getCurrentWorkspace: () => ({
            ...current,
            roots: current.roots.map(root => ({ ...root, hostPath: '/work/current' })),
        }),
        getWorkspaceProjectName: workspace => {
            if (workspace.navigationUri === current.navigationUri) { return 'Current Alias'; }
            if (workspace.navigationUri === other.navigationUri) { return 'Other Alias'; }
            return '   ';
        },
    }));
    controller.setAggregate(makeAggregate([
        makeRegistration(SELF, 9000, current.navigationUri, { openedAtMs: 3000, workspace: current }),
        makeRegistration(OLDER, 8000, other.navigationUri, { openedAtMs: 1000, workspace: other }),
        makeRegistration(NEWER, 7000, unnamed.navigationUri, { openedAtMs: 2000, workspace: unnamed }),
    ]));

    const cards = controller.getCards();
    assert.deepEqual(cards.map(card => card.name), ['Other Alias', 'Unnamed', 'Current Alias']);
    assert.equal(cards[2].kind, 'current');
});

test('OPEN-ALL-WINDOWS-LIST-001 gives every remote window the same authoritative project order', () => {
    const localProjectA = makeRecord({ name: 'Project A', uri: '/work/project-a' });
    const localProjectB = makeRecord({ name: 'Project B', uri: '/work/project-b' });
    const localProjectC = makeRecord({ name: 'Project C', uri: '/work/project-c' });
    const projectA = makeRecord({
        ...localProjectA,
        navigationIdentity: 'a'.repeat(64),
    });
    const projectB = makeRecord({
        ...localProjectB,
        navigationIdentity: 'b'.repeat(64),
    });
    const projectC = makeRecord({
        ...localProjectC,
        navigationIdentity: 'c'.repeat(64),
    });
    const aggregate = makeAggregate([
        makeRegistration(SELF, 9000, projectA.navigationUri, {
            openedAtMs: 3000,
            workspace: projectA,
        }),
        makeRegistration(OLDER, 8000, projectB.navigationUri, {
            openedAtMs: 1000,
            workspace: projectB,
        }),
        makeRegistration(NEWER, 7000, projectC.navigationUri, {
            openedAtMs: 2000,
            workspace: projectC,
        }),
    ]);
    const createWorkspace = record => ({
        ...record,
        roots: record.roots.map(root => ({ ...root, hostPath: root.uri })),
    });
    const projectAWindow = new OpenWorkspaceDashboardController(createOptions({
        getCurrentWorkspace: () => createWorkspace(localProjectA),
        getBridgeInstanceId: () => SELF,
    }));
    const projectBWindow = new OpenWorkspaceDashboardController(createOptions({
        getCurrentWorkspace: () => createWorkspace(localProjectB),
        getBridgeInstanceId: () => OLDER,
    }));
    const projectCWindow = new OpenWorkspaceDashboardController(createOptions({
        getCurrentWorkspace: () => createWorkspace(localProjectC),
        getBridgeInstanceId: () => NEWER,
    }));

    projectAWindow.setAggregate(aggregate);
    projectBWindow.setAggregate(aggregate);
    projectCWindow.setAggregate(aggregate);

    assert.deepEqual(projectAWindow.getCards().map(card => card.name), [
        'Project B', 'Project C', 'Project A',
    ]);
    assert.deepEqual(projectBWindow.getCards().map(card => card.name), [
        'Project B', 'Project C', 'Project A',
    ]);
    assert.deepEqual(projectCWindow.getCards().map(card => card.name), [
        'Project B', 'Project C', 'Project A',
    ]);
    assert.equal(projectAWindow.getCards()[2].kind, 'current');
    assert.equal(projectBWindow.getCards()[0].kind, 'current');
    assert.equal(projectCWindow.getCards()[1].kind, 'current');
    assert.equal(projectAWindow.getCards()[2].navigationIdentity, projectA.navigationIdentity);

    const pinnedProjectA = createOpenWorkspacePinSnapshot([{
        protocolVersion: 1,
        navigationIdentity: projectA.navigationIdentity,
        pinnedAtMs: 500,
    }]);
    projectAWindow.setPinSnapshot(pinnedProjectA);
    projectBWindow.setPinSnapshot(pinnedProjectA);
    projectCWindow.setPinSnapshot(pinnedProjectA);
    assert.deepEqual(projectAWindow.getCards().map(card => card.name), [
        'Project A', 'Project B', 'Project C',
    ]);
    assert.deepEqual(projectBWindow.getCards().map(card => card.name), [
        'Project A', 'Project B', 'Project C',
    ]);
    assert.deepEqual(projectCWindow.getCards().map(card => card.name), [
        'Project A', 'Project B', 'Project C',
    ]);
    assert.equal(projectAWindow.getCards()[0].pinned, true);
});

test('PROJECT-INCREMENTAL-REFRESH-001 republishes OPEN search when only the saved project catalog changes', async () => {
    const posted = [];
    let groups = [];
    const controller = new OpenWorkspaceDashboardController(createOptions({
        getGroups: () => groups,
        postMessage: message => {
            posted.push(message);
            return Promise.resolve(true);
        },
    }));

    controller.postUpdated();
    await flushAsync();
    groups = [{
        id: 'work',
        groupName: 'Work',
        collapsed: false,
        projects: [{ id: 'saved', name: 'Saved', path: '/work/saved' }],
    }];
    controller.postUpdated();
    await flushAsync();

    assert.equal(posted.length, 2);
    assert.notEqual(posted[0].semanticRevision, posted[1].semanticRevision);
    assert.deepEqual(posted[1].searchCatalog.savedProjects.map(item => item.projectId), ['saved']);
});

test('PROJECT-INCREMENTAL-REFRESH-001 ignores stale and invalidated OPEN delivery failures', async () => {
    const deliveries = [];
    const refreshes = [];
    let groups = [];
    const controller = new OpenWorkspaceDashboardController(createOptions({
        getGroups: () => groups,
        postMessage: () => {
            const deferred = createDeferred();
            deliveries.push(deferred);
            return deferred.promise;
        },
        refresh: reason => refreshes.push(reason),
    }));

    controller.postUpdated();
    groups = [{
        id: 'work',
        groupName: 'Work',
        projects: [{ id: 'saved', name: 'Saved', path: '/work/saved' }],
    }];
    controller.postUpdated();
    deliveries[0].resolve(false);
    await flushAsync();
    assert.equal(deliveries.length, 2);
    deliveries[1].resolve(true);
    await flushAsync();

    groups = [{
        id: 'work',
        groupName: 'Work renamed',
        projects: [{ id: 'saved', name: 'Saved', path: '/work/saved' }],
    }];
    controller.postUpdated();
    controller.invalidatePendingUpdates();
    deliveries[2].resolve(false);
    await flushAsync();

    assert.deepEqual(refreshes, []);
});

test('OPEN-OPEN-PROJECT-DASHBOARD-CONTROLLER-001 retries undelivered and rejected incremental updates through full refresh', async () => {
    const posted = [];
    const refreshes = [];
    const errors = [];
    let delivery = () => Promise.resolve(false);
    const controller = new OpenWorkspaceDashboardController(createOptions({
        postMessage: message => {
            posted.push(message);
            return delivery();
        },
        refresh: reason => refreshes.push(reason),
        logError: (message, error) => errors.push([message, error.message]),
    }));
    controller.setAggregate(makeAggregate([makeRegistration()], {
        semanticRevision: 'delivery-revision',
    }));

    controller.postUpdated();
    await flushAsync();
    controller.postUpdated();
    delivery = () => Promise.reject(new Error('webview closed'));
    await flushAsync();
    controller.postUpdated();
    await flushAsync();

    assert.equal(posted.length, 3);
    assert.deepEqual(refreshes, [
        'open-workspace-update-not-delivered',
        'open-workspace-update-not-delivered',
        'open-workspace-update-post-error',
    ]);
    assert.deepEqual(errors, [['Failed to post OPEN WORKSPACE update message.', 'webview closed']]);
});

test('OPEN-OPEN-PROJECT-INCREMENTAL-RENDERING-001 renderer-ready replay never falls back to a self-refresh loop', async () => {
    const refreshes = [];
    const errors = [];
    let delivery = () => Promise.resolve(false);
    const controller = new OpenWorkspaceDashboardController(createOptions({
        postMessage: () => delivery(),
        refresh: reason => refreshes.push(reason),
        logError: (message, error) => errors.push([message, error.message]),
    }));

    controller.postUpdated({ fallbackToFullRefresh: false });
    await flushAsync();
    delivery = () => Promise.reject(new Error('webview closed'));
    controller.postUpdated({ fallbackToFullRefresh: false });
    await flushAsync();

    assert.deepEqual(refreshes, []);
    assert.deepEqual(errors, [['Failed to post OPEN WORKSPACE update message.', 'webview closed']]);
});

test('PERSIST-DASHBOARD-MIGRATION-PUBLICATION-001 republishes only after migrated project metadata is visible', async () => {
    const events = [];
    let metadata = 'before-migration';
    let migrated = true;
    const controller = new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded: async () => {
            if (migrated) metadata = 'after-migration';
            return { projects: { migrated }, todos: { migrated: false } };
        },
        refreshDashboard: () => events.push(['refresh', metadata]),
        publishOpenWorkspace: () => events.push(['publish', metadata]),
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        logError: () => undefined,
        showAgentPivot: () => events.push(['show']),
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'workspace',
        getVisibleEditorLanguageIds: () => [],
    });

    await controller.checkDataMigration();
    migrated = false;
    await controller.checkDataMigration();
    migrated = true;
    metadata = 'before-explicit-migration';
    await controller.checkDataMigration(true);

    assert.deepEqual(events, [
        ['refresh', 'after-migration'],
        ['publish', 'after-migration'],
        ['refresh', 'after-migration'],
        ['publish', 'after-migration'],
        ['show'],
    ]);
});
