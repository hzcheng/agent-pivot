'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const { getAiSessionsDiv } = require('../../out/webview/webviewAiSessionContent');

const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const viewStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewAiSessionViewStateScripts.js'),
    'utf8'
);

const frontendKey = {
    repositoryKey: '/repo/.git',
    canonicalWorktreePath: '/repo/frontend-feature-authentication-with-a-long-name',
};
const backendKey = {
    repositoryKey: '/repo/.git',
    canonicalWorktreePath: '/repo/.agent-pivot/worktrees/backend',
};

function worktree(key, branchRef, activity) {
    return {
        kind: 'ready',
        git: {
            key,
            branchRef,
            head: 'a'.repeat(40),
            isMain: false,
            isBare: false,
            health: 'normal',
            headKind: 'branch',
        },
        activity,
        sessions: [],
        authority: { canResume: true, canRemove: activity === 'idle' },
    };
}

function surface() {
    return getAiSessionsDiv({
        id: 'project-a',
        activeAiSessionProvider: 'codex',
        selectedAiSessionProviders: ['codex'],
        activeAiSessionTab: 'chats',
        codexSessions: [{
            id: 'legacy-session',
            name: 'Existing project chat must remain visible',
            provider: 'codex',
        }],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [{
            key: 'codex:frontend-session',
            provider: 'codex',
            sessionId: 'frontend-session',
            name: 'Implement the responsive worktree session grouping experience',
            executionState: 'running',
            backend: 'vscode',
            attached: true,
            worktreeKey: frontendKey,
        }],
        worktrees: [
            {
                kind: 'provisioning', operationId: 'operation-1', repositoryKey: '/repo/.git',
                taskName: 'Prepare frontend authentication environment',
                proposedPath: '/repo/.agent-pivot/worktrees/prepare-frontend-authentication',
                stage: 'creating', completedSteps: [], retryable: false, cancellable: true,
            },
            worktree(frontendKey, 'refs/heads/frontend/feature-authentication-with-a-long-name', 'attention'),
            worktree(backendKey, 'refs/heads/backend', 'idle'),
        ],
        worktreeSnapshotRevision: 1,
        worktreeRepositoryCount: 1,
        bareWorktreeCount: 0,
    });
}

test('WORKTREE-GROUPING-UI-001 renders CHATS and ALL tabs with the tree in CHATS', async t => {
    const page = await openSurfacePage(320);
    t.after(() => page.close());

    const tabs = page.locator('[data-ai-session-tab]');
    assert.deepEqual(
        (await tabs.allTextContents()).map(text => text.replace(/[\d]/g, '').trim()),
        ['CHATS', 'ALL'],
    );
    assert.equal(await page.locator('[data-ai-session-panel="chats"]').count(), 1);
    assert.equal(await page.locator('[data-ai-session-panel="all"]').count(), 1);
    assert.equal(await page.locator('[data-ai-session-surface-tab]').count(), 0,
        'the surface switcher is retired');
    assert.equal(await page.locator('[data-ai-session-grouping-select]').count(), 0,
        'the tree is the CHATS view, not a grouping preference');
    assert.ok(
        await page.locator('[data-ai-session-panel="chats"] .ai-session-worktree-group').count() > 0,
        'the CHATS tree shows the ready worktrees by default',
    );
    assert.equal(await page.locator('[data-action="toggle-chats-view-menu"]').count(), 1,
        'the CHATS tab pair carries the view-menu trigger');
});

