'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PromptTerminalCommandController } = require('../../../out/prompts/terminalCommandController');

function createTerminal({ sendText } = {}) {
    return {
        sent: [],
        shown: 0,
        sendText: sendText || function (text, addNewLine) {
            this.sent.push([text, addNewLine]);
        },
        show() { this.shown += 1; },
    };
}

function createSnapshot({
    selectedPromptId = null,
    prompts = [
        { id: 'prompt-a', name: 'Review', text: 'Review this change.' },
        { id: 'prompt-b', name: 'Test', text: 'Run the focused tests.' },
    ],
    readOnlyReason,
} = {}) {
    return {
        version: 1,
        revision: 2,
        selectedPromptId,
        prompts,
        ...(readOnlyReason ? { readOnlyReason } : {}),
    };
}

function createFixture({ terminal = createTerminal(), snapshot = createSnapshot(), selectedPromptId } = {}) {
    const quickPickCalls = [];
    const warnings = [];
    const information = [];
    const availabilityChecks = [];
    const availableTerminals = new Set(terminal ? [terminal] : []);
    let snapshotReads = 0;
    let opened = 0;
    const fixture = {
        activeTerminal: terminal,
        quickPickCalls,
        warnings,
        information,
        availabilityChecks,
        availableTerminals,
        get snapshotReads() { return snapshotReads; },
        get opened() { return opened; },
        onQuickPick: () => undefined,
    };
    if (selectedPromptId !== undefined) snapshot = { ...snapshot, selectedPromptId };
    fixture.controller = new PromptTerminalCommandController({
        service: {
            getSnapshot: () => {
                snapshotReads += 1;
                return snapshot;
            },
        },
        getActiveTerminal: () => fixture.activeTerminal,
        isTerminalAvailable: candidate => {
            availabilityChecks.push(candidate);
            return availableTerminals.has(candidate);
        },
        showQuickPick: async (items, options) => {
            quickPickCalls.push({ items, options });
            return fixture.onQuickPick(items, options);
        },
        showWarningMessage: message => warnings.push(message),
        showInformationMessage: async (message, action) => {
            information.push([message, action]);
            return fixture.onInformationMessage ? fixture.onInformationMessage(message, action) : undefined;
        },
        openAiPrompts: async () => { opened += 1; },
    });
    return fixture;
}

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 inserts the default without a picker', async () => {
    const terminal = { sent: [], shown: 0, sendText(text, addNewLine) {
        this.sent.push([text, addNewLine]);
    }, show() { this.shown += 1; } };
    const fixture = createFixture({
        terminal,
        snapshot: {
            version: 1, revision: 2, selectedPromptId: 'prompt-a',
            prompts: [{ id: 'prompt-a', name: 'Review', text: 'Review\nthis.' }],
        },
    });
    await fixture.controller.insertPromptToActiveTerminal();
    assert.deepEqual(terminal.sent, [['Review\nthis.', false]]);
    assert.equal(terminal.shown, 1);
    assert.equal(fixture.quickPickCalls.length, 0);
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 retains the terminal captured before the picker', async () => {
    const original = createTerminal();
    const replacement = createTerminal();
    const fixture = createFixture({ terminal: original, selectedPromptId: null });
    fixture.onQuickPick = items => {
        fixture.activeTerminal = replacement;
        return items[1];
    };
    await fixture.controller.insertPromptToActiveTerminal();
    assert.equal(original.sent.length, 1);
    assert.equal(replacement.sent.length, 0);
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 presents stored-order labels with bounded first-line previews', async () => {
    const longFirstLine = 'x'.repeat(121);
    const fixture = createFixture({
        snapshot: createSnapshot({
            prompts: [
                { id: 'first', name: 'First', text: `${longFirstLine}\nnot visible` },
                { id: 'second', name: 'Second', text: 'second first line\nand neither is this' },
            ],
        }),
    });
    fixture.onQuickPick = () => undefined;

    await fixture.controller.insertPromptToActiveTerminal();

    assert.deepEqual(fixture.quickPickCalls, [{
        items: [
            { label: 'First', description: `${'x'.repeat(120)}…`, promptId: 'first' },
            { label: 'Second', description: 'second first line', promptId: 'second' },
        ],
        options: { placeHolder: 'Select an AI Prompt', matchOnDescription: true },
    }]);
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 treats picker cancellation and unknown picker IDs as no-ops', async () => {
    const fixture = createFixture();
    await fixture.controller.insertPromptToActiveTerminal();
    fixture.onQuickPick = () => ({ label: 'Spoofed', description: 'ignored', promptId: 'not-in-snapshot' });
    await fixture.controller.insertPromptToActiveTerminal();

    assert.deepEqual(fixture.activeTerminal.sent, []);
    assert.equal(fixture.activeTerminal.shown, 0);
    assert.equal(fixture.warnings.length, 0);
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 offers AI Prompts when the library is empty', async () => {
    const fixture = createFixture({ snapshot: createSnapshot({ prompts: [] }) });
    fixture.onInformationMessage = (_message, action) => action;

    await fixture.controller.insertPromptToActiveTerminal();

    assert.deepEqual(fixture.information, [[
        'No AI Prompts are configured. Create one in AI > PROMPTS.',
        'Open AI Prompts',
    ]]);
    assert.equal(fixture.opened, 1);
    assert.deepEqual(fixture.activeTerminal.sent, []);
    assert.equal(fixture.quickPickCalls.length, 0);
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 falls back from a stale default to the picker without mutating data', async () => {
    const snapshot = createSnapshot({ selectedPromptId: 'stale-id' });
    const fixture = createFixture({ snapshot });
    fixture.onQuickPick = items => items[0];

    await fixture.controller.insertPromptToActiveTerminal();

    assert.equal(fixture.quickPickCalls.length, 1);
    assert.deepEqual(fixture.activeTerminal.sent, [['Review this change.', false]]);
    assert.equal(snapshot.selectedPromptId, 'stale-id');
    assert.deepEqual(snapshot.prompts, createSnapshot().prompts);
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 blocks unsupported or read-only Prompt data', async () => {
    for (const readOnlyReason of ['invalid-data', 'unsupported-version']) {
        const fixture = createFixture({ snapshot: createSnapshot({ readOnlyReason }) });
        await fixture.controller.insertPromptToActiveTerminal();
        assert.deepEqual(fixture.warnings, [
            'AI Prompts are unavailable because their saved data is invalid or unsupported.',
        ]);
        assert.deepEqual(fixture.activeTerminal.sent, []);
        assert.equal(fixture.quickPickCalls.length, 0);
    }
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 stops before reading Prompt data when no terminal is active', async () => {
    const fixture = createFixture({ terminal: null });

    await fixture.controller.insertPromptToActiveTerminal();

    assert.deepEqual(fixture.warnings, ['No active terminal is available to receive the Prompt.']);
    assert.equal(fixture.snapshotReads, 0);
    assert.equal(fixture.quickPickCalls.length, 0);
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 warns once when the captured terminal rejects insertion', async () => {
    const original = createTerminal({ sendText: () => Promise.reject(new Error('disposed')) });
    const replacement = createTerminal();
    const fixture = createFixture({ terminal: original });
    fixture.onQuickPick = items => {
        fixture.activeTerminal = replacement;
        return items[0];
    };

    await fixture.controller.insertPromptToActiveTerminal();

    assert.deepEqual(fixture.warnings, ['The selected terminal is no longer available.']);
    assert.equal(original.shown, 0);
    assert.deepEqual(replacement.sent, []);
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 warns without sending when the captured terminal closes while the picker is open', async () => {
    const original = createTerminal();
    const replacement = createTerminal();
    const fixture = createFixture({ terminal: original });
    fixture.onQuickPick = items => {
        fixture.availableTerminals.delete(original);
        fixture.availableTerminals.add(replacement);
        fixture.activeTerminal = replacement;
        return items[0];
    };

    await fixture.controller.insertPromptToActiveTerminal();

    assert.deepEqual(fixture.availabilityChecks, [original]);
    assert.deepEqual(fixture.warnings, ['The selected terminal is no longer available.']);
    assert.deepEqual(original.sent, []);
    assert.equal(original.shown, 0);
    assert.deepEqual(replacement.sent, []);
    assert.equal(replacement.shown, 0);
});

