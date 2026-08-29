'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    ChangesCollector,
} = require('../../../out/worktrees/changesCollector');

function git(cwd, args) {
    return childProcess.execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

async function repositoryFixture(t) {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-changes-'));
    const repo = path.join(sandbox, 'repository');
    await fs.promises.mkdir(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Agent Pivot Tests']);
    git(repo, ['config', 'user.email', 'tests@example.invalid']);
    await fs.promises.writeFile(path.join(repo, 'README.md'), 'fixture\n');
    await fs.promises.writeFile(path.join(repo, 'tracked.ts'), 'one\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'fixture']);
    t.after(async () => fs.promises.rm(sandbox, { recursive: true, force: true }));
    return { sandbox, repo };
}

async function trackingFixture(t) {
    const sandbox = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-tracking-'));
    const repo = path.join(sandbox, 'repository');
    await fs.promises.mkdir(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Agent Pivot Tests']);
    git(repo, ['config', 'user.email', 'tests@example.invalid']);
    await fs.promises.writeFile(path.join(repo, 'README.md'), 'fixture\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'one']);
    const origin = path.join(sandbox, 'origin.git');
    git(repo, ['init', '--bare', '-b', 'main', origin]);
    git(repo, ['remote', 'add', 'origin', origin]);
    git(repo, ['push', '-u', 'origin', 'main']);
    t.after(async () => fs.promises.rm(sandbox, { recursive: true, force: true }));
    return { sandbox, repo, origin };
}

function commitFile(repo, name, content, message) {
    fs.writeFileSync(path.join(repo, name), content);
    git(repo, ['add', name]);
    git(repo, ['commit', '-m', message, '-q']);
}

test('WORKTREE-CHANGES-COLLECT-001 no tracking branch is none against a real repository', async t => {
    const { repo } = await repositoryFixture(t);
    const snapshot = await new ChangesCollector().collect(repo);
    assert.equal(snapshot.availability, 'baselineUnavailable');
    assert.deepEqual(snapshot.upstream, { status: 'none' });
    assert.match(snapshot.headSha, /^[0-9a-f]{40}$/);
    assert.equal(snapshot.headSha, git(repo, ['rev-parse', 'HEAD']));
});

test('WORKTREE-CHANGES-COLLECT-001 a tracked branch reports sha and diverged ahead/behind', async t => {
    const { sandbox, repo, origin } = await trackingFixture(t);
    const collector = new ChangesCollector();

    const clean = await collector.collect(repo);
    assert.equal(clean.availability, 'baselineUnavailable',
        'tracking collection is independent of the baseline (PRD §14.1)');
    assert.equal(clean.branchName, 'main');
    assert.equal(clean.headSha, git(repo, ['rev-parse', 'HEAD']));
    assert.deepEqual(clean.upstream, {
        status: 'tracked',
        fullRef: 'refs/remotes/origin/main',
        sha: git(repo, ['rev-parse', 'refs/remotes/origin/main']),
        ahead: 0,
        behind: 0,
    });

    // Diverge: two commits reach the remote through a second clone, one
    // local commit stays unpublished — ahead/behind must both be non-zero.
    const other = path.join(sandbox, 'other');
    git(sandbox, ['clone', origin, other]);
    git(other, ['config', 'user.name', 'Agent Pivot Tests']);
    git(other, ['config', 'user.email', 'tests@example.invalid']);
    commitFile(other, 'remote-one.ts', 'r1\n', 'remote one');
    commitFile(other, 'remote-two.ts', 'r2\n', 'remote two');
    git(other, ['push', '-q']);
    commitFile(repo, 'local.ts', 'l1\n', 'local one');
    git(repo, ['fetch', '-q', 'origin']);

    const diverged = await collector.collect(repo);
    assert.deepEqual(diverged.upstream, {
        status: 'tracked',
        fullRef: 'refs/remotes/origin/main',
        sha: git(repo, ['rev-parse', 'refs/remotes/origin/main']),
        ahead: 1,
        behind: 2,
    }, 'rev-list --left-right --count: left = behind, right = ahead');
    assert.equal(diverged.headSha, git(repo, ['rev-parse', 'HEAD']));
});

test('WORKTREE-CHANGES-COLLECT-001 detached HEAD is none with a real headSha', async t => {
    const { repo } = await trackingFixture(t);
    git(repo, ['checkout', '-q', '--detach', 'HEAD']);
    const snapshot = await new ChangesCollector().collect(repo);
    assert.deepEqual(snapshot.upstream, { status: 'none' },
        'symbolic-ref -q exits 1 on a detached HEAD — a fact, not a failure');
    assert.equal(snapshot.headSha, git(repo, ['rev-parse', 'HEAD']));
});

test('WORKTREE-CHANGES-COLLECT-001 reads a real repository end to end', async t => {
    const { repo } = await repositoryFixture(t);
    const baselineSha = git(repo, ['rev-parse', 'HEAD']);
    const baseline = {
        commitSha: baselineSha,
        capturedAt: Date.now(),
        source: { kind: 'branch', fullRef: 'refs/heads/main' },
    };
    const collector = new ChangesCollector();

    const clean = await collector.collect(repo, baseline);
    assert.equal(clean.availability, 'available');
    assert.equal(clean.workingItemCount, 0);
    assert.equal(clean.aheadCount, 0);

    // One commit ahead, then: staged + unstaged-again on the same file, a
    // plain modification, and an untracked file.
    await fs.promises.writeFile(path.join(repo, 'committed.ts'), 'committed\n');
    git(repo, ['add', 'committed.ts']);
    git(repo, ['commit', '-m', 'intermediate', '-q']);
    await fs.promises.writeFile(path.join(repo, 'tracked.ts'), 'two\n');
    git(repo, ['add', 'tracked.ts']);
    await fs.promises.writeFile(path.join(repo, 'tracked.ts'), 'three\n');
    await fs.promises.writeFile(path.join(repo, 'README.md'), 'changed\n');
    await fs.promises.writeFile(path.join(repo, 'brand new.ts'), 'new\n');

    const snapshot = await collector.collect(repo, baseline);
    assert.equal(snapshot.aheadCount, 1);
    const byGroup = group => snapshot.workingItems
        .filter(item => item.group === group)
        .map(item => item.path)
        .sort();
    assert.deepEqual(byGroup('staged'), ['tracked.ts']);
    assert.deepEqual(byGroup('changes'), ['README.md', 'tracked.ts'],
        'tracked.ts is both staged and modified again — two SCM rows');
    assert.deepEqual(byGroup('untracked'), ['brand new.ts']);
    assert.equal(snapshot.workingItemCount, 4);

    // History rewrite: baseline stops being an ancestor.
    git(repo, ['reset', '--hard', baselineSha]);
    git(repo, ['commit', '--allow-empty', '--amend', '-m', 'rewritten', '-q']);
    const unrelated = {
        commitSha: 'b'.repeat(40),
        capturedAt: Date.now(),
        source: { kind: 'commit' },
    };
    const rewritten = await collector.collect(repo, unrelated);
    assert.equal(rewritten.availability, 'historyRewritten');
});

test('WORKTREE-CHANGES-COLLECT-001 task file count unions the tracked diff and untracked files', async t => {
    const { repo } = await repositoryFixture(t);
    const baselineSha = git(repo, ['rev-parse', 'HEAD']);
    const baseline = {
        commitSha: baselineSha,
        capturedAt: Date.now(),
        source: { kind: 'branch', fullRef: 'refs/heads/main' },
    };
    const collector = new ChangesCollector();

    // One committed file ahead, one modified tracked file, and untracked
    // files (an ignored one must stay out).
    await fs.promises.writeFile(path.join(repo, 'committed.ts'), 'committed\n');
    git(repo, ['add', 'committed.ts']);
    git(repo, ['commit', '-m', 'intermediate', '-q']);
    await fs.promises.writeFile(path.join(repo, 'tracked.ts'), 'two\n');
    await fs.promises.writeFile(path.join(repo, 'scratch.txt'), 'untracked\n');
    await fs.promises.writeFile(path.join(repo, '.gitignore'), 'ignored.log\n');
    await fs.promises.writeFile(path.join(repo, 'ignored.log'), 'ignored\n');

    const snapshot = await collector.collect(repo, baseline);
    assert.equal(snapshot.availability, 'available');
    // Tracked diff: committed.ts + tracked.ts = 2; untracked: scratch.txt
    // + .gitignore = 2 (ignored.log excluded); Task result ⊃ Working
    // changes (PRD §4.3) — untracked must join the count.
    assert.equal(snapshot.taskFileCount, 4,
        'task result counts committed + modified + untracked files');
});
