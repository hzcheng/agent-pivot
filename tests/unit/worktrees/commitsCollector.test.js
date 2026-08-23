'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    CommitsCollector,
    parseNameStatusZ,
    parseNumstatZ,
} = require('../../../out/worktrees/commitsCollector');

const HEAD = 'f'.repeat(40);
const BASE = 'a'.repeat(40);
const UPSTREAM = 'b'.repeat(40);
const C1 = 'c'.repeat(40);
const C2 = 'd'.repeat(40);

function commitRow(sha, subject, author, time) {
    return `${sha}\x00${subject}\x00${author}\x00${time}`;
}

/**
 * Scriptable execGit: handlers match by a predicate on the arg list and
 * answer in order; unmatched commands fail the test loudly.
 */
function scriptGit(routes) {
    const calls = [];
    const execGit = async args => {
        calls.push(args);
        for (const [predicate, answer] of routes) {
            if (predicate(args)) {
                if (answer instanceof Error) {
                    throw answer;
                }
                return { stdout: answer, stderr: '' };
            }
        }
        throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    };
    return { calls, execGit };
}

const has = (...flags) => args => flags.every(flag => args.includes(flag));

test('WORKTREE-CHANGES-COMMITS-001 lists the since-start page over baseline..historyHead', async () => {
    const { calls, execGit } = scriptGit([
        [has('rev-parse'), `${HEAD}\n`],
        [has('log', '-1'), new Error('no subject scripted')],
        [has('log'), [commitRow(C1, 'fix: race', 'hz', 1724000000),
            commitRow(C2, 'chore: tidy', 'hz', 1723990000)].join('\n') + '\n'],
    ]);
    const collector = new CommitsCollector({ execGit });
    const result = await collector.list('/wt',
        { scope: 'since-start', offset: 0 }, BASE);
    assert.equal(result.historyHead, HEAD);
    assert.equal(result.hasMore, false);
    assert.equal(result.sectionComplete, true,
        'an exhausted since-start page closes the section');
    assert.deepEqual(result.baselineRow, { sha: BASE },
        'no baseline subject was scripted, so the row carries only the sha');
    assert.equal(result.commits.length, 2);
    assert.equal(result.commits[0].sha, C1);
    assert.equal(result.commits[0].subject, 'fix: race');
    assert.equal(result.commits[0].authorTime, 1724000000);
    assert.equal(result.commits[0].inTrackingBranch, undefined,
        'no upstream ⇒ no row badge (PRD §15.5.2)');
    const logArgs = calls.find(args => args.includes('log'));
    assert.ok(logArgs.includes(`${BASE}..${HEAD}`),
        'since-start ranges baseline..historyHead');
    assert.ok(logArgs.includes('--max-count=51'), 'page size 50 + 1 probe');
    assert.ok(logArgs.includes('--skip=0'));
});

test('WORKTREE-CHANGES-COMMITS-001 pages with max-count probe and defers the baseline row', async () => {
    const rows = Array.from({ length: 51 }, (_unused, index) =>
        commitRow(String(index).padStart(40, '1'), `c${index}`, 'hz', 1));
    const { execGit } = scriptGit([
        [has('rev-parse'), `${HEAD}\n`],
        [has('log'), rows.join('\n') + '\n'],
    ]);
    const collector = new CommitsCollector({ execGit });
    const result = await collector.list('/wt',
        { scope: 'since-start', offset: 0 }, BASE);
    assert.equal(result.hasMore, true);
    assert.equal(result.commits.length, 50);
    assert.equal(result.sectionComplete, undefined,
        'mid-pagination never claims the boundary (PRD §15.5.6)');
    assert.equal(result.baselineRow, undefined);
});

test('WORKTREE-CHANGES-COMMITS-001 a mismatched echoed historyHead reports history-moved', async () => {
    const { calls, execGit } = scriptGit([
        [has('rev-parse'), `${HEAD}\n`],
    ]);
    const collector = new CommitsCollector({ execGit });
    const result = await collector.list('/wt', {
        scope: 'since-start', offset: 50, historyHead: 'e'.repeat(40),
    }, BASE);
    assert.equal(result.degraded, 'history-moved');
    assert.equal(result.historyHead, HEAD);
    assert.equal(result.commits.length, 0);
    assert.ok(!calls.some(args => args.includes('log')),
        'no list command runs once the frozen head is stale');
});