test('SESSION-AI-PROMPT-TERMINAL-INSERTION-001 preserves multiline text and never changes the service', async () => {
    const snapshot = createSnapshot({
        selectedPromptId: 'multiline',
        prompts: [{ id: 'multiline', name: 'Multiline', text: 'first\nsecond\nthird' }],
    });
    let mutations = 0;
    const terminal = createTerminal();
    const controller = new PromptTerminalCommandController({
        service: {
            getSnapshot: () => snapshot,
            createPrompt: () => { mutations += 1; },
            updatePrompt: () => { mutations += 1; },
            deletePrompt: () => { mutations += 1; },
            reorderPrompts: () => { mutations += 1; },
            selectDefault: () => { mutations += 1; },
        },
        getActiveTerminal: () => terminal,
        isTerminalAvailable: candidate => candidate === terminal,
        showQuickPick: async () => assert.fail('default should not open picker'),
        showWarningMessage: message => assert.fail(`unexpected warning: ${message}`),
        showInformationMessage: async () => assert.fail('unexpected information message'),
        openAiPrompts: () => assert.fail('unexpected AI Prompt navigation'),
    });

    await controller.insertPromptToActiveTerminal();

    assert.deepEqual(terminal.sent, [['first\nsecond\nthird', false]]);
    assert.equal(mutations, 0);
});
