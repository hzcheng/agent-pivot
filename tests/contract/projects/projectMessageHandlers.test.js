'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createProjectMessageHandlers,
    createProjectSurfaceRefresh,
} = require('../../../out/projects/projectMessageHandlers');
const { getAttentionProjectKey } = require('../../../out/aiSessions/attentionProject');

function createFixture(overrides = {}) {
    const calls = [];
    const record = name => (...args) => {
        calls.push([name, ...args]);
        return Promise.resolve();
    };
    const project = { id: 'project-a', name: 'API', path: '/work/api', isGitRepo: true };
    const options = {
        projectService: {
            getProject: projectId => {
                calls.push(['getProject', projectId]);
                return Object.prototype.hasOwnProperty.call(overrides, 'project')
                    ? overrides.project
                    : project;
            },
            copyProjectsFromFilledStorageOptionToEmptyStorageOption: async () => {
                calls.push(['copyFromOtherStorage']);
            },
        },
        projectOpenController: { openProject: record('openProject') },
        projectMutationController: {
            addProject: record('addProject'),
            editProject: record('editProject'),
            editProjectColor: record('editProjectColor'),
        },
        projectOrderController: { reorderGroups: record('reorderGroups') },
        favoriteProjectController: {
            reorderFavoriteProjects: record('reorderFavoriteProjects'),
            toggleProjectFavorite: record('toggleProjectFavorite'),
        },
        projectRemovalController: { removeProject: record('removeProject') },
        groupCommandController: {
            editGroup: record('editGroup'),
            removeGroup: record('removeGroup'),
            addGroup: record('addGroup'),
        },
        groupCollapseController: { collapseGroup: record('collapseGroup') },
        getWorkspaceNavigationController: () => ({ open: record('openWorkspaceNavigation') }),
        getOpenWorkspacePinController: () => ({ handle: record('handleOpenWorkspacePin') }),
        getAttentionAggregate: () => overrides.attentionAggregate || null,
        acknowledgeAiSessionAttentionEventIds: record('acknowledgeAttention'),
        refreshAfterMutation: mode => { calls.push(['refreshAfterMutation', mode]); },
        showWarningMessage: message => { calls.push(['showWarningMessage', message]); },
    };
    const handlers = createProjectMessageHandlers(options);
    return { handlers, calls, project };
}

function createSurfaceFixture(options = {}) {
    const events = [];
    const panel = { postUpdated: mode => events.push(['projects-panel', mode]) };
    const surface = createProjectSurfaceRefresh({
        getProjectsPanelController: () => (options.omitPanel ? undefined : panel),
        getOpenWorkspaceDashboardController: () => ({
            postUpdated: () => events.push(['open-workspaces-panel']),
        }),
        publishOpenWorkspace: () => events.push(['publish-workspace']),
        syncProjectColorToCurrentWindow: project => events.push(['window-color', project]),
    });
    return { surface, events };
}

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 exposes every production project/group handler key', () => {
    const { handlers } = createFixture();

    assert.deepEqual(Object.keys(handlers), [
        'selected-project',
        'set-open-workspace-pin',
        'add-project',
        'import-from-other-storage',
        'reordered-projects',
        'reordered-favorites',
        'remove-project',
        'edit-project',
        'color-project',
        'favorite-project',
        'edit-group',
        'remove-group',
        'add-group',
        'collapse-group',
        'toggle-all-groups',
    ]);
});

test('OPEN-PROJECT-UI-HOST-NAVIGATION-001 routes workspace navigation cards before any project lookup', async () => {
    const { handlers, calls } = createFixture();

    await handlers['selected-project']({
        type: 'selected-project',
        projectId: '__openWorkspaceNavigation-card-7',
    });

    assert.deepEqual(calls, [['openWorkspaceNavigation', '__openWorkspaceNavigation-card-7']],
        'navigation cards must go straight to the workspace navigation controller');
});

test('OPEN-PROJECT-UI-HOST-NAVIGATION-001 warns and stops when the selected project is gone', async () => {
    const { handlers, calls } = createFixture({ project: null });

    await handlers['selected-project']({
        type: 'selected-project',
        projectId: 'missing',
        projectOpenType: 3,
    });

    assert.deepEqual(calls, [
        ['getProject', 'missing'],
        ['showWarningMessage', 'Selected Project not found.'],
    ], 'a missing project must warn without acknowledging attention or opening anything');
});

test('OPEN-PROJECT-UI-HOST-NAVIGATION-001 acknowledges the card attention before opening the project', async () => {
    const attentionAggregate = {
        protocolVersion: 1,
        aggregateRevision: '0'.repeat(64),
        generatedAtMs: 10,
        sessions: [{
            projectId: getAttentionProjectKey('/work/api'),
            sessionKey: 'codex:session-1',
            reasons: ['completed'],
            eventIds: ['evt-1', 'evt-2'],
            observedAtMs: 9,
        }],
    };
    const { handlers, calls, project } = createFixture({ attentionAggregate });

    await handlers['selected-project']({
        type: 'selected-project',
        projectId: 'project-a',
        projectOpenType: 3,
    });

    assert.deepEqual(calls, [
        ['getProject', 'project-a'],
        ['acknowledgeAttention', ['evt-1', 'evt-2']],
        ['openProject', project, 3],
    ], 'the open flow must acknowledge every event the card represents before opening');
});

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 delegates project mutations to their controllers', async () => {
    const { handlers, calls } = createFixture();

    await handlers['add-project']({ groupId: 'group-a' });
    await handlers['edit-project']({ projectId: 'project-a' });
    await handlers['color-project']({ projectId: 'project-b' });

    assert.deepEqual(calls, [
        ['addProject', 'group-a'],
        ['editProject', 'project-a'],
        ['editProjectColor', 'project-b'],
    ]);
});

