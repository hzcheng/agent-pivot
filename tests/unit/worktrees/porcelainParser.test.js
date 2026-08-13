'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    parseWorktreePorcelain,
    WorktreePorcelainParseError,
} = require('../../../out/worktrees/porcelainParser');

test('WORKTREE-DISCOVERY-001 parses LF porcelain flags, reasons, spaces, and quoted paths', () => {
    const records = parseWorktreePorcelain([
        'worktree /repo/main checkout',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree "/repo/feature\\040caf\\303\\251"',
        'HEAD 2222222222222222222222222222222222222222',
        'detached',
        'locked in use',
        '',
        'worktree /repo/missing',
        'HEAD 3333333333333333333333333333333333333333',
        'branch refs/heads/stale',
        'prunable gitdir file points to non-existent location',
        '',
    ].join('\n'));

    assert.deepEqual(records, [
        {
            worktreePath: '/repo/main checkout',
            head: '1'.repeat(40),
            branchRef: 'refs/heads/main',
            bare: false,
            detached: false,
            locked: false,
            prunable: false,
        },
        {
            worktreePath: '/repo/feature café',
            head: '2'.repeat(40),
            bare: false,
            detached: true,
            locked: true,
            prunable: false,
        },
        {
            worktreePath: '/repo/missing',
            head: '3'.repeat(40),
            branchRef: 'refs/heads/stale',
            bare: false,
            detached: false,
            locked: false,
            prunable: true,
        },
    ]);
});

test('WORKTREE-DISCOVERY-001 parses NUL porcelain and bare repositories', () => {
    const records = parseWorktreePorcelain([
        'worktree /srv/repo.git',
        'bare',
        '',
        'worktree /srv/linked',
        `HEAD ${'a'.repeat(40)}`,
        'branch refs/heads/topic',
        '',
        '',
    ].join('\0'));

    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
        worktreePath: '/srv/repo.git',
        head: '',
        bare: true,
        detached: false,
        locked: false,
        prunable: false,
    });
    assert.equal(records[1].branchRef, 'refs/heads/topic');
});

test('WORKTREE-DISCOVERY-001 rejects malformed, duplicate, and unbounded porcelain', () => {
    assert.throws(
        () => parseWorktreePorcelain(`HEAD ${'a'.repeat(40)}\n`),
        WorktreePorcelainParseError
    );
    assert.throws(
        () => parseWorktreePorcelain('worktree /a\nworktree /b\nHEAD a\n'),
        /duplicate/
    );
    assert.throws(
        () => parseWorktreePorcelain('worktree /a\nHEAD a\n', { maxInputBytes: 4 }),
        /size limit/
    );
    assert.throws(
        () => parseWorktreePorcelain(
            'worktree /a\nHEAD a\n\nworktree /b\nHEAD b\n',
            { maxRecords: 1 }
        ),
        /record limit/
    );
});
