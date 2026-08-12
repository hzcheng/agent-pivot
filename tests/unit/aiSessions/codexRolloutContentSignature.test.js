'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    readCodexRolloutContentSignature,
} = require('../../../out/aiSessions/codexRolloutContentSignature');

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 rollout content signature tracks file size and mtime', async t => {
    const dir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-codex-content-signature-')
    );
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const rolloutPath = path.join(dir, 'rollout.jsonl');

    // A missing rollout degrades to an always-fresh full provider read.
    assert.equal(readCodexRolloutContentSignature(rolloutPath), undefined);
    assert.equal(readCodexRolloutContentSignature(''), undefined);
    assert.equal(readCodexRolloutContentSignature(dir), undefined);

    await fs.promises.writeFile(rolloutPath, '{"type":"session_meta"}\n');
    const first = readCodexRolloutContentSignature(rolloutPath);
    assert.equal(typeof first, 'string');
    const stat = fs.statSync(rolloutPath);
    assert.equal(first, `${stat.size}:${stat.mtimeMs}`);

    // An untouched file keeps its signature stable across probes.
    assert.equal(readCodexRolloutContentSignature(rolloutPath), first);

    // Any append changes the signature, which is what forces the next
    // conversation read back to the app server.
    await fs.promises.appendFile(rolloutPath, '{"type":"event_msg"}\n');
    const updated = readCodexRolloutContentSignature(rolloutPath);
    assert.notEqual(updated, first);
});
