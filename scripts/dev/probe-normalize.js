'use strict';
// Run the production normalizeThreadRead over the live thread payload.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = '/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/worktree-sidebar';
const result = JSON.parse(fs.readFileSync('/tmp/thread-read.json', 'utf8'));

const fakeVscode = { ViewColumn: { Active: 1 }, Uri: { parse: v => v, file: v => ({ fsPath: v }) } };
const prev = Module._load;
Module._load = function (req, ...rest) {
    if (req === 'vscode') return fakeVscode;
    return prev.call(this, req, ...rest);
};
// normalizeThreadRead is module-private; exercise it through the adapter's
// loadFresh path instead: stub the client to answer thread/read with the
// captured payload.
const { CodexConversationAdapter } = require(path.join(ROOT, 'out/aiSessions/conversation/codexAdapter'));
const { CodexRolloutGoalTurnsReader } = require(path.join(ROOT, 'out/aiSessions/codexRolloutGoalTurns'));
Module._load = prev;

const client = {
    request: async (method, params) => {
        if (method === 'thread/read') return result;
        throw new Error('unexpected ' + method);
    },
    getServerVersion: () => '0.147',
    watchNotifications: undefined,
    dispose() {},
};
const adapter = new CodexConversationAdapter({
    client,
    now: Date.now,
    setTimeout, clearTimeout,
});
adapter.readOutline('01a00b13-c259-7a93-b8d8-4a2361858461').then(
    outline => console.log('OK interactions:', outline.interactions.length),
    error => {
        console.log('NORMALIZE/LOAD ERROR:', error.code, error.reason || '');
        console.log((error.stack || '').split('\n').slice(0, 8).join('\n'));
    }
);