test('WORKTREE-GROUPING-UI-001 gives each worktree group a bounded surface and header divider', async t => {
    const page = await openSurfacePage(320);
    t.after(() => page.close());
    await page.addStyleTag({ content: `
        :root {
            --vscode-editorWidget-background: #202020;
            --vscode-widget-border: #666;
            --vscode-focusBorder: #6ea8fe;
        }
    ` });

    const appearance = await page.locator(
        '.ai-session-worktree-group:not(.ai-session-worktree-anchor)'
    ).first().evaluate(group => {
        const groupStyle = getComputedStyle(group);
        const toolbarStyle = getComputedStyle(group.querySelector('.ai-session-worktree-toolbar'));
        const headerStyle = getComputedStyle(group.querySelector('.ai-session-worktree-header'));
        return {
            background: groupStyle.backgroundColor,
            borderTopColor: groupStyle.borderTopColor,
            toolbarBorderBottomWidth: toolbarStyle.borderBottomWidth,
            toolbarBorderBottomColor: toolbarStyle.borderBottomColor,
            headerBorderBottomWidth: headerStyle.borderBottomWidth,
        };
    });
    assert.equal(appearance.background, 'rgb(32, 32, 32)',
        'the worktree must stand apart from the surrounding sidebar');
    assert.equal(appearance.borderTopColor, 'rgb(102, 102, 102)');
    assert.equal(appearance.toolbarBorderBottomWidth, '1px',
        'the full toolbar must separate the group identity from its child sessions');
    assert.equal(appearance.toolbarBorderBottomColor, 'rgb(102, 102, 102)');
    assert.equal(appearance.headerBorderBottomWidth, '0px',
        'the divider belongs to the full-width toolbar, not only the title button');

    const header = page.locator(
        '.ai-session-worktree-group:not(.ai-session-worktree-anchor) .ai-session-worktree-header'
    ).first();
    await header.focus();
    const focus = await header.evaluate(element => {
        const style = getComputedStyle(element);
        return { outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
    });
    assert.equal(focus.outlineWidth, '1px',
        'keyboard focus must remain distinct from the low-contrast resting surface');
    assert.equal(focus.outlineColor, 'rgb(110, 168, 254)');
});

test('WORKTREE-GROUPING-UI-001 keeps a low-contrast fallback group visible at default and minimum widths', async t => {
    for (const width of [320, 170]) {
        const page = await openSurfacePage(width);
        t.after(() => page.close());
        await page.addStyleTag({ content: `
            :root {
                --vscode-panel-border: #666;
                --vscode-list-hoverBackground: #2a2a2a;
                --vscode-editorWidget-background: initial;
                --vscode-widget-border: initial;
            }
        ` });
        await page.evaluate(() => {
            const fixture = document.createElement('section');
            fixture.className = 'ai-session-worktree-group';
            fixture.setAttribute('data-visual-worktree-fixture', '');
            fixture.innerHTML = `<div class="ai-session-worktree-toolbar">
                <button type="button" class="ai-session-worktree-header">Fallback worktree</button>
            </div><div class="ai-session-worktree-session-list">Session</div>`;
            fixture.style.cssText = 'position:fixed;top:8px;left:8px;width:calc(100vw - 16px);z-index:1';
            document.querySelector('[data-open-session-surface]').append(fixture);
        });
        const group = page.locator('[data-visual-worktree-fixture]');
        const header = group.locator('.ai-session-worktree-header');
        const computed = await group.evaluate(element => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, borderTopColor: style.borderTopColor };
        });
        assert.equal(computed.background, 'rgb(24, 24, 24)',
            'the absent widget token falls back to the sidebar surface');
        assert.equal(computed.borderTopColor, 'rgb(102, 102, 102)',
            'the absent widget border falls back to the panel border');

        const restingPixels = await group.screenshot();
        await header.hover();
        assert.equal(await header.evaluate(element => getComputedStyle(element).backgroundColor),
            'rgb(42, 42, 42)', 'hover must use the visible list-hover surface');
        assert.notDeepEqual(await group.screenshot(), restingPixels,
            `hover must remain visible above the fallback group surface at ${width}px`);
        await page.mouse.move(1, 850);
        await page.addStyleTag({ content: '.ai-session-worktree-group { background-image: none !important; }' });
        assert.notDeepEqual(await group.screenshot(), restingPixels,
            `the fallback overlay must remain visible in the ${width}px rendered worktree`);
    }
});

test('WORKTREE-GROUPING-UI-001 keeps the live session in the CHATS tree and the ALL list intact', async t => {
    const page = await openSurfacePage(320);
    t.after(() => page.close());

    assert.equal(
        await page.locator('[data-ai-session-panel="chats"] .active-ai-session-row').count(),
        1,
        'the live session lives in the CHATS tree',
    );
    await page.evaluate(() => {
        selectAiSessionTabDom(document.querySelector('[data-open-session-surface]'), 'all');
    });
    const all = page.locator('[data-ai-session-panel="all"]');
    assert.equal(
        await all.locator('.codex-session-row').count(),
        1,
        'legacy current-project chats remain in ALL',
    );
    assert.equal(
        await all.locator('.ai-session-worktree-group').count(),
        0,
        'ALL retains the original flat history layout',
    );
});

test('WORKTREE-GROUPING-UI-001 collapse hides the session rows with the real stylesheet', async t => {
    const page = await openSurfacePage(320);
    t.after(() => page.close());

    const rows = page.locator(
        '[data-ai-session-panel="chats"] .codex-session-row[data-session-id="frontend-session"]'
    );
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.first().isVisible(), true);

    await page.evaluate(() => {
        const header = document.querySelector(
            '[data-ai-session-panel="chats"] .ai-session-worktree-group:not(.ai-session-worktree-anchor) .ai-session-worktree-header'
        );
        setAiSessionWorktreeExpanded(header, false);
    });
    assert.equal(await rows.first().isVisible(), false,
        'a collapsed worktree must hide its session rows, not just mark them hidden');

    await page.evaluate(() => {
        const header = document.querySelector(
            '[data-ai-session-panel="chats"] .ai-session-worktree-group:not(.ai-session-worktree-anchor) .ai-session-worktree-header'
        );
        setAiSessionWorktreeExpanded(header, true);
    });
    assert.equal(await rows.first().isVisible(), true);
});

