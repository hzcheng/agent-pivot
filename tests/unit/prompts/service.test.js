'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    PromptMutationError,
    PromptService,
    normalizePromptSetting,
} = require('../../../out/prompts/service');

function createFixture(initial, options = {}) {
    let stored = initial;
    const writes = [];
    const diagnostics = [];
    const ids = options.ids || ['prompt-a', 'prompt-b', 'prompt-c'];
    const service = new PromptService({
        readSetting: () => stored,
        writeGlobalSetting: async data => {
            writes.push(structuredClone(data));
            if (options.beforeWrite) await options.beforeWrite(data, writes);
            if (options.writeError) throw options.writeError;
            stored = structuredClone(data);
        },
        createId: () => ids.shift(),
        logDiagnostic: value => diagnostics.push(value),
    });
    return {
        service,
        writes,
        diagnostics,
        getStored: () => stored,
        setStored: value => { stored = value; },
    };
}

function readyData(overrides = {}) {
    return {
        version: 1,
        revision: 2,
        selectedPromptId: null,
        prompts: [
            { id: 'prompt-a', name: 'Alpha', text: 'First body' },
            { id: 'prompt-b', name: 'Bravo', text: 'Second body' },
        ],
        ...overrides,
    };
}

function assertErrorCode(code) {
    return error => error instanceof PromptMutationError && error.code === code;
}

test('PERSIST-AI-PROMPT-STORE-001 starts with immutable empty V1 data', () => {
    const fixture = createFixture(undefined);
    const snapshot = fixture.service.getSnapshot();
    assert.deepEqual(snapshot, {
        version: 1, revision: 0, selectedPromptId: null, prompts: [],
    });
    assert.throws(() => snapshot.prompts.push({}));
});

test('PERSIST-AI-PROMPT-STORE-001 creates, edits, reorders, selects, and deletes atomically', async () => {
    const fixture = createFixture(undefined);
    await fixture.service.createPrompt(0, { name: 'Review', text: 'Review this diff.' });
    await fixture.service.createPrompt(1, { name: 'Explain', text: 'Explain\ncarefully.' });
    await fixture.service.updatePrompt(2, {
        promptId: 'prompt-a', name: 'Review code', text: 'Review this code.',
    });
    await fixture.service.reorderPrompts(3, ['prompt-b', 'prompt-a']);
    await fixture.service.selectDefault(4, 'prompt-a');
    const result = await fixture.service.deletePrompt(5, 'prompt-a');
    assert.deepEqual(result, {
        version: 1,
        revision: 6,
        selectedPromptId: null,
        prompts: [{ id: 'prompt-b', name: 'Explain', text: 'Explain\ncarefully.' }],
    });
    assert.equal(fixture.writes.length, 6);
    assert.deepEqual(fixture.getStored(), result);
});

test('PERSIST-AI-PROMPT-STORE-001 trims names and preserves nonblank Prompt bodies exactly', async () => {
    const fixture = createFixture(undefined);
    const body = '  Preserve leading and trailing whitespace.\n\nExactly.  ';
    const result = await fixture.service.createPrompt(0, { name: '  Review  ', text: body });
    assert.deepEqual(result.prompts, [{ id: 'prompt-a', name: 'Review', text: body }]);
    assert.deepEqual(fixture.writes[0], {
        version: 1,
        revision: 1,
        selectedPromptId: null,
        prompts: [{ id: 'prompt-a', name: 'Review', text: body }],
    });
});

test('PERSIST-AI-PROMPT-STORE-001 rejects duplicate folded names and blank mutation fields', async () => {
    const fixture = createFixture(readyData());
    await assert.rejects(
        () => fixture.service.createPrompt(2, { name: ' alpha ', text: 'Different body' }),
        assertErrorCode('invalid')
    );
    await assert.rejects(
        () => fixture.service.createPrompt(2, { name: '  ', text: 'A body' }),
        assertErrorCode('invalid')
    );
    await assert.rejects(
        () => fixture.service.createPrompt(2, { name: 'New', text: ' \n\t ' }),
        assertErrorCode('invalid')
    );
    await assert.rejects(
        () => fixture.service.updatePrompt(2, {
            promptId: 'prompt-a', name: 'Bravo', text: 'A body',
        }),
        assertErrorCode('invalid')
    );
    assert.equal(fixture.writes.length, 0);
});