test('WORKTREE-CHANGES-COMMITS-001 the full scope pages the baseline ancestors directly', async () => {
    const { calls, execGit } = scriptGit([
        [has('rev-parse'), `${HEAD}\n`],
        [has('log'), commitRow(BASE, 'main: merged #241', 'hz', 1) + '\n'],
    ]);
    const collector = new CommitsCollector({ execGit });
    const result = await collector.list('/wt',
        { scope: 'full', offset: 0, historyHead: HEAD }, BASE);
    const logArgs = calls.find(args => args.includes('log'));
    assert.ok(logArgs.includes(BASE), 'full range starts at the baseline');
    assert.ok(!logArgs.includes(`${BASE}..${HEAD}`),
        'never pages from HEAD for the Earlier section');
    assert.equal(result.sectionComplete, undefined,
        'no synthetic Since-start boundary on the full scope');
    assert.equal(result.baselineRow, undefined);
});

test('WORKTREE-CHANGES-COMMITS-001 a missing baseline degrades to the single history stream', async () => {
    const { calls, execGit } = scriptGit([
        [has('rev-parse'), `${HEAD}\n`],
        [has('log'), commitRow(C1, 'only', 'hz', 1) + '\n'],
    ]);
    const collector = new CommitsCollector({ execGit });
    const result = await collector.list('/wt',
        { scope: 'since-start', offset: 0 }, undefined);
    const logArgs = calls.find(args => args.includes('log'));
    assert.ok(logArgs.includes(HEAD) && !logArgs.some(arg =>
        arg.includes('..')), 'single stream ranges over the frozen head');
    assert.equal(result.sectionComplete, undefined,
        'no fabricated boundary without a baseline');
    assert.equal(result.baselineRow, undefined);
});

test('WORKTREE-CHANGES-COMMITS-001 backfills inTrackingBranch against the frozen upstream sha', async () => {
    const { calls, execGit } = scriptGit([
        [has('rev-parse'), `${HEAD}\n`],
        [args => args.includes('log') && !args.includes('-1'),
            commitRow(C1, 'pushed', 'hz', 1) + '\n'
                + commitRow(C2, 'local', 'hz', 2)],
        [has('rev-list'), `${C2}\n`],
        [has('-1'), 'main: merged #241\n'],
    ]);
    const collector = new CommitsCollector({ execGit });
    const result = await collector.list('/wt',
        { scope: 'since-start', offset: 0 }, BASE, UPSTREAM);
    assert.equal(result.commits[0].inTrackingBranch, true);
    assert.equal(result.commits[1].inTrackingBranch, false);
    const revList = calls.find(args => args.includes('rev-list'));
    assert.ok(revList.includes(`${UPSTREAM}..${HEAD}`),
        'the badge set diffs the frozen upstream against the frozen head');
    assert.deepEqual(result.baselineRow,
        { sha: BASE, subject: 'main: merged #241' },
        'the closing row carries the collected baseline subject');
});

test('WORKTREE-CHANGES-COMMITS-001 a badge-collection failure drops badges, not the page', async () => {
    const { execGit } = scriptGit([
        [has('rev-parse'), `${HEAD}\n`],
        [has('log'), commitRow(C1, 'pushed', 'hz', 1) + '\n'],
        [has('rev-list'), new Error('refs gone')],
        [has('-1'), 'subject\n'],
    ]);
    const collector = new CommitsCollector({ execGit });
    const result = await collector.list('/wt',
        { scope: 'since-start', offset: 0 }, BASE, UPSTREAM);
    assert.equal(result.degraded, undefined);
    assert.equal(result.commits[0].inTrackingBranch, undefined);
});

test('WORKTREE-CHANGES-COMMITS-001 git failures degrade; a killed process reports timeout', async () => {
    const killed = new Error('timed out');
    killed.killed = true;
    killed.signal = 'SIGTERM';
    const timeoutCollector = new CommitsCollector({
        execGit: scriptGit([[has('rev-parse'), killed]]).execGit,
    });
    const timeout = await timeoutCollector.list('/wt',
        { scope: 'since-start', offset: 0 }, BASE);
    assert.equal(timeout.degraded, 'timeout');

    const errorCollector = new CommitsCollector({
        execGit: scriptGit([
            [has('rev-parse'), `${HEAD}\n`],
            [has('log'), new Error('corrupt object')],
        ]).execGit,
    });
    const failure = await errorCollector.list('/wt',
        { scope: 'since-start', offset: 0 }, BASE);
    assert.equal(failure.degraded, 'error');
    assert.equal(failure.commits.length, 0,
        'a failed page is degraded, never an empty list (§14.3)');
});

