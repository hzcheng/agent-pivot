'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../../..');

// ARCH-EXTENSION-HOST-PLACEMENT-001
test('ARCH-EXTENSION-HOST-PLACEMENT-001 keeps filesystem/session ownership in the workspace host', () => {
    const main = require(path.join(repositoryRoot, 'package.json'));
    const bridge = require(path.join(
        repositoryRoot,
        'extensions',
        'attention-ui-bridge',
        'package.json'
    ));

    assert.deepEqual(
        main.extensionKind,
        ['workspace'],
        'the main extension must not fall back to the UI host for remote workspaces'
    );
    assert.deepEqual(
        bridge.extensionKind,
        ['ui'],
        'the companion bridge must remain in the desktop UI host'
    );
    assert.deepEqual(
        main.extensionDependencies,
        [`${bridge.publisher}.${bridge.name}`],
        'the workspace extension must depend on the UI-host bridge'
    );
});
