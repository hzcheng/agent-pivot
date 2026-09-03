'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    MachineProjectsController,
} = require('../../../out/projects/machineProjectsController');

const MACHINE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function createFixture(overrides = {}) {
    const calls = [];
    let profile = overrides.profile || null;
    const controller = new MachineProjectsController({
        getProfile: async machineId => {
            calls.push(['getProfile', machineId]);
            return profile;
        },
        updateProfile: async (machineId, nextProfile) => {
            calls.push(['updateProfile', machineId, nextProfile]);
            if (overrides.updateError) throw overrides.updateError;
            profile = nextProfile && { machineId, ...nextProfile, updatedAtMs: 1 };
            return { profiles: profile ? [profile] : [] };
        },
        showConnectionKindPicker: async () => overrides.connectionKind === undefined
            ? 'ssh' : overrides.connectionKind,
        showConnectionTargetInput: async options => {
            calls.push(['showConnectionTargetInput', options]);
            return overrides.target === undefined ? 'devbox' : overrides.target;
        },
        showSaveChoice: async () => overrides.saveChoice === undefined
            ? 'saveAndOpen' : overrides.saveChoice,
        showWarningMessage: message => calls.push(['warning', message]),
        showErrorMessage: message => calls.push(['error', message]),
        executeHostOpen: async machineId => {
            calls.push(['executeHostOpen', machineId]);
            if (overrides.openError) throw overrides.openError;
            return overrides.navigationOutcome || 'handedOff';
        },
        executeProjectOpen: async (machineId, projectPath) => {
            calls.push(['executeProjectOpen', machineId, projectPath]);
            return overrides.navigationOutcome || 'handedOff';
        },
        resolveProjectTarget: target => {
            calls.push(['resolveProjectTarget', target]);
            return overrides.projectTarget === undefined
                ? { projectPath: '/work/api' } : overrides.projectTarget;
        },
        refreshProjects: () => calls.push(['refreshProjects']),
    });
    return { controller, calls, getProfile: () => profile };
}

test('MACHINE-PROJECTS-HOST-001 MACHINE-PROJECTS-HOST-NAVIGATION-001 saves an SSH profile before handing off a Host window', async () => {
    const fixture = createFixture();
    const progress = [];
    const result = await fixture.controller.handle({
        version: 1,
        requestId: 'request-1',
        action: 'setup',
        machineId: MACHINE_ID,
        machineName: 'Build machine',
    }, message => progress.push(message));

    assert.equal(result.status, 'handedOff');
    assert.deepEqual(fixture.getProfile(), {
        machineId: MACHINE_ID,
        kind: 'ssh',
        target: 'devbox',
        resolverAuthority: 'ssh-remote+devbox',
        updatedAtMs: 1,
    });
    assert.equal(fixture.calls.filter(call => call[0] === 'updateProfile').length, 1);
    assert.equal(fixture.calls.filter(call => call[0] === 'executeHostOpen').length, 1);
    assert.deepEqual(progress.map(message => [message.status, message.message]), [
        ['opening', 'Opening a new VS Code window…'],
    ]);
});

test('MACHINE-PROJECTS-HOST-001 distinguishes configuration persistence from window launch failures', async () => {
    const saveFailure = createFixture({ updateError: new Error('read-only storage') });
    const saveResult = await saveFailure.controller.handle({
        version: 1, requestId: 'request-save-failure', action: 'rebind',
        machineId: MACHINE_ID, machineName: 'Build machine',
    });
    assert.equal(saveResult.status, 'failed');
    assert.match(saveResult.message, /was not saved/);
    assert.equal(saveFailure.calls.some(call => call[0] === 'executeHostOpen'), false);

    const openFailure = createFixture({ openError: new Error('window command failed') });
    const progress = [];
    const openResult = await openFailure.controller.handle({
        version: 1, requestId: 'request-open-failure', action: 'setup',
        machineId: MACHINE_ID, machineName: 'Build machine',
    }, message => progress.push(message));
    assert.equal(openResult.status, 'failed');
    assert.match(openResult.message, /couldn’t start the window/);
    assert.deepEqual(progress.map(message => message.status), ['opening']);
});

