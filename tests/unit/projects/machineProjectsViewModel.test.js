'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildMachineProjectsViewModel,
    normalizeMachineDisplayName,
    resolveMachineHostTarget,
    withMachineDisplayName,
} = require('../../../out/projects/machineProjectsViewModel');

function groups() {
    const anchor = Buffer.from(JSON.stringify({
        hostPath: '/home/dev/workspace',
        localDocker: false,
        configFile: { path: '/home/dev/workspace/.devcontainer/devcontainer.json' },
    }), 'utf8').toString('hex');
    return [{
        id: 'backend',
        groupName: 'Backend',
        projects: [{
            id: 'api',
            name: 'API',
            path: 'vscode-remote://ssh-remote%2Bdevbox/work/api',
            tags: ['active', 'api'],
            favorite: true,
            favoriteOrder: 1,
        }, {
            id: 'worker',
            name: 'Worker',
            path: `vscode-remote://dev-container%2B${anchor}%40ssh-remote%2Bdevbox/work/worker`,
            tags: ['active', 'worker'],
        }],
    }];
}

test('MACHINE-PROJECTS-PROJECTION-001 derives Machine, Host, and Dev Container rows directly from saved Project URIs', () => {
    const model = buildMachineProjectsViewModel(groups());

    assert.equal(model.projectCount, 2);
    assert.equal(model.machines.length, 1);
    assert.equal(model.machines[0].displayName, 'devbox');
    assert.deepEqual(model.machines[0].environments.map(environment => environment.kind), [
        'host', 'devContainer',
    ]);
    assert.deepEqual(
        model.machines[0].environments.flatMap(environment =>
            environment.projects.map(project => project.id)),
        ['api', 'worker'],
    );
    assert.equal(
        model.machines[0].environments[1].projects[0].path,
        groups()[0].projects[1].path,
        'the view never rewrites the URI used by the existing Project opener',
    );
    assert.deepEqual(model.tags, ['active', 'api', 'Backend', 'worker']);
    assert.equal(model.favorites[0].id, 'api');
});

test('MACHINE-PROJECTS-PROJECTION-001 treats WSL as its own Machine and local containers as an Environment of Local', () => {
    const localContainer = Buffer.from(JSON.stringify({
        hostPath: '/work/local-api',
        localDocker: true,
        configFile: { path: '/work/local-api/.devcontainer/devcontainer.json' },
    }), 'utf8').toString('hex');
    const model = buildMachineProjectsViewModel([{
        id: 'mixed', groupName: 'Mixed', projects: [{
            id: 'wsl', name: 'WSL', path: 'vscode-remote://wsl%2BUbuntu/home/dev/app', tags: [],
        }, {
            id: 'local-container', name: 'Container',
            path: `vscode-remote://dev-container%2B${localContainer}/workspaces/app`, tags: [],
        }, {
            id: 'local', name: 'Local', path: '/home/dev/local', tags: [],
        }],
    }]);

    assert.deepEqual(model.machines.map(machine => machine.displayName), ['Ubuntu (WSL)', 'Local']);
    assert.deepEqual(model.machines[1].environments.map(environment => environment.kind), [
        'host', 'devContainer',
    ]);
    assert.equal(model.machines[1].hostOpenable, true);
    assert.equal(model.machines[1].hostProjectId, 'local');
    assert.deepEqual(resolveMachineHostTarget([{
        id: 'local', groupName: 'Local', projects: [{
            id: 'local', name: 'Local', path: '/home/dev/local', tags: [],
        }],
    }], {
        machineId: model.machines[1].id,
        projectId: 'local',
    }), {
        kind: 'local',
        name: 'Local',
    });
});

test('MACHINE-PROJECTS-HOST-NAVIGATION-001 derives a Host root from the same saved URI without a connection profile', () => {
    const model = buildMachineProjectsViewModel(groups());
    const machine = model.machines[0];

    assert.equal(machine.hostOpenable, true);
    assert.equal(machine.hostProjectId, 'api');
    assert.deepEqual(resolveMachineHostTarget(groups(), {
        machineId: machine.id,
        projectId: machine.hostProjectId,
    }), {
        kind: 'remote',
        name: 'devbox',
        path: 'vscode-remote://ssh-remote%2Bdevbox/',
        remoteType: 1,
    });
});

test('MACHINE-PROJECTS-HOST-NAVIGATION-001 can derive an SSH Host from a container-only Machine', () => {
    const source = groups();
    source[0].projects.shift();
    const model = buildMachineProjectsViewModel(source);
    const machine = model.machines[0];

    assert.equal(machine.hostProjectId, 'worker');
    assert.equal(resolveMachineHostTarget(source, {
        machineId: machine.id,
        projectId: machine.hostProjectId,
    }).path, 'vscode-remote://ssh-remote%2Bdevbox/');
});

test('MACHINE-PROJECTS-RENAME-001 projects share one synced display name without changing Machine identity or URIs', () => {
    const source = groups();
    const original = buildMachineProjectsViewModel(source).machines[0];
    source[0].projects[1].machineDisplayName = '  Build   Box  ';

    const renamed = buildMachineProjectsViewModel(source).machines[0];
    assert.equal(renamed.id, original.id);
    assert.equal(renamed.defaultName, 'devbox');
    assert.equal(renamed.displayName, 'Build Box');
    assert.equal(renamed.renamed, true);
    assert.deepEqual(renamed.environments.flatMap(environment =>
        environment.projects.map(project => project.machineName)), ['Build Box', 'Build Box']);

    const updated = withMachineDisplayName(source, renamed.id, 'Team Dev');
    assert.deepEqual(updated[0].projects.map(project => project.machineDisplayName), [
        'Team Dev', 'Team Dev',
    ]);
    assert.deepEqual(updated[0].projects.map(project => project.path),
        source[0].projects.map(project => project.path));
    const reset = withMachineDisplayName(updated, renamed.id, null);
    assert.deepEqual(reset[0].projects.map(project => project.machineDisplayName),
        [undefined, undefined]);
    assert.equal(buildMachineProjectsViewModel(reset).machines[0].displayName, 'devbox');
    assert.equal(normalizeMachineDisplayName('x'.repeat(81)), null);
});
