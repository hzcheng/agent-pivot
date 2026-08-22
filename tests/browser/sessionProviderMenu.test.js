'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { createFakeVscode } = require('../helpers/fakeVscode');

function loadWebviewContent() {
    const vscode = createFakeVscode({});
    vscode.Uri = {
        file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }),
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../out/webview/webviewContent');
    } finally {
        Module._load = previousLoad;
    }
}

const { getAiSessionsDiv } = loadWebviewContent();

const viewStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewAiSessionViewStateScripts.js'),
    'utf8'
);
const workspaceUpdateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewWorkspaceUpdateScripts.js'),
    'utf8'
);
const projectCollapseScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectCollapseScripts.js'),
    'utf8'
);
const projectContextMenuScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectContextMenuScripts.js'),
    'utf8'
);
const projectAiUpdateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectAiUpdateScripts.js'),
    'utf8'
);
const aiSessionControlsScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectAiSessionControlsScripts.js'),
    'utf8'
);
const groupFormScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewGroupFormScripts.js'),
    'utf8'
);
const projectScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectScripts.js'),
    'utf8'
);
const scrollStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewScrollStateScripts.js'),
    'utf8'
);

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function getSessionSurface(id, selectedProviders = ['codex']) {
    return {
        id,
        activeAiSessionProvider: selectedProviders[0],
        selectedAiSessionProviders: selectedProviders,
        activeAiSessionTab: 'sessions',
        codexSessions: [{ id: `${id}-codex`, name: 'Codex history', provider: 'codex' }],
        kimiSessions: [{ id: `${id}-kimi`, name: 'Kimi history', provider: 'kimi' }],
        claudeSessions: [{ id: `${id}-claude`, name: 'Claude history', provider: 'claude' }],
        activeAiSessions: [],
    };
}

async function openMenuPage(t, selectedProviders = ['codex']) {
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
    t.after(() => page.close());
    const firstPanel = getAiSessionsDiv(getSessionSurface('project-a', selectedProviders));
    const secondPanel = getAiSessionsDiv(getSessionSurface('project-b', ['kimi']));

    await page.setContent(`<!doctype html>
        <html>
            <body class="steward-sidebar">
                <div class="steward-sticky-header"></div>
                <div class="sticky-groups-wrapper">
                    <div class="open-current-workspace-group">
                        <div class="project workspace-card" data-id="project-a" data-current-workspace
                            data-workspace-scope-identity="scope-project-a"
                            data-workspace-navigation-identity="navigation-project-a">${firstPanel}</div>
                    </div>
                    <div class="project workspace-card" data-id="project-b"
                        data-workspace-navigation-identity="navigation-project-b">${secondPanel}</div>
                </div>
                <button type="button" id="outside">Outside</button>
            </body>
        </html>`);
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.normalizeDashboardSearchCatalog = catalog => catalog;
        window.vscode = {
            getState: () => undefined,
            setState: () => undefined,
            postMessage: message => window.__postedMessages.push(message),
        };
    });
    await page.addScriptTag({ content: scrollStateScript });
    await page.addScriptTag({ content: viewStateScript });
    await page.addScriptTag({ content: workspaceUpdateScript });
    await page.addScriptTag({ content: projectCollapseScript });
    await page.addScriptTag({ content: projectContextMenuScript });
    await page.addScriptTag({ content: projectAiUpdateScript });
    await page.addScriptTag({ content: groupFormScript });
    await page.addScriptTag({ content: aiSessionControlsScript });
    await page.addScriptTag({ content: projectScript });
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
    });
    return page;
}

function getAiSessionsUpdateHtml(selectedProviders) {
    return `<div class="open-current-workspace-group">
        <div class="project workspace-card" data-id="project-a" data-current-workspace
            data-workspace-scope-identity="scope-project-a"
            data-workspace-navigation-identity="navigation-project-a">
            ${getAiSessionsDiv(getSessionSurface('project-a', selectedProviders))}
        </div>
    </div>`;
}

