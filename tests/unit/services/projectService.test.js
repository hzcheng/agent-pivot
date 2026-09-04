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

function makeProjectService(
    globalState,
    colorService = { addRecentColor: async () => undefined },
    localMachineId,
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
        { localMachineId },
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

test('MACHINE-PROJECTS-RENAME-001 inherits a Machine alias on add and clears it after a move', async () => {
    const groups = [{
        id: 'group-a',
        groupName: 'A',
        collapsed: false,
        projects: [{
            id: 'project-api',
            name: 'API',
            path: 'vscode-remote://ssh-remote%2Bdevbox/work/api',
            color: '#112233',
            machineDisplayName: 'Build Box',
        }],
    }];
    const service = makeProjectService(makeGlobalState({ projects: groups }));

    await service.addProject({
        id: 'project-worker',
        name: 'Worker',
        path: 'vscode-remote://ssh-remote%2Bdevbox/work/worker',
        color: '#445566',
    }, 'group-a');
    assert.equal(service.getProject('project-worker').machineDisplayName, 'Build Box');

    await service.updateProject('project-worker', {
        id: 'ignored-by-update',
        name: 'Worker',
        path: 'vscode-remote://ssh-remote%2Bother/work/worker',
        color: '#445566',
    });
    assert.equal(service.getProject('project-worker').machineDisplayName, undefined);
    assert.equal(service.getProject('project-api').machineDisplayName, 'Build Box');
});

test('MACHINE-PROJECTS-LOCAL-SCOPE-001 scopes legacy and new Local Projects without touching remotes', async () => {
    const localContainerAnchor = Buffer.from(JSON.stringify({
        hostPath: '/work/container',
        localDocker: true,
    }), 'utf8').toString('hex');
    const groups = [{
        id: 'group-a', groupName: 'A', projects: [{
            id: 'legacy-local', name: 'Local', path: '/work/local', color: '#112233',
        }, {
            id: 'local-container', name: 'Local container',
            path: `vscode-remote://dev-container%2B${localContainerAnchor}/workspaces/app`,
            color: '#182838',
        }, {
            id: 'remote', name: 'Remote',
            path: 'vscode-remote://ssh-remote%2Bdevbox/work/remote', color: '#223344',
        }],
    }];
    const service = makeProjectService(
        makeGlobalState({ projects: groups }),
        undefined,
        'computer-a',
    );

    assert.equal(await service.migrateDataIfNeeded(), true);
    const scope = service.getLocalMachineScope();
    assert.match(scope, /^local-machine-[a-f0-9]{16}$/);
    assert.equal(service.getProject('legacy-local').localMachineScope, scope);
    assert.equal(service.getProject('local-container').localMachineScope, scope);
    assert.equal(service.getProject('remote').localMachineScope, undefined);

    await service.addProject({
        id: 'new-local', name: 'New local', path: '/work/new', color: '#334455',
    }, 'group-a');
    assert.equal(service.getProject('new-local').localMachineScope, scope);

    await service.updateProject('new-local', {
        id: 'ignored', name: 'Now remote',
        path: 'vscode-remote://ssh-remote%2Bdevbox/work/new', color: '#334455',
        localMachineScope: scope,
    });
    assert.equal(service.getProject('new-local').localMachineScope, undefined);

    await service.updateProject('remote', {
        id: 'ignored', name: 'Now local', path: '/work/remote', color: '#223344',
    });
    assert.equal(service.getProject('remote').localMachineScope, scope);
});
