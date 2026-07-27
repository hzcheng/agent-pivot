'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
    CodexAppServerClient,
} = require('../../../out/aiSessions/conversation/codexAppServerClient');
const {
    CONVERSATION_LIMITS,
    ConversationAbortController,
} = require('../../../out/aiSessions/conversation/types');

const SESSION_ID = '33333333-3333-4333-8333-333333333333';

class FakeStdin extends EventEmitter {
    constructor() {
        super();
        this.writable = true;
        this.writes = [];
        this.writeResults = [];
        this.onWrite = undefined;
    }

    write(value) {
        const bytes = Buffer.from(value);
        this.writes.push(bytes);
        if (this.onWrite) {
            this.onWrite(bytes);
        }
        return this.writeResults.length ? this.writeResults.shift() : true;
    }
}

class FakeChild extends EventEmitter {
    constructor(options = {}) {
        super();
        this.stdin = new FakeStdin();
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.killCount = 0;
        if (options.spawn !== false) {
            queueMicrotask(() => this.emit('spawn'));
        }
    }

    kill() {
        this.killCount += 1;
        return true;
    }
}

function fakeTimers(options = {}) {
    let nextHandle = 1;
    const active = new Map();
    const scheduledDelays = [];
    return {
        scheduledDelays,
        setTimeout(callback, delayMs) {
            const handle = nextHandle++;
            active.set(handle, { callback, delayMs });
            scheduledDelays.push(delayMs);
            if (options.autoRun && options.autoRun(delayMs)) {
                queueMicrotask(() => {
                    const timer = active.get(handle);
                    if (timer) {
                        active.delete(handle);
                        timer.callback();
                    }
                });
            }
            return handle;
        },
        clearTimeout(handle) {
            active.delete(handle);
        },
        fireNext(delayMs) {
            const found = Array.from(active.entries())
                .find(([, timer]) => timer.delayMs === delayMs);
            assert.ok(found, `expected an active ${delayMs}ms timer`);
            active.delete(found[0]);
            found[1].callback();
        },
        activeCount() {
            return active.size;
        },
    };
}

function createHarness(overrides = {}) {
    const child = overrides.child || new FakeChild();
    const timers = overrides.timers || fakeTimers();
    const diagnostics = [];
    const spawnCalls = [];
    const resolverCalls = [];
    const client = new CodexAppServerClient({
        spawn(executable, args, options) {
            spawnCalls.push({ executable, args, options });
            return overrides.spawn
                ? overrides.spawn(executable, args, options)
                : child;
        },
        resolveExecutable(commandName) {
            resolverCalls.push(commandName);
            return overrides.resolveExecutable
                ? overrides.resolveExecutable(commandName)
                : '/usr/bin/codex';
        },
        now: overrides.now || (() => 1_000),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        onDiagnostic(diagnostic) {
            diagnostics.push(diagnostic);
        },
    });
    return {
        child,
        client,
        diagnostics,
        resolverCalls,
        spawnCalls,
        timers,
    };
}

function parsedWrites(child) {
    return child.stdin.writes.map(bytes => JSON.parse(
        bytes.subarray(0, bytes.length - 1).toString('utf8')
    ));
}