async function postAiSessionsUpdate(page, selectedProviders, sequence) {
    const html = getAiSessionsUpdateHtml(selectedProviders);
    await page.evaluate(({ html, sequence }) => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'ai-sessions-updated',
            version: 3,
            sequence,
            projectionRevision: sequence,
            generatedAt: '2026-08-11T00:00:00.000Z',
            currentWorkspaceCount: 1,
            html,
            searchCatalog: {
                version: 3,
                sessions: [],
                worktrees: [],
                openWorkspaces: [],
                savedProjects: [], todos: [],
            },
            presentation: {
                type: 'ai-session-presentation-state',
                version: 1,
                projectionRevision: sequence,
                workspaceScopeIdentity: 'scope-project-a',
                workspaceNavigationIdentity: 'navigation-project-a',
                attentionCount: 0,
                activeAttentionCount: 0,
                runningSessionCount: 0,
                runningCardAnimation: 'current',
                runningIconAnimation: 'current',
                revealFocused: false,
                focusedTarget: null,
                attentionSessions: [],
                sessions: [],
            },
        } }));
    }, { html, sequence });
}

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 AI-SESSION-PROVIDER-MENU-001 opens and posts the complete selected provider set', async t => {
    const page = await openMenuPage(t);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');

    await trigger.click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await project.locator('[data-ai-provider-option][data-provider="claude"]').click();
    assert.deepEqual(await page.evaluate(() => window.__postedMessages.at(-1)), {
        type: 'select-ai-session-providers',
        version: 1,
        requestId: 1,
        projectId: 'project-a',
        selectedProviders: ['codex', 'claude'],
    });
});

test('AI-SESSION-PROVIDER-MENU-002 refuses pointer and keyboard removal of the last provider', async t => {
    const page = await openMenuPage(t);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');
    const codex = project.locator('[data-ai-provider-option][data-provider="codex"]');

    await trigger.click();
    assert.equal(await codex.getAttribute('aria-disabled'), 'true');
    await codex.click({ force: true });
    await codex.focus();
    await codex.press('Space');
    assert.deepEqual(await page.evaluate(() => window.__postedMessages), []);
});

test('AI-SESSION-PROVIDER-MENU-003 supports roving keyboard focus and Escape restoration', async t => {
    const page = await openMenuPage(t);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');
    const codex = project.locator('[data-ai-provider-option][data-provider="codex"]');
    const kimi = project.locator('[data-ai-provider-option][data-provider="kimi"]');
    const claude = project.locator('[data-ai-provider-option][data-provider="claude"]');

    await trigger.click();
    await trigger.press('ArrowDown');
    assert.equal(await codex.evaluate(element => document.activeElement === element), true);
    await codex.press('ArrowDown');
    assert.equal(await kimi.evaluate(element => document.activeElement === element), true);
    await kimi.press('End');
    assert.equal(await claude.evaluate(element => document.activeElement === element), true);
    await claude.press('Home');
    assert.equal(await codex.evaluate(element => document.activeElement === element), true);
    await codex.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await project.locator('[data-ai-provider-menu]').getAttribute('hidden'), '');
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
});

test('AI-SESSION-PROVIDER-MENU-004 activates options with Space and Enter', async t => {
    const spacePage = await openMenuPage(t);
    const spaceProject = spacePage.locator('.project[data-id="project-a"]');
    const spaceTrigger = spaceProject.locator('[data-ai-provider-menu-trigger]');
    const spaceKimi = spaceProject.locator('[data-ai-provider-option][data-provider="kimi"]');

    await spaceTrigger.click();
    await spaceTrigger.press('ArrowDown');
    await spaceKimi.focus();
    await spaceKimi.press('Space');
    assert.deepEqual(await spacePage.evaluate(() => window.__postedMessages.at(-1)), {
        type: 'select-ai-session-providers',
        version: 1,
        requestId: 1,
        projectId: 'project-a',
        selectedProviders: ['codex', 'kimi'],
    });

    const enterPage = await openMenuPage(t);
    const enterProject = enterPage.locator('.project[data-id="project-a"]');
    const enterTrigger = enterProject.locator('[data-ai-provider-menu-trigger]');
    const enterKimi = enterProject.locator('[data-ai-provider-option][data-provider="kimi"]');
    await enterTrigger.click();
    await enterKimi.focus();
    await enterKimi.press('Enter');
    assert.deepEqual(await enterPage.evaluate(() => window.__postedMessages.at(-1)), {
        type: 'select-ai-session-providers',
        version: 1,
        requestId: 1,
        projectId: 'project-a',
        selectedProviders: ['codex', 'kimi'],
    });
});

