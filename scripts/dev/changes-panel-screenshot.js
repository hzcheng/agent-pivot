'use strict';

/**
 * Rendered-output verification for the conversation changes panel
 * (review-fix-commit-loop skill): loads the real viewer document in
 * headless Chromium, feeds it a changes state, and screenshots the
 * sidebar at default (240px) and minimum (192px) widths.
 *
 * Usage: node scripts/dev/changes-panel-screenshot.js <outDir>
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { chromium } = require('playwright-chromium');

const ROOT = path.join(__dirname, '..', '..');

function fakeHostUri(value) {
    return value;
}

function loadViewerDocument() {
    const fakeVscode = {
        ViewColumn: { Active: 1, Beside: 2 },
        Uri: { parse: value => value, file: value => ({ fsPath: value }) },
    };
    const previousLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (request === 'vscode') return fakeVscode;
        return previousLoad.call(this, request, ...rest);
    };
    try {
        return require(path.join(
            ROOT, 'out/aiSessions/conversation/viewerDocument'));
    } finally {
        Module._load = previousLoad;
    }
}

async function main() {
    const outDir = process.argv[2] || '/tmp/changes-panel-shots';
    await fs.promises.mkdir(outDir, { recursive: true });
    const { renderConversationViewerDocument } = loadViewerDocument();
    const panel = {
        webview: {
            cspSource: 'https://viewer.test',
            asWebviewUri: uri =>
                `https://viewer.test/${path.basename(uri.fsPath || uri)}`,
        },
    };
    const html = renderConversationViewerDocument({
        panel,
        target: {
            projectId: 'project', provider: 'codex', sessionId: 'session-1',
            workspaceName: 'Workspace', interactionId: 'i1',
            expectedRevision: 'r1', displayName: 'Fix login',
            duplicateDisplayName: false,
        },
        commentSnapshot: { revision: 0, comments: [] },
        projectCommentSnapshot: { revision: 0, comments: [] },
        bookmarkSnapshot: { revision: 0, interactionIds: [] },
        subscriptionGeneration: 1,
        telemetrySnapshot: undefined,
        mediaUri: fileName => ({ fsPath: fileName }),
    });

    const browser = await chromium.launch({
        headless: true, args: ['--no-sandbox'],
    });
    try {
        const page = await browser.newPage({
            viewport: { width: 900, height: 640 },
        });
        await page.route('https://viewer.test/**', async route => {
            const basename = path.basename(
                new URL(route.request().url()).pathname);
            const candidates = [
                path.join(ROOT, 'media', basename),
                path.join(ROOT, 'node_modules/dompurify/dist', basename),
                path.join(ROOT, 'node_modules/mermaid/dist', basename),
            ];
            const found = candidates.find(candidate =>
                fs.existsSync(candidate));
            if (found) {
                await route.fulfill({
                    body: fs.readFileSync(found, 'utf8'),
                    contentType: basename.endsWith('.css')
                        ? 'text/css' : 'text/javascript',
                });
                return;
            }
            await route.fulfill({ body: '', contentType: 'text/plain' });
        });
        await page.route('https://fonts.local/**', route =>
            route.fulfill({ body: '', contentType: 'text/css' }));
        await page.setContent(html);
        await page.evaluate(() => {
            window.__postedMessages = [];
            window.vscode = {
                postMessage(message) {
                    window.__postedMessages.push(message);
                },
                getState: () => ({
                    conversationSidebar: { open: true, view: 'changes' },
                }),
                setState() {},
            };
        });
        // Re-run the viewer script so it picks up window.vscode.
        await page.evaluate(() => undefined);
        await page.reload();
        await page.setContent(html);
        await page.evaluate(() => {
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'conversation-viewer-changes',
                    version: 1,
                    subscriptionGeneration: Number(
                        document.body.getAttribute(
                            'data-subscription-generation')),
                    changes: {
                        kind: 'ready',
                        aggregate: {
                            completeness: 'complete', workingItemCount: 4,
                            workingPartial: false, aheadCount: 2,
                            aheadPartial: false, allUnreadable: false,
                        },
                        members: [{
                            memberId: 'm-api', repoLabel: 'api',
                            branchName: 'agent-pivot/fix-login',
                            worktreePath: '/wt/api',
                            availability: 'available', workingItemCount: 3,
                            aheadCount: 2, truncated: false,
                        }],
                        selectedMemberId: 'm-api',
                        detail: {
                            memberId: 'm-api', availability: 'available',
                            baselineSha: 'a'.repeat(40), aheadCount: 2,
                            taskFileCount: 5,
                            items: [
                                { group: 'staged', xy: 'M ', path: 'src/auth/session.ts' },
                                { group: 'changes', xy: ' M', path: 'src/auth/a-very-long-directory-name/login.ts' },
                                { group: 'untracked', xy: '??', path: 'src/auth/login.test.ts' },
                            ],
                            truncated: false,
                        },
                        collectedAt: 1724000000000,
                    },
                },
            }));
        });
        await page.locator('[data-telemetry-changes]').click();
        const sidebar = page.locator('[data-conversation-sidebar]');
        await sidebar.waitFor({ state: 'visible' });
        await page.screenshot({
            path: path.join(outDir, 'changes-default-240.png'),
        });
        // Minimum supported sidebar width (192px, per the resizer clamp).
        await page.evaluate(() => {
            document.querySelector('.conversation-workspace')
                .style.setProperty('--conversation-comments-width', '192px');
        });
        await page.screenshot({
            path: path.join(outDir, 'changes-min-192.png'),
        });
        const overflow = await page.evaluate(() => {
            const panel = document.querySelector('[data-conversation-changes]');
            return {
                horizontalOverflow: panel.scrollWidth > panel.clientWidth + 1,
                selectClipped: (() => {
                    const select = panel.querySelector(
                        '[data-changes-member-select]');
                    return select.scrollWidth > select.clientWidth + 1;
                })(),
            };
        });
        console.log(JSON.stringify(overflow));
        console.log(`screenshots written to ${outDir}`);
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
