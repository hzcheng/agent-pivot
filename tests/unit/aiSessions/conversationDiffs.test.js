'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    parseUnifiedDiff,
    synthesizeFragmentDiff,
} = require('../../../out/aiSessions/conversation/diffs');
const { CONVERSATION_LIMITS } = require('../../../out/aiSessions/conversation/types');

test('CONVERSATION-DIFF-VISIBILITY-001 parses a multi-file unified diff with counts and hunk starts', () => {
    const files = parseUnifiedDiff([
        'diff --git a/src/a.ts b/src/a.ts',
        'index 111..222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -10,3 +10,4 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        '+const c = 4;',
        ' const d = 5;',
        'diff --git a/src/b.ts b/src/b.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/b.ts',
        '@@ -0,0 +1,2 @@',
        '+export const x = 1;',
        '+export const y = 2;',
    ].join('\n'));

    assert.equal(files.length, 2);
    assert.deepEqual(files[0], {
        path: 'src/a.ts',
        additions: 2,
        deletions: 1,
        hunks: [{
            oldStart: 10,
            newStart: 10,
            lines: [
                { type: 'context', text: ' const a = 1;'.slice(1) },
                { type: 'del', text: 'const b = 2;' },
                { type: 'add', text: 'const b = 3;' },
                { type: 'add', text: 'const c = 4;' },
                { type: 'context', text: 'const d = 5;' },
            ],
        }],
    });
    assert.equal(files[1].path, 'src/b.ts');
    assert.equal(files[1].kind, 'add');
    assert.equal(files[1].additions, 2);
    assert.equal(files[1].deletions, 0);
});

test('CONVERSATION-DIFF-VISIBILITY-001 tolerates headerless line streams under a fallback path', () => {
    const files = parseUnifiedDiff(
        '-old line\n+new line\n context line',
        'src/c.ts',
        'update'
    );

    assert.deepEqual(files, [{
        path: 'src/c.ts',
        kind: 'update',
        additions: 1,
        deletions: 1,
        hunks: [{
            lines: [
                { type: 'del', text: 'old line' },
                { type: 'add', text: 'new line' },
                { type: 'context', text: 'context line' },
            ],
        }],
    }]);
});

test('CONVERSATION-DIFF-VISIBILITY-001 returns no files for empty or contentless text', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
    assert.deepEqual(parseUnifiedDiff('   \n  '), []);
    assert.deepEqual(parseUnifiedDiff('plain prose\nno diff lines'), []);
    assert.deepEqual(parseUnifiedDiff(undefined), []);
});

test('CONVERSATION-DIFF-VISIBILITY-001 caps files and lines with explicit truncation counts', () => {
    const manyFiles = Array.from(
        { length: CONVERSATION_LIMITS.maxDiffsPerToolCall + 2 },
        (_unused, index) => `--- a/f${index}.ts\n+++ b/f${index}.ts\n@@ -1 +1 @@\n-a\n+b`
    ).join('\n');
    const files = parseUnifiedDiff(manyFiles);
    assert.equal(files.length, CONVERSATION_LIMITS.maxDiffsPerToolCall);

    const manyLines = ['--- a/big.ts', '+++ b/big.ts', '@@ -1 +1 @@'];
    for (let index = 0; index < CONVERSATION_LIMITS.maxDiffLinesPerFile + 10; index += 1) {
        manyLines.push(`+line ${index}`);
    }
    const big = parseUnifiedDiff(manyLines.join('\n'));
    assert.equal(big.length, 1);
    assert.equal(
        big[0].hunks[0].lines.length,
        CONVERSATION_LIMITS.maxDiffLinesPerFile
    );
    assert.equal(big[0].hunks[0].truncatedLines, 10);
    assert.equal(big[0].additions, CONVERSATION_LIMITS.maxDiffLinesPerFile);
});

test('CONVERSATION-DIFF-VISIBILITY-001 synthesizes fragment diffs with interleaved context via LCS', () => {
    const file = synthesizeFragmentDiff(
        'src/edit.ts',
        'update',
        'alpha\nbeta\ngamma\ndelta',
        'alpha\nBETA\ngamma\ndelta\nepsilon'
    );

    assert.equal(file.path, 'src/edit.ts');
    assert.equal(file.kind, 'update');
    assert.deepEqual(file.hunks[0].lines, [
        { type: 'context', text: 'alpha' },
        { type: 'del', text: 'beta' },
        { type: 'add', text: 'BETA' },
        { type: 'context', text: 'gamma' },
        { type: 'context', text: 'delta' },
        { type: 'add', text: 'epsilon' },
    ]);
    assert.equal(file.additions, 2);
    assert.equal(file.deletions, 1);
});

test('CONVERSATION-DIFF-VISIBILITY-001 synthesizes all-add and all-del fragments', () => {
    const added = synthesizeFragmentDiff('src/new.ts', 'add', '', 'one\ntwo');
    assert.deepEqual(added.hunks[0].lines, [
        { type: 'add', text: 'one' },
        { type: 'add', text: 'two' },
    ]);
    assert.equal(added.additions, 2);
    assert.equal(added.deletions, 0);

    const removed = synthesizeFragmentDiff('src/gone.ts', 'delete', 'one\n', '');
    assert.deepEqual(removed.hunks[0].lines, [
        { type: 'del', text: 'one' },
    ]);
    assert.equal(removed.deletions, 1);
});

test('CONVERSATION-DIFF-VISIBILITY-001 degrades oversized synthesis to delete-all then add-all', () => {
    const oldText = Array.from(
        { length: CONVERSATION_LIMITS.diffSynthesizeMaxLines + 1 },
        (_unused, index) => `old ${index}`
    ).join('\n');
    const file = synthesizeFragmentDiff('src/huge.ts', 'update', oldText, 'new');

    const lines = file.hunks[0].lines;
    // The line cap absorbs the whole fragment: every emitted line is a
    // deletion and the remaining deletions plus the addition are counted
    // as truncated.
    assert.equal(
        lines.every(line => line.type === 'del'),
        true
    );
    assert.equal(lines.length, CONVERSATION_LIMITS.maxDiffLinesPerFile);
    assert.equal(file.hunks[0].truncatedLines, 2);
});

test('CONVERSATION-DIFF-VISIBILITY-001 bounds line text and paths by grapheme limits', () => {
    const longLine = `+${'x'.repeat(CONVERSATION_LIMITS.diffLineGraphemes + 50)}`;
    const files = parseUnifiedDiff(longLine, 'src/long.ts', 'update');
    assert.equal(
        files[0].hunks[0].lines[0].text.length
            <= CONVERSATION_LIMITS.diffLineGraphemes + 1,
        true
    );

    const longPath = 'src/'.repeat(400);
    const file = synthesizeFragmentDiff(longPath, 'update', 'a', 'b');
    assert.equal(
        file.path.length <= CONVERSATION_LIMITS.diffPathGraphemes + 1,
        true
    );
});
