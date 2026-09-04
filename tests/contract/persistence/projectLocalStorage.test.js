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

test('MACHINE-PROJECTS-LOCAL-STORE-001 migrates Local Projects out of synchronized settings', async () => {
    const localContainerAnchor = Buffer.from(JSON.stringify({
        hostPath: '/work/container',
        localDocker: true,
    }), 'utf8').toString('hex');
    const initial = [{
        id: 'group-main', groupName: 'Main', projects: [{
            id: 'project-local', name: 'Local', path: '/work/local', color: '#445566',
        }, {
            id: 'project-container', name: 'Container',
            path: `vscode-remote://dev-container%2B${localContainerAnchor}/workspaces/app`,
            color: '#556677',
        }, {
            id: 'project-remote', name: 'Remote',
            path: 'vscode-remote://ssh-remote%2Bdevbox/work/remote', color: '#667788',
        }],
    }];
    const { clientA, clientB, settings, stateA, stateB } = makeHarness(initial);

    stateA.failNextUpdate('localProjects.v1', new Error('local storage unavailable'));
    await assert.rejects(clientA.migrateDataIfNeeded(), /local storage unavailable/);
    assert.deepEqual(projectIds(settings.projectData), [
        'project-container',
        'project-local',
        'project-remote',
    ]);
    assert.equal(stateA.values['localProjects.v1'], undefined);

    assert.equal(await clientA.migrateDataIfNeeded(), true);
    assert.deepEqual(projectIds(settings.projectData), ['project-remote']);
    assert.deepEqual(projectIds(stateA.values['localProjects.v1']), [
        'project-container',
        'project-local',
    ]);
    assert.deepEqual(projectIds(clientA.getGroups()), [
        'project-container',
        'project-local',
        'project-remote',
    ]);

    await clientB.reconcileProjectCatalog();
    assert.deepEqual(projectIds(clientB.getGroups()), ['project-remote']);
    assert.equal(stateB.values['localProjects.v1'], undefined);

    await clientA.addProject({
        id: 'project-local-a', name: 'Local A', path: '/work/local-a', color: '#778899',
    }, 'group-main');
    await clientB.addProject({
        id: 'project-local-b', name: 'Local B', path: '/work/local-b', color: '#8899aa',
    }, 'group-main');
    await clientA.reconcileProjectCatalog();
    assert.deepEqual(projectIds(settings.projectData), ['project-remote']);
    assert.deepEqual(projectIds(clientA.getGroups()), [
        'project-container',
        'project-local',
        'project-local-a',
        'project-remote',
    ]);
    assert.deepEqual(projectIds(clientB.getGroups()), [
        'project-local-b',
        'project-remote',
    ]);

    await clientA.addProject({
        id: 'project-remote-two', name: 'Remote two',
        path: 'vscode-remote://ssh-remote%2Bdevbox/work/two', color: '#99aabb',
    }, 'group-main');
    await clientB.reconcileProjectCatalog();
    assert.deepEqual(projectIds(clientB.getGroups()), [
        'project-local-b',
        'project-remote',
        'project-remote-two',
    ]);

    await clientA.updateProject('project-local', {
        id: 'ignored', name: 'Local moved remote',
        path: 'vscode-remote://ssh-remote%2Bdevbox/work/local', color: '#445566',
    });
    assert.deepEqual(projectIds(stateA.values['localProjects.v1']), [
        'project-container',
        'project-local-a',
    ]);
    assert.deepEqual(projectIds(settings.projectData), [
        'project-local',
        'project-remote',
        'project-remote-two',
    ]);

    await clientA.updateProject('project-remote', {
        id: 'ignored', name: 'Remote moved local', path: '/work/returned', color: '#667788',
    });
    await clientB.reconcileProjectCatalog();
    assert.deepEqual(projectIds(settings.projectData), [
        'project-local',
        'project-remote-two',
    ]);
    assert.deepEqual(projectIds(clientB.getGroups()), [
        'project-local',
        'project-local-b',
        'project-remote-two',
    ]);
});
