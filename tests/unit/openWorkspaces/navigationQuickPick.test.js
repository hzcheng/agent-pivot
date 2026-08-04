'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorkspaceNavigationQuickPickController,
} = require('../../../out/openWorkspaces/navigationQuickPickController');

function card(overrides) {
    return Object.assign({
        id: '__openWorkspaceNavigation-abc123',
        kind: 'navigation',
        workspaceKind: 'singleFolder',
        name: 'workspace-a',
    }, overrides);
}

function record(navigationUri) {
    return {
        navigationIdentity: 'a'.repeat(64),
        scopeIdentity: 'b'.repeat(64),
        kind: 'singleFolder',
        displayName: 'workspace-a',
        navigationUri,
        environment: 'local',
        runningAiSessionCount: 0,
        roots: [],
    };
}

function createController(overrides) {
    const calls = { quickPick: 0, open: [], info: [], projectDisplay: [] };
    const options = Object.assign({
        getCards: () => [],
        getRecord: () => null,
        getProjectGroupName: workspace => { calls.projectDisplay.push(workspace); return null; },
        showQuickPick: async () => { calls.quickPick += 1; return undefined; },
        open: async cardId => { calls.open.push(cardId); },
        showInformationMessage: message => { calls.info.push(message); },
    }, overrides);
    return {
        controller: new WorkspaceNavigationQuickPickController(options),
        calls,
    };
}

test('pickAndOpen informs when no other windows are open', async () => {
    const { controller, calls } = createController({
        getCards: () => [card({ kind: 'current' })],
    });

    await controller.pickAndOpen();

    assert.equal(calls.quickPick, 0);
    assert.equal(calls.open.length, 0);
    assert.deepEqual(calls.info, ['No other open windows to switch to.']);
});

test('pickAndOpen shows the window name with its project group', async () => {
    let shownItems;
    let shownOptions;
    const { controller, calls } = createController({
        getCards: () => [
            card({ kind: 'current', id: '__currentWorkspace-fff' }),
            card(),
            card({ id: '__openWorkspaceNavigation-def456', name: 'workspace-b' }),
            card({ id: '__openWorkspaceNavigation-ghi789', name: 'workspace-c' }),
        ],
        getRecord: cardId => (cardId === '__openWorkspaceNavigation-ghi789' ? null : record(`file:///work/${cardId}`)),
        getProjectGroupName: workspace => {
            calls.projectDisplay.push(workspace);
            if (workspace.navigationUri.endsWith('abc123')) {
                return 'Backend';
            }
            return null;
        },
        showQuickPick: async (items, options) => { shownItems = items; shownOptions = options; return undefined; },
    });

    await controller.pickAndOpen();

    assert.deepEqual(shownItems, [
        { label: 'workspace-a', description: 'Backend', cardId: '__openWorkspaceNavigation-abc123' },
        { label: 'workspace-b', description: undefined, cardId: '__openWorkspaceNavigation-def456' },
        { label: 'workspace-c', description: undefined, cardId: '__openWorkspaceNavigation-ghi789' },
    ]);
    assert.equal(shownOptions.title, 'Switch to Open Window');
    assert.ok(shownOptions.placeHolder.length > 0);
    assert.equal(calls.projectDisplay.length, 2);
});

test('pickAndOpen opens the selected card', async () => {
    const { controller, calls } = createController({
        getCards: () => [card()],
        getRecord: () => record('file:///work/workspace-a'),
        showQuickPick: async items => items[0],
    });

    await controller.pickAndOpen();

    assert.deepEqual(calls.open, ['__openWorkspaceNavigation-abc123']);
    assert.equal(calls.info.length, 0);
});

test('pickAndOpen does nothing when the pick is cancelled', async () => {
    const { controller, calls } = createController({
        getCards: () => [card()],
        showQuickPick: async () => undefined,
    });

    await controller.pickAndOpen();

    assert.deepEqual(calls.open, []);
});
