'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const util = require('node:util');

const execFile = util.promisify(childProcess.execFile);
const harnessPath = path.join(__dirname, 'helpers', 'terminalCloseHarness.js');

function harnessEnvironment() {
    return { ...process.env, NODE_V8_COVERAGE: '' };
}

test('ATTENTION-RUNTIME-EXIT-NEUTRAL-001 production process exit creates no attention side effect', async () => {
    await execFile(process.execPath, [harnessPath, 'baseline'], { env: harnessEnvironment() });
});

test('ATTENTION-USER-TERMINAL-CLOSE-001 production user close acknowledges existing attention without completion suppression', async () => {
    await execFile(process.execPath, [harnessPath, 'user-close'], { env: harnessEnvironment() });
});

test('ATTENTION-EXPLICIT-SESSION-CLOSE-001 production close action acknowledges attention without completion suppression', async () => {
    await execFile(process.execPath, [harnessPath, 'explicit-close'], { env: harnessEnvironment() });
});

test('ATTENTION-EXPLICIT-SESSION-CLOSE-001 tmux detach acknowledges current attention without suppressing future completion', async () => {
    await execFile(process.execPath, [harnessPath, 'explicit-detach'], { env: harnessEnvironment() });
});

test('ATTENTION-EXPLICIT-SESSION-CLOSE-001 RUNTIME-TMUX-TERMINATE-SESSION-001 tmux stop acknowledges current attention without suppressing future completion', async () => {
    await execFile(process.execPath, [harnessPath, 'explicit-terminate'], { env: harnessEnvironment() });
});

test('ATTENTION-USER-TERMINAL-CLOSE-001 controlled bridge-first acknowledgement mutation is rejected', async () => {
    await assert.rejects(
        execFile(process.execPath, [harnessPath, 'mutation:acknowledge-order'], { env: harnessEnvironment() }),
        /must be awaited only after the local refresh/);
});

test('WEBVIEW-AI-SESSION-DASHBOARD-CONTROLLER-001 presentation ships inside the incremental render envelope', async () => {
    await execFile(process.execPath, [harnessPath, 'attention-state-order'], { env: harnessEnvironment() });
});

test('WEBVIEW-AI-SESSION-DASHBOARD-CONTROLLER-001 controlled missing envelope presentation is rejected', async () => {
    await assert.rejects(
        execFile(process.execPath, [harnessPath, 'mutation:attention-state-before-render'], { env: harnessEnvironment() }),
        /must publish one coherent presentation envelope/);
});

test('ATTENTION-PRODUCTION-ATTENTION-BRIDGE-INTEGRATION-001 remote aggregate schedules a refresh without auto-acknowledging', async () => {
    await execFile(process.execPath, [harnessPath, 'remote-aggregate'], { env: harnessEnvironment() });
});

test('ATTENTION-PRODUCTION-ATTENTION-BRIDGE-INTEGRATION-001 controlled aggregate auto-acknowledge mutation is rejected', async () => {
    await assert.rejects(
        execFile(process.execPath, [harnessPath, 'mutation:aggregate-auto-acknowledge'], { env: harnessEnvironment() }),
        /must not (scan released sessions|auto-acknowledge a delivered completion)/);
});

test('ATTENTION-PRODUCTION-ATTENTION-BRIDGE-INTEGRATION-001 controlled missing aggregate refresh mutation is rejected', async () => {
    await assert.rejects(
        execFile(process.execPath, [harnessPath, 'mutation:aggregate-refresh-skipped'], { env: harnessEnvironment() }),
        /must schedule an attention views refresh/);
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 terminal completion queues a structured runtime settlement', async () => {
    await execFile(process.execPath, [harnessPath, 'highlighter-completion'], { env: harnessEnvironment() });
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 controlled completion-without-settlement mutation is rejected', async () => {
    await assert.rejects(
        execFile(process.execPath, [harnessPath, 'mutation:completion-queue-skipped'], { env: harnessEnvironment() }),
        /must queue a runtime settlement/);
});

test('WEBVIEW-ACTIVE-AI-SESSION-TERMINAL-HIGHLIGHT-001 active terminal change syncs highlight and evaluates through the lifecycle task', async () => {
    await execFile(process.execPath, [harnessPath, 'active-terminal'], { env: harnessEnvironment() });
});

test('WEBVIEW-ACTIVE-AI-SESSION-TERMINAL-HIGHLIGHT-001 controlled bare active-terminal evaluation mutation is rejected', async () => {
    await assert.rejects(
        execFile(process.execPath, [harnessPath, 'mutation:active-terminal-bare-evaluate'], { env: harnessEnvironment() }),
        /must be routed through the safe lifecycle task/);
});

test('ATTENTION-RUNTIME-EXIT-NEUTRAL-001 controlled close-without-lifecycle-tick mutation is rejected', async () => {
    await assert.rejects(
        execFile(process.execPath, [harnessPath, 'mutation:close-tick-skipped'], { env: harnessEnvironment() }),
        /must re-run the lifecycle tick/);
});

test('ATTENTION-RUNTIME-EXIT-NEUTRAL-001 controlled completion-suppression mutation is rejected', async () => {
    await assert.rejects(
        execFile(process.execPath, [harnessPath, 'mutation'], { env: harnessEnvironment() }),
        /runtime exit must never suppress completion attention/);
});
