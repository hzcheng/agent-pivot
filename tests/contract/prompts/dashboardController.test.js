'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PromptDashboardController } = require('../../../out/prompts/dashboardController');
const { PromptService } = require('../../../out/prompts/service');
const { getPromptSurfaceContent } = require('../../../out/prompts/webviewContent');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function promptData(overrides = {}) {
    return {
        version: 1,
        revision: 0,
        selectedPromptId: null,
        prompts: [],
        ...overrides,
    };
}

function command(operation, payload, overrides = {}) {
    return {
        type: 'prompt-command',
        version: 1,
        requestId: 'prompt-request-1',
        target: 'global-prompt-library',
        expectedRevision: 0,
        operation,
        payload,
        ...overrides,
    };
}

function createController(options = {}) {
    let stored = clone(options.initial === undefined ? promptData() : options.initial);
    const writes = [];
    const confirmations = [];
    const ids = [...(options.ids || ['prompt-a', 'prompt-b', 'prompt-c'])];
    const service = new PromptService({
        readSetting: () => clone(stored),
        writeGlobalSetting: async data => {
            if (options.writeError) {
                throw options.writeError;
            }
            writes.push(clone(data));
            stored = clone(data);
        },
        createId: () => ids.shift(),
    });
    if (options.snapshotErrorCall) {
        const getSnapshot = service.getSnapshot.bind(service);
        let snapshotCalls = 0;
        service.getSnapshot = () => {
            snapshotCalls += 1;
            if (snapshotCalls === options.snapshotErrorCall) {
                throw new Error('private snapshot read failure');
            }
            return getSnapshot();
        };
    }
    if (options.mutationError) {
        service.createPrompt = async () => {
            throw options.mutationError;
        };
    }

    let renderCalls = 0;
    const renderPromptSurface = snapshot => {
        renderCalls += 1;
        if (options.renderError) {
            throw options.renderError;
        }
        return getPromptSurfaceContent(snapshot);
    };
    const controller = new PromptDashboardController({
        service,
        confirmDelete: async prompt => {
            confirmations.push(clone(prompt));
            if (options.confirmError) {
                throw options.confirmError;
            }
            return options.confirmDelete === undefined ? true : options.confirmDelete;
        },
        renderPromptSurface,
    });

    return {
        controller,
        service,
        writes,
        confirmations,
        getStored: () => clone(stored),
        getRenderCalls: () => renderCalls,
    };
}

function assertFailure(result, errorCode, operation = 'create') {
    assert.ok(result);
    assert.equal(result.type, 'prompt-command-result');
    assert.equal(result.version, 1);
    assert.equal(result.requestId, 'prompt-request-1');
    assert.equal(result.target, 'global-prompt-library');
    assert.equal(result.operation, operation);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, errorCode);
    assert.equal(typeof result.html, 'string');
    assert.ok(result.snapshot);
}

