'use strict';

// Characterization tests for the MOD-SHARED-KERNEL path assignment utilities.
// They pin the CURRENT behavior of src/sessionAssignment.ts (posix and
// windows branches alike — the host OS is irrelevant because the module picks
// the path API from the string shape) so the module's strict-mode claim rests
// on direct coverage, not only on indirect worktree-assignment tests.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    assignPathToWorkspaceRoot,
    getWorkspaceHostPathComparisonKey,
    isWorkspaceHostPathContained,
    normalizeWorkspaceHostPath,
} = require('../../../out/sessionAssignment');

test('normalizeWorkspaceHostPath blanks non-path input', () => {
    assert.equal(normalizeWorkspaceHostPath(''), '');
    assert.equal(normalizeWorkspaceHostPath('   '), '');
    assert.equal(normalizeWorkspaceHostPath(null), '');
    assert.equal(normalizeWorkspaceHostPath(undefined), '');
});

test('normalizeWorkspaceHostPath normalizes posix paths and strips trailing separators', () => {
    assert.equal(normalizeWorkspaceHostPath('/a/b/'), '/a/b');
    assert.equal(normalizeWorkspaceHostPath('/a/./b'), '/a/b');
    assert.equal(normalizeWorkspaceHostPath('/a/b/../c'), '/a/c');
    assert.equal(normalizeWorkspaceHostPath('/'), '/');
});

test('normalizeWorkspaceHostPath selects the win32 API from the string shape', () => {
    assert.equal(normalizeWorkspaceHostPath('C:\\foo\\bar\\'), 'C:\\foo\\bar');
    assert.equal(normalizeWorkspaceHostPath('c:/foo/bar'), 'c:\\foo\\bar');
    assert.equal(normalizeWorkspaceHostPath('D:\\'), 'D:\\');
});

test('getWorkspaceHostPathComparisonKey lowercases windows and preserves posix case', () => {
    assert.equal(getWorkspaceHostPathComparisonKey('C:\\Foo\\Bar'), 'windows:c:\\foo\\bar');
    assert.equal(getWorkspaceHostPathComparisonKey('/Foo/Bar'), 'posix:/Foo/Bar');
    assert.equal(getWorkspaceHostPathComparisonKey(''), '');
});

test('isWorkspaceHostPathContained matches the root itself and descendants only', () => {
    assert.equal(isWorkspaceHostPathContained('/a/b', '/a/b'), true);
    assert.equal(isWorkspaceHostPathContained('/a/b', '/a/b/c/d'), true);
    assert.equal(isWorkspaceHostPathContained('/a/b', '/a/b2'), false);
    assert.equal(isWorkspaceHostPathContained('/a/b', '/a'), false);
    assert.equal(isWorkspaceHostPathContained('/a/b', ''), false);
});

test('isWorkspaceHostPathContained is case-insensitive on windows and never crosses path kinds', () => {
    assert.equal(isWorkspaceHostPathContained('C:\\Foo', 'c:\\foo\\bar'), true);
    assert.equal(isWorkspaceHostPathContained('C:\\foo', '/c/foo'), false);
});

test('assignPathToWorkspaceRoot prefers the longest containing root, then ordinal, then declaration order', () => {
    const roots = [
        { id: 'outer', hostPath: '/repo', ordinal: 0 },
        { id: 'inner', hostPath: '/repo/packages/api', ordinal: 1 },
    ];
    assert.equal(assignPathToWorkspaceRoot('/repo/packages/api/src', roots)?.id, 'inner');
    assert.equal(assignPathToWorkspaceRoot('/repo/tools', roots)?.id, 'outer');

    const tied = [
        { id: 'second', hostPath: '/repo', ordinal: 1 },
        { id: 'first', hostPath: '/repo', ordinal: 0 },
    ];
    assert.equal(assignPathToWorkspaceRoot('/repo/x', tied)?.id, 'first');

    const sameOrdinal = [
        { id: 'declared-first', hostPath: '/repo', ordinal: 0 },
        { id: 'declared-second', hostPath: '/repo', ordinal: 0 },
    ];
    assert.equal(assignPathToWorkspaceRoot('/repo/x', sameOrdinal)?.id, 'declared-first');
});

test('assignPathToWorkspaceRoot rejects empty candidates and skips unusable roots', () => {
    const roots = [{ id: 'usable', hostPath: '/repo', ordinal: 0 }];
    assert.equal(assignPathToWorkspaceRoot('', roots), null);
    assert.equal(assignPathToWorkspaceRoot('/repo/x', []), null);
    assert.equal(assignPathToWorkspaceRoot('/elsewhere/x', roots), null);
    const degraded = [
        { id: 'blank', hostPath: '', ordinal: 0 },
        { id: 'usable', hostPath: '/repo', ordinal: 1 },
    ];
    assert.equal(assignPathToWorkspaceRoot('/repo/x', degraded)?.id, 'usable');
});
