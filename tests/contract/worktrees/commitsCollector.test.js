'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    CommitsCollector,
} = require('../../../out/worktrees/commitsCollector');

function git(cwd, args) {
    return childProcess.execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

async function repositoryFixture(t) {
    const sandbox = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-commits-'));
    const repo = path.join(sandbox, 'repository');
    await fs.promises.mkdir(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Agent Pivot Tests']);
    git(repo, ['config', 'user.email', 'tests@example.invalid']);
    // Git may launch maintenance after a burst of fixture commits. Keep the
    // repository self-contained so its after hook never races a background
    // writer while removing .git/info.
    git(repo, ['config', 'gc.auto', '0']);
    git(repo, ['config', 'maintenance.auto', 'false']);
    t.after(async () =>
        fs.promises.rm(sandbox, { recursive: true, force: true }));
    return { sandbox, repo };
}

function commitFile(repo, name, content, message) {
    fs.writeFileSync(path.join(repo, name), content);
    git(repo, ['add', name]);
    git(repo, ['commit', '-m', message, '-q']);
}

test('WORKTREE-CHANGES-COMMITS-001 pages a real history and closes with the baseline row', async t => {
    const { repo } = await repositoryFixture(t);
    commitFile(repo, 'base.ts', 'base\n', 'base commit');
    const baseline = git(repo, ['rev-parse', 'HEAD']);
    for (let index = 0; index < 53; index += 1) {
        commitFile(repo, `f${index}.ts`, `${index}\n`, `commit ${index}`);
    }
    const head = git(repo, ['rev-parse', 'HEAD']);

    const collector = new CommitsCollector();
    const first = await collector.list(repo,
        { scope: 'since-start', offset: 0 }, baseline);
    assert.equal(first.historyHead, head);
    assert.equal(first.commits.length, 50);
    assert.equal(first.hasMore, true);
    assert.equal(first.sectionComplete, undefined);
    assert.equal(first.baselineRow, undefined,
        'the closing row never renders mid-pagination');

    const last = await collector.list(repo, {
        scope: 'since-start', offset: 50, historyHead: first.historyHead,
    }, baseline);
    assert.equal(last.commits.length, 3);
    assert.equal(last.hasMore, false);
    assert.equal(last.sectionComplete, true);
    assert.deepEqual(last.baselineRow,
        { sha: baseline, subject: 'base commit' });

    // Newest first, and the two pages partition the range exactly.
    const subjects = [...first.commits, ...last.commits]
        .map(commit => commit.subject);
    assert.deepEqual(subjects, Array.from({ length: 53 },
        (_unused, index) => `commit ${52 - index}`));
});

test('WORKTREE-CHANGES-COMMITS-001 a commit landing mid-pagination moves the frozen head', async t => {
    const { repo } = await repositoryFixture(t);
    commitFile(repo, 'base.ts', 'base\n', 'base commit');
    const baseline = git(repo, ['rev-parse', 'HEAD']);
    commitFile(repo, 'one.ts', '1\n', 'one');

    const collector = new CommitsCollector();
    const first = await collector.list(repo,
        { scope: 'since-start', offset: 0 }, baseline);
    commitFile(repo, 'two.ts', '2\n', 'two');
    const stale = await collector.list(repo, {
        scope: 'since-start', offset: 0, historyHead: first.historyHead,
    }, baseline);
    assert.equal(stale.degraded, 'history-moved');
    assert.equal(stale.historyHead, git(repo, ['rev-parse', 'HEAD']));
});

test('WORKTREE-CHANGES-COMMITS-001 the full scope continues from the baseline ancestors', async t => {
    const { repo } = await repositoryFixture(t);
    commitFile(repo, 'old.ts', 'old\n', 'old commit');
    commitFile(repo, 'base.ts', 'base\n', 'base commit');
    const baseline = git(repo, ['rev-parse', 'HEAD']);
    commitFile(repo, 'new.ts', 'new\n', 'new commit');

    const collector = new CommitsCollector();
    const result = await collector.list(repo,
        { scope: 'full', offset: 0 }, baseline);
    assert.deepEqual(result.commits.map(commit => commit.subject),
        ['base commit', 'old commit'],
        'the Earlier section starts at the baseline itself — the webview '
            + 'dedupes the rendered closing row by sha');
});

test('WORKTREE-CHANGES-COMMITS-001 detail reports merge, rename, and binary rows against real diffs', async t => {
    const { repo } = await repositoryFixture(t);
    fs.writeFileSync(path.join(repo, 'image.png'), Buffer.from([0, 1, 2]));
    git(repo, ['add', 'image.png']);
    commitFile(repo, 'text.ts', 'one\n', 'initial');

    // Rename with full similarity so -M detects it.
    git(repo, ['mv', 'text.ts', 'renamed.ts']);
    git(repo, ['commit', '-m', 'rename', '-q']);
    const renameSha = git(repo, ['rev-parse', 'HEAD']);

    // Merge commit: a side branch adds a file, main advances, merge.
    git(repo, ['checkout', '-q', '-b', 'side', 'HEAD~1']);
    commitFile(repo, 'side.ts', 'side\n', 'side change');
    git(repo, ['checkout', '-q', 'main']);
    commitFile(repo, 'main.ts', 'main\n', 'main change');
    git(repo, ['merge', '--no-ff', '-m', 'merge side', 'side', '-q']);
    const mergeSha = git(repo, ['rev-parse', 'HEAD']);

    const collector = new CommitsCollector();
    const rename = await collector.detail(repo, renameSha);
    assert.deepEqual(rename.files, [{
        path: 'renamed.ts', oldPath: 'text.ts', status: 'R',
        additions: 0, deletions: 0,
    }], 'rename stays one row with oldPath first');

    const merge = await collector.detail(repo, mergeSha);
    assert.equal(merge.parentSha, git(repo, ['rev-parse', 'HEAD^1']));
    assert.deepEqual(merge.files.map(file => file.path), ['side.ts'],
        'a merge diffs against the first parent only');

    const initial = await collector.detail(repo,
        git(repo, ['rev-list', '--max-parents=0', 'HEAD']));
    assert.equal(initial.parentSha, undefined, 'root commit has no parent');
    const image = initial.files.find(file => file.path === 'image.png');
    assert.ok(image, 'the root commit lists the binary file');
    assert.equal(image.additions, undefined,
        'binary numstat keeps counts absent');
});