test('WORKTREE-CHANGES-COMMITS-001 detail joins name-status with numstat per path', async () => {
    const { calls, execGit } = scriptGit([
        [has('cat-file'), ''],
        [has('rev-list'), `${C1} ${BASE}\n`],
        [has('--name-status'), 'M\x00src/a.ts\x00R100\x00src/old.ts\x00src/new.ts\x00'],
        [has('--numstat'), '12\t3\tsrc/a.ts\x004\t1\t\x00src/old.ts\x00src/new.ts\x00'],
    ]);
    const collector = new CommitsCollector({ execGit });
    const detail = await collector.detail('/wt', C1);
    assert.equal(detail.degraded, undefined);
    assert.equal(detail.parentSha, BASE);
    assert.deepEqual(detail.files, [
        { path: 'src/a.ts', status: 'M', additions: 12, deletions: 3 },
        { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'R',
            additions: 4, deletions: 1 },
    ], 'rename keeps old→new order and carries its numstat');
    const diffTree = calls.filter(args => args.includes('diff-tree'));
    assert.equal(diffTree.length, 2, 'two commands: name-status + numstat');
    for (const args of diffTree) {
        assert.ok(args.includes('-M'),
            'plumbing diff-tree needs explicit rename detection');
    }
});

test('WORKTREE-CHANGES-COMMITS-001 detail handles root, merge, and binary rows', async () => {
    const rootGit = scriptGit([
        [has('cat-file'), ''],
        [has('rev-list'), `${C1}\n`],
        [has('--name-status'), 'A\x00README.md\x00'],
        [has('--numstat'), '-\t-\tREADME.md\x00'],
    ]);
    const rootCollector = new CommitsCollector({ execGit: rootGit.execGit });
    const root = await rootCollector.detail('/wt', C1);
    assert.equal(root.parentSha, undefined, 'root commit: no parent side');
    assert.deepEqual(root.files, [{ path: 'README.md', status: 'A' }],
        'binary numstat (-) leaves counts undefined');
    assert.ok(rootGit.calls.find(args => args.includes('diff-tree'))
        .includes('--root'));

    const mergeGit = scriptGit([
        [has('cat-file'), ''],
        [has('rev-list'), `${C1} ${BASE} ${UPSTREAM}\n`],
        [has('--name-status'), 'M\x00src/a.ts\x00'],
        [has('--numstat'), '1\t1\tsrc/a.ts\x00'],
    ]);
    const mergeCollector = new CommitsCollector({
        execGit: mergeGit.execGit,
    });
    const merge = await mergeCollector.detail('/wt', C1);
    assert.equal(merge.parentSha, BASE, 'merge diffs the first parent');
    const mergeDiffTree = mergeGit.calls.find(args =>
        args.includes('diff-tree'));
    assert.ok(!mergeDiffTree.includes('-m'),
        '-m prints one section per parent even with --first-parent');
    const shaIndex = mergeDiffTree.indexOf(C1);
    assert.ok(mergeDiffTree[shaIndex - 1] === BASE,
        'merge detail is an explicit two-tree diff against the first parent');
});

test('WORKTREE-CHANGES-COMMITS-001 detail caps files at 400 and reports the total honestly', async () => {
    const statuses = Array.from({ length: 405 }, (_unused, index) =>
        `M\x00src/f${index}.ts\x00`).join('');
    const stats = Array.from({ length: 405 }, (_unused, index) =>
        `1\t0\tsrc/f${index}.ts\x00`).join('');
    const { execGit } = scriptGit([
        [has('cat-file'), ''],
        [has('rev-list'), `${C1} ${BASE}\n`],
        [has('--name-status'), statuses],
        [has('--numstat'), stats],
    ]);
    const collector = new CommitsCollector({ execGit });
    const detail = await collector.detail('/wt', C1);
    assert.equal(detail.files.length, 400);
    assert.equal(detail.totalFiles, 405);
    assert.equal(detail.filesTruncated, true,
        'Review this commit shares the cap — never implies full coverage');
});

test('WORKTREE-CHANGES-COMMITS-001 detail reports a vanished commit as unknown-commit', async () => {
    const { calls, execGit } = scriptGit([
        [has('cat-file'), new Error('Not a valid object name')],
    ]);
    const collector = new CommitsCollector({ execGit });
    const detail = await collector.detail('/wt', C1);
    assert.equal(detail.degraded, 'unknown-commit');
    assert.ok(!calls.some(args => args.includes('diff-tree')),
        'no diff-tree runs for a rewritten-away commit');
    assert.equal(await collector.commitExists('/wt', 'not-a-sha'), false,
        'malformed shas never reach git');
});

test('WORKTREE-CHANGES-COMMITS-001 parsers bound their inputs', () => {
    assert.deepEqual(parseNameStatusZ('M\x00src/a.ts\x00'), [
        { path: 'src/a.ts', status: 'M' },
    ]);
    // Truncated trailing records are dropped, never half-parsed.
    assert.deepEqual(parseNameStatusZ('R100\x00src/old.ts\x00'), []);
    const stats = parseNumstatZ('5\t2\tsrc/a.ts\x00-\t-\tbin.png\x00');
    assert.deepEqual(stats.get('src/a.ts'), { additions: 5, deletions: 2 });
    assert.deepEqual(stats.get('bin.png'),
        { additions: undefined, deletions: undefined });
});
