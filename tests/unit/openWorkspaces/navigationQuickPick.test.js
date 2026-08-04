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
        environmentLabel: 'Local',
        runningSessionCount: 0,
        attentionCount: 0,
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
    const calls = { quickPick: 0, open: [], info: [] };
    const options = Object.assign({
        getCards: () => [],
        getRecord: () => null,
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

test('pickAndOpen maps navigation cards to quick pick items', async () => {
    const uri = 'vscode-remote://ssh-remote%2Bhost/work/workspace-a';
    let shownItems;
    let shownOptions;
    const { controller } = createController({
        getCards: () => [
            card({ kind: 'current', id: '__currentWorkspace-fff' }),
            card({ runningSessionCount: 2, attentionCount: 1 }),
            card({
                id: '__openWorkspaceNavigation-def456',
                name: 'workspace-b',
                environmentLabel: 'WSL',
                workspaceKind: 'untitledMultiRoot',
            }),
        ],
        getRecord: cardId => (cardId === '__openWorkspaceNavigation-abc123' ? record(uri) : null),
        showQuickPick: async (items, options) => { shownItems = items; shownOptions = options; return undefined; },
    });

    await controller.pickAndOpen();

    assert.equal(shownItems.length, 2);
    assert.deepEqual(shownItems[0], {
        label: 'workspace-a',
        description: 'Local · 2 running sessions · 1 needs attention',
        detail: uri,
        cardId: '__openWorkspaceNavigation-abc123',
    });
    assert.deepEqual(shownItems[1], {
        label: 'workspace-b',
        description: 'WSL · unsaved workspace',
        detail: undefined,
        cardId: '__openWorkspaceNavigation-def456',
    });
    assert.equal(shownOptions.title, 'Switch to Open Window');
    assert.ok(shownOptions.placeHolder.length > 0);
});

test('pickAndOpen opens the selected card', async () => {
    const { controller, calls } = createController({
        getCards: () => [card()],
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

test('pickAndOpen uses singular running session wording', async () => {
    let shownItems;
    const { controller } = createController({
        getCards: () => [card({ runningSessionCount: 1 })],
        showQuickPick: async items => { shownItems = items; return undefined; },
    });

    await controller.pickAndOpen();

    assert.equal(shownItems[0].description, 'Local · 1 running session');
});