function emitResponse(child, value, ending = '\n') {
    child.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify(value)}${ending}`, 'utf8')
    );
}

async function settle() {
    await new Promise(resolve => setImmediate(resolve));
}

async function finishHandshake(child) {
    await settle();
    assert.deepEqual(parsedWrites(child)[0], {
        method: 'initialize',
        id: 1,
        params: {
            clientInfo: {
                name: 'project_steward',
                title: 'Agent Pivot',
                version: '2.1.6',
            },
        },
    });
    emitResponse(child, {
        id: 1,
        result: {
            serverInfo: {
                name: 'codex-app-server',
                version: '1.42.7-private',
            },
        },
    });
    await settle();
}

function assertSanitizedDiagnostics(diagnostics, forbidden = []) {
    for (const diagnostic of diagnostics) {
        assert.deepEqual(
            Object.keys(diagnostic).sort(),
            Object.keys(diagnostic).filter(key =>
                ['event', 'provider', 'category', 'version'].includes(key)
            ).sort()
        );
        assert.equal(diagnostic.event, 'codex-conversation-app-server');
        assert.equal(diagnostic.provider, 'codex');
        if (diagnostic.version !== undefined) {
            assert.match(diagnostic.version, /^[0-9]{1,6}\.[0-9]{1,6}$/);
        }
    }
    const serialized = JSON.stringify(diagnostics);
    forbidden.forEach(secret => assert.equal(serialized.includes(secret), false));
}

test('SESSION-AI-SESSION-CODEX-APP-SERVER-001 performs one stable handshake and correlates out-of-order IDs', async t => {
    const harness = createHarness();
    t.after(() => harness.client.dispose());

    const first = harness.client.request('thread/read', {
        threadId: SESSION_ID,
        includeTurns: true,
    });
    await finishHandshake(harness.child);
    assert.deepEqual(parsedWrites(harness.child), [
        {
            method: 'initialize',
            id: 1,
            params: {
                clientInfo: {
                    name: 'project_steward',
                    title: 'Agent Pivot',
                    version: '2.1.6',
                },
            },
        },
        { method: 'initialized', params: {} },
        {
            method: 'thread/read',
            id: 2,
            params: { threadId: SESSION_ID, includeTurns: true },
        },
    ]);
    const second = harness.client.request('thread/read', {
        threadId: '44444444-4444-4444-8444-444444444444',
        includeTurns: true,
    });
    await settle();
    emitResponse(harness.child, { id: 3, result: { sequence: 2 } });
    assert.deepEqual(await second, { sequence: 2 });
    let firstSettled = false;
    first.then(() => { firstSettled = true; });
    await settle();
    assert.equal(firstSettled, false);
    emitResponse(harness.child, { id: 2, result: { sequence: 1 } });
    assert.deepEqual(await first, { sequence: 1 });
    assert.equal(
        parsedWrites(harness.child)
            .filter(message => message.method === 'initialize').length,
        1
    );
    assert.deepEqual(harness.resolverCalls, ['codex']);
    assert.deepEqual(harness.spawnCalls[0], {
        executable: '/usr/bin/codex',
        args: ['app-server', '--listen', 'stdio://'],
        options: {
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        },
    });
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-002 frames Buffer chunks across arbitrary LF and CRLF boundaries exactly once', async t => {
    const harness = createHarness();
    t.after(() => harness.client.dispose());
    const first = harness.client.request('thread/read', { threadId: SESSION_ID });
    await finishHandshake(harness.child);
    const second = harness.client.request('thread/read', { threadId: 'second' });
    await settle();

    const bytes = Buffer.from(
        `${JSON.stringify({ id: 3, result: { value: 'second' } })}\r\n`
        + `${JSON.stringify({ id: 2, result: { value: 'first' } })}\n`,
        'utf8'
    );
    [1, 2, 7, 3, 19].reduce((offset, size) => {
        if (offset < bytes.length) {
            harness.child.stdout.emit(
                'data',
                bytes.subarray(offset, Math.min(bytes.length, offset + size))
            );
        }
        return offset + size;
    }, 0);
    const emitted = 1 + 2 + 7 + 3 + 19;
    if (emitted < bytes.length) {
        harness.child.stdout.emit('data', bytes.subarray(emitted));
    }

    assert.deepEqual(await Promise.all([first, second]), [
        { value: 'first' },
        { value: 'second' },
    ]);
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-003 enforces the 16 MiB limit before parsing framed or unterminated lines', async t => {
    for (const terminated of [false, true]) {
        await t.test(terminated ? 'terminated line' : 'unterminated line', async t => {
            const harness = createHarness();
            t.after(() => harness.client.dispose());
            const request = harness.client.request('thread/read', {
                threadId: SESSION_ID,
            });
            await finishHandshake(harness.child);
            const oversized = Buffer.alloc(
                CONVERSATION_LIMITS.maxCodexResponseBytes + 1,
                0x20
            );
            harness.child.stdout.emit(
                'data',
                terminated
                    ? Buffer.concat([oversized, Buffer.from('\n')])
                    : oversized
            );
            await assert.rejects(
                request,
                error => error.name === 'ConversationError'
                    && error.code === 'tooLarge'
            );
            assert.equal(harness.child.killCount, 1);
            assert.equal(
                harness.diagnostics.some(item => item.category === 'oversized'),
                true
            );
        });
    }
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-004 serializes newline writes and waits for drain after backpressure', async t => {
    const harness = createHarness();
    t.after(() => harness.client.dispose());
    const first = harness.client.request('thread/read', { threadId: SESSION_ID });
    await finishHandshake(harness.child);
    harness.child.stdin.writeResults.push(false, true);

    const second = harness.client.request('thread/read', { threadId: 'second' });
    await settle();
    const writesWhileBlocked = harness.child.stdin.writes.length;
    const third = harness.client.request('thread/read', { threadId: 'third' });
    await settle();
    assert.equal(harness.child.stdin.writes.length, writesWhileBlocked);
    harness.child.stdin.emit('drain');
    await settle();
    assert.equal(harness.child.stdin.writes.length, writesWhileBlocked + 1);

    harness.child.stdin.writes.forEach(bytes => {
        assert.equal(bytes[bytes.length - 1], 0x0a);
        assert.notEqual(bytes[bytes.length - 2], 0x0a);
    });
    emitResponse(harness.child, { id: 2, result: 'first' });
    emitResponse(harness.child, { id: 3, result: 'second' });
    emitResponse(harness.child, { id: 4, result: 'third' });
    assert.deepEqual(await Promise.all([first, second, third]), [
        'first',
        'second',
        'third',
    ]);
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-005 drains stderr only as bytes and removes owned listeners', async () => {
    const harness = createHarness();
    const request = harness.client.request('thread/read', {
        threadId: SESSION_ID,
    });
    await finishHandshake(harness.child);
    assert.equal(harness.child.stderr.listenerCount('data'), 1);
    harness.child.stderr.emit(
        'data',
        Buffer.from('stderr-private-path:/private/codex.jsonl', 'utf8')
    );
    emitResponse(harness.child, { id: 2, result: {} });
    await request;
    assertSanitizedDiagnostics(harness.diagnostics, [
        'stderr-private-path',
        '/private/codex.jsonl',
    ]);
    harness.client.dispose();
    assert.equal(harness.child.stdout.listenerCount('data'), 0);
    assert.equal(harness.child.stderr.listenerCount('data'), 0);
    assert.equal(harness.child.listenerCount('exit'), 0);
    assert.equal(harness.child.listenerCount('error'), 0);
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-006 rejects timeout and abort while cleaning pending state', async t => {
    await t.test('timeout', async t => {
        const harness = createHarness();
        t.after(() => harness.client.dispose());
        const request = harness.client.request('thread/read', {
            threadId: SESSION_ID,
        });
        await finishHandshake(harness.child);
        harness.timers.fireNext(CONVERSATION_LIMITS.codexRequestTimeoutMs);
        await assert.rejects(
            request,
            error => error.name === 'ConversationError'
                && error.code === 'timeout'
        );
        assert.equal(harness.child.killCount, 1);
        assert.equal(harness.timers.activeCount(), 0);
        assert.equal(
            harness.diagnostics.some(item => item.category === 'timeout'),
            true
        );
    });

    await t.test('abort', async t => {
        const harness = createHarness();
        t.after(() => harness.client.dispose());
        const controller = new ConversationAbortController();
        const request = harness.client.request(
            'thread/read',
            { threadId: SESSION_ID },
            controller.signal
        );
        await finishHandshake(harness.child);
        controller.abort();
        await assert.rejects(
            request,
            error => error.name === 'AbortError'
        );
        assert.equal(harness.timers.activeCount(), 0);
        emitResponse(harness.child, { id: 2, result: { stale: true } });
        const next = harness.client.request('thread/read', {
            threadId: 'still-connected',
        });
        await settle();
        emitResponse(harness.child, { id: 3, result: { fresh: true } });
        assert.deepEqual(await next, { fresh: true });
    });

    await t.test('abort while the shared handshake is pending', async () => {
        const harness = createHarness();
        const controller = new ConversationAbortController();
        let rejected;
        const request = harness.client.request(
            'thread/read',
            { threadId: SESSION_ID },
            controller.signal
        );
        request.catch(error => {
            rejected = error;
        });
        await settle();
        controller.abort();
        await settle();
        assert.equal(rejected?.name, 'AbortError');
        emitResponse(harness.child, {
            id: 1,
            result: {
                serverInfo: {
                    name: 'codex-app-server',
                    version: '1.42.7',
                },
            },
        });
        await settle();
        harness.client.dispose();
    });
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-007 maps capability and protocol failures without raw leakage', async t => {
    await t.test('missing thread/read', async t => {
        const harness = createHarness();
        t.after(() => harness.client.dispose());
        const request = harness.client.request('thread/read', {
            threadId: SESSION_ID,
        });
        await finishHandshake(harness.child);
        emitResponse(harness.child, {
            id: 2,
            error: {
                code: -32601,
                message: 'RAW-CAPABILITY-SECRET',
                data: { path: '/private/capability.json' },
            },
        });
        await assert.rejects(request, error =>
            error.name === 'ConversationError'
            && error.code === 'unavailable'
            && error.reason === 'updateCodex'
            && error.message === 'unavailable'
        );
        assertSanitizedDiagnostics(harness.diagnostics, [
            'RAW-CAPABILITY-SECRET',
            '/private/capability.json',
            SESSION_ID,
        ]);
    });

    await t.test('handshake schema mismatch', async t => {
        const harness = createHarness();
        t.after(() => harness.client.dispose());
        const request = harness.client.request('thread/read', {
            threadId: SESSION_ID,
        });
        await settle();
        emitResponse(harness.child, {
            id: 1,
            result: 'RAW-HANDSHAKE-SECRET',
        });
        await assert.rejects(request, error =>
            error.name === 'ConversationError'
            && error.code === 'unsupportedVersion'
            && error.reason === 'unsupportedCodexProtocol'
            && !JSON.stringify(error).includes('RAW-HANDSHAKE-SECRET')
        );
        assert.equal(harness.child.killCount, 1);
        assertSanitizedDiagnostics(harness.diagnostics, [
            'RAW-HANDSHAKE-SECRET',
            SESSION_ID,
        ]);
    });

    await t.test('malformed response envelope', async t => {
        const harness = createHarness();
        t.after(() => harness.client.dispose());
        const request = harness.client.request('thread/read', {
            threadId: SESSION_ID,
        });
        await finishHandshake(harness.child);
        emitResponse(harness.child, {
            id: 2,
            result: { raw: 'RAW-RESULT-SECRET' },
            error: { code: -32000, message: 'RAW-ERROR-SECRET' },
        });
        await assert.rejects(request, error =>
            error.name === 'ConversationError'
            && error.code === 'unsupportedVersion'
            && error.reason === 'unsupportedCodexProtocol'
        );
        assert.equal(harness.child.killCount, 1);
        assertSanitizedDiagnostics(harness.diagnostics, [
            'RAW-RESULT-SECRET',
            'RAW-ERROR-SECRET',
            SESSION_ID,
        ]);
    });
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-008 resolves only the extension-host executable and sanitizes spawn failures', async t => {
    await t.test('missing executable', async () => {
        const harness = createHarness({
            resolveExecutable: () => null,
        });
        await assert.rejects(
            harness.client.request('thread/read', { threadId: SESSION_ID }),
            error => error.name === 'ConversationError'
                && error.code === 'unavailable'
                && error.reason === 'updateCodex'
        );
        assert.deepEqual(harness.resolverCalls, ['codex']);
        assert.equal(harness.spawnCalls.length, 0);
        assertSanitizedDiagnostics(harness.diagnostics, [SESSION_ID, '.codex']);
    });

    await t.test('spawn error', async () => {
        const harness = createHarness({
            spawn() {
                throw new Error('RAW-SPAWN-SECRET /private/codex');
            },
        });
        await assert.rejects(
            harness.client.request('thread/read', { threadId: SESSION_ID }),
            error => error.name === 'ConversationError'
                && error.code === 'unavailable'
                && error.reason === 'updateCodex'
                && !error.message.includes('RAW-SPAWN-SECRET')
        );
        assertSanitizedDiagnostics(harness.diagnostics, [
            'RAW-SPAWN-SECRET',
            '/private/codex',
            SESSION_ID,
        ]);
    });
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-009 rejects pending requests on exit and enforces the rolling restart budget', async () => {
    const children = [];
    const timers = fakeTimers({
        autoRun(delayMs) {
            return delayMs === 1_000 || delayMs === 4_000;
        },
    });
    const harness = createHarness({
        timers,
        spawn() {
            const child = new FakeChild();
            child.stdin.onWrite = bytes => {
                const message = JSON.parse(
                    bytes.subarray(0, bytes.length - 1).toString('utf8')
                );
                if (message.method === 'initialize') {
                    queueMicrotask(() => emitResponse(child, {
                        id: message.id,
                        result: {
                            serverInfo: {
                                name: 'codex-app-server',
                                version: '2.8.1',
                            },
                        },
                    }));
                } else if (message.id) {
                    queueMicrotask(() => emitResponse(child, {
                        id: message.id,
                        result: { child: children.indexOf(child) + 1 },
                    }));
                }
            };
            children.push(child);
            return child;
        },
    });

    assert.deepEqual(
        await harness.client.request('thread/read', { threadId: SESSION_ID }),
        { child: 1 }
    );
    children[0].emit('exit', 17, null);
    assert.deepEqual(
        await harness.client.request('thread/read', { threadId: SESSION_ID }),
        { child: 2 }
    );
    children[1].emit('exit', 18, null);
    assert.deepEqual(
        await harness.client.request('thread/read', { threadId: SESSION_ID }),
        { child: 3 }
    );
    children[2].emit('exit', 19, null);
    await assert.rejects(
        harness.client.request('thread/read', { threadId: SESSION_ID }),
        error => error.name === 'ConversationError'
            && error.code === 'unavailable'
            && error.reason === 'codexRetryExhausted'
            && error.retryAfterMs > 0
            && error.reason !== 'updateCodex'
    );
    assert.deepEqual(
        timers.scheduledDelays.filter(delay => delay !== 10_000),
        [1_000, 4_000]
    );
    assert.equal(children.length, 3);
    assertSanitizedDiagnostics(harness.diagnostics, [
        SESSION_ID,
        '17',
        '18',
        '19',
    ]);
    harness.client.dispose();
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-010 rejects every pending request when the child exits', async () => {
    const harness = createHarness();
    const first = harness.client.request('thread/read', {
        threadId: SESSION_ID,
    });
    await finishHandshake(harness.child);
    harness.child.stdin.writeResults.push(false);
    const second = harness.client.request('thread/read', {
        threadId: 'second-pending',
    });
    await settle();
    harness.child.emit('exit', 73, null);
    await assert.rejects(first, error =>
        error.name === 'ConversationError'
        && error.code === 'unavailable'
        && error.reason === 'reconnectingCodex'
    );
    await assert.rejects(second, error =>
        error.name === 'ConversationError'
        && error.code === 'unavailable'
        && error.reason === 'reconnectingCodex'
    );
    assert.equal(harness.timers.activeCount(), 0);
    assert.equal(harness.child.stdin.listenerCount('drain'), 0);
    assert.equal(harness.child.stdin.listenerCount('error'), 0);
    assert.equal(harness.child.stdout.listenerCount('data'), 0);
    assert.equal(harness.child.stderr.listenerCount('data'), 0);
    assertSanitizedDiagnostics(harness.diagnostics, [
        SESSION_ID,
        'second-pending',
        '73',
    ]);
    harness.client.dispose();
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-011 supports synchronous injected restart timers', async () => {
    const children = [];
    const baseTimers = fakeTimers();
    const timers = {
        ...baseTimers,
        setTimeout(callback, delayMs) {
            if (delayMs === 1_000 || delayMs === 4_000) {
                callback();
                return `sync-${delayMs}`;
            }
            return baseTimers.setTimeout(callback, delayMs);
        },
    };
    const harness = createHarness({
        timers,
        spawn() {
            const child = new FakeChild();
            child.stdin.onWrite = bytes => {
                const message = JSON.parse(
                    bytes.subarray(0, bytes.length - 1).toString('utf8')
                );
                if (message.method === 'initialize') {
                    queueMicrotask(() => emitResponse(child, {
                        id: message.id,
                        result: {},
                    }));
                } else if (message.id) {
                    queueMicrotask(() => emitResponse(child, {
                        id: message.id,
                        result: { child: children.indexOf(child) + 1 },
                    }));
                }
            };
            children.push(child);
            return child;
        },
    });
    await harness.client.request('thread/read', { threadId: SESSION_ID });
    children[0].emit('exit', 1, null);
    assert.deepEqual(
        await harness.client.request('thread/read', { threadId: SESSION_ID }),
        { child: 2 }
    );
    harness.client.dispose();
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-012 never retains an unbounded server version in diagnostics', async () => {
    const harness = createHarness();
    const request = harness.client.request('thread/read', {
        threadId: SESSION_ID,
    });
    await settle();
    emitResponse(harness.child, {
        id: 1,
        result: {
            serverInfo: {
                name: 'codex-app-server',
                version: `${'7'.repeat(10_000)}.2.3-private`,
            },
        },
    });
    await settle();
    emitResponse(harness.child, { id: 2, result: {} });
    await request;
    harness.child.emit('exit', 1, null);
    assertSanitizedDiagnostics(harness.diagnostics, [
        '7777777777',
        SESSION_ID,
    ]);
    harness.client.dispose();
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-013 owns accepted-write stdin errors and keeps reconnects bounded', async t => {
    const children = [];
    const timers = fakeTimers({
        autoRun(delayMs) {
            return delayMs === 1_000 || delayMs === 4_000;
        },
    });
    const harness = createHarness({
        timers,
        spawn() {
            const child = new FakeChild();
            child.stdin.onWrite = bytes => {
                const message = JSON.parse(
                    bytes.subarray(0, bytes.length - 1).toString('utf8')
                );
                if (message.method === 'initialize') {
                    queueMicrotask(() => emitResponse(child, {
                        id: message.id,
                        result: {},
                    }));
                } else if (message.method === 'thread/read'
                    && children.indexOf(child) === 1) {
                    child.stdin.writeResults.push(false);
                }
            };
            children.push(child);
            return child;
        },
    });
    t.after(() => harness.client.dispose());

    for (let index = 0; index < 3; index++) {
        const request = harness.client.request('thread/read', {
            threadId: `${SESSION_ID}-${index}`,
        });
        request.catch(() => undefined);
        await settle();
        const child = children[index];
        assert.ok(child);
        assert.equal(
            parsedWrites(child).some(message =>
                message.method === 'thread/read'
            ),
            true
        );
        const runtimeError = new Error(
            `RAW-RUNTIME-ERROR-${index} /private/codex-${index}`
        );
        runtimeError.code = index === 0 ? 'EPIPE' : 'ERUNTIME';
        assert.doesNotThrow(() => {
            if (index < 2) {
                child.stdin.emit('error', runtimeError);
            } else {
                child.emit('error', runtimeError);
            }
        });
        await assert.rejects(request, error =>
            error.name === 'ConversationError'
            && error.code === 'unavailable'
            && error.reason === 'reconnectingCodex'
            && !error.message.includes('EPIPE')
        );
        assert.equal(child.killCount, 1);
        assert.equal(child.stdin.listenerCount('drain'), 0);
        assert.equal(child.stdin.listenerCount('error'), 0);
        assert.equal(child.stdout.listenerCount('data'), 0);
        assert.equal(child.stderr.listenerCount('data'), 0);
        assert.equal(child.listenerCount('spawn'), 0);
        assert.equal(child.listenerCount('exit'), 0);
        assert.equal(child.listenerCount('error'), 0);
        assert.equal(timers.activeCount(), 0);
    }
    await assert.rejects(
        harness.client.request('thread/read', { threadId: SESSION_ID }),
        error => error.name === 'ConversationError'
            && error.code === 'unavailable'
            && error.reason === 'codexRetryExhausted'
            && error.retryAfterMs > 0
    );
    assert.deepEqual(
        timers.scheduledDelays.filter(delay => delay !== 10_000),
        [1_000, 4_000]
    );
    assert.deepEqual(
        harness.diagnostics.map(item => item.category),
        ['exit', 'exit', 'exit']
    );
    assertSanitizedDiagnostics(harness.diagnostics, [
        'RAW-STDIN-ERROR',
        'RAW-RUNTIME-ERROR',
        '/private/codex',
        'EPIPE',
        SESSION_ID,
    ]);
});

test('SESSION-AI-SESSION-CODEX-APP-SERVER-014 classifies asynchronous pre-spawn errors without charging restart budget', async t => {
    const children = [];
    const timers = fakeTimers({
        autoRun(delayMs) {
            return delayMs === 1_000 || delayMs === 4_000;
        },
    });
    const failures = ['ENOENT', 'EACCES'];
    const harness = createHarness({
        timers,
        spawn() {
            const failureCode = failures[children.length];
            const child = new FakeChild({
                spawn: failureCode === undefined,
            });
            if (failureCode) {
                queueMicrotask(() => {
                    const error = new Error(
                        `RAW-${failureCode} /private/missing-codex`
                    );
                    error.code = failureCode;
                    child.emit('error', error);
                });
            } else {
                child.stdin.onWrite = bytes => {
                    const message = JSON.parse(
                        bytes.subarray(0, bytes.length - 1).toString('utf8')
                    );
                    if (message.method === 'initialize') {
                        queueMicrotask(() => emitResponse(child, {
                            id: message.id,
                            result: {},
                        }));
                    } else if (message.id) {
                        queueMicrotask(() => emitResponse(child, {
                            id: message.id,
                            result: { recovered: true },
                        }));
                    }
                };
            }
            children.push(child);
            return child;
        },
    });
    t.after(() => harness.client.dispose());

    for (const failureCode of failures) {
        await assert.rejects(
            harness.client.request('thread/read', { threadId: SESSION_ID }),
            error => error.name === 'ConversationError'
                && error.code === 'unavailable'
                && error.reason === 'updateCodex'
                && !error.message.includes(failureCode)
        );
        const failedChild = children[children.length - 1];
        assert.equal(failedChild.killCount, 1);
        assert.equal(failedChild.stdin.listenerCount('error'), 0);
        assert.equal(failedChild.stdout.listenerCount('data'), 0);
        assert.equal(failedChild.stderr.listenerCount('data'), 0);
        assert.equal(failedChild.listenerCount('spawn'), 0);
        assert.equal(failedChild.listenerCount('exit'), 0);
        assert.equal(failedChild.listenerCount('error'), 0);
        assert.equal(timers.activeCount(), 0);
    }
    assert.deepEqual(
        await harness.client.request('thread/read', {
            threadId: SESSION_ID,
        }),
        { recovered: true }
    );
    assert.deepEqual(
        timers.scheduledDelays.filter(delay => delay !== 10_000),
        []
    );
    assert.deepEqual(
        harness.diagnostics.map(item => item.category),
        ['spawn', 'spawn']
    );
    assertSanitizedDiagnostics(harness.diagnostics, [
        'RAW-ENOENT',
        'RAW-EACCES',
        '/private/missing-codex',
        'ENOENT',
        'EACCES',
        SESSION_ID,
    ]);
});
