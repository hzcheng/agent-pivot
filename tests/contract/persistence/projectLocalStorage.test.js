'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const { loadFreshWithFakeVscode } = require('../../helpers/runtimeContract');

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeMemento(initial = {}) {
    const values = clone(initial);
    const failures = new Map();
    return {
        values,
        failNextUpdate(key, error) {
            failures.set(key, error);
        },
        get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(values, key) ? clone(values[key]) : fallback;
        },
        async update(key, value) {
            if (failures.has(key)) {
                const error = failures.get(key);
                failures.delete(key);
                throw error;
            }
            if (value === undefined) delete values[key];
            else values[key] = clone(value);
        },
    };
}

function projectIds(groups) {
    return (groups || []).flatMap(group => group.projects || [])
        .map(project => project.id)
        .sort();
}

function makeHarness(initialGroups) {
    const settings = {
        storeProjectsInSettings: true,
        projectData: clone(initialGroups),
    };
    const configuration = {
        get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(settings, key)
                ? clone(settings[key])
                : fallback;
        },
        inspect(key) {
            return Object.prototype.hasOwnProperty.call(settings, key)
                ? { globalValue: clone(settings[key]) }
                : undefined;
        },
        async update(key, value) {
            settings[key] = clone(value);
        },
    };
    const vscode = createFakeVscode({
        workspace: { getConfiguration: () => configuration },
    });
    vscode.ConfigurationTarget = { Global: 1 };
    const ProjectService = loadFreshWithFakeVscode(
        '../../../out/services/projectService',
        vscode,
        __dirname
    ).default;
    const stateA = makeMemento();
    const stateB = makeMemento();
    const colorService = { addRecentColor: async () => undefined };
    return {
        settings,
        stateA,
        stateB,
        clientA: new ProjectService(
            { globalState: stateA },
            colorService,
            { createActorId: () => 'actor-a' },
        ),
        clientB: new ProjectService(
            { globalState: stateB },
            colorService,
            { createActorId: () => 'actor-b' },
        ),
    };
}

test('MACHINE-PROJECTS-LOCAL-STORE-001 keeps legacy synchronized Projects inert', async () => {
    const initial = [{
        id: 'group-main', groupName: 'Main', projects: [{
            id: 'project-local', name: 'Local', path: '/work/local', color: '#445566',
        }, {
            id: 'project-remote', name: 'Remote',
            path: 'vscode-remote://ssh-remote%2Bdevbox/work/remote', color: '#667788',
        }],
    }];
    const { clientA, clientB, settings, stateA, stateB } = makeHarness(initial);

    assert.deepEqual(projectIds(settings.projectData), ['project-local', 'project-remote']);
    assert.deepEqual(clientA.getGroups(), []);
    assert.deepEqual(clientB.getGroups(), []);
    assert.equal(stateB.values['localProjects.v1'], undefined);

    await clientA.addProject({
        id: 'project-local-a', name: 'Local A', path: '/work/local-a', color: '#778899',
    }, 'group-main');
    await clientB.addProject({
        id: 'project-local-b', name: 'Local B', path: '/work/local-b', color: '#8899aa',
    }, 'group-main');
    assert.deepEqual(projectIds(clientA.getGroups()), ['project-local-a']);
    assert.deepEqual(projectIds(clientB.getGroups()), ['project-local-b']);
    assert.deepEqual(projectIds(settings.projectData), ['project-local', 'project-remote']);
    await assert.rejects(clientA.addProject({
        id: 'project-remote-two', name: 'Remote two',
        path: 'vscode-remote://ssh-remote%2Bdevbox/work/two', color: '#99aabb',
    }, 'group-main'), /Managed Machine/u);
    assert.deepEqual(projectIds(stateA.values['localProjects.v1']), ['project-local-a']);
    assert.deepEqual(projectIds(settings.projectData), ['project-local', 'project-remote']);
});