test('WEBVIEW-AI-PROMPT-MUTATION-001 echoes the full correlation identity and authoritative HTML', async () => {
    const fixture = createController();
    const result = await fixture.controller.handle(
        command('create', { name: 'Review', text: 'Review this.' })
    );
    assert.deepEqual({
        version: result.version,
        requestId: result.requestId,
        target: result.target,
        operation: result.operation,
        success: result.success,
    }, {
        version: 1,
        requestId: 'prompt-request-1',
        target: 'global-prompt-library',
        operation: 'create',
        success: true,
    });
    assert.match(result.html, /data-prompt-id="prompt-a"/);
    assert.equal(result.snapshot.revision, 1);
    assert.deepEqual(result.snapshot, fixture.service.getSnapshot());
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 executes every operation against Host-resolved Prompt identities', async () => {
    const fixture = createController({
        initial: promptData({
            revision: 2,
            prompts: [
                { id: 'prompt-a', name: 'Alpha', text: 'First body' },
                { id: 'prompt-b', name: 'Bravo', text: 'Second body' },
            ],
        }),
    });

    const updated = await fixture.controller.handle(command('update', {
        promptId: 'prompt-a',
        name: 'Alpha edited',
        text: 'Edited body',
    }, { expectedRevision: 2 }));
    const selected = await fixture.controller.handle(command('select-default', {
        promptId: 'prompt-b',
    }, { expectedRevision: 3, requestId: 'prompt-request-2' }));
    const reordered = await fixture.controller.handle(command('reorder', {
        promptIds: ['prompt-b', 'prompt-a'],
    }, { expectedRevision: 4, requestId: 'prompt-request-3' }));
    const deleted = await fixture.controller.handle(command('delete', {
        promptId: 'prompt-a',
    }, { expectedRevision: 5, requestId: 'prompt-request-4' }));

    assert.equal(updated.success, true);
    assert.equal(selected.success, true);
    assert.equal(reordered.success, true);
    assert.equal(deleted.success, true);
    assert.deepEqual(fixture.confirmations, [{ id: 'prompt-a', name: 'Alpha edited' }]);
    assert.deepEqual(deleted.snapshot, {
        version: 1,
        revision: 6,
        selectedPromptId: 'prompt-b',
        prompts: [{ id: 'prompt-b', name: 'Bravo', text: 'Second body' }],
    });
    assert.deepEqual(deleted.snapshot, fixture.service.getSnapshot());
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 requires exact top-level and operation payload fields', async t => {
    const cases = [
        ['extra top-level field', command('create', { name: 'Review', text: 'Body' }, { extra: true })],
        ['missing expected revision', (() => {
            const value = command('create', { name: 'Review', text: 'Body' });
            delete value.expectedRevision;
            return value;
        })()],
        ['non-integer expected revision', command('create', { name: 'Review', text: 'Body' }, { expectedRevision: 0.5 })],
        ['create missing name', command('create', { text: 'Body' })],
        ['create missing text', command('create', { name: 'Review' })],
        ['create extra payload field', command('create', { name: 'Review', text: 'Body', id: 'spoofed' })],
        ['update missing promptId', command('update', { name: 'Review', text: 'Body' })],
        ['update extra payload field', command('update', {
            promptId: 'prompt-a', name: 'Review', text: 'Body', selected: true,
        })],
        ['delete extra payload field', command('delete', { promptId: 'prompt-a', force: true })],
        ['reorder extra payload field', command('reorder', { promptIds: [], revision: 0 })],
        ['select-default extra payload field', command('select-default', { promptId: null, selected: true })],
        ['array payload', command('create', [])],
    ];

    for (const [name, value] of cases) {
        await t.test(name, async () => {
            const fixture = createController();
            const result = await fixture.controller.handle(value);
            assertFailure(result, 'invalid', value.operation);
            assert.equal(fixture.writes.length, 0);
            assert.equal(fixture.getRenderCalls(), 1);
        });
    }
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 rejects unresolved IDs before confirmation or mutation', async t => {
    const initial = promptData({
        revision: 2,
        prompts: [
            { id: 'prompt-a', name: 'Alpha', text: 'First body' },
            { id: 'prompt-b', name: 'Bravo', text: 'Second body' },
        ],
    });
    const cases = [
        ['update', { promptId: 'missing', name: 'New', text: 'Body' }, 'not-found'],
        ['delete', { promptId: 'missing' }, 'not-found'],
        ['select-default', { promptId: 'missing' }, 'not-found'],
        ['reorder', { promptIds: ['prompt-a'] }, 'invalid'],
        ['reorder', { promptIds: ['prompt-a', 'prompt-a'] }, 'invalid'],
        ['reorder', { promptIds: ['prompt-a', 'missing'] }, 'invalid'],
    ];

    for (const [operation, payload, errorCode] of cases) {
        await t.test(`${operation} ${JSON.stringify(payload)}`, async () => {
            const fixture = createController({ initial });
            const result = await fixture.controller.handle(
                command(operation, payload, { expectedRevision: 2 })
            );
            assertFailure(result, errorCode, operation);
            assert.equal(fixture.confirmations.length, 0);
            assert.equal(fixture.writes.length, 0);
        });
    }
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 returns the current authoritative snapshot on a stale revision', async () => {
    const fixture = createController({
        initial: promptData({
            revision: 1,
            prompts: [{ id: 'prompt-a', name: 'Current', text: 'Current body' }],
        }),
    });
    const result = await fixture.controller.handle(
        command('create', { name: 'Stale', text: 'Stale body' })
    );

    assertFailure(result, 'conflict');
    assert.equal(result.snapshot.revision, 1);
    assert.match(result.html, />Current</);
    assert.doesNotMatch(result.html, />Stale</);
    assert.equal(fixture.writes.length, 0);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 settles delete cancellation without mutating', async () => {
    const fixture = createController({
        initial: promptData({
            revision: 1,
            prompts: [{ id: 'prompt-a', name: 'Private', text: 'body must stay private' }],
        }),
        confirmDelete: false,
    });
    const result = await fixture.controller.handle(command(
        'delete',
        { promptId: 'prompt-a' },
        { expectedRevision: 1 }
    ));

    assertFailure(result, 'cancelled', 'delete');
    assert.deepEqual(fixture.confirmations, [{ id: 'prompt-a', name: 'Private' }]);
    assert.equal(fixture.writes.length, 0);
    assert.equal(result.snapshot.revision, 1);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 maps confirmation throws to a safe storage failure', async () => {
    const fixture = createController({
        initial: promptData({
            revision: 1,
            prompts: [{ id: 'prompt-a', name: 'Private', text: 'secret confirmation body' }],
        }),
        confirmError: new Error('secret confirmation failure'),
    });
    const result = await fixture.controller.handle(command(
        'delete',
        { promptId: 'prompt-a' },
        { expectedRevision: 1 }
    ));

    assertFailure(result, 'storage', 'delete');
    assert.equal(fixture.writes.length, 0);
    assert.doesNotMatch(result.html, /secret confirmation failure/);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 maps expected storage and unexpected mutation failures', async t => {
    await t.test('PromptService storage error', async () => {
        const fixture = createController({ writeError: new Error('private storage error') });
        const result = await fixture.controller.handle(
            command('create', { name: 'Review', text: 'Private body' })
        );
        assertFailure(result, 'storage');
        assert.doesNotMatch(result.html, /private storage error/);
        assert.equal(result.snapshot.revision, 0);
    });

    await t.test('unexpected mutation error', async () => {
        const fixture = createController({ mutationError: new Error('unexpected private error') });
        const result = await fixture.controller.handle(
            command('create', { name: 'Review', text: 'Private body' })
        );
        assertFailure(result, 'storage');
        assert.doesNotMatch(result.html, /unexpected private error/);
        assert.equal(result.snapshot.revision, 0);
    });
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 returns a stable recovery surface when rendering throws', async () => {
    const fixture = createController({ renderError: new Error('rendered private body') });
    const result = await fixture.controller.handle(
        command('create', { name: 'Private name', text: 'Private body' })
    );

    assertFailure(result, 'storage');
    assert.equal(result.snapshot.revision, 1);
    assert.match(result.html, /data-prompt-surface/);
    assert.match(result.html, /data-prompt-revision="1"/);
    assert.match(result.html, /could not be displayed/i);
    assert.doesNotMatch(result.html, /rendered private body|Private name|Private body/);
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.getRenderCalls(), 1);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 ignores a reused request ID without a second settlement or mutation', async () => {
    const fixture = createController();
    const first = await fixture.controller.handle(
        command('create', { name: 'First', text: 'First body' })
    );
    const duplicate = await fixture.controller.handle(command(
        'create',
        { name: 'Second', text: 'Second body' },
        { expectedRevision: 1 }
    ));

    assert.equal(first.success, true);
    assert.equal(duplicate, undefined);
    assert.equal(fixture.writes.length, 1);
    assert.deepEqual(fixture.service.getSnapshot().prompts, [
        { id: 'prompt-a', name: 'First', text: 'First body' },
    ]);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 uses recovery HTML when the authoritative reread fails after mutation', async () => {
    const fixture = createController({ snapshotErrorCall: 2 });
    const result = await fixture.controller.handle(
        command('create', { name: 'Review', text: 'Private body' })
    );

    assertFailure(result, 'storage');
    assert.equal(fixture.writes.length, 1);
    assert.equal(result.snapshot.revision, 1);
    assert.match(result.html, /data-prompt-recovery/);
    assert.match(result.html, /data-prompt-revision="1"/);
    assert.doesNotMatch(result.html, /Review|Private body/);
    assert.equal(fixture.getRenderCalls(), 0);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 maps unsupported stored data to a read-only settlement', async () => {
    const fixture = createController({
        initial: { version: 2, revision: 7, selectedPromptId: null, prompts: [] },
    });
    const result = await fixture.controller.handle(
        command('create', { name: 'Review', text: 'Body' })
    );

    assertFailure(result, 'unsupported-version');
    assert.equal(result.snapshot.readOnlyReason, 'unsupported-version');
    assert.match(result.html, /newer version/i);
    assert.equal(fixture.writes.length, 0);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 settles every recognizable validation envelope exactly once', async () => {
    const fixture = createController();
    const values = [
        command('create', { name: '', text: 'Body' }),
        command('create', { name: 'Review', text: '' }, { requestId: 'prompt-request-2' }),
        command('delete', { promptId: 7 }, { requestId: 'prompt-request-3' }),
        command('reorder', { promptIds: 'prompt-a' }, { requestId: 'prompt-request-4' }),
        command('select-default', { promptId: 7 }, { requestId: 'prompt-request-5' }),
    ];

    const results = await Promise.all(values.map(value => fixture.controller.handle(value)));
    assert.equal(results.length, values.length);
    assert.ok(results.every(Boolean));
    assert.ok(results.every(result => result.success === false && result.errorCode === 'invalid'));
    assert.equal(fixture.getRenderCalls(), values.length);
    assert.equal(new Set(results.map(result => result.requestId)).size, values.length);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 ignores messages without a complete bounded V1 correlation identity', async t => {
    const cases = [
        ['undefined', undefined],
        ['array', []],
        ['unrelated object', { type: 'todo-command' }],
        ['unsupported message version', command('create', { name: 'Review', text: 'Body' }, { version: 2 })],
        ['wrong target', command('create', { name: 'Review', text: 'Body' }, { target: 'project-a' })],
        ['missing target', (() => {
            const value = command('create', { name: 'Review', text: 'Body' });
            delete value.target;
            return value;
        })()],
        ['unknown operation', command('rename', { promptId: 'prompt-a', name: 'Review' })],
        ['empty request ID', command('create', { name: 'Review', text: 'Body' }, { requestId: '' })],
        ['overlong request ID', command('create', { name: 'Review', text: 'Body' }, { requestId: 'r'.repeat(129) })],
        ['non-string request ID', command('create', { name: 'Review', text: 'Body' }, { requestId: 1 })],
    ];

    for (const [name, value] of cases) {
        await t.test(name, async () => {
            const fixture = createController();
            assert.equal(await fixture.controller.handle(value), undefined);
            assert.equal(fixture.writes.length, 0);
            assert.equal(fixture.getRenderCalls(), 0);
        });
    }

    const bounded = createController();
    const result = await bounded.controller.handle(command(
        'create',
        { name: '', text: 'Body' },
        { requestId: 'r'.repeat(128) }
    ));
    assert.ok(result);
    assert.equal(result.requestId.length, 128);
});

test('WEBVIEW-AI-PROMPT-MUTATION-001 creates correlated initial and refresh content messages', () => {
    const fixture = createController({
        initial: promptData({
            revision: 3,
            prompts: [{ id: 'prompt-a', name: 'Alpha', text: 'First body' }],
        }),
    });

    const panel = fixture.controller.getPanelContent('load-request-1');
    assert.deepEqual({
        type: panel.type,
        version: panel.version,
        requestId: panel.requestId,
        target: panel.target,
        revision: panel.snapshot.revision,
    }, {
        type: 'ai-panel-content',
        version: 1,
        requestId: 'load-request-1',
        target: 'global-prompt-library',
        revision: 3,
    });
    assert.match(panel.html, /data-ai-panel/);
    assert.match(panel.html, /data-prompt-revision="3"/);

    const refresh = fixture.controller.getRefreshContent();
    assert.deepEqual({
        type: refresh.type,
        version: refresh.version,
        target: refresh.target,
        revision: refresh.snapshot.revision,
    }, {
        type: 'prompt-panel-updated',
        version: 1,
        target: 'global-prompt-library',
        revision: 3,
    });
    assert.match(refresh.html, /data-prompt-surface/);
    assert.doesNotMatch(refresh.html, /data-ai-panel/);
});
