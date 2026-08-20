'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createWindowCycleSwitchHandler,
} = require('../../../out/dashboard/windowCycleSwitch');

function win(cardId, navigationIdentity) {
    return { cardId, navigationIdentity };
}

function makeHandler(overrides = {}) {
    const calls = [];
    const handler = createWindowCycleSwitchHandler({
        listOtherWindows: () => overrides.others || [],
        getSelfNavigationIdentity: () => overrides.self,
        openWindow: cardId => {
            calls.push(['open', cardId]);
            return Promise.resolve();
        },
        showInformationMessage: message => calls.push(['info', message]),
    });
    return { calls, handler };
}

test('OPEN-WINDOW-CYCLE-RAILS-001 reports when there is no other window to switch to', async () => {
    const { calls, handler } = makeHandler({ self: 'self' });

    await handler.switchWindow('next');
    await handler.switchWindow('previous');

    assert.deepEqual(calls, [
        ['info', 'No other open windows to switch to.'],
        ['info', 'No other open windows to switch to.'],
    ]);
});

test('OPEN-WINDOW-CYCLE-RAILS-001 steps to this window\'s neighbour on a shared stable ring', async () => {
    // The ring sorts by navigation identity: aaa < self < zzz. The handler is
    // stateless: each window anchors on its own identity, and the focus move
    // itself carries the cycle forward — the next press happens in the
    // destination window, which steps from its own position on the same ring.
    const others = [win('card-z', 'zzz'), win('card-a', 'aaa')];
    const { calls, handler } = makeHandler({ others, self: 'self' });

    await handler.switchWindow('next');
    await handler.switchWindow('previous');
    await handler.switchWindow('next');

    assert.deepEqual(calls, [
        ['open', 'card-z'],
        ['open', 'card-a'],
        ['open', 'card-z'],
    ]);
});

test('OPEN-WINDOW-CYCLE-RAILS-001 wraps around both ends of the ring', async () => {
    const others = [win('card-a', 'aaa'), win('card-b', 'bbb')];

    // Ring: 000 < aaa < bbb. Self leads, so next wraps to the first other.
    const next = makeHandler({ others, self: '000' });
    await next.handler.switchWindow('next');
    assert.deepEqual(next.calls, [['open', 'card-a']]);

    // Previous from self wraps to the ring's end.
    const previous = makeHandler({ others, self: '000' });
    await previous.handler.switchWindow('previous');
    assert.deepEqual(previous.calls, [['open', 'card-b']]);
});

test('OPEN-WINDOW-CYCLE-RAILS-001 starts at a ring end when this window is unknown', async () => {
    const others = [win('card-b', 'bbb'), win('card-a', 'aaa')];
    const { calls, handler } = makeHandler({ others, self: undefined });

    await handler.switchWindow('next');
    await handler.switchWindow('previous');

    assert.deepEqual(calls, [
        ['open', 'card-a'],
        ['open', 'card-b'],
    ]);
});

test('OPEN-WINDOW-CYCLE-RAILS-001 drops duplicate and invalid window entries', async () => {
    const others = [
        win('card-a', 'aaa'),
        win('card-a2', 'aaa'),
        win('', 'bbb'),
        win('card-c', ''),
        null,
    ];
    const { calls, handler } = makeHandler({ others, self: 'self' });

    // Ring: aaa < self — exactly one aaa entry survives, and the first card
    // wins the open.
    await handler.switchWindow('previous');

    assert.deepEqual(calls, [['open', 'card-a']]);
});
