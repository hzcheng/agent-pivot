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