test('PERSIST-AI-PROMPT-STORE-001 rejects invalid stored records but repairs only stale selection', () => {
    const invalidCases = [
        readyData({ revision: 1.5 }),
        readyData({ revision: -1 }),
        readyData({ prompts: [{ id: 'duplicate', name: 'One', text: 'one' }, { id: 'duplicate', name: 'Two', text: 'two' }] }),
        readyData({ prompts: [{ id: 'one', name: 'Same', text: 'one' }, { id: 'two', name: ' same ', text: 'two' }] }),
        readyData({ prompts: [{ id: 'one', name: '  ', text: 'one' }] }),
        readyData({ prompts: [{ id: 'one', name: 'One', text: '  \n ' }] }),
    ];
    for (const value of invalidCases) {
        const result = normalizePromptSetting(value);
        assert.equal(result.status, 'read-only');
        assert.equal(result.snapshot.readOnlyReason, 'invalid-data');
    }
    const recovered = normalizePromptSetting(readyData({ selectedPromptId: 'missing-id' }));
    assert.deepEqual(recovered, {
        status: 'ready',
        snapshot: {
            version: 1,
            revision: 2,
            selectedPromptId: null,
            prompts: [
                { id: 'prompt-a', name: 'Alpha', text: 'First body' },
                { id: 'prompt-b', name: 'Bravo', text: 'Second body' },
            ],
        },
    });
});

test('PERSIST-AI-PROMPT-STORE-001 diagnoses a repaired stale selection without Prompt text', () => {
    const fixture = createFixture(readyData({
        selectedPromptId: `missing-${'x'.repeat(150)}`,
        prompts: [
            { id: 'prompt-a', name: 'Private', text: 'body that must not be logged' },
        ],
    }));

    assert.equal(fixture.service.getSnapshot().selectedPromptId, null);
    assert.deepEqual(fixture.diagnostics, [{
        category: 'prompt-stale-selection',
        revision: 2,
        promptId: `missing-${'x'.repeat(112)}`,
        promptName: undefined,
    }]);
    assert.equal(JSON.stringify(fixture.diagnostics).includes('body that must not be logged'), false);
});

test('PERSIST-AI-PROMPT-STORE-001 uses locale-independent Prompt-name identity', () => {
    const originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function () {
        return String(this) === 'I' ? '\u0131' : originalToLocaleLowerCase.call(this);
    };
    try {
        const result = normalizePromptSetting(readyData({
            prompts: [
                { id: 'upper-i', name: 'I', text: 'Uppercase Latin I' },
                { id: 'lower-i', name: 'i', text: 'Lowercase Latin i' },
            ],
        }));
        assert.equal(result.status, 'read-only');
        assert.equal(result.snapshot.readOnlyReason, 'invalid-data');
    } finally {
        String.prototype.toLocaleLowerCase = originalToLocaleLowerCase;
    }
});

test('PERSIST-AI-PROMPT-STORE-001 exposes positive unsupported versions as read-only', async () => {
    const fixture = createFixture({ version: 2, revision: 0, selectedPromptId: null, prompts: [] });
    assert.deepEqual(fixture.service.getSnapshot(), {
        version: 1,
        revision: 0,
        selectedPromptId: null,
        prompts: [],
        readOnlyReason: 'unsupported-version',
    });
    await assert.rejects(
        () => fixture.service.createPrompt(0, { name: 'New', text: 'body' }),
        assertErrorCode('unsupported-version')
    );
});

test('PERSIST-AI-PROMPT-STORE-001 requires integer revisions and rejects stale revisions', async () => {
    const fixture = createFixture(readyData());
    await assert.rejects(
        () => fixture.service.createPrompt(2.5, { name: 'New', text: 'body' }),
        assertErrorCode('invalid')
    );
    await assert.rejects(
        () => fixture.service.createPrompt(-1, { name: 'New', text: 'body' }),
        assertErrorCode('invalid')
    );
    await assert.rejects(
        () => fixture.service.createPrompt(1, { name: 'New', text: 'body' }),
        assertErrorCode('conflict')
    );
    assert.equal(fixture.writes.length, 0);
});

test('PERSIST-AI-PROMPT-STORE-001 requires an exact reorder permutation and existing mutation targets', async () => {
    const fixture = createFixture(readyData());
    await assert.rejects(
        () => fixture.service.reorderPrompts(2, ['prompt-a', 'prompt-a']),
        assertErrorCode('invalid')
    );
    await assert.rejects(
        () => fixture.service.reorderPrompts(2, ['prompt-a']),
        assertErrorCode('invalid')
    );
    await assert.rejects(
        () => fixture.service.reorderPrompts(2, ['prompt-a', 'missing']),
        assertErrorCode('invalid')
    );
    await assert.rejects(
        () => fixture.service.updatePrompt(2, {
            promptId: 'missing', name: 'New', text: 'body',
        }),
        assertErrorCode('not-found')
    );
    await assert.rejects(() => fixture.service.deletePrompt(2, 'missing'), assertErrorCode('not-found'));
    await assert.rejects(() => fixture.service.selectDefault(2, 'missing'), assertErrorCode('not-found'));
    const selected = await fixture.service.selectDefault(2, 'prompt-a');
    assert.equal(selected.selectedPromptId, 'prompt-a');
    const deselected = await fixture.service.selectDefault(3, 'prompt-a');
    assert.equal(deselected.selectedPromptId, null);
});