test('PROJECT-PROJECT-ORDER-CONTROLLER-001 passes group orders through unchanged', async () => {
    const { handlers, calls } = createFixture();

    const groupOrders = [{ groupId: 'group-a', projectIds: ['project-a'] }];
    await handlers['reordered-projects']({ groupOrders });

    assert.deepEqual(calls, [['reorderGroups', groupOrders]]);
    assert.equal(calls[0][1], groupOrders, 'group orders must pass through unchanged');
});

test('PROJECT-FAVORITE-PROJECT-CONTROLLER-001 delegates favorite mutations with the array guard', async () => {
    const { handlers, calls } = createFixture();

    await handlers['favorite-project']({ projectId: 'project-a' });
    await handlers['reordered-favorites']({ projectIds: ['project-b', 'project-a'] });
    await handlers['reordered-favorites']({ projectIds: 'project-a' });

    assert.deepEqual(calls, [
        ['toggleProjectFavorite', 'project-a'],
        ['reorderFavoriteProjects', ['project-b', 'project-a']],
        ['reorderFavoriteProjects', []],
    ], 'a non-array favorite order must degrade to an empty order');
});

test('PROJECT-PROJECT-REMOVAL-CONTROLLER-001 delegates removals by project id', async () => {
    const { handlers, calls } = createFixture();

    await handlers['remove-project']({ projectId: 'project-a' });

    assert.deepEqual(calls, [['removeProject', 'project-a']]);
});

test('PROJECT-INCREMENTAL-REFRESH-001 imports the other storage before refreshing the surfaces', async () => {
    const { handlers, calls } = createFixture();

    await handlers['import-from-other-storage']({ type: 'import-from-other-storage' });

    assert.deepEqual(calls, [
        ['copyFromOtherStorage'],
        ['refreshAfterMutation', undefined],
    ], 'the catalog copy must settle before the partial surface refresh');
});

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 delegates group commands and workspace pins', async () => {
    const { handlers, calls } = createFixture();

    await handlers['edit-group']({ groupId: 'group-a' });
    await handlers['remove-group']({ groupId: 'group-b' });
    await handlers['add-group']({});
    await handlers['collapse-group']({ groupId: 'group-a', collapsed: true });
    const pinMessage = { type: 'set-open-workspace-pin', requestId: 'req-1', cardId: 'card-1', pinned: true };
    await handlers['set-open-workspace-pin'](pinMessage);

    assert.deepEqual(calls, [
        ['editGroup', 'group-a'],
        ['removeGroup', 'group-b'],
        ['addGroup'],
        ['collapseGroup', 'group-a', true],
        ['handleOpenWorkspacePin', pinMessage],
    ]);
    assert.equal(calls[4][1], pinMessage, 'the pin message must pass through untouched');

    assert.strictEqual(handlers['toggle-all-groups']({ collapsed: true }), undefined,
        'collapse-all stays a per-webview convenience action with no host work');
    assert.equal(calls.length, 5, 'toggle-all-groups must not reach any controller');
});

test('PROJECT-INCREMENTAL-REFRESH-001 posts both project surfaces without a full rebuild', () => {
    const { surface, events } = createSurfaceFixture();

    surface.postProjectSurfacesUpdated('merge');

    assert.deepEqual(events, [
        ['projects-panel', 'merge'],
        ['open-workspaces-panel'],
    ]);
});

test('PROJECT-INCREMENTAL-REFRESH-001 tolerates a missing projects panel', () => {
    const { surface, events } = createSurfaceFixture({ omitPanel: true });

    surface.postProjectSurfacesUpdated('replace');

    assert.deepEqual(events, [['open-workspaces-panel']]);
});

test('PROJECT-INCREMENTAL-REFRESH-001 orders the mutation refresh: surfaces, colour, republish', () => {
    const { surface, events } = createSurfaceFixture();
    const project = { id: 'project-a' };

    surface.refreshAfterMutation();
    assert.deepEqual(events, [
        ['projects-panel', 'replace'],
        ['open-workspaces-panel'],
        ['window-color', null],
        ['publish-workspace'],
    ], 'the default replace refresh must update surfaces, sync the window colour, then republish');

    events.length = 0;
    surface.refreshAfterMutation('merge');
    assert.deepEqual(events[0], ['projects-panel', 'merge'], 'the update mode must reach the panels');

    events.length = 0;
    surface.applyProjectColorToCurrentWindow(project);
    assert.deepEqual(events, [['window-color', project]],
        'an explicit project colour sync must pass the project through');
});