let browser;
test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

async function openSurfacePage(width) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(`<!doctype html><html><body class="steward-sidebar">
        <div class="open-session-surface" data-open-session-surface data-id="project-a" data-current-workspace>
            ${surface()}
        </div>
    </body></html>`);
    await page.addStyleTag({ content: styles });
    await page.addStyleTag({ content: `
        :root {
            --vscode-font-family: sans-serif;
            --vscode-foreground: #ddd;
            --vscode-descriptionForeground: #aaa;
            --vscode-sideBar-background: #181818;
            --vscode-panel-border: #555;
            --vscode-input-background: #222;
        }
        html, body { margin: 0; }
        .project { box-sizing: border-box; padding: 4px; }
    ` });
    await page.addScriptTag({ content: viewStateScript });
    return page;
}

test('WORKTREE-GROUPING-UI-001 WORKTREE-PROVISIONING-UI-001 WORKTREE-MANAGED-CLEANUP-001 stays usable at the 170px minimum sidebar width', async t => {
    const page = await openSurfacePage(170);
    t.after(() => page.close());

    assert.equal(await page.locator(
        '[data-ai-session-panel="chats"] .codex-session-row[data-session-id="frontend-session"]'
    ).count(), 1);
    assert.equal(await page.locator('.ai-session-worktree-anchor').count(), 1,
        'Current is a distinct top-level creation target');
    assert.equal(await page.locator('.ai-session-worktree-group:not(.ai-session-worktree-anchor) .ai-session-worktree-header').count(), 2,
        'both ordinary worktrees retain their headers');
    assert.equal(await page.locator('.ai-session-worktree-header').count(), 3);
    assert.equal(await page.locator('.ai-session-worktree-more').count(), 3);
    assert.equal(await page.locator('.ai-session-provisioning-row').count(), 1);
    assert.equal(await page.locator('[data-action="cancel-isolated-session"]').isVisible(), true);
    assert.equal(
        await page.locator('.ai-session-worktree-group:not(.ai-session-worktree-anchor) .ai-session-worktree-more')
            .first().getAttribute('aria-label'),
        'Actions for frontend/feature-authentication-with-a-long-name'
    );
    const layout = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        projectWidth: document.querySelector('[data-open-session-surface]').getBoundingClientRect().width,
        headerWidths: Array.from(document.querySelectorAll('.ai-session-worktree-header'))
            .map(header => header.getBoundingClientRect().width),
        overflowers: Array.from(document.querySelectorAll('body *')).map(element => {
            const rect = element.getBoundingClientRect();
            return {
                selector: `${element.tagName.toLowerCase()}.${element.className}`,
                left: rect.left,
                right: rect.right,
                width: rect.width,
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
            };
        }).filter(item => item.right > 170.5 || item.scrollWidth > item.clientWidth + 1)
            .slice(0, 12),
    }));
    assert.ok(layout.documentWidth <= layout.viewportWidth,
        `170px layout must not scroll horizontally: ${JSON.stringify(layout)}`);
    assert.ok(layout.headerWidths.every(width => width <= layout.projectWidth),
        `worktree headers must remain bounded: ${JSON.stringify(layout)}`);

    const screenshot = await page.screenshot({ fullPage: true });
    assert.ok(screenshot.length > 1_000, '170px acceptance screenshot must contain rendered pixels');

    await page.evaluate(() => {
        selectAiSessionTabDom(document.querySelector('[data-open-session-surface]'), 'all');
    });
    assert.equal(await page.locator(
        '[data-ai-session-panel="all"] .codex-session-row[data-session-id="legacy-session"]'
    ).count(), 1,
        'ALL must retain the legacy history session');
    assert.equal(await page.locator(
        '[data-ai-session-panel="chats"] .codex-session-row[data-session-id="frontend-session"]'
    ).count(), 1,
        'the active session stays in the CHATS tree');
    assert.equal(await page.locator('.ai-session-worktree-header').first().isVisible(), false,
        'the CHATS tree hides while ALL is selected');
});

