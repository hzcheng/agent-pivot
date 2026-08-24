'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildRunningSessionQueue,
    getNextRunningSessionQueueItem,
} = require('../../../out/aiSessions/runningQueue');
const {
    createRunningSessionJumpHandler,
} = require('../../../out/dashboard/runningSessionJump');
const {
    createSessionNavigationCoordinator,
} = require('../../../out/dashboard/sessionNavigationCoordinator');
const {
    createSessionNavigationFocusExecutor,
} = require('../../../out/dashboard/sessionNavigationFocusExecutor');

const WINDOW_A = 'a'.repeat(64);
const WINDOW_B = 'b'.repeat(64);

function local(provider, sessionId, name) {
    return { provider, sessionId, name };
}

function remote(navigationIdentity, runningSessionCount = 1, cardId) {
    return {
        cardId: cardId || `card-${navigationIdentity.slice(0, 8)}`,
        navigationIdentity,
        displayName: `Window ${navigationIdentity.slice(0, 4)}`,
        runningSessionCount,
    };
}

function makeJumpOptions(overrides = {}) {
    const calls = [];
    const options = {
        buildQueue: () => overrides.queue || { items: [], localCount: 0, remoteCount: 0, total: 0 },
        focusSession: item => {
            calls.push(['focus', item.provider, item.sessionId]);
            return Promise.resolve(overrides.focusResult !== false);
        },
        openConversation: item => {
            calls.push(['open', item.provider, item.sessionId]);
            return Promise.resolve();
        },
        requestRemoteFocus: item => {
            calls.push(['request', item.navigationIdentity]);
            if (overrides.requestThrows) {
                return Promise.reject(new Error('command is not registered'));
            }
            return Promise.resolve(overrides.requestResult !== false);
        },
        openNavigationCard: cardId => {
            calls.push(['navigate', cardId]);
            return Promise.resolve();
        },
        showInformationMessage: message => calls.push(['info', message]),
        showWarningMessage: message => calls.push(['warn', message]),
        nowMs: overrides.nowMs || (() => 0),
    };
    return { calls, options };
}

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 builds a stable local-first running queue', () => {
    const queue = buildRunningSessionQueue({
        localSessions: [
            local('kimi', 'k2', 'Second'),
            local('codex', 'c1', 'First'),
            local('codex', 'c1', 'Duplicate'),
            local('claude', ''),
            { provider: 'other', sessionId: 'x' },
            null,
        ],
        remoteWindows: [
            remote(WINDOW_B, 2),
            remote(WINDOW_A),
            remote(WINDOW_A),
            remote('c'.repeat(64), 0),
            { cardId: '', navigationIdentity: '', runningSessionCount: 3 },
        ],
    });

    assert.deepEqual(queue.items.map(item => item.key), [
        'session:codex:c1',
        'session:kimi:k2',
        `window:${WINDOW_A}`,
        `window:${WINDOW_B}`,
    ]);
    assert.deepEqual(
        queue.items.map(item => item.kind),
        ['local', 'local', 'remote', 'remote'],
    );
    assert.equal(queue.items[0].sessionName, 'First');
    assert.equal(queue.items[2].cardId, `card-${'a'.repeat(8)}`);
    assert.equal(queue.localCount, 2);
    assert.equal(queue.remoteCount, 2);
    assert.equal(queue.total, 4);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 advances the cursor with wrap-around and resets a vanished cursor', () => {
    const queue = buildRunningSessionQueue({
        localSessions: [local('codex', 'c1'), local('kimi', 'k1')],
        remoteWindows: [remote(WINDOW_A)],
    });
    const items = queue.items;

    assert.equal(getNextRunningSessionQueueItem(items, null).key, 'session:codex:c1');
    assert.equal(
        getNextRunningSessionQueueItem(items, 'session:codex:c1').key,
        'session:kimi:k1',
    );
    assert.equal(
        getNextRunningSessionQueueItem(items, `window:${WINDOW_A}`).key,
        'session:codex:c1',
    );
    assert.equal(
        getNextRunningSessionQueueItem(items, 'session:codex:gone').key,
        'session:codex:c1',
    );
    assert.equal(getNextRunningSessionQueueItem([], null), null);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 cycles local sessions with focus and conversation per jump', async () => {
    const queue = buildRunningSessionQueue({
        localSessions: [local('codex', 'c1'), local('kimi', 'k1')],
        remoteWindows: [],
    });
    const { calls, options } = makeJumpOptions({ queue });
    const handler = createRunningSessionJumpHandler(options);

    await handler.jumpToNextRunningSession();
    await handler.jumpToNextRunningSession();
    await handler.jumpToNextRunningSession();

    assert.deepEqual(calls, [
        ['focus', 'codex', 'c1'],
        ['open', 'codex', 'c1'],
        ['focus', 'kimi', 'k1'],
        ['open', 'kimi', 'k1'],
        ['focus', 'codex', 'c1'],
        ['open', 'codex', 'c1'],
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 skips a session that died mid-cycle instead of trapping the cursor', async () => {
    const { calls, options } = makeJumpOptions({
        queue: buildRunningSessionQueue({
            localSessions: [local('codex', 'c1'), local('kimi', 'k1')],
            remoteWindows: [],
        }),
        focusResult: false,
    });
    const handler = createRunningSessionJumpHandler(options);

    await handler.jumpToNextRunningSession();
    await handler.jumpToNextRunningSession();

    assert.deepEqual(calls, [
        ['focus', 'codex', 'c1'],
        ['warn', 'Agent Pivot: the selected AI session is no longer active.'],
        ['focus', 'kimi', 'k1'],
        ['warn', 'Agent Pivot: the selected AI session is no longer active.'],
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 hands off and switches windows for remote running sessions', async () => {
    const { calls, options } = makeJumpOptions({
        queue: buildRunningSessionQueue({
            localSessions: [local('codex', 'c1')],
            remoteWindows: [remote(WINDOW_A, 2)],
        }),
    });
    const handler = createRunningSessionJumpHandler(options);

    await handler.jumpToNextRunningSession();
    await handler.jumpToNextRunningSession();
    await handler.jumpToNextRunningSession();

    assert.deepEqual(calls, [
        ['focus', 'codex', 'c1'],
        ['open', 'codex', 'c1'],
        ['request', WINDOW_A],
        ['navigate', `card-${'a'.repeat(8)}`],
        ['focus', 'codex', 'c1'],
        ['open', 'codex', 'c1'],
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 degrades to a plain window switch when the hand-off channel is missing', async () => {
    for (const overrides of [{ requestResult: false }, { requestThrows: true }]) {
        const { calls, options } = makeJumpOptions({
            ...overrides,
            queue: buildRunningSessionQueue({
                localSessions: [],
                remoteWindows: [remote(WINDOW_A)],
            }),
        });
        const handler = createRunningSessionJumpHandler(options);

        await handler.jumpToNextRunningSession();

        assert.deepEqual(calls, [
            ['request', WINDOW_A],
            ['navigate', `card-${'a'.repeat(8)}`],
            ['info', 'Agent Pivot: switched to Window aaaa;'
                + ' run Next Running Session again to focus a session there.'],
        ]);
    }
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 reports an empty queue and an empty local scope distinctly', async () => {
    const empty = makeJumpOptions({});
    await createRunningSessionJumpHandler(empty.options).jumpToNextRunningSession();
    assert.deepEqual(empty.calls, [['info', 'Agent Pivot: no running AI sessions.']]);

    const remoteOnly = makeJumpOptions({
        queue: buildRunningSessionQueue({
            localSessions: [],
            remoteWindows: [remote(WINDOW_A)],
        }),
    });
    await createRunningSessionJumpHandler(remoteOnly.options).jumpToNextLocalRunningSession();
    assert.deepEqual(remoteOnly.calls, [
        ['info', 'Agent Pivot: no running AI sessions in this window.'],
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 routes a focus hand-off to a local jump without leaving the window', async () => {
    const { calls, options } = makeJumpOptions({
        queue: buildRunningSessionQueue({
            localSessions: [local('codex', 'c1'), local('kimi', 'k1')],
            remoteWindows: [remote(WINDOW_A)],
        }),
    });
    const handler = createRunningSessionJumpHandler(options);

    await handler.jumpToNextLocalRunningSession();
    await handler.jumpToNextLocalRunningSession();

    assert.deepEqual(calls, [
        ['focus', 'codex', 'c1'],
        ['open', 'codex', 'c1'],
        ['focus', 'kimi', 'k1'],
        ['open', 'kimi', 'k1'],
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 restarts at the head when the cursor session stopped', async () => {
    let sessions = [local('codex', 'c1'), local('kimi', 'k1')];
    const { calls, options } = makeJumpOptions({});
    options.buildQueue = () => buildRunningSessionQueue({
        localSessions: sessions,
        remoteWindows: [],
    });
    const handler = createRunningSessionJumpHandler(options);

    await handler.jumpToNextRunningSession();
    sessions = [local('kimi', 'k1')];
    await handler.jumpToNextRunningSession();

    assert.deepEqual(calls, [
        ['focus', 'codex', 'c1'],
        ['open', 'codex', 'c1'],
        ['focus', 'kimi', 'k1'],
        ['open', 'kimi', 'k1'],
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 rotates remote windows to continue the cycle after the current window', () => {
    const WINDOW_C = 'c'.repeat(64);
    const rotate = (selfIdentity, sessionId) => buildRunningSessionQueue({
        localSessions: [local('codex', sessionId)],
        remoteWindows: [WINDOW_A, WINDOW_B, WINDOW_C]
            .filter(identity => identity !== selfIdentity)
            .map(identity => remote(identity)),
        selfNavigationIdentity: selfIdentity,
    }).items.map(item => item.key);

    assert.deepEqual(rotate(WINDOW_A, 'sa'), [
        'session:codex:sa', `window:${WINDOW_B}`, `window:${WINDOW_C}`,
    ]);
    assert.deepEqual(rotate(WINDOW_B, 'sb'), [
        'session:codex:sb', `window:${WINDOW_C}`, `window:${WINDOW_A}`,
    ]);
    assert.deepEqual(rotate(WINDOW_C, 'sc'), [
        'session:codex:sc', `window:${WINDOW_A}`, `window:${WINDOW_B}`,
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 continues after the focused session instead of re-landing on it', () => {
    const items = buildRunningSessionQueue({
        localSessions: [local('codex', 'c1'), local('kimi', 'k1')],
        remoteWindows: [remote(WINDOW_A)],
    }).items;

    assert.equal(
        getNextRunningSessionQueueItem(items, null, 'session:kimi:k1').key,
        `window:${WINDOW_A}`,
    );
    assert.equal(
        getNextRunningSessionQueueItem(items, null, 'session:codex:c1').key,
        'session:kimi:k1',
    );
    assert.equal(
        getNextRunningSessionQueueItem(items, 'session:codex:gone', 'session:kimi:k1').key,
        `window:${WINDOW_A}`,
    );
    assert.equal(
        getNextRunningSessionQueueItem(items, `window:${WINDOW_A}`, 'session:codex:c1').key,
        'session:kimi:k1',
    );

    const single = buildRunningSessionQueue({
        localSessions: [local('codex', 'c1')],
        remoteWindows: [],
    }).items;
    assert.equal(
        getNextRunningSessionQueueItem(single, null, 'session:codex:c1').key,
        'session:codex:c1',
    );
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 cycles three single-session windows in a stable rotation', async () => {
    const WINDOW_C = 'c'.repeat(64);
    const identities = [WINDOW_A, WINDOW_B, WINDOW_C];
    const sessionOf = identity => `s-${identity[0]}`;
    const cardOf = identity => `card-${identity[0]}`;
    const world = {
        activeWindow: WINDOW_A,
        focused: new Map([[WINDOW_A, sessionOf(WINDOW_A)]]),
    };
    const handlers = new Map();
    for (const identity of identities) {
        const others = identities.filter(candidate => candidate !== identity);
        handlers.set(identity, createRunningSessionJumpHandler({
            nowMs: () => 0,
            buildQueue: () => buildRunningSessionQueue({
                localSessions: [local('codex', sessionOf(identity))],
                remoteWindows: others.map(other => remote(other, 1, cardOf(other))),
                selfNavigationIdentity: identity,
            }),
            focusSession: item => {
                world.focused.set(identity, item.sessionId);
                return Promise.resolve(true);
            },
            openConversation: () => Promise.resolve(),
            requestRemoteFocus: item => {
                world.activeWindow = item.navigationIdentity;
                return handlers.get(item.navigationIdentity)
                    .jumpToNextLocalRunningSession()
                    .then(() => true);
            },
            openNavigationCard: cardId => {
                world.activeWindow = identities
                    .find(candidate => cardOf(candidate) === cardId);
                return Promise.resolve();
            },
            showInformationMessage: () => {},
            showWarningMessage: () => {},
            getCurrentKey: () => {
                const focused = world.focused.get(identity);
                return focused ? `session:codex:${focused}` : null;
            },
        }));
    }

    const visited = [];
    for (let press = 0; press < 6; press += 1) {
        await handlers.get(world.activeWindow).jumpToNextRunningSession();
        visited.push(`${world.activeWindow}:${world.focused.get(world.activeWindow)}`);
    }

    assert.deepEqual(visited, [
        `${WINDOW_B}:s-b`,
        `${WINDOW_C}:s-c`,
        `${WINDOW_A}:s-a`,
        `${WINDOW_B}:s-b`,
        `${WINDOW_C}:s-c`,
        `${WINDOW_A}:s-a`,
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 visits every running session in a multi-session window', async () => {
    const WINDOW_C = 'c'.repeat(64);
    const identities = [WINDOW_A, WINDOW_B, WINDOW_C];
    const sessions = new Map([
        [WINDOW_A, [local('codex', 'a1')]],
        [WINDOW_B, [local('codex', 'b1'), local('kimi', 'b2')]],
        [WINDOW_C, [local('codex', 'c1')]],
    ]);
    const world = {
        activeWindow: WINDOW_A,
        focused: new Map([
            [WINDOW_A, 'session:codex:a1'],
            [WINDOW_B, 'session:codex:b1'],
            [WINDOW_C, 'session:codex:c1'],
        ]),
    };
    const handlers = new Map();
    for (const identity of identities) {
        const others = identities.filter(candidate => candidate !== identity);
        handlers.set(identity, createRunningSessionJumpHandler({
            nowMs: () => 0,
            buildQueue: () => buildRunningSessionQueue({
                localSessions: sessions.get(identity),
                remoteWindows: others.map(other => remote(
                    other,
                    sessions.get(other).length,
                    `card-${other[0]}`,
                )),
                selfNavigationIdentity: identity,
            }),
            focusSession: item => {
                world.focused.set(identity, item.key);
                return Promise.resolve(true);
            },
            openConversation: () => Promise.resolve(),
            requestRemoteFocus: item => handlers.get(item.navigationIdentity)
                .jumpToNextLocalRunningSession({
                    sourceNavigationIdentity: identity,
                    targetNavigationIdentity: item.navigationIdentity,
                    createdAtMs: 1,
                })
                .then(() => true),
            openNavigationCard: cardId => {
                world.activeWindow = identities
                    .find(candidate => `card-${candidate[0]}` === cardId);
                return Promise.resolve();
            },
            showInformationMessage: () => {},
            showWarningMessage: () => {},
            getCurrentKey: () => world.focused.get(identity),
        }));
    }

    const visited = [];
    for (let press = 0; press < 8; press += 1) {
        await handlers.get(world.activeWindow).jumpToNextRunningSession();
        visited.push(`${world.activeWindow[0]}:${world.focused.get(world.activeWindow)}`);
    }

    assert.deepEqual(visited, [
        'b:session:codex:b1',
        'b:session:kimi:b2',
        'c:session:codex:c1',
        'a:session:codex:a1',
        'b:session:codex:b1',
        'b:session:kimi:b2',
        'c:session:codex:c1',
        'a:session:codex:a1',
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 does not starve a window when local ring context is unavailable', async () => {
    const WINDOW_C = 'c'.repeat(64);
    const identities = [WINDOW_A, WINDOW_B, WINDOW_C];
    const sessionOf = identity => `s-${identity[0]}`;
    const cardOf = identity => `card-${identity[0]}`;
    const world = {
        activeWindow: WINDOW_A,
        focused: new Map(identities.map(identity => [identity, sessionOf(identity)])),
    };
    const handlers = new Map();
    for (const identity of identities) {
        const others = identities.filter(candidate => candidate !== identity);
        handlers.set(identity, createRunningSessionJumpHandler({
            nowMs: () => 0,
            buildQueue: () => buildRunningSessionQueue({
                localSessions: [local('codex', sessionOf(identity))],
                remoteWindows: others.map(other => remote(other, 1, cardOf(other))),
                // A bridge snapshot can temporarily lack the current window's
                // ring anchor. The authoritative hand-off target must still
                // prevent A/B ping-pong from starving C.
            }),
            focusSession: item => {
                world.focused.set(identity, item.sessionId);
                return Promise.resolve(true);
            },
            openConversation: () => Promise.resolve(),
            requestRemoteFocus: item => handlers.get(item.navigationIdentity)
                .jumpToNextLocalRunningSession({
                    sourceNavigationIdentity: identity,
                    targetNavigationIdentity: item.navigationIdentity,
                    createdAtMs: 1,
                })
                .then(() => true),
            openNavigationCard: cardId => {
                world.activeWindow = identities
                    .find(candidate => cardOf(candidate) === cardId);
                return Promise.resolve();
            },
            showInformationMessage: () => {},
            showWarningMessage: () => {},
            getCurrentKey: () => `session:codex:${world.focused.get(identity)}`,
        }));
    }

    const visited = [];
    for (let press = 0; press < 6; press += 1) {
        await handlers.get(world.activeWindow).jumpToNextRunningSession();
        visited.push(world.activeWindow);
    }

    assert.deepEqual(visited, [
        WINDOW_B, WINDOW_C, WINDOW_A, WINDOW_B, WINDOW_C, WINDOW_A,
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 keeps every window reachable in a four-window degraded ring', async () => {
    const identities = [WINDOW_A, WINDOW_B, 'c'.repeat(64), 'd'.repeat(64)];
    const world = {
        activeWindow: WINDOW_A,
        focused: new Map(identities.map(identity => [identity, `session:codex:s-${identity[0]}`])),
    };
    const handlers = new Map();
    for (const identity of identities) {
        const others = identities.filter(candidate => candidate !== identity);
        handlers.set(identity, createRunningSessionJumpHandler({
            nowMs: () => 0,
            buildQueue: () => buildRunningSessionQueue({
                localSessions: [local('codex', `s-${identity[0]}`)],
                remoteWindows: others.map(other => remote(other, 1, `card-${other[0]}`)),
            }),
            focusSession: item => {
                world.focused.set(identity, item.key);
                return Promise.resolve(true);
            },
            openConversation: () => Promise.resolve(),
            requestRemoteFocus: item => handlers.get(item.navigationIdentity)
                .jumpToNextLocalRunningSession({
                    sourceNavigationIdentity: identity,
                    targetNavigationIdentity: item.navigationIdentity,
                    createdAtMs: 1,
                })
                .then(() => true),
            openNavigationCard: cardId => {
                world.activeWindow = identities
                    .find(candidate => `card-${candidate[0]}` === cardId);
                return Promise.resolve();
            },
            showInformationMessage: () => {},
            showWarningMessage: () => {},
            getCurrentKey: () => world.focused.get(identity),
        }));
    }

    const visited = [];
    for (let press = 0; press < 8; press += 1) {
        await handlers.get(world.activeWindow).jumpToNextRunningSession();
        visited.push(world.activeWindow[0]);
    }

    assert.deepEqual(visited, ['b', 'c', 'd', 'a', 'b', 'c', 'd', 'a']);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 returns to the source when only two windows are running', async () => {
    const queue = buildRunningSessionQueue({
        localSessions: [local('codex', 'a')],
        remoteWindows: [remote(WINDOW_B)],
    });
    const { calls, options } = makeJumpOptions({ queue });
    options.getCurrentKey = () => null;
    const handler = createRunningSessionJumpHandler(options);

    await handler.jumpToNextLocalRunningSession({
        sourceNavigationIdentity: WINDOW_B,
        targetNavigationIdentity: WINDOW_A,
        createdAtMs: 1,
    });
    calls.length = 0;
    await handler.jumpToNextRunningSession();

    assert.deepEqual(calls, [
        ['request', WINDOW_B],
        ['navigate', `card-${'b'.repeat(8)}`],
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 re-anchors after a manual detour with three local sessions', async () => {
    const queue = buildRunningSessionQueue({
        localSessions: ['a', 'b', 'c'].map(sessionId => local('codex', sessionId)),
        remoteWindows: [],
    });
    let focused = 'a';
    const picked = [];
    const { options } = makeJumpOptions({ queue });
    options.focusSession = item => {
        focused = item.sessionId;
        picked.push(item.sessionId);
        return Promise.resolve(true);
    };
    options.getCurrentKey = () => `session:codex:${focused}`;
    const handler = createRunningSessionJumpHandler(options);

    await handler.jumpToNextRunningSession();
    focused = 'a';
    await handler.jumpToNextRunningSession();

    assert.deepEqual(picked, ['b', 'b'],
        'manual focus changes must re-anchor the next press regardless of queue length');
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 serializes rapid invocations without duplicating a target', async () => {
    const queue = buildRunningSessionQueue({
        localSessions: ['a', 'b', 'c'].map(sessionId => local('codex', sessionId)),
        remoteWindows: [],
    });
    let focused = 'a';
    const picked = [];
    const releases = [];
    const { options } = makeJumpOptions({ queue });
    options.focusSession = item => new Promise(resolve => {
        picked.push(item.sessionId);
        releases.push(() => {
            focused = item.sessionId;
            resolve(true);
        });
    });
    options.getCurrentKey = () => `session:codex:${focused}`;
    const handler = createRunningSessionJumpHandler(options);

    const first = handler.jumpToNextRunningSession();
    const second = handler.jumpToNextRunningSession();
    await Promise.resolve();
    assert.deepEqual(picked, ['b'], 'the second invocation waits for the first focus');
    releases.shift()();
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(picked, ['b', 'c']);
    releases.shift()();
    await Promise.all([first, second]);
    assert.equal(focused, 'c');
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 retains only the newest pending navigation intent', async () => {
    const coordinator = createSessionNavigationCoordinator();
    const calls = [];
    let releaseFirst;
    const first = coordinator.enqueueLatest(() => new Promise(resolve => {
        calls.push('first');
        releaseFirst = resolve;
    }));
    const stale = coordinator.enqueueLatest(async () => {
        calls.push('stale');
    });
    const latest = coordinator.enqueueLatest(async () => {
        calls.push('latest');
    });

    await Promise.resolve();
    assert.deepEqual(calls, ['first']);
    await stale;
    assert.deepEqual(calls, ['first'], 'a superseded pending intent settles as a no-op');
    releaseFirst();
    await Promise.all([first, latest]);
    assert.deepEqual(calls, ['first', 'latest']);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 emits target-free queue timing for started, superseded, and settled intents', async () => {
    let now = 100;
    const timings = [];
    const coordinator = createSessionNavigationCoordinator({
        now: () => now,
        onTiming: timing => timings.push(timing),
    });
    let releaseFirst;
    const first = coordinator.enqueueLatest(() => new Promise(resolve => {
        releaseFirst = resolve;
    }));
    await Promise.resolve();
    now = 125;
    const stale = coordinator.enqueueLatest(async () => {});
    now = 140;
    const latest = coordinator.enqueueLatest(async () => {});
    await stale;
    now = 200;
    releaseFirst();
    await Promise.all([first, latest]);

    assert.deepEqual(timings, [
        { event: 'started', latest: true, queueMs: 0 },
        { event: 'superseded', latest: true, queueMs: 15 },
        {
            event: 'settled', latest: true, queueMs: 0,
            executionMs: 100, outcome: 'succeeded',
        },
        { event: 'started', latest: true, queueMs: 60 },
        {
            event: 'settled', latest: true, queueMs: 60,
            executionMs: 0, outcome: 'succeeded',
        },
    ]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 makes a late handoff idempotent with a newer local jump', async () => {
    const queue = buildRunningSessionQueue({
        localSessions: [local('codex', 'b1'), local('codex', 'b2')],
        remoteWindows: [],
    });
    let focused = 'b1';
    const picked = [];
    const { options } = makeJumpOptions({ queue, nowMs: () => 2000 });
    options.focusSession = item => {
        focused = item.sessionId;
        picked.push(item.sessionId);
        return Promise.resolve(true);
    };
    options.getCurrentKey = () => `session:codex:${focused}`;
    const handler = createRunningSessionJumpHandler(options);

    await handler.jumpToNextRunningSession();
    await handler.jumpToNextLocalRunningSession({
        sourceNavigationIdentity: WINDOW_A,
        targetNavigationIdentity: WINDOW_B,
        createdAtMs: 1000,
    });

    assert.deepEqual(picked, ['b2', 'b2'],
        'a handoff delivered after a user jump may reaffirm, but never reverse, that jump');
    assert.equal(focused, 'b2');
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 keeps the shared navigation queue usable after a failed transaction', async () => {
    const coordinator = createSessionNavigationCoordinator();
    const calls = [];

    const failed = coordinator.enqueue(async () => {
        calls.push('failed');
        throw new Error('focus failed');
    });
    const recovered = coordinator.enqueue(async () => {
        calls.push('recovered');
    });

    await assert.rejects(failed, /focus failed/);
    await recovered;
    assert.deepEqual(calls, ['failed', 'recovered']);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 executes terminal focus and conversation open against one project snapshot', async () => {
    let projectId = 'project-before-focus';
    const calls = [];
    const executor = createSessionNavigationFocusExecutor({
        getProjectId: () => projectId,
        focusActive: async (capturedProjectId, provider, sessionId) => {
            calls.push(['focus', capturedProjectId, provider, sessionId]);
            projectId = 'project-after-focus';
            return true;
        },
        openConversation: async request => {
            calls.push(['open', request.projectId, request.provider, request.sessionId]);
            return true;
        },
    });

    assert.deepEqual(await executor.execute({ provider: 'codex', sessionId: 'target' }), {
        focused: true,
        conversationOpened: true,
    });
    assert.deepEqual(calls, [
        ['focus', 'project-before-focus', 'codex', 'target'],
        ['open', 'project-before-focus', 'codex', 'target'],
    ], 'one transaction cannot focus and open against different workspace cards');
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 reports target-free focus and conversation timings', async () => {
    let now = 50;
    const timings = [];
    const executor = createSessionNavigationFocusExecutor({
        getProjectId: () => 'project-a',
        focusActive: async () => {
            now = 70;
            return true;
        },
        openConversation: async () => {
            now = 95;
            return true;
        },
        now: () => now,
        onTiming: timing => timings.push(timing),
    });

    await executor.execute({ provider: 'codex', sessionId: 'sensitive-session-id' });

    assert.deepEqual(timings, [{
        outcome: 'conversation-opened',
        focusMs: 20,
        conversationMs: 25,
        totalMs: 45,
    }], 'performance diagnostics deliberately omit all target identity');
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 does not open a conversation when local focus cannot be established', async () => {
    let opens = 0;
    const executor = createSessionNavigationFocusExecutor({
        getProjectId: () => 'project',
        focusActive: async () => false,
        openConversation: async () => {
            opens += 1;
            return true;
        },
    });

    assert.deepEqual(await executor.execute({ provider: 'codex', sessionId: 'gone' }), {
        focused: false,
        conversationOpened: false,
    });
    assert.equal(opens, 0);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 records focus before opening the conversation', async () => {
    const calls = [];
    const executor = createSessionNavigationFocusExecutor({
        getProjectId: () => 'project',
        focusActive: async () => {
            calls.push('focus');
            return true;
        },
        openConversation: async () => {
            calls.push('open');
            return true;
        },
    });

    await executor.execute(
        { provider: 'codex', sessionId: 'target' },
        { onFocused: () => calls.push('record-mru') },
    );
    assert.deepEqual(calls, ['focus', 'record-mru', 'open']);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 advances after conversation open fails post-focus', async () => {
    const queue = buildRunningSessionQueue({
        localSessions: ['a', 'b', 'c'].map(sessionId => local('codex', sessionId)),
        remoteWindows: [],
    });
    let focused = 'a';
    const picked = [];
    const { options } = makeJumpOptions({ queue });
    options.focusSession = async item => {
        focused = item.sessionId;
        picked.push(item.sessionId);
        return true;
    };
    let opens = 0;
    options.openConversation = async () => {
        opens += 1;
        if (opens === 1) {
            throw new Error('conversation unavailable');
        }
    };
    options.getCurrentKey = () => `session:codex:${focused}`;
    const handler = createRunningSessionJumpHandler(options);

    await assert.rejects(handler.jumpToNextRunningSession(), /conversation unavailable/);
    await handler.jumpToNextRunningSession();

    assert.deepEqual(picked, ['b', 'c'],
        'a post-focus open failure must not make the next command repeat the focused session');
});
