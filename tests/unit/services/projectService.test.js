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

function makeProjectService(globalState) {
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
        { addRecentColor: async () => undefined }
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

test('PROJECT-LAST-OPENED-001 persists the timestamp on the opened project only', async () => {
    const globalState = makeGlobalState({ projects: makeGroups() });
    const service = makeProjectService(globalState);

    await service.touchProjectLastOpened('project-a', 1234567890);

    assert.deepEqual(globalState.updates, ['projects'], 'the touch must persist exactly one write');
    const stored = globalState.get('projects');
    const touched = stored[0].projects.find(project => project.id === 'project-a');
    const other = stored[0].projects.find(project => project.id === 'project-b');
    assert.equal(touched.lastOpenedAt, 1234567890);
    assert.deepEqual(touched.tags, ['backend'], 'unrelated fields must survive the touch');
    assert.equal(other.lastOpenedAt, undefined);
});

test('PROJECT-LAST-OPENED-001 ignores unknown and empty project ids without writing', async () => {
    const globalState = makeGlobalState({ projects: makeGroups() });
    const service = makeProjectService(globalState);

    await service.touchProjectLastOpened('missing');
    await service.touchProjectLastOpened('');
    await service.touchProjectLastOpened(undefined);

    assert.deepEqual(globalState.updates, [], 'a no-op touch must not churn persisted state');
});
