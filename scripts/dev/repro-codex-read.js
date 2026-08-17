'use strict';
// Read the live codex session through the production adapter.
const path = require('path');
const Module = require('module');
const childProcess = require('child_process');
const ROOT = '/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/worktree-sidebar';
const SESSION_ID = process.argv[2] || '01a00b13-c259-7a93-b8d8-4a2361858461';

const fakeVscode = {
    ViewColumn: { Active: 1, Beside: 2 },
    Uri: { parse: v => v, file: v => ({ fsPath: v }) },
};

async function main() {
    const prev = Module._load;
    Module._load = function (req, ...rest) {
        if (req === 'vscode') return fakeVscode;
        return prev.call(this, req, ...rest);
    };
    const { CodexConversationAdapter } = require(path.join(ROOT, 'out/aiSessions/conversation/codexAdapter'));
    const { CodexAppServerClient } = require(path.join(ROOT, 'out/aiSessions/conversation/codexAppServerClient'));
    Module._load = prev;
    const adapter = new CodexConversationAdapter({
        client: new CodexAppServerClient({
            experimentalApi: false,
            spawn: childProcess.spawn,
            resolveExecutable: () => 'codex',
            now: Date.now,
            setTimeout, clearTimeout,
        }),
        now: Date.now,
        setTimeout, clearTimeout,
    });
    setTimeout(() => { console.log('TIMEOUT 20s — still reading'); }, 20000).unref();
    try {
        const outline = await adapter.readOutline(SESSION_ID);
        console.log('interactions:', outline.interactions.length,
            'revision:', outline.sourceRevision);
    } catch (error) {
        console.log('READ ERROR:', error.code, error.reason || '', error.message);
        console.log(error.stack && error.stack.split('\n').slice(0, 6).join('\n'));
    }
}
main();
