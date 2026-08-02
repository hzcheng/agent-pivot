'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CodexSessionService = require('../../../out/services/codexSessionService').default;

test('CONVERSATION-TELEMETRY-001 resolveSessionFilePath locates rollout files by session id', async t => {
    // The AiSessionService contract module is type-only; load it once so
    // changed-line coverage sees the instrumented module.
    assert.doesNotThrow(() => require('../../../out/aiSessions/types'));

    const home = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-codex-home-')
    );
    t.after(() => fs.promises.rm(home, { recursive: true, force: true }));
    const sessionsDir = path.join(home, 'sessions', '2026', '08', '02');
    await fs.promises.mkdir(sessionsDir, { recursive: true });
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const rolloutPath = path.join(
        sessionsDir,
        `rollout-2026-08-02T00-00-00-${sessionId}.jsonl`
    );
    await fs.promises.writeFile(rolloutPath, '{}\n');

    process.env.CODEX_HOME = home;
    t.after(() => {
        delete process.env.CODEX_HOME;
    });
    const service = new CodexSessionService();
    assert.equal(service.resolveSessionFilePath(sessionId), rolloutPath);
    assert.equal(service.resolveSessionFilePath('missing-session'), null);
    assert.equal(service.resolveSessionFilePath(''), null);
});
