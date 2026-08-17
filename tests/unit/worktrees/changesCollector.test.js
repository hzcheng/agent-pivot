'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ChangesCollector,
    aggregateMemberChanges,
    classifyPorcelainXY,
    parsePorcelainZ,
} = require('../../../out/worktrees/changesCollector');

const BASELINE = {
    commitSha: 'a'.repeat(40),
    capturedAt: 1724000000000,
    source: { kind: 'branch', fullRef: 'refs/heads/main' },
};

test('WORKTREE-CHANGES-COLLECT-001 classifies porcelain XY pairs like Source Control', () => {
    assert.deepEqual(classifyPorcelainXY('?', '?'), ['untracked']);
    assert.deepEqual(classifyPorcelainXY('M', ' '), ['staged']);
    assert.deepEqual(classifyPorcelainXY(' ', 'M'), ['changes']);
    assert.deepEqual(classifyPorcelainXY('M', 'M'), ['staged', 'changes'],
        'staged + modified-again counts as two SCM resource rows');
    assert.deepEqual(classifyPorcelainXY('A', ' '), ['staged']);
    assert.deepEqual(classifyPorcelainXY(' ', 'D'), ['changes']);
    assert.deepEqual(classifyPorcelainXY('U', 'U'), ['merge']);
    assert.deepEqual(classifyPorcelainXY('A', 'A'), ['merge']);
    assert.deepEqual(classifyPorcelainXY('!', '!'), [],
        'ignored entries never surface');
});

test('WORKTREE-CHANGES-COLLECT-001 parses -z output with spaces, newlines, and renames', () => {
    const input = [
        'M  staged.ts',
        ' M unstaged file.ts',
        'MM both.ts',
        '?? new file.ts',
        'R  new name.ts\0old name.ts',
        ' M line\nbreak.ts',
    ].join('\0') + '\0';
    const entries = parsePorcelainZ(input);
    assert.deepEqual(entries, [
        { xy: 'M ', path: 'staged.ts' },
        { xy: ' M', path: 'unstaged file.ts' },
        { xy: 'MM', path: 'both.ts' },
        { xy: '??', path: 'new file.ts' },
        { xy: 'R ', path: 'new name.ts', originalPath: 'old name.ts' },
        { xy: ' M', path: 'line\nbreak.ts' },
    ]);
});

function collectorWith(handlers) {
    return new ChangesCollector({
        execGit: async args => {
            for (const [marker, handler] of handlers) {
                if (args.includes(marker)) {
                    const value = typeof handler === 'function'
                        ? handler(args) : handler;
                    if (value instanceof Error) {
                        throw value;
                    }
                    return { stdout: value, stderr: '' };
                }
            }
            return { stdout: '', stderr: '' };
        },
        now: () => 1724000000000,
    });
}

test('WORKTREE-CHANGES-COLLECT-001 collects working groups and the ahead count', async () => {
    const collector = collectorWith([
        ['status', 'M  a.ts\0 M b.ts\0?? c.ts\0'],
        ['merge-base', ''],
        ['rev-list', '3\n'],
    ]);
    const snapshot = await collector.collect('/worktrees/task', BASELINE);
    assert.equal(snapshot.availability, 'available');
    assert.equal(snapshot.aheadCount, 3);
    assert.equal(snapshot.workingItemCount, 3);
    assert.deepEqual(snapshot.workingItems.map(item => item.group),
        ['staged', 'changes', 'untracked']);
    assert.equal(snapshot.collectedAt, 1724000000000);
});

test('WORKTREE-CHANGES-COLLECT-001 untracked are always collected (SCM-config independent)', async () => {
    const seenArgs = [];
    const collector = new ChangesCollector({
        execGit: async args => {
            seenArgs.push(args);
            return { stdout: '', stderr: '' };
        },
    });
    await collector.collect('/worktrees/task', BASELINE);
    const statusArgs = seenArgs.find(args => args.includes('status'));
    assert.ok(statusArgs.includes('--untracked-files=all'),
        'untracked files are always collected, ignoring git.untrackedChanges');
    assert.ok(statusArgs.includes('-z'));
});

test('WORKTREE-CHANGES-COLLECT-001 git failure degrades to unreadable, never throws', async () => {
    const collector = collectorWith([
        ['status', new Error('not a git repository')],
    ]);
    const snapshot = await collector.collect('/gone', BASELINE);
    assert.equal(snapshot.availability, 'unreadable');
    assert.equal(snapshot.workingItemCount, 0);
    assert.equal(snapshot.aheadCount, undefined,
        'unknown is never reported as zero');
});

test('WORKTREE-CHANGES-COLLECT-001 missing baseline and rewritten history degrade explicitly', async () => {
    const noBaseline = collectorWith([['status', ''], ['merge-base', '']]);
    const adopted = await noBaseline.collect('/worktrees/task');
    assert.equal(adopted.availability, 'baselineUnavailable');
    assert.equal(adopted.aheadCount, undefined);

    const rewritten = collectorWith([
        ['status', ''],
        ['merge-base', new Error('exit 1')],
    ]);
    const rebased = await rewritten.collect('/worktrees/task', BASELINE);
    assert.equal(rebased.availability, 'historyRewritten');
    assert.equal(rebased.aheadCount, undefined,
        'a rewritten history never shows a made-up ahead count');
});

test('WORKTREE-CHANGES-COLLECT-001 aggregate completeness marks partial state explicitly', () => {
    const available = {
        availability: 'available', workingItems: [], workingItemCount: 3,
        truncated: false, aheadCount: 2, collectedAt: 1,
    };
    const clean = {
        availability: 'available', workingItems: [], workingItemCount: 0,
        truncated: false, aheadCount: 0, collectedAt: 1,
    };
    const noBaseline = {
        availability: 'baselineUnavailable', workingItems: [],
        workingItemCount: 1, truncated: false, collectedAt: 1,
    };
    const unreadable = {
        availability: 'unreadable', workingItems: [], workingItemCount: 0,
        truncated: false, collectedAt: 1,
    };

    assert.deepEqual(aggregateMemberChanges([available, clean]), {
        completeness: 'complete', workingItemCount: 3, workingPartial: false,
        aheadCount: 2, aheadPartial: false, allUnreadable: false,
    });
    const partial = aggregateMemberChanges([available, noBaseline]);
    assert.equal(partial.completeness, 'partial');
    assert.equal(partial.aheadCount, 2);
    assert.equal(partial.aheadPartial, true, 'UI renders ↑? — never ↑0');
    assert.equal(partial.workingItemCount, 4);

    const partialWorking = aggregateMemberChanges([available, unreadable]);
    assert.equal(partialWorking.workingPartial, true, 'UI renders 3+');
    assert.equal(partialWorking.completeness, 'partial');

    const allGone = aggregateMemberChanges([unreadable]);
    assert.equal(allGone.completeness, 'unavailable');
    assert.equal(allGone.allUnreadable, true);

    const baselineless = aggregateMemberChanges([noBaseline]);
    assert.equal(baselineless.aheadCount, undefined);
    assert.equal(baselineless.aheadPartial, true, 'UI renders ↑—');
});
