'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const checkerPath = path.resolve(
    __dirname,
    '../../../scripts/run-release-packaging-checks.js',
);
const releasePackagingChecks = require(
    checkerPath
);

test('exact main VSIX entries reject an unreviewed compiled output', () => {
    assert.ok(
        Array.isArray(releasePackagingChecks.EXPECTED_MAIN_ENTRIES),
        'release checks must expose one explicit reviewed main-entry allowlist',
    );
    assert.equal(
        typeof releasePackagingChecks.assertExactEntries,
        'function',
        'release checks must expose exact-entry validation',
    );
    assert.doesNotMatch(
        fs.readFileSync(checkerPath, 'utf8'),
        /sourceOutputEntries/,
        'the reviewed allowlist must not be derived from source discovery',
    );
    const extraEntry = 'extension/out/workspaces/unreviewed.js';
    assert.equal(
        releasePackagingChecks.EXPECTED_MAIN_ENTRIES.includes(extraEntry),
        false,
        'an unreviewed output must not auto-enter the allowlist',
    );
    const entries = new Map(
        releasePackagingChecks.EXPECTED_MAIN_ENTRIES
            .concat(extraEntry)
            .map(entry => [entry, Buffer.alloc(0)])
    );

    assert.throws(
        () => releasePackagingChecks.assertExactEntries(
            entries,
            releasePackagingChecks.EXPECTED_MAIN_ENTRIES,
            'controlled main VSIX',
        ),
        /must contain exactly the reviewed release files/,
    );
});