test('AI-SESSION-PROVIDER-MENU-005 keeps one popup open and closes it on outside click', async t => {
    const page = await openMenuPage(t);
    const firstProject = page.locator('.project[data-id="project-a"]');
    const secondProject = page.locator('.project[data-id="project-b"]');
    const firstTrigger = firstProject.locator('[data-ai-provider-menu-trigger]');
    const secondTrigger = secondProject.locator('[data-ai-provider-menu-trigger]');

    await firstTrigger.click();
    await secondTrigger.click();
    assert.equal(await firstTrigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await secondTrigger.getAttribute('aria-expanded'), 'true');
    await page.locator('#outside').click();
    assert.equal(await secondTrigger.getAttribute('aria-expanded'), 'false');
});

test('AI-SESSION-PROVIDER-MENU-006 blocks provider changes while a batch archive is pending', async t => {
    const page = await openMenuPage(t);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');
    const claude = project.locator('[data-ai-provider-option][data-provider="claude"]');

    await project.locator('[data-action="manage-ai-sessions"]').click();
    await project.locator('.codex-session-row[data-session-id="project-a-codex"]').click();
    await project.locator('[data-action="archive-selected-ai-sessions"]').click();
    await page.evaluate(() => { window.__postedMessages.length = 0; });
    assert.equal(await trigger.isDisabled(), true);
    assert.equal(await trigger.getAttribute('aria-disabled'), 'true');
    assert.equal(await claude.getAttribute('aria-disabled'), 'true');
    await trigger.click({ force: true });
    await claude.dispatchEvent('click');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(await page.evaluate(() => window.__postedMessages), []);
});

test('AI-SESSION-PROVIDER-MENU-007 selects a hidden search-result provider before revealing it', async t => {
    const page = await openMenuPage(t);

    assert.equal(await page.evaluate(() => window.__agentPivotRevealWorkspaceSession(
        'navigation-project-a',
        'claude',
        'missing-claude-session'
    )), true);
    assert.deepEqual(await page.evaluate(() => window.__postedMessages.at(-1)), {
        type: 'select-ai-session-providers',
        version: 1,
        requestId: 1,
        projectId: 'project-a',
        selectedProviders: ['codex', 'claude'],
    });
});

test('AI-SESSION-PROVIDER-MENU-008 locks stale provider choices until authoritative refresh', async t => {
    const page = await openMenuPage(t);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');
    const claude = project.locator('[data-ai-provider-option][data-provider="claude"]');
    const kimi = project.locator('[data-ai-provider-option][data-provider="kimi"]');

    await trigger.click();
    await claude.click();
    assert.equal(await trigger.isDisabled(), true);
    assert.equal(await trigger.getAttribute('aria-disabled'), 'true');
    await kimi.dispatchEvent('click');
    assert.deepEqual(await page.evaluate(() => window.__postedMessages), [{
        type: 'select-ai-session-providers',
        version: 1,
        requestId: 1,
        projectId: 'project-a',
        selectedProviders: ['codex', 'claude'],
    }]);
});