test('MACHINE-PROJECTS-HOST-001 keeps opening after best-effort progress delivery fails', async () => {
    const fixture = createFixture();
    const result = await fixture.controller.handle({
        version: 1, requestId: 'request-progress-failure', action: 'setup',
        machineId: MACHINE_ID, machineName: 'Build machine',
    }, async () => { throw new Error('Webview was disposed'); });

    assert.equal(result.status, 'handedOff');
    assert.equal(fixture.calls.some(call => call[0] === 'updateProfile'), true);
    assert.equal(fixture.calls.some(call => call[0] === 'executeHostOpen'), true);
});

test('MACHINE-PROJECTS-HOST-001 cancellation performs no write or open and UI-host dependency failures remain recoverable', async () => {
    const targetCancelled = createFixture({ target: null });
    const targetResult = await targetCancelled.controller.handle({
        version: 1, requestId: 'request-2', action: 'setup',
        machineId: MACHINE_ID, machineName: 'Build machine',
    });
    assert.equal(targetResult.status, 'cancelled');
    assert.equal(targetCancelled.calls.some(call => call[0] === 'updateProfile'), false);
    assert.equal(targetCancelled.calls.some(call => call[0] === 'executeHostOpen'), false);

    const missing = createFixture({ navigationOutcome: 'remoteSshMissing' });
    const missingResult = await missing.controller.handle({
        version: 1, requestId: 'request-3', action: 'setup',
        machineId: MACHINE_ID, machineName: 'Build machine',
    });
    assert.equal(missingResult.status, 'failed');
    assert.match(missingResult.message, /Install it, then retry/);
    assert.equal(missing.calls.some(call => call[0] === 'updateProfile'), true,
        'the Machine profile remains saved while the UI offers dependency installation');
    assert.equal(missing.calls.some(call => call[0] === 'executeHostOpen'), true,
        'only the UI bridge decides whether its local Remote - SSH is available');
});

test('MACHINE-PROJECTS-HOST-001 always re-reads the profile before opening', async () => {
    const fixture = createFixture({
        profile: {
            machineId: MACHINE_ID,
            kind: 'ssh',
            target: 'fresh-alias',
            resolverAuthority: 'ssh-remote+fresh-alias',
            updatedAtMs: 2,
        },
    });
    const result = await fixture.controller.handle({
        version: 1, requestId: 'request-4', action: 'openHost',
        machineId: MACHINE_ID, machineName: 'Build machine',
    });

    assert.equal(result.status, 'handedOff');
    assert.deepEqual(fixture.calls[0], ['getProfile', MACHINE_ID]);
    assert.equal(fixture.calls[1][0], 'executeHostOpen');
    assert.equal(fixture.calls[1][1], MACHINE_ID,
        'the UI bridge receives only Machine identity and re-reads the authoritative alias');
});

test('MACHINE-PROJECTS-HOST-NAVIGATION-001 opens a verified Host Project without forwarding a legacy authority', async () => {
    const fixture = createFixture({
        profile: {
            machineId: MACHINE_ID,
            kind: 'ssh',
            target: 'current-client-alias',
            resolverAuthority: 'ssh-remote+current-client-alias',
            updatedAtMs: 2,
        },
    });
    const result = await fixture.controller.handle({
        version: 1, requestId: 'request-project', action: 'openProject',
        machineId: MACHINE_ID, machineName: 'Build machine',
        projectId: 'api', environmentId: 'host-environment',
    });

    assert.equal(result.status, 'handedOff');
    assert.deepEqual(fixture.calls.find(call => call[0] === 'executeProjectOpen'), [
        'executeProjectOpen', MACHINE_ID, '/work/api',
    ]);
    assert.equal(JSON.stringify(fixture.calls).includes('ssh-remote+current-client-alias'), false,
        'the workspace host never forwards connection authority to the UI bridge');
});

test('MACHINE-PROJECTS-HOST-NAVIGATION-001 fails closed when a Project has no current Client Profile', async () => {
    const fixture = createFixture();
    const result = await fixture.controller.handle({
        version: 1, requestId: 'request-project-missing-profile', action: 'openProject',
        machineId: MACHINE_ID, machineName: 'Build machine',
        projectId: 'api', environmentId: 'host-environment',
    });

    assert.equal(result.status, 'failed');
    assert.equal(fixture.calls.some(call => call[0] === 'resolveProjectTarget'), false);
    assert.equal(fixture.calls.some(call => call[0] === 'executeProjectOpen'), false);
});
