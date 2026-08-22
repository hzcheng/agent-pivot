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

const HEAD_SHA = 'c'.repeat(40);
const UPSTREAM_SHA = 'd'.repeat(40);

function trackingCollector(tracking) {
    const seen = [];
    const collector = new ChangesCollector({
        execGit: async args => {
            seen.push(args);
            if (args.includes('symbolic-ref')) {
                const value = tracking.symbolicRef ?? 'refs/heads/fix-x\n';
                if (value instanceof Error) { throw value; }
                return { stdout: value, stderr: '' };
            }
            if (args.includes('for-each-ref')) {
                const value = tracking.forEachRef ?? '';
                if (value instanceof Error) { throw value; }
                return { stdout: value, stderr: '' };
            }
            if (args.includes('rev-parse')) {
                const value = tracking.revParse ?? `${HEAD_SHA}\n`;
                if (value instanceof Error) { throw value; }
                return { stdout: value, stderr: '' };
            }
            if (args.includes('--left-right')) {
                const value = tracking.revList ?? '0\t0\n';
                if (value instanceof Error) { throw value; }
                return { stdout: value, stderr: '' };
            }
            return { stdout: '', stderr: '' };
        },
        now: () => 1724000000000,
    });
    return { collector, seen };
}

test('WORKTREE-CHANGES-COLLECT-001 collects headSha and a tracked upstream in four processes', async () => {
    const { collector, seen } = trackingCollector({
        forEachRef: 'refs/remotes/origin/fix-x\n',
        revParse: `${HEAD_SHA}\n${UPSTREAM_SHA}\n`,
        revList: '2\t3\n',
    });
    // No baseline: tracking collection is independent of it (PRD §14.1).
    const snapshot = await collector.collect('/worktrees/task');
    assert.equal(snapshot.availability, 'baselineUnavailable');
    assert.equal(snapshot.headSha, HEAD_SHA);
    assert.deepEqual(snapshot.upstream, {
        status: 'tracked',
        fullRef: 'refs/remotes/origin/fix-x',
        sha: UPSTREAM_SHA,
        ahead: 3,
        behind: 2,
    }, 'rev-list --left-right --count: left = behind, right = ahead');
    const trackingCalls = seen.filter(args => !args.includes('status'));
    assert.equal(trackingCalls.length, 4,
        'at most four extra git processes per member (PRD §14.1)');
    const revParse = trackingCalls.find(args => args.includes('rev-parse'));
    assert.deepEqual(
        revParse.slice(revParse.indexOf('rev-parse') + 1),
        ['HEAD', 'refs/remotes/origin/fix-x'],
        'one rev-parse process resolves both shas');
    const counts = trackingCalls.find(args => args.includes('--left-right'));
    assert.equal(counts[counts.length - 1],
        `${UPSTREAM_SHA}...${HEAD_SHA}`,
        'fork counts use the frozen shas they are published with');
});

test('WORKTREE-CHANGES-COLLECT-001 no tracking branch is an explicit none, headSha stays', async () => {
    const { collector, seen } = trackingCollector({
        symbolicRef: 'refs/heads/local-only\n',
        forEachRef: '',
    });
    const snapshot = await collector.collect('/worktrees/task', BASELINE);
    assert.deepEqual(snapshot.upstream, { status: 'none' },
        'a successful but empty upstream query is a fact, not a failure');
    assert.equal(snapshot.headSha, HEAD_SHA);
    assert.ok(!seen.some(args => args.includes('--left-right')),
        'no upstream means no fork-count process');
});

test('WORKTREE-CHANGES-COLLECT-001 detached HEAD reports none via the quiet exit 1', async () => {
    const detached = Object.assign(new Error('exit 1'), { code: 1 });
    const { collector } = trackingCollector({ symbolicRef: detached });
    const snapshot = await collector.collect('/worktrees/task', BASELINE);
    assert.deepEqual(snapshot.upstream, { status: 'none' });
    assert.equal(snapshot.headSha, HEAD_SHA,
        'a detached worktree still has a HEAD');
});

test('WORKTREE-CHANGES-COLLECT-001 tracking failures degrade to unknown, never to zero', async () => {
    // symbolic-ref itself fails (not the quiet detached exit).
    const brokenRef = trackingCollector({
        symbolicRef: Object.assign(new Error('fatal'), { code: 128 }),
    });
    const fromRef = await brokenRef.collector.collect('/worktrees/task', BASELINE);
    assert.deepEqual(fromRef.upstream, { status: 'unknown' });
    assert.equal(fromRef.headSha, HEAD_SHA,
        'headSha collection is independent of the upstream chain');

    // for-each-ref fails / times out.
    const brokenQuery = trackingCollector({ forEachRef: new Error('timeout') });
    const fromQuery = await brokenQuery.collector.collect('/worktrees/task', BASELINE);
    assert.deepEqual(fromQuery.upstream, { status: 'unknown' });

    // rev-parse fails after an upstream ref was found.
    const brokenShas = trackingCollector({
        forEachRef: 'refs/remotes/origin/fix-x\n',
        revParse: new Error('fatal'),
    });
    const fromShas = await brokenShas.collector.collect('/worktrees/task', BASELINE);
    assert.deepEqual(fromShas.upstream, { status: 'unknown' });
    assert.equal(fromShas.headSha, undefined);

    // rev-list fails, or answers garbage — unknown is never faked as 0/0.
    const brokenCount = trackingCollector({
        forEachRef: 'refs/remotes/origin/fix-x\n',
        revParse: `${HEAD_SHA}\n${UPSTREAM_SHA}\n`,
        revList: new Error('fatal'),
    });
    const fromCount = await brokenCount.collector.collect('/worktrees/task', BASELINE);
    assert.deepEqual(fromCount.upstream, { status: 'unknown' });

    const garbageCount = trackingCollector({
        forEachRef: 'refs/remotes/origin/fix-x\n',
        revParse: `${HEAD_SHA}\n${UPSTREAM_SHA}\n`,
        revList: 'not-a-count\n',
    });
    const fromGarbage = await garbageCount.collector.collect('/worktrees/task', BASELINE);
    assert.deepEqual(fromGarbage.upstream, { status: 'unknown' });
});

test('WORKTREE-CHANGES-COLLECT-001 unreadable members omit headSha and upstream entirely', async () => {
    const collector = collectorWith([
        ['status', new Error('not a git repository')],
    ]);
    const snapshot = await collector.collect('/gone', BASELINE);
    assert.equal(snapshot.availability, 'unreadable');
    assert.ok(!('headSha' in snapshot), 'no made-up HEAD');
    assert.ok(!('upstream' in snapshot), 'no made-up tracking state');
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
