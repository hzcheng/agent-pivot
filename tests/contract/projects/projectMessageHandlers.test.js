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
    const outgoing = [];
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
            getProjectAndGroup: (projectId, groupId) => {
                calls.push(['getProjectAndGroup', projectId, groupId]);
                const value = Object.prototype.hasOwnProperty.call(overrides, 'project')
                    ? overrides.project
                    : project;
                return value && groupId === 'group-a' ? [value, { id: groupId }] : [null, null];
            },
            copyProjectsFromFilledStorageOptionToEmptyStorageOption: async () => {
                calls.push(['copyFromOtherStorage']);
            },
            updateProject: async (projectId, updated) => {
                calls.push(['updateProject', projectId]);
                var p = Object.prototype.hasOwnProperty.call(overrides, 'project')
                    ? overrides.project
                    : project;
                Object.assign(p, updated);
            },
        },
        projectOpenController: {
            openProject: overrides.failOpen
                ? async (...args) => {
                    calls.push(['openProject', ...args]);
                    throw new Error('open failed');
                }
                : record('openProject'),
        },
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
        postMessage: message => { outgoing.push(message); return Promise.resolve(true); },
        showWarningMessage: message => { calls.push(['showWarningMessage', message]); },
    };
    const handlers = createProjectMessageHandlers(options);
    return { handlers, calls, outgoing, project };
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
        'open-window-navigation-request',
        'add-project',
        'import-from-other-storage',
        'reordered-projects',
        'reordered-favorites',
        'remove-project',
        'edit-project',
        'save-project-inline',
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
    ], 'the open flow must not mutate the synchronized project catalog');
});

test('PROJECT-LAST-OPENED-001 opens without persisting nonessential activity metadata', async () => {
    const { handlers, calls } = createFixture();

    await handlers['selected-project']({
        type: 'selected-project',
        projectId: 'project-a',
        projectOpenType: 3,
    });

    assert.deepEqual(calls, [
        ['getProject', 'project-a'],
        ['acknowledgeAttention', []],
        ['openProject', calls[2][1], 3],
    ], 'a successful open must not add a synchronized whole-record write');
});

test('PROJECT-LAST-OPENED-001 does not mutate metadata when the open throws', async () => {
    const { handlers, calls } = createFixture({ failOpen: true });

    await assert.rejects(handlers['selected-project']({
        type: 'selected-project',
        projectId: 'project-a',
        projectOpenType: 3,
    }), /open failed/);

    assert.deepEqual(calls.map(call => call[0]), [
        'getProject',
        'acknowledgeAttention',
        'openProject',
    ], 'a failed open must never persist activity metadata');
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

test('PROJECT-INLINE-EDIT-001 saves name, description, and tags without losing synced project fields', async () => {
    const { handlers, calls, outgoing, project } = createFixture();
    project.color = '#abcdef';
    project.favorite = true;
    project.lastOpenedAt = 123456789;

    await handlers['save-project-inline']({
        type: 'save-project-inline',
        version: 1,
        requestId: 'inline-save-1',
        projectId: 'project-a',
        groupId: 'group-a',
        name: '  New Name  ',
        description: '  Updated desc  ',
        tags: ' frontend , #urgent , FRONTEND ',
    });

    assert.deepEqual(calls, [
        ['getProjectAndGroup', 'project-a', 'group-a'],
        ['updateProject', 'project-a'],
        ['refreshAfterMutation', undefined],
    ], 'inline save must call updateProject then refresh');

    // Verify the project was updated in-place
    assert.equal(project.name, 'New Name', 'name must be trimmed');
    assert.equal(project.description, 'Updated desc', 'description must be trimmed');
    assert.deepEqual(project.tags, ['frontend', 'urgent'], 'tags must be normalized and deduplicated');
    assert.equal(project.path, '/work/api', 'path must survive an inline edit');
    assert.equal(project.color, '#abcdef', 'colour must survive an inline edit');
    assert.equal(project.favorite, true, 'favorite state must survive an inline edit');
    assert.equal(project.lastOpenedAt, 123456789, 'last-opened state must survive an inline edit');
    assert.deepEqual(outgoing, [{
        type: 'project-inline-edit-settlement', version: 1,
        requestId: 'inline-save-1', projectId: 'project-a', status: 'saved',
    }], 'the host must correlate the saved result to its originating form');
});

test('PROJECT-INLINE-EDIT-001 rejects empty names and missing projects without refreshing', async () => {
    const { handlers, calls, outgoing } = createFixture();

    // Empty name
    await handlers['save-project-inline']({
        type: 'save-project-inline',
        version: 1,
        requestId: 'inline-empty-name',
        projectId: 'project-a',
        groupId: 'group-a',
        name: '   ',
        description: '',
        tags: '',
    });

    assert.deepEqual(calls, [
        ['getProjectAndGroup', 'project-a', 'group-a'],
    ], 'empty name must not trigger a refresh');
    assert.deepEqual(outgoing, [{
        type: 'project-inline-edit-settlement', version: 1,
        requestId: 'inline-empty-name', projectId: 'project-a', status: 'failed',
    }]);

    const missing = createFixture({ project: null });
    await missing.handlers['save-project-inline']({
        type: 'save-project-inline',
        version: 1,
        requestId: 'inline-missing-project',
        projectId: 'nonexistent',
        groupId: 'group-a',
        name: 'Test',
        description: '',
        tags: '',
    });

    assert.deepEqual(missing.calls, [
        ['getProjectAndGroup', 'nonexistent', 'group-a'],
    ], 'a missing project must not be updated or refresh the panel');
    assert.deepEqual(missing.outgoing, [{
        type: 'project-inline-edit-settlement', version: 1,
        requestId: 'inline-missing-project', projectId: 'nonexistent', status: 'failed',
    }]);
});

test('PROJECT-INLINE-EDIT-001 clears tags when the input is empty', async () => {
    const { handlers, calls, outgoing, project } = createFixture();
    project.tags = ['old-tag'];

    await handlers['save-project-inline']({
        type: 'save-project-inline',
        version: 1,
        requestId: 'inline-clear-tags',
        projectId: 'project-a',
        groupId: 'group-a',
        name: 'API',
        description: '',
        tags: '',
    });

    assert.deepEqual(calls, [
        ['getProjectAndGroup', 'project-a', 'group-a'],
        ['updateProject', 'project-a'],
        ['refreshAfterMutation', undefined],
    ], 'empty tags must still call update then refresh');
    assert.equal(project.tags, undefined, 'empty tags input must clear the tags field');
    assert.deepEqual(outgoing, [{
        type: 'project-inline-edit-settlement', version: 1,
        requestId: 'inline-clear-tags', projectId: 'project-a', status: 'saved',
    }]);
});

test('PROJECT-INLINE-EDIT-001 rejects malformed correlated requests before reading or mutating project data', async () => {
    const { handlers, calls, outgoing } = createFixture();

    await handlers['save-project-inline']({
        type: 'save-project-inline', version: 1, requestId: 'inline-malformed',
        projectId: 'project-a', name: 'API', description: 42, tags: '',
    });

    assert.deepEqual(calls, [], 'malformed values must not reach the project service');
    assert.deepEqual(outgoing, [{
        type: 'project-inline-edit-settlement', version: 1,
        requestId: 'inline-malformed', projectId: 'project-a', status: 'failed',
    }], 'a recognized correlated request must settle exactly once even when malformed');
});
