'use strict';

/**
 * Rendered-output verification for the conversation changes panel
 * (review-fix-commit-loop skill): loads the real viewer document in
 * headless Chromium, feeds it a changes state, and screenshots the
 * sidebar at default (240px), recommended (320px), and minimum (192px)
 * widths.
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
        // Every (re)load gets the API stub: the script below reloads the
        // page, which wipes evaluate-time globals.
        await page.addInitScript(() => {
            window.__postedMessages = [];
            window.acquireVsCodeApi = () => ({
                postMessage(message) {
                    window.__postedMessages.push(message);
                },
                // No persisted state: the panel starts closed and the
                // telemetry click below opens it.
                getState: () => ({}),
                setState() {},
            });
        });
        await page.setContent(html);
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
                            upstream: {
                                status: 'tracked',
                                fullRef: 'refs/remotes/origin/agent-pivot/fix-login',
                                sha: 'b'.repeat(40), ahead: 10, behind: 34,
                            },
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
        // First-open recommendation width for new Webview state (PRD §15.6).
        await page.evaluate(() => {
            document.querySelector('.conversation-workspace')
                .style.setProperty('--conversation-comments-width', '320px');
        });
        await page.screenshot({
            path: path.join(outDir, 'changes-recommended-320.png'),
        });
        // Minimum supported sidebar width (192px, per the resizer clamp).
        await page.evaluate(() => {
            document.querySelector('.conversation-workspace')
                .style.setProperty('--conversation-comments-width', '192px');
        });
        await page.screenshot({
            path: path.join(outDir, 'changes-min-192.png'),
        });

        // Commits sub-tab at all three widths (PRD §15.5): switch over,
        // answer the lazy list request with a small history including
        // both tracking badges, and expand the first commit inline.
        await page.locator('[data-changes-subtab="commits"]').click();
        const listRequest = await page.evaluate(() =>
            window.__postedMessages.filter(message =>
                message.type === 'conversation-viewer-commits-list')
                .at(-1));
        await page.evaluate(requestId => {
            const sha = index => String(index).padStart(40, 'c');
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'conversation-viewer-commits',
                    version: 1,
                    requestId,
                    subscriptionGeneration: Number(
                        document.body.getAttribute(
                            'data-subscription-generation')),
                    memberId: 'm-api',
                    scope: 'since-start',
                    offset: 0,
                    historyHead: sha(9),
                    commits: [{
                        sha: sha(9), subject: 'fix: token refresh race',
                        authorName: 'hzcheng', authorTime: 1724000000,
                        inTrackingBranch: false,
                    }, {
                        sha: sha(8), subject: 'chore: setup script',
                        authorName: 'hzcheng', authorTime: 1723990000,
                        inTrackingBranch: true,
                    }],
                    hasMore: false,
                    sectionComplete: true,
                    baselineRow: {
                        sha: 'a'.repeat(40), subject: 'main · merged #241',
                    },
                },
            }));
        }, listRequest.requestId);
        await page.locator('.conversation-changes-commit-row').first()
            .waitFor({ state: 'visible' });
        const detailRequest = await (async () => {
            await page.locator('.conversation-changes-commit-row').first()
                .click();
            return page.evaluate(() =>
                window.__postedMessages.filter(message =>
                    message.type === 'conversation-viewer-commit-detail')
                    .at(-1));
        })();
        await page.evaluate(requestId => {
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'conversation-viewer-commit-detail',
                    version: 1,
                    requestId,
                    subscriptionGeneration: Number(
                        document.body.getAttribute(
                            'data-subscription-generation')),
                    memberId: 'm-api',
                    sha: String(9).padStart(40, 'c'),
                    files: [{
                        path: 'src/auth/login.ts', status: 'M',
                        additions: 12, deletions: 3,
                    }, {
                        path: 'src/auth/session.ts', status: 'M',
                        additions: 4, deletions: 1,
                    }],
                    totalFiles: 2,
                    filesTruncated: false,
                },
            }));
        }, detailRequest.requestId);
        await page.locator('.conversation-changes-commit-file-row')
            .first().waitFor({ state: 'visible' });
        await page.screenshot({
            path: path.join(outDir, 'changes-commits-192.png'),
        });
        await page.evaluate(() => {
            document.querySelector('.conversation-workspace')
                .style.setProperty('--conversation-comments-width', '240px');
        });
        await page.screenshot({
            path: path.join(outDir, 'changes-commits-240.png'),
        });
        await page.evaluate(() => {
            document.querySelector('.conversation-workspace')
                .style.setProperty('--conversation-comments-width', '320px');
        });
        await page.screenshot({
            path: path.join(outDir, 'changes-commits-320.png'),
        });
        // Back to Files for the overflow probe.
        await page.locator('[data-changes-subtab="files"]').click();
        const overflow = await page.evaluate(() => {
            const panel = document.querySelector('[data-conversation-changes]');
            return {
                horizontalOverflow: panel.scrollWidth > panel.clientWidth + 1,
                selectClipped: (() => {
                    const select = panel.querySelector(
                        '[data-changes-member-select]');
                    // Single-member sessions render no select at all — the
                    // repo name is a plain text title (PRD §15.1).
                    return select
                        ? select.scrollWidth > select.clientWidth + 1
                        : null;
                })(),
            };
        });
        console.log(JSON.stringify(overflow));
        // Icon parity: the changes glyph must render at the same size as
        // its telemetry siblings.
        const iconMetrics = await page.evaluate(() => {
            const out = {};
            for (const sel of ['position', 'comments', 'subagents', 'changes']) {
                const btn = document.querySelector('[data-telemetry-' + sel + ']')
                    || document.querySelector('[data-conversation-' + sel + ']');
                const svg = btn && btn.querySelector('svg');
                if (!btn || !svg) { out[sel] = null; continue; }
                const b = btn.getBoundingClientRect();
                const g = svg.getBoundingClientRect();
                out[sel] = {
                    buttonH: Math.round(b.height * 10) / 10,
                    svgW: Math.round(g.width * 10) / 10,
                    svgH: Math.round(g.height * 10) / 10,
                };
            }
            return out;
        });
        console.log('telemetry icons:', JSON.stringify(iconMetrics));
        console.log(`screenshots written to ${outDir}`);
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
