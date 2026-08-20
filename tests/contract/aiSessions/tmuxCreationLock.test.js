'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { withTmuxCreationLock } = require('../../../out/aiSessions/tmuxCreationLock');

test('RUNTIME-FILESYSTEM-MUTATION-LOCK-001 recovers a stale zero-byte unpublished claim', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-lock-recovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const key = 'runtime-binding-final-records';
    const digest = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
    const lockPath = path.join(root, 'ai-session-tmux-locks', `${digest}.lock`);
    const heldPath = path.join(lockPath, 'held');
    const claimPath = path.join(heldPath, `${'a'.repeat(64)}.claim`);
    fs.mkdirSync(heldPath, { recursive: true });
    fs.writeFileSync(claimPath, '');
    const staleTime = new Date(Date.now() - 31_000);
    fs.utimesSync(claimPath, staleTime, staleTime);
    fs.utimesSync(heldPath, staleTime, staleTime);

    let entered = false;
    await withTmuxCreationLock(root, key, async () => {
        entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(claimPath), false);
    assert.equal(fs.existsSync(heldPath), false);
    assert.equal(fs.lstatSync(lockPath).isDirectory(), true);
});
