'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    managedRemoteLinuxPlatformUpdate,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedRemotePlatform');

test('MANAGED-REMOTE-NAVIGATION-001 marks managed aliases as Linux and preserves user entries', () => {
    const update = managedRemoteLinuxPlatformUpdate({
        personal: 'windows',
        old: 'linux',
        keptByUser: 'windows',
    }, ['old', 'keptByUser'], ['build']);

    assert.deepEqual(update.value, {
        personal: 'windows',
        keptByUser: 'windows',
        build: 'linux',
    });
    assert.deepEqual(update.aliases, ['build']);
    assert.equal(update.changed, true);
});

test('MANAGED-REMOTE-NAVIGATION-001 avoids rewriting an unchanged platform map', () => {
    const update = managedRemoteLinuxPlatformUpdate(
        { build: 'linux', personal: 'macOS' },
        ['build'],
        ['build'],
    );
    assert.equal(update.changed, false);
});
