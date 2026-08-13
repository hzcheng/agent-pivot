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
        activeAiSessionTab: 'sessions',
        codexSessions: [{
            id: 'frontend-session',
            name: 'Implement the responsive worktree session grouping experience',
            provider: 'codex',
            worktreeKey: frontendKey,
        }],
        kimiSessions: [],
        claudeSessions: [],
        activeAiSessions: [],
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
        <div class="project workspace-card" data-id="project-a" data-current-workspace>
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

    assert.equal(await page.locator('[data-ai-session-grouping-select]').inputValue(), 'worktree');
    assert.equal(await page.locator('.codex-session-row[data-session-id="frontend-session"]').count(), 1);
    assert.equal(await page.locator('.ai-session-worktree-header').count(), 2);
    assert.equal(await page.locator('.ai-session-worktree-quick-create').count(), 2);
    assert.equal(await page.locator('[data-action="remove-managed-worktree"]').count(), 1);
    assert.equal(await page.locator('.ai-session-provisioning-row').count(), 1);
    assert.equal(await page.locator('[data-action="cancel-isolated-session"]').isVisible(), true);
    assert.equal(
        await page.locator('.ai-session-worktree-quick-create').first().getAttribute('aria-label'),
        'New Codex session in frontend/feature-authentication-with-a-long-name'
    );
    const layout = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        projectWidth: document.querySelector('.project').getBoundingClientRect().width,
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
        applyAiSessionGroupingDom(document.querySelector('.project'), 'flat', true);
    });
    assert.equal(await page.locator('.codex-sessions').getAttribute('data-ai-session-grouping'), 'flat');
    assert.equal(await page.locator('.codex-session-row[data-session-id="frontend-session"]').count(), 1,
        'Flat and Worktree modes must keep one authoritative session node');
    assert.equal(await page.locator('.ai-session-worktree-header').first().isVisible(), false);
});

test('WORKTREE-GROUPING-UI-001 renders Worktree and Flat modes at the default sidebar width', async t => {
    const page = await openSurfacePage(320);
    t.after(() => page.close());

    const section = page.locator('.codex-sessions');
    const chip = page.locator('.ai-session-worktree-chip');
    assert.equal(await section.getAttribute('data-ai-session-grouping'), 'worktree');
    assert.equal(await page.locator('.ai-session-worktree-header').first().isVisible(), true);
    assert.equal(await chip.isVisible(), false);
    const worktreeScreenshot = await page.screenshot({ fullPage: true });
    assert.ok(worktreeScreenshot.length > 1_000,
        'default-width Worktree screenshot must contain rendered pixels');

    await page.evaluate(() => {
        applyAiSessionGroupingDom(document.querySelector('.project'), 'flat', true);
    });
    assert.equal(await section.getAttribute('data-ai-session-grouping'), 'flat');
    assert.equal(await chip.isVisible(), true);
    assert.equal(await page.locator('.codex-session-row[data-session-id="frontend-session"]').count(), 1);
    const flatScreenshot = await page.screenshot({ fullPage: true });
    assert.ok(flatScreenshot.length > 1_000,
        'default-width Flat screenshot must contain rendered pixels');
});