test('AI-SESSION-PROVIDER-MENU-009 forced Manage cannot bypass provider-selection pending', async t => {
    const page = await openMenuPage(t);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');
    const options = project.locator('[data-ai-provider-option]');

    await trigger.click();
    await project.locator('[data-ai-provider-option][data-provider="claude"]').click();
    await project.locator('[data-action="manage-ai-sessions"]').click({ force: true });

    assert.deepEqual(await page.evaluate(() => window.__agentPivotBatchAiSessions.snapshot()), {
        projectId: null,
        selectedItems: [],
        pending: false,
    });
    assert.equal(await project.getAttribute('data-ai-session-managing'), null);
    assert.equal(await trigger.isDisabled(), true);
    assert.equal(await trigger.getAttribute('aria-disabled'), 'true');
    assert.deepEqual(await options.evaluateAll(elements =>
        elements.map(element => [element.disabled, element.getAttribute('aria-disabled')])
    ), [[true, 'true'], [true, 'true'], [true, 'true']]);
});

test('AI-SESSION-PROVIDER-MENU-010 unlocks success only after a matching authoritative replacement', async t => {
    const page = await openMenuPage(t, ['kimi', 'claude']);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');
    await trigger.click();
    await project.locator('[data-ai-provider-option][data-provider="codex"]').click();

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'ai-session-provider-selection-result',
        version: 1,
        requestId: 1,
        projectId: 'project-b',
        success: false,
    } })));
    await postAiSessionsUpdate(page, ['kimi', 'claude'], 1);
    assert.equal(await trigger.isDisabled(), true);
    assert.equal(await trigger.getAttribute('aria-disabled'), 'true');

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'ai-session-provider-selection-result',
        version: 1,
        requestId: 1,
        projectId: 'project-a',
        success: true,
    } })));
    assert.equal(await trigger.isDisabled(), true);

    await postAiSessionsUpdate(page, ['kimi', 'codex', 'claude'], 2);
    assert.equal(await trigger.isDisabled(), false);
    assert.equal(await trigger.getAttribute('aria-disabled'), 'false');
    assert.equal(
        await project.locator('[data-ai-session-region]')
            .getAttribute('data-selected-ai-session-providers'),
        'kimi,codex,claude'
    );
});

