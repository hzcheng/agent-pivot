'use strict';
// Reproduce the stuck-loading path with the REAL kimi transcript through
// the real viewer: host builds the publication, webview applies it.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { chromium } = require('playwright-chromium');
const ROOT = '/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/worktree-sidebar';
const SESSION_ID = 'a5e28404-3be4-413f-b6be-d59d36ba98a8';
const SESSION_DIR = '/home/hzcheng/.kimi/sessions/816d39e2fefe1010f0ff5b535bc1f84d/' + SESSION_ID;

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
    const { KimiConversationAdapter } = require(path.join(ROOT, 'out/aiSessions/conversation/kimiAdapter'));
    const { ConversationViewer } = require(path.join(ROOT, 'out/aiSessions/conversation/viewer'));
    Module._load = prev;

    const adapter = new KimiConversationAdapter({
        resolveSource: sessionId => sessionId === SESSION_ID ? {
            providerHome: '/home/hzcheng/.kimi',
            sourcePath: path.join(SESSION_DIR, 'wire.jsonl'),
            cwd: ROOT,
        } : null,
        now: Date.now,
        setTimeout, clearTimeout,
    });
    const posted = [];
    const panel = {
        visible: true, active: true, postedMessages: posted,
        webview: {
            html: '', cspSource: 'https://viewer.test', options: {},
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: m => { posted.push(m); return Promise.resolve(true); },
            asWebviewUri: u => 'https://viewer.test/' + path.basename(u.fsPath || String(u)),
        },
        onDidDispose: () => ({ dispose() {} }),
        onDidChangeViewState: () => ({ dispose() {} }),
        reveal() {}, dispose() {},
    };
    const viewer = new ConversationViewer({
        createPanel: () => panel,
        readOutline: (p, s) => adapter.readOutline(s),
        readPage: req => adapter.readPage(req),
        watch: () => ({ dispose() {} }),
        restoreFocus: () => {},
        mediaUri: f => ({ fsPath: f }),
    });
    const outline = await adapter.readOutline(SESSION_ID);
    const latestInteraction = outline.interactions.at(-1);
    console.log('interactions:', outline.interactions.length,
        'latest:', latestInteraction && latestInteraction.id);
    await viewer.open({
        projectId: 'project', provider: 'kimi', sessionId: SESSION_ID,
        workspaceName: 'ws', interactionId: latestInteraction.id,
        expectedRevision: 'r1',
        displayName: 'repro', duplicateDisplayName: false,
    });
    const pageMsg = posted.filter(m => m.type === 'conversation-viewer-page').at(-1);
    console.log('page published:', !!pageMsg, 'html bytes:', pageMsg ? pageMsg.html.length : 0,
        'loading html still shown:', panel.webview.html.includes('Loading conversation'));

    // Now apply the publication in the real webview document+scripts.
    const docHtml = panel.webview.html;
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const pg = await browser.newPage();
    const pageErrors = [];
    pg.on('pageerror', e => pageErrors.push(String(e.message || e)));
    await pg.route('https://viewer.test/**', async route => {
        const base = path.basename(new URL(route.request().url()).pathname);
        const candidates = [path.join(ROOT, 'media', base),
            path.join(ROOT, 'node_modules/dompurify/dist', base),
            path.join(ROOT, 'node_modules/mermaid/dist', base)];
        const found = candidates.find(c => fs.existsSync(c));
        await route.fulfill({ body: found ? fs.readFileSync(found, 'utf8') : '',
            contentType: base.endsWith('.css') ? 'text/css' : 'text/javascript' });
    });
    await pg.setContent(docHtml);
    await pg.evaluate(() => {
        window.__postedMessages = [];
        window.vscode = {
            postMessage(m) { window.__postedMessages.push(m); },
            getState: () => null, setState() {},
        };
    });
    await pg.waitForTimeout(500);
    const status = await pg.evaluate(() => ({
        loading: document.body.getAttribute('data-conversation-loading'),
        statusText: document.querySelector('[data-conversation-status]')?.textContent,
        messageCount: document.querySelectorAll('[data-message-id]').length,
        resyncs: window.__postedMessages.filter(m => m.type === 'conversation-viewer-request-sync').length,
        posts: window.__postedMessages.map(m => m.type),
    }));
    console.log('webview state:', JSON.stringify(status, null, 1));
    console.log('page errors:', JSON.stringify(pageErrors.slice(0, 3)));
    await browser.close();
}
main().catch(e => { console.error('REPRO-ERR', e); process.exit(1); });
