'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { withTmuxCreationLock } = require('../../../out/aiSessions/tmuxCreationLock');

function createStaleZeroByteClaim(t, key) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-lock-recovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const digest = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
    const lockPath = path.join(root, 'ai-session-tmux-locks', `${digest}.lock`);
    const heldPath = path.join(lockPath, 'held');
    const claimPath = path.join(heldPath, `${'a'.repeat(64)}.claim`);
    fs.mkdirSync(heldPath, { recursive: true });
    fs.writeFileSync(claimPath, '');
    const staleTime = new Date(Date.now() - 31_000);
    fs.utimesSync(claimPath, staleTime, staleTime);
    fs.utimesSync(heldPath, staleTime, staleTime);
    return { root, lockPath, heldPath, claimPath };
}

test('RUNTIME-FILESYSTEM-MUTATION-LOCK-001 recovers a stale zero-byte unpublished claim', async t => {
    const { root, lockPath, heldPath, claimPath } = createStaleZeroByteClaim(
        t, 'runtime-binding-final-records'
    );

    let entered = false;
    await withTmuxCreationLock(root, 'runtime-binding-final-records', async () => {
        entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(claimPath), false);
    assert.equal(fs.existsSync(heldPath), false);
    assert.equal(fs.lstatSync(lockPath).isDirectory(), true);
});

test('RUNTIME-FILESYSTEM-MUTATION-LOCK-001 retries a transient missing claim during stale inspection', async t => {
    const key = 'transient-missing-stale-claim';
    const { root, claimPath } = createStaleZeroByteClaim(t, key);
    const originalLstat = fs.promises.lstat;
    let claimInspections = 0;
    fs.promises.lstat = async target => {
        if (target === claimPath && ++claimInspections === 2) {
            const error = new Error('claim disappeared during inspection');
            error.code = 'ENOENT';
            throw error;
        }
        return originalLstat.call(fs.promises, target);
    };

    let entered = false;
    try {
        await withTmuxCreationLock(root, key, async () => {
            entered = true;
        });
    } finally {
        fs.promises.lstat = originalLstat;
    }

    assert.equal(entered, true);
    assert.ok(claimInspections >= 4);
});

test('RUNTIME-FILESYSTEM-MUTATION-LOCK-001 propagates an unexpected stale-claim inspection error', async t => {
    const key = 'stale-claim-inspection-error';
    const { root, claimPath } = createStaleZeroByteClaim(t, key);
    const originalLstat = fs.promises.lstat;
    const expected = new Error('claim inspection denied');
    expected.code = 'EACCES';
    let claimInspections = 0;
    fs.promises.lstat = async target => {
        if (target === claimPath && ++claimInspections === 2) {
            throw expected;
        }
        return originalLstat.call(fs.promises, target);
    };

    let entered = false;
    try {
        await assert.rejects(
            withTmuxCreationLock(root, key, async () => {
                entered = true;
            }),
            error => error === expected
        );
    } finally {
        fs.promises.lstat = originalLstat;
    }

    assert.equal(entered, false);
});
