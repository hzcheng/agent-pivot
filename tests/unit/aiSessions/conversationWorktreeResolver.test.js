'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    ConversationWorktreeResolver,
} = require('../../../out/aiSessions/conversation/worktreeResolver');

// Hermetic git setup: identity comes from -c flags, and every command runs
// with an empty HOME so global or system config can never leak in.
function git(cwd, args, env = {}) {
    return childProcess.execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            HOME: env.home || '/nonexistent-home',
            GIT_CONFIG_NOSYSTEM: '1',
            XDG_CONFIG_HOME: '/nonexistent-xdg',
            ...env.extra,
        },
    }).trim();
}

function gitCommit(cwd, args) {
    return git(cwd, [
        '-c', 'user.name=Agent Pivot Tests',
        '-c', 'user.email=tests@example.invalid',
        ...args,
    ]);
}

async function createRepo(t) {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-worktree-resolver-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    await fs.promises.mkdir(repo);
    git(repo, ['init', '-b', 'main']);
    await fs.promises.writeFile(path.join(repo, 'README.md'), 'demo\n');
    gitCommit(repo, ['add', 'README.md']);
    gitCommit(repo, ['commit', '-m', 'initial']);
    return { root, repo };
}

test('ARCH-SESSION-WORKTREE-001 resolves the main checkout, linked worktrees, and detached HEAD', async t => {
    const { repo, root } = await createRepo(t);
    const resolver = new ConversationWorktreeResolver({ now: Date.now });

    const main = await resolver.resolve(path.join(repo));
    assert.deepEqual(main, {
        branch: 'main',
        worktreeRoot: repo,
        repoRoot: repo,
    });

    const linked = path.join(root, 'feature-x');
    git(repo, ['worktree', 'add', '-b', 'feature/x', linked]);
    const missingDir = path.join(linked, 'missing-dir');
    const worktree = await resolver.resolve(missingDir);
    assert.equal(worktree, undefined, 'missing directories do not resolve');
    const nested = path.join(linked, 'sub', 'dir');
    await fs.promises.mkdir(nested, { recursive: true });
    const linkedInfo = await resolver.resolve(nested);
    assert.deepEqual(linkedInfo, {
        branch: 'feature/x',
        worktreeRoot: linked,
        repoRoot: repo,
    });

    git(linked, ['checkout', '--detach', 'HEAD']);
    const detached = await resolver.resolve(linked);
    assert.match(detached.branch, /^[0-9a-f]{7}$/);
    assert.equal(detached.worktreeRoot, linked);
    assert.equal(detached.repoRoot, repo);

    const plain = path.join(root, 'plain');
    await fs.promises.mkdir(plain);
    assert.equal(await resolver.resolve(plain), undefined);
});

test('ARCH-SESSION-WORKTREE-001 caches resolutions briefly and rejects non-absolute paths', async t => {
    const { repo } = await createRepo(t);
    let gitCalls = 0;
    const resolver = new ConversationWorktreeResolver({
        now: Date.now,
        execGit: (args, cwd) => new Promise((resolve, reject) => {
            gitCalls += 1;
            childProcess.execFile(
                'git',
                args,
                { cwd, timeout: 5000 },
                (error, stdout, stderr) =>
                    error ? reject(error) : resolve({ stdout, stderr })
            );
        }),
        cacheTtlMs: 60_000,
    });

    assert.equal(await resolver.resolve('relative/path'), undefined);
    assert.equal(gitCalls, 0);
    const first = await resolver.resolve(repo);
    const second = await resolver.resolve(repo);
    assert.deepEqual(second, first);
    assert.equal(gitCalls, 1, 'the second resolve hits the cache');
});

test('ARCH-SESSION-WORKTREE-001 resolveKey returns the manifest-compatible WorktreeKey', async t => {
    const { repo } = await createRepo(t);
    const resolver = new ConversationWorktreeResolver({ now: Date.now });

    const key = await resolver.resolveKey(repo);
    assert.deepEqual(key, {
        repositoryKey: await fs.promises.realpath(path.join(repo, '.git')),
        canonicalWorktreePath: await fs.promises.realpath(repo),
    }, 'repositoryKey is the canonical common git dir — never dirname(commonDir)');

    // Linked worktree: the common dir still points at the main checkout's
    // .git, while the worktree path is the linked root.
    const linked = path.join(path.dirname(repo), 'linked');
    git(repo, ['worktree', 'add', '-b', 'linked-branch', linked]);
    const linkedKey = await resolver.resolveKey(linked);
    assert.deepEqual(linkedKey, {
        repositoryKey: await fs.promises.realpath(path.join(repo, '.git')),
        canonicalWorktreePath: await fs.promises.realpath(linked),
    });

    // Missing paths resolve to undefined rather than throwing.
    assert.equal(await resolver.resolveKey(path.join(repo, 'gone')), undefined);
});

test('ARCH-SESSION-WORKTREE-001 resolveKey rejects unusable candidates', async () => {
    const resolver = new ConversationWorktreeResolver({ now: Date.now });
    assert.equal(await resolver.resolveKey('relative/path'), undefined);
    assert.equal(await resolver.resolveKey(''), undefined);
    assert.equal(await resolver.resolveKey(undefined), undefined);
});