test('AI-SESSION-PROVIDER-MENU-011 correlated stale-target failure unlocks unchanged state and permits retry', async t => {
    const page = await openMenuPage(t);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');
    await trigger.click();
    await project.locator('[data-ai-provider-option][data-provider="claude"]').click();

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'ai-session-provider-selection-result',
        version: 1,
        requestId: 99,
        projectId: 'project-a',
        success: false,
    } })));
    assert.equal(await trigger.isDisabled(), true);

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'ai-session-provider-selection-result',
        version: 1,
        requestId: 1,
        projectId: 'project-a',
        success: false,
    } })));
    assert.equal(await trigger.isDisabled(), false);
    assert.equal(
        await project.locator('[data-ai-session-region]')
            .getAttribute('data-selected-ai-session-providers'),
        'codex'
    );
    assert.equal(
        await project.locator('[data-ai-session-live-region]').textContent(),
        'Could not update AI session providers. Try again.'
    );

    await trigger.click();
    await project.locator('[data-ai-provider-option][data-provider="kimi"]').click();
    assert.deepEqual(await page.evaluate(() => window.__postedMessages.at(-1)), {
        type: 'select-ai-session-providers',
        version: 1,
        requestId: 2,
        projectId: 'project-a',
        selectedProviders: ['codex', 'kimi'],
    });
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 preserves an open provider popup and matching focus across authoritative replacements', async t => {
    const page = await openMenuPage(t, ['codex', 'claude']);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');

    await trigger.click();
    await postAiSessionsUpdate(page, ['codex', 'claude'], 1);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await project.locator('[data-ai-provider-menu]').isHidden(), false);
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);

    const claude = project.locator('[data-ai-provider-option][data-provider="claude"]');
    await claude.focus();
    await postAiSessionsUpdate(page, ['codex', 'claude'], 2);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await project.locator('[data-ai-provider-menu]').isHidden(), false);
    assert.equal(await claude.evaluate(element => document.activeElement === element), true);
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 does not restore a provider popup or hidden focus after selection submission', async t => {
    const page = await openMenuPage(t);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');
    const kimi = project.locator('[data-ai-provider-option][data-provider="kimi"]');

    await trigger.click();
    await project.locator('[data-ai-provider-option][data-provider="claude"]').click();
    await page.evaluate(() => {
        const projectElement = document.querySelector('.project[data-id="project-a"]');
        const staleTrigger = projectElement.querySelector('[data-ai-provider-menu-trigger]');
        staleTrigger.setAttribute('aria-expanded', 'true');
        projectElement.querySelector('[data-ai-provider-menu]').hidden = false;
        projectElement.querySelector('[data-ai-provider-option][data-provider="kimi"]').focus();
    });
    await postAiSessionsUpdate(page, ['codex', 'claude'], 1);

    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await project.locator('[data-ai-provider-menu]').isHidden(), true);
    assert.equal(await kimi.evaluate(element => document.activeElement === element), false);
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 does not restore a provider popup or hidden focus while batch archive is pending', async t => {
    const page = await openMenuPage(t);
    const project = page.locator('.project[data-id="project-a"]');
    const trigger = project.locator('[data-ai-provider-menu-trigger]');
    const kimi = project.locator('[data-ai-provider-option][data-provider="kimi"]');

    await project.locator('[data-action="manage-ai-sessions"]').click();
    await project.locator('.codex-session-row[data-session-id="project-a-codex"]').click();
    await project.locator('[data-action="archive-selected-ai-sessions"]').click();
    await page.evaluate(() => {
        const projectElement = document.querySelector('.project[data-id="project-a"]');
        const staleTrigger = projectElement.querySelector('[data-ai-provider-menu-trigger]');
        staleTrigger.setAttribute('aria-expanded', 'true');
        projectElement.querySelector('[data-ai-provider-menu]').hidden = false;
        projectElement.querySelector('[data-ai-provider-option][data-provider="kimi"]').focus();
    });
    await postAiSessionsUpdate(page, ['codex'], 1);

    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await project.locator('[data-ai-provider-menu]').isHidden(), true);
    assert.equal(await kimi.evaluate(element => document.activeElement === element), false);
});

test('PERSIST-MULTI-PROVIDER-BATCH-ARCHIVE-001 announces partial and malformed aggregate outcomes in the polite live region', async t => {
    const page = await openMenuPage(t, ['codex', 'claude']);
    const project = page.locator('.project[data-id="project-a"]');
    const liveRegion = project.locator('[data-ai-session-live-region]');

    await project.locator('[data-action="manage-ai-sessions"]').click();
    await project.locator('[data-action="select-unpinned-ai-sessions"]').click();
    await project.locator('[data-action="archive-selected-ai-sessions"]').click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 1,
        projectId: 'project-a',
        status: 'finished',
        result: {
            archived: [{ provider: 'codex', sessionId: 'codex-sensitive-id' }],
            running: [],
            missing: [],
            rejected: [],
            rejectedCount: 0,
            failed: [{ provider: 'claude', sessionId: 'claude-sensitive-id' }],
            malformedCount: 0,
        },
    } })));
    assert.equal(await liveRegion.textContent(), 'Archived 1 AI session; 1 session failed.');

    await project.locator('[data-action="manage-ai-sessions"]').click();
    await project.locator('[data-action="select-unpinned-ai-sessions"]').click();
    await project.locator('[data-action="archive-selected-ai-sessions"]').click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'ai-session-batch-archive-completed',
        version: 1,
        requestId: 2,
        projectId: 'project-a',
        status: 'finished',
        result: {
            archived: { length: 1 },
            running: [],
            missing: [],
            rejected: [],
            rejectedCount: 0,
            failed: [],
            malformedCount: 0,
        },
    } })));
    assert.equal(
        await liveRegion.textContent(),
        'Archive completed, but its result summary was unavailable.'
    );
});
