'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createOpenWorkspacePinSnapshot,
} = require('../../../out/openWorkspaces/pinProtocol');
const { loadWithFakeVscode, makeAggregate, makeRecord, makeRegistration, OTHER } = require('./helpers');
const {
    OpenWorkspaceDashboardController,
} = loadWithFakeVscode('../../../out/openWorkspaces/dashboardController');

function createController(overrides = {}) {
    const currentWorkspace = makeRecord({ name: 'Current', uri: '/work/current' });
    return new OpenWorkspaceDashboardController({
        getCurrentWorkspace: () => ({
            ...currentWorkspace,
            roots: currentWorkspace.roots.map(root => ({ ...root, hostPath: '/work/current' })),
        }),
        isWorkspaceSavedAsProject: () => true,
        getWorkspaceProjectColor: () => '',
        getCurrentWorkspaceAiSessions: () => null,
        beginAiSessionProjection: () => ({ revision: 1 }),
        getGroups: () => [],
        getTodoSearchItems: () => [],
        getCollapsed: () => false,
        getRunningCardAnimation: () => undefined,
        getRunningIconAnimation: () => undefined,
        getAttentionAggregate: () => null,
        getBridgeInstanceId: () => 'instance',
        buildOpenWorkspacesUpdatedMessage: loadWithFakeVscode('../../../out/dashboard/webviewUpdateMessages').buildOpenWorkspacesUpdatedMessage,
        nextSequence: () => 1,
        postMessage: async () => true,
        isVisible: () => true,
        logDiagnostic: () => undefined,
        logError: () => undefined,
        ...overrides,
    });
}

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 starts connecting so the section is never a complete-looking empty list', () => {
    const controller = createController();

    assert.equal(controller.getState().otherWindows.status, 'connecting');
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 leaves connecting for the first bridge status', () => {
    const controller = createController();

    assert.equal(controller.setBridgeStatus('ready'), true);
    assert.equal(controller.getState().otherWindows.status, 'ready');
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 reports an unavailable bridge instead of staying connecting', () => {
    const controller = createController();

    assert.equal(controller.setBridgeStatus('unavailable'), true);
    assert.equal(controller.getState().otherWindows.status, 'unavailable');
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 discards a connecting-era aggregate when the bridge turns unavailable', () => {
    const controller = createController();
    controller.setBridgeStatus('ready');
    controller.setAggregate(makeAggregate([makeRegistration(OTHER, 4000, '/work/other')]));
    controller.setPinSnapshot(createOpenWorkspacePinSnapshot([]));
    assert.ok(controller.getCards().some(card => card.kind === 'navigation'));

    assert.equal(controller.setBridgeStatus('unavailable'), true);
    assert.equal(controller.getCards().filter(card => card.kind === 'navigation').length, 0);
});