test('PERSIST-AI-PROMPT-STORE-001 serializes local mutations and re-reads before each write', async () => {
    let releaseFirstWrite;
    const firstWrite = new Promise(resolve => { releaseFirstWrite = resolve; });
    let writeCount = 0;
    const fixture = createFixture(undefined, {
        beforeWrite: async () => {
            writeCount += 1;
            if (writeCount === 1) await firstWrite;
        },
    });
    const first = fixture.service.createPrompt(0, { name: 'First', text: 'one' });
    const second = fixture.service.createPrompt(1, { name: 'Second', text: 'two' });
    await Promise.resolve();
    assert.equal(fixture.writes.length, 1);
    releaseFirstWrite();
    await Promise.all([first, second]);
    assert.deepEqual(fixture.getStored(), {
        version: 1,
        revision: 2,
        selectedPromptId: null,
        prompts: [
            { id: 'prompt-a', name: 'First', text: 'one' },
            { id: 'prompt-b', name: 'Second', text: 'two' },
        ],
    });
});

test('PERSIST-AI-PROMPT-STORE-001 stages a local echo before the awaited Settings writer settles', async () => {
    let stored;
    let service;
    let consumedDuringWrite;
    service = new PromptService({
        readSetting: () => stored,
        writeGlobalSetting: async data => {
            stored = structuredClone(data);
            consumedDuringWrite = service.consumeCurrentSettingsDataLocalWriteEcho();
        },
        createId: () => 'prompt-a',
        logDiagnostic: () => undefined,
    });

    await service.createPrompt(0, { name: 'Private', text: 'body' });

    assert.equal(consumedDuringWrite, true);
    assert.equal(service.consumeCurrentSettingsDataLocalWriteEcho(), false);
});

test('PERSIST-AI-PROMPT-STORE-001 retires older echoes after a newer coalesced Settings value', async () => {
    const fixture = createFixture(undefined);
    await fixture.service.createPrompt(0, { name: 'First', text: 'one' });
    await fixture.service.createPrompt(1, { name: 'Second', text: 'two' });

    assert.equal(fixture.service.consumeCurrentSettingsDataLocalWriteEcho(), true);
    fixture.setStored(fixture.writes[0]);
    assert.equal(fixture.service.consumeCurrentSettingsDataLocalWriteEcho(), false);
});

test('PERSIST-AI-PROMPT-STORE-001 wraps failed writes, refreshes afterwards, and consumes only successful local echoes', async () => {
    const failed = createFixture(undefined, { writeError: new Error('setting unavailable') });
    await assert.rejects(
        () => failed.service.createPrompt(0, { name: 'Private', text: 'body that must not be logged' }),
        assertErrorCode('storage')
    );
    assert.deepEqual(failed.service.getSnapshot(), {
        version: 1, revision: 0, selectedPromptId: null, prompts: [],
    });
    assert.equal(failed.service.consumeCurrentSettingsDataLocalWriteEcho(), false);

    const successful = createFixture(undefined);
    await successful.service.createPrompt(0, { name: 'Private', text: 'body that must not be logged' });
    assert.equal(successful.service.consumeCurrentSettingsDataLocalWriteEcho(), true);
    assert.equal(successful.service.consumeCurrentSettingsDataLocalWriteEcho(), false);
    assert.ok(successful.diagnostics.every(event => !JSON.stringify(event).includes('body that must not be logged')));
    assert.ok(failed.diagnostics.every(event => !JSON.stringify(event).includes('body that must not be logged')));
});

test('PERSIST-AI-PROMPT-STORE-001 classifies dirty or newer User Settings without exposing Prompt data', async t => {
    const settingsErrors = [
        'Unable to write into user settings because the file has unsaved changes. Please save the user settings file first and then try again.',
        'Unable to write into user settings because the content of the file is newer.',
    ];
    for (const message of settingsErrors) {
        await t.test(message.includes('unsaved') ? 'unsaved settings' : 'newer settings', async () => {
            const privateBody = 'sensitive body must never escape';
            const fixture = createFixture(undefined, {
                writeError: Object.assign(new Error(message), { name: 'CodeExpectedError' }),
            });
            await assert.rejects(
                () => fixture.service.createPrompt(0, {
                    name: 'Private prompt name',
                    text: privateBody,
                }),
                error => {
                    assert.ok(error instanceof PromptMutationError);
                    assert.equal(error.code, 'settings-write-conflict');
                    assert.doesNotMatch(error.message, /Private prompt name|sensitive body/);
                    return true;
                }
            );
            assert.ok(fixture.diagnostics.some(
                event => event.category === 'prompt-write-settings-conflict'
            ));
            assert.doesNotMatch(
                JSON.stringify(fixture.diagnostics),
                /Private prompt name|sensitive body must never escape|Unable to write/
            );
        });
    }
});
