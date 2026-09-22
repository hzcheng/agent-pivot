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

function createPreviousBootClaim(t, key, change = {}) {
    const fixture = createStaleZeroByteClaim(t, key);
    const container = fs.lstatSync(fixture.lockPath);
    const held = fs.lstatSync(fixture.heldPath);
    const record = {
        version: 1,
        containerDev: 16777230,
        containerIno: container.ino,
        containerBirthtimeMs: container.birthtimeMs,
        heldDev: 16777230,
        heldIno: held.ino,
        heldBirthtimeMs: held.birthtimeMs,
        ...change,
    };
    fs.writeFileSync(fixture.claimPath, JSON.stringify(record));
    const previousBoot = new Date(Date.now() - 7_200_000);
    fs.utimesSync(fixture.claimPath, previousBoot, previousBoot);
    t.mock.method(os, 'uptime', () => 3600);
    const originalLstat = fs.promises.lstat;
    t.mock.method(fs.promises, 'lstat', async (...args) => {
        const stat = await originalLstat.apply(fs.promises, args);
        // Actual reported reboot: st_dev changed from 16777230 to 16777231.
        if (args[0] === fixture.lockPath || args[0] === fixture.heldPath) {
            stat.dev = 16777231;
        }
        return stat;
    });
    return fixture;
}

test('RUNTIME-FILESYSTEM-MUTATION-LOCK-001 recovers a pre-reboot claim after the device number changes', async t => {
    const key = 'runtime-binding-final-records';
    const { root, claimPath, heldPath } = createPreviousBootClaim(t, key);
    let entered = 0;
    await withTmuxCreationLock(root, key, async () => { entered++; });
    assert.equal(entered, 1);
    assert.equal(fs.existsSync(claimPath), false);
    assert.equal(fs.existsSync(heldPath), false);
    // Subsequent create/resume operations can acquire the same global lock.
    await withTmuxCreationLock(root, key, async () => { entered++; });
    assert.equal(entered, 2);
});

for (const scenario of ['current-boot', 'different-inode', 'different-birthtime', 'different-filesystems']) {
    test(`RUNTIME-FILESYSTEM-MUTATION-LOCK-001 preserves a mismatched ${scenario} claim`, async t => {
        const change = scenario === 'different-inode' ? { heldIno: 1 }
            : scenario === 'different-birthtime' ? { containerBirthtimeMs: 1 }
                : scenario === 'different-filesystems' ? { heldDev: 16777229 } : {};
        const { root, claimPath } = createPreviousBootClaim(t, scenario, change);
        if (scenario === 'current-boot') {
            const staleButCurrentBoot = new Date(Date.now() - 31_000);
            fs.utimesSync(claimPath, staleButCurrentBoot, staleButCurrentBoot);
        }
        const original = fs.readFileSync(claimPath, 'utf8');
        await assert.rejects(withTmuxCreationLock(root, scenario, async () => {
            assert.fail('must not enter a lock with an unproven stale owner');
        }), /Timed out waiting for filesystem mutation lock/);
        assert.equal(fs.readFileSync(claimPath, 'utf8'), original);
    });
}
