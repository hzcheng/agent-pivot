'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildMachineProjectsBlockingViewModel,
    buildMachineProjectsViewModel,
    resolveMachineProjectTarget,
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

test('MACHINE-PROJECTS-PROJECTION-001 MACHINE-PROJECTS-MIGRATION-PREVIEW-001 builds one Machine with distinct Host and Dev Container environments', () => {
    const preview = buildMachineProjectsViewModel(groups(), {
        profileAvailability: 'ready',
        profiles: [],
    });

    assert.equal(preview.kind, 'ready');
    assert.equal(preview.machines.length, 1);
    assert.deepEqual(preview.machines[0].environments.map(environment => environment.kind), [
        'host', 'devContainer',
    ]);
    assert.deepEqual(
        preview.machines[0].environments.flatMap(environment =>
            environment.projects.map(project => project.legacyProjectId)),
        ['api', 'worker'],
    );
    assert.equal(preview.machines[0].connectionState, 'notConfigured');
    assert.deepEqual(preview.tags, ['active', 'api', 'Backend', 'worker']);
    assert.deepEqual(preview.migrationPreview, {
        legacyGroupCount: 1,
        legacyProjectCount: 2,
        machineCount: 1,
        environmentCount: 2,
        devContainerCount: 1,
        groupTagCount: 1,
        readyProjectCount: 2,
        reviewProjectCount: 0,
        cannotOpenProjectCount: 0,
        blockingCount: 0,
        overLimitTagCount: 0,
        overLimitProjectCount: 0,
    });
});

test('MACHINE-PROJECTS-PROJECTION-001 mirrors Favorites without duplicating Project identity or counts', () => {
    const initial = buildMachineProjectsViewModel(groups(), {
        profileAvailability: 'ready',
        profiles: [],
    });
    const machineId = initial.machines[0].id;
    const preview = buildMachineProjectsViewModel(groups(), {
        profileAvailability: 'ready',
        profiles: [{
            machineId,
            kind: 'ssh',
            target: 'devbox-local-alias',
            resolverAuthority: 'ssh-remote+devbox-local-alias',
            updatedAtMs: 1,
        }],
    });

    assert.equal(preview.projectCount, 2);
    assert.equal(preview.favorites.length, 1);
    assert.equal(preview.favorites[0].legacyProjectId, 'api');
    assert.equal(preview.favorites[0].machineId, machineId);
    assert.equal(preview.machines[0].connectionState, 'configured');
    assert.equal(preview.machines[0].connectionLabel, 'SSH · devbox-local-alias');
    const hostProject = preview.machines[0].environments[0].projects[0];
    const containerProject = preview.machines[0].environments[1].projects[0];
    assert.equal(hostProject.navigationState, 'open');
    assert.equal(containerProject.navigationState, 'previewOnly');
    assert.deepEqual(resolveMachineProjectTarget(groups(), {
        legacyProjectId: hostProject.legacyProjectId,
        machineId: hostProject.machineId,
        environmentId: hostProject.environmentId,
    }), { projectPath: '/work/api' });
    assert.equal(resolveMachineProjectTarget(groups(), {
        legacyProjectId: hostProject.legacyProjectId,
        machineId: hostProject.machineId,
        environmentId: containerProject.environmentId,
    }), null, 'a stale or forged placement cannot open the Project');
});

test('MACHINE-PROJECTS-PROJECTION-001 fails closed when profile authority is unavailable', () => {
    const preview = buildMachineProjectsViewModel(groups(), {
        profileAvailability: 'unavailable',
        profiles: [],
    });

    assert.equal(preview.kind, 'ready');
    assert.equal(preview.machines[0].connectionState, 'setupUnavailable');
    assert.equal(preview.machines[0].hostAction, 'setup');
    assert.equal(preview.machines[0].environments[0].projects[0].navigationState, 'unavailable');
});

test('MACHINE-PROJECTS-MIGRATION-PREVIEW-001 reports a real blocking preview without activating V2', () => {
    const invalid = groups();
    invalid[0].projects.push({ ...invalid[0].projects[0] });
    assert.throws(() => buildMachineProjectsViewModel(invalid, {
        profileAvailability: 'ready', profiles: [],
    }), /duplicate legacy project id/);

    const blocked = buildMachineProjectsBlockingViewModel(invalid);
    assert.equal(blocked.kind, 'error');
    assert.equal(blocked.migrationPreview.blockingCount, 1);
    assert.equal(blocked.migrationPreview.legacyProjectCount, 3);
});
