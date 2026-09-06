'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const { loadFreshWithFakeVscode } = require('../../helpers/runtimeContract');

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeGlobalState(initial = {}) {
    const values = clone(initial);
    const updates = [];
    return {
        values,
        updates,
        get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(values, key) ? clone(values[key]) : fallback;
        },
        async update(key, value) {
            updates.push(key);
            if (value === undefined) delete values[key];
            else values[key] = clone(value);
        },
    };
}

function makeProjectService(
    globalState,
    colorService = { addRecentColor: async () => undefined },
) {
    const vscode = createFakeVscode({
        workspace: {
            getConfiguration: () => ({
                get: (key, fallback) => fallback,
                inspect: () => undefined,
                update: async () => undefined,
            }),
        },
    });
    const ProjectService = loadFreshWithFakeVscode(
        '../../../out/services/projectService',
        vscode,
        __dirname
    ).default;
    return new ProjectService(
        { globalState },
        colorService,
    );
}

function makeGroups() {
    return [{
        id: 'group-a',
        groupName: 'A',
        collapsed: false,
        projects: [
            { id: 'project-a', name: 'API', path: '/work/api', color: '#112233', tags: ['backend'] },
            { id: 'project-b', name: 'Web', path: '/work/web', color: '#445566' },
        ],
    }];
}

test('PROJECT-LAST-OPENED-001 opening metadata is not persisted into the synchronized project catalog', async () => {
    const globalState = makeGlobalState({ projects: makeGroups() });
    const service = makeProjectService(globalState);

    await service.touchProjectLastOpened('project-a', 1234567890);

    assert.deepEqual(globalState.updates, [], 'opening must not write a whole synchronized project record');
});

test('PROJECT-LAST-OPENED-001 ignores all activity timestamp writes', async () => {
    const globalState = makeGlobalState({ projects: makeGroups() });
    const service = makeProjectService(globalState);

    await service.touchProjectLastOpened('missing');
    await service.touchProjectLastOpened('');
    await service.touchProjectLastOpened(undefined);

    assert.deepEqual(globalState.updates, [], 'a no-op touch must not churn persisted state');
});

test('PROJECT-INCREMENTAL-REFRESH-001 inline metadata updates do not rewrite recent colors', async () => {
    const globalState = makeGlobalState({ projects: makeGroups() });
    const colors = [];
    const service = makeProjectService(globalState, {
        addRecentColor: async color => colors.push(color),
    });

    await service.updateProject('project-a', {
        id: 'project-a', name: 'Renamed', path: '/work/api', color: '#112233', tags: ['frontend'],
    }, undefined, false);

    assert.deepEqual(colors, [], 'inline edits must not change recent-colour configuration');
});

test('MANAGED-REMOTE-AUTHORITY-001 MANAGED-REMOTE-LOCAL-PROJECTION-001 keeps synchronized remote bytes inert while local Projects remain editable', async () => {
    const legacyRemote = [{
        id: 'legacy-group', groupName: 'Legacy', projects: [{
            id: 'legacy-remote', name: 'Legacy Remote',
            path: 'vscode-remote://ssh-remote%2Bold/work/legacy', color: '#112233',
        }],
    }];
    const local = [{
        id: 'local-group', groupName: 'Local', projects: [{
            id: 'local-project', name: 'Local', path: '/work/local', color: '#223344',
        }],
    }];
    const globalState = makeGlobalState({
        projects: legacyRemote,
        'localProjects.v1': local,
    });
    const service = makeProjectService(globalState);

    assert.deepEqual(service.getProjectsFlat().map(project => project.id), ['local-project']);
    await service.addProject({
        id: 'local-second', name: 'Local 2', path: '/work/local-2', color: '#334455',
    }, 'local-group');
    await service.addProject({
        id: 'local-wsl', name: 'WSL',
        path: 'vscode-remote://wsl%2BUbuntu/home/dev/app', color: '#334455',
    }, 'local-group');
    assert.deepEqual(globalState.values.projects, legacyRemote,
        'normal product writes must not rewrite retained legacy remote bytes');
    assert.deepEqual(service.getProjectsFlat().map(project => project.id), [
        'local-project', 'local-second', 'local-wsl',
    ]);
    await assert.rejects(service.addProject({
        id: 'remote-new', name: 'Remote',
        path: 'vscode-remote://ssh-remote%2Bnew/work/new', color: '#445566',
    }, 'local-group'), /Managed Machine/u);
    assert.deepEqual(globalState.values.projects, legacyRemote);
});