test('WORKTREE-GROUPING-UI-001 renders Worktree and Chats at the default sidebar width', async t => {
    const page = await openSurfacePage(320);
    t.after(() => page.close());

    assert.equal(await page.locator('.ai-session-worktree-header').first().isVisible(), true);
    const treeScreenshot = await page.screenshot({ fullPage: true });
    assert.ok(treeScreenshot.length > 1_000,
        'default-width CHATS tree screenshot must contain rendered pixels');

    await page.evaluate(() => {
        selectAiSessionTabDom(document.querySelector('[data-open-session-surface]'), 'all');
    });
    assert.equal(await page.locator('.ai-session-worktree-header').first().isVisible(), false);
    assert.equal(await page.locator(
        '[data-ai-session-panel="all"] .codex-session-row[data-session-id="legacy-session"]'
    ).count(), 1);
    const allScreenshot = await page.screenshot({ fullPage: true });
    assert.ok(allScreenshot.length > 1_000,
        'default-width ALL screenshot must contain rendered pixels');
});

test('WORKTREE-GROUPING-UI-001 OPEN-WINDOW-VIEW-STATE-PERSISTENCE-001 collapse gestures mirror the group keys into the window view-state protocol', async t => {
    const page = await openSurfacePage(320);
    t.after(() => page.close());
    await page.evaluate(() => {
        window.__postedMessages = [];
        let state = {};
        window.vscode = {
            getState: () => state,
            setState(next) { state = next; },
            postMessage: message => window.__postedMessages.push(message),
        };
    });

    // Collapse-everything via the collapse-all affordance path.
    await page.evaluate(() => toggleAllAiSessionWorktrees(document.querySelector('[data-open-session-surface]')));
    let posts = await page.evaluate(() =>
        window.__postedMessages.filter(message => message.type === 'set-ai-session-collapsed-worktree-groups'));
    assert.equal(posts.length, 1, 'one mirror post per collapse gesture');
    assert.equal(posts[0].version, 1);
    assert.equal(posts[0].projectId, 'project-a');
    assert.equal(posts[0].collapsedKeys.length, 3,
        'Current and both unmanaged worktree groups are reported collapsed');

    // Expanding again mirrors the empty set.
    await page.evaluate(() => toggleAllAiSessionWorktrees(document.querySelector('[data-open-session-surface]')));
    posts = await page.evaluate(() =>
        window.__postedMessages.filter(message => message.type === 'set-ai-session-collapsed-worktree-groups'));
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].collapsedKeys, []);
});

test('WORKTREE-GROUPING-UI-001 the host-persisted collapsed set renders collapsed at first paint', async t => {
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    t.after(() => page.close());
    const collapsedKey = JSON.stringify([
        '/repo/.git',
        '/repo/frontend-feature-authentication-with-a-long-name',
        false,
    ]);
    await page.setContent(`<!doctype html><html><body class="steward-sidebar">
        <div class="open-session-surface" data-open-session-surface data-id="project-a" data-current-workspace>
            ${getAiSessionsDiv({
                id: 'project-a',
                activeAiSessionProvider: 'codex',
                selectedAiSessionProviders: ['codex'],
                activeAiSessionTab: 'chats',
                codexSessions: [],
                kimiSessions: [],
                claudeSessions: [],
                activeAiSessions: [],
                windowViewState: {
                    tab: 'chats',
                    chatsViewMode: 'tree',
                    collapsedWorktreeGroups: [collapsedKey],
                },
                worktrees: [
                    {
                        kind: 'ready',
                        git: {
                            key: frontendKey,
                            branchRef: 'refs/heads/frontend/feature-authentication-with-a-long-name',
                            head: 'a'.repeat(40),
                            isMain: false,
                            isBare: false,
                            health: 'normal',
                            headKind: 'branch',
                        },
                        activity: 'attention',
                        sessions: [],
                        authority: { canResume: true, canRemove: true },
                    },
                    worktree(backendKey, 'refs/heads/backend', 'idle'),
                ],
                worktreeSnapshotRevision: 1,
                worktreeRepositoryCount: 1,
                bareWorktreeCount: 0,
            })}
        </div>
    </body></html>`);

    const collapsed = page.locator('.ai-session-worktree-group[data-worktree-collapsed]');
    assert.equal(await collapsed.count(), 1);
    assert.equal(
        await collapsed.first().getAttribute('data-worktree-path'),
        '/repo/frontend-feature-authentication-with-a-long-name',
    );
    assert.equal(
        await collapsed.first().locator('.ai-session-worktree-header').getAttribute('aria-expanded'),
        'false',
    );
    assert.equal(
        await page.locator('.ai-session-worktree-group:not(.ai-session-worktree-anchor):not([data-worktree-collapsed])').count(),
        1,
        'the other group stays expanded',
    );
});
