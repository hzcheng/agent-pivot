'use strict';

// Covers WEBVIEW-OPEN-TAB-SPLIT-001 (OPEN tab independent CURRENT WINDOW /
// OPEN WINDOWS scroll regions with a draggable, keyboard-accessible,
// persisted separator).

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

const { getStewardContent } = loadWebviewContent();
const dashboardStyles = fs.readFileSync(
    path.join(__dirname, '../../media/styles.css'),
    'utf8'
);
const scrollStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewScrollStateScripts.js'),
    'utf8'
);
const aiSessionViewStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewAiSessionViewStateScripts.js'),
    'utf8'
);
const dashboardValidationScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewDashboardValidationScripts.js'),
    'utf8'
);
const workspaceUpdateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewWorkspaceUpdateScripts.js'),
    'utf8'
);
const openTabSplitScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewOpenTabSplitScripts.js'),
    'utf8'
);

const BROWSER_CONDITION_TIMEOUT_MS = 5_000;
const OPEN_TAB_PANE_MIN_PX = 72;
// Mirrors OPEN_TAB_PANE_MIN_EXPANDED_PX in webviewOpenTabSplitScripts.js.
const OPEN_TAB_PANE_MIN_EXPANDED_PX = 250;

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function makeWorkspaceCard(overrides = {}) {
    const kind = overrides.kind || 'current';
    const index = overrides.index ?? 0;
    return {
        id: overrides.id || (kind === 'current' ? 'current' : `navigation-${index}`),
        kind,
        workspaceKind: 'singleFolder',
        showSaveAction: false,
        runningSessionCount: 0,
        navigationIdentity: `navigation:${kind}:${index}`,
        scopeIdentity: `scope:${kind}:${index}`,
        name: kind === 'current' ? 'Current' : `Other ${index}`,
        environment: 'local',
        environmentLabel: 'Local',
        color: '#00aacc',
        roots: [{ id: `root:${kind}:${index}`, name: 'work', ordinal: 0 }],
        attentionCount: 0,
    };
}

function makeWorkspaceCards(navigationCount) {
    const cards = [makeWorkspaceCard()];
    for (let index = 0; index < navigationCount; index += 1) {
        cards.push(makeWorkspaceCard({ kind: 'navigation', index }));
    }
    return cards;
}

function dashboardDocument(cards, isSidebar) {
    return getStewardContent(
        { extensionPath: '/extension' },
        {
            cspSource: 'https://assets.test',
            asWebviewUri: resource => ({
                toString: () => `https://assets.test/${path.basename(resource.fsPath)}`,
            }),
        },
        [],
        {
            config: { get: (_key, fallback) => fallback },
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            otherStorageHasData: false,
        },
        isSidebar,
        cards,
        'ready',
    )
        .replace(/<meta[^>]*Content-Security-Policy[^>]*>/, '')
        .replace(/<link[^>]*rel="stylesheet"[^>]*>/, '')
        .replace(/<script src="[^"]*webviewDashboardBundle\.js[^"]*"><\/script>/, '')
        .replace('</head>', `<style>${dashboardStyles}</style></head>`)
        .replace('class="dashboard-styles-pending"', '');
}

// Boots only the OPEN tab split module (plus the optional scroll-state and
// workspace-update helpers) against the real dashboard document; the sticky
// header offset the bundle normally maintains is applied once here.
async function openDashboardPage(t, { width, height, isSidebar = false, cards, initialState, withWorkspaceUpdate = false } = {}) {
    const page = await browser.newPage({ viewport: { width, height } });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(dashboardDocument(cards || makeWorkspaceCards(10), isSidebar), {
        waitUntil: 'load',
    });
    await page.evaluate(payload => {
        window.vscode = {
            _state: payload.initialState || {},
            getState() { return this._state; },
            setState(next) { this._state = next; },
            postMessage() { return undefined; },
        };
        eval(payload.sources.scrollState);
        if (payload.withWorkspaceUpdate) {
            eval(payload.sources.aiSessionViewState);
            eval(payload.sources.dashboardValidation);
            eval(payload.sources.workspaceUpdate);
            window.applyOpenWorkspacesUpdate = applyOpenWorkspacesUpdate;
        }
        eval(payload.sources.openTabSplit);
        const header = document.querySelector('.steward-sticky-header');
        document.body.style.setProperty('--steward-sticky-header-height',
            `${Math.ceil(header.getBoundingClientRect().height)}px`);
        window.__split = initOpenTabSplit();
    }, {
        initialState: initialState || null,
        withWorkspaceUpdate: Boolean(withWorkspaceUpdate),
        sources: {
            scrollState: scrollStateScript,
            aiSessionViewState: aiSessionViewStateScript,
            dashboardValidation: dashboardValidationScript,
            workspaceUpdate: workspaceUpdateScript,
            openTabSplit: openTabSplitScript,
        },
    });
    return page;
}

function openTabGeometry(page) {
    return page.evaluate(() => {
        const rect = selector => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, height: box.height };
        };
        const listState = selector => {
            const element = document.querySelector(selector);
            if (!element) return null;
            return {
                scrollTop: element.scrollTop,
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight,
                overflowY: getComputedStyle(element).overflowY,
            };
        };
        const wrapper = document.querySelector('#dashboard-tab-open .sticky-groups-wrapper');
        const resizer = document.querySelector('[data-open-tab-split-resizer]');
        const currentGroupEl = document.querySelector('#dashboard-tab-open .open-current-workspace-group');
        const currentTitle = currentGroupEl.querySelector('.group-title');
        const currentListEl = currentGroupEl.querySelector('.group-list');
        return {
            viewportHeight: window.innerHeight,
            bodyScrollHeight: document.scrollingElement.scrollHeight,
            bodyScrollY: window.scrollY,
            header: rect('.steward-sticky-header'),
            panel: rect('#dashboard-tab-open'),
            currentGroup: rect('#dashboard-tab-open .open-current-workspace-group'),
            otherGroup: rect('#dashboard-tab-open .open-other-windows-group'),
            currentGroupMaxHeight: getComputedStyle(
                document.querySelector('#dashboard-tab-open .open-current-workspace-group')
            ).maxHeight,
            currentContentHeight: (currentTitle ? currentTitle.offsetHeight : 0)
                + (currentListEl ? currentListEl.scrollHeight : 0),
            resizer: rect('[data-open-tab-split-resizer]'),
            resizerHidden: resizer ? resizer.hidden : null,
            resizerValueNow: resizer ? resizer.getAttribute('aria-valuenow') : null,
            manual: wrapper.classList.contains('open-tab-split-manual'),
            shareProperty: wrapper.style.getPropertyValue('--open-tab-current-share'),
            currentList: listState('#dashboard-tab-open .open-current-workspace-group .group-list'),
            otherList: listState('#dashboard-tab-open .open-other-windows-group .group-list'),
        };
    });
}

test('WEBVIEW-OPEN-TAB-SPLIT-001 lays out two independently scrolling window regions', async t => {
    for (const config of [
        { width: 800, height: 600, isSidebar: false },
        { width: 240, height: 480, isSidebar: true },
    ]) {
        const page = await openDashboardPage(t, config);
        const before = await openTabGeometry(page);
        const label = `width ${config.width}`;

        assert.ok(
            Math.abs(before.panel.height - (before.viewportHeight - before.header.height)) <= 1,
            `${label}: the OPEN panel must own the viewport below the sticky header `
                + `(panel ${before.panel.height}, viewport ${before.viewportHeight}, header ${before.header.height})`
        );
        assert.ok(
            before.bodyScrollHeight <= before.viewportHeight + 1,
            `${label}: the body must not scroll (scrollHeight ${before.bodyScrollHeight})`
        );
        assert.ok(
            before.otherList.scrollHeight > before.otherList.clientHeight,
            `${label}: OPEN WINDOWS must overflow its own region`
        );
        assert.equal(before.otherList.overflowY, 'auto', `${label}: OPEN WINDOWS list scrolls`);
        assert.equal(before.currentList.overflowY, 'auto', `${label}: CURRENT WINDOW list scrolls`);
        assert.ok(
            before.currentGroup.height <= before.panel.height / 2 + 1,
            `${label}: auto layout caps CURRENT WINDOW at half the panel `
                + `(height ${before.currentGroup.height}, panel ${before.panel.height})`
        );
        if (before.currentContentHeight <= before.panel.height / 2) {
            assert.ok(
                before.currentList.scrollHeight <= before.currentList.clientHeight + 1,
                `${label}: CURRENT WINDOW shows its full card when it fits under the cap `
                    + `(list scrollHeight ${before.currentList.scrollHeight}, `
                    + `clientHeight ${before.currentList.clientHeight})`
            );
        } else {
            assert.ok(
                Math.abs(before.currentGroup.height - before.panel.height / 2) <= 2,
                `${label}: CURRENT WINDOW pins to the half-panel cap when its content overflows `
                    + `(height ${before.currentGroup.height}, panel ${before.panel.height})`
            );
        }
        assert.ok(
            before.resizer.top >= before.currentGroup.bottom - 1
                && before.otherGroup.top >= before.resizer.bottom
                && before.otherGroup.top - before.currentGroup.bottom <= 24,
            `${label}: the separator must sit between the two regions `
                + `(current bottom ${before.currentGroup.bottom}, `
                + `resizer ${before.resizer.top}-${before.resizer.bottom}, `
                + `other top ${before.otherGroup.top})`
        );
        assert.equal(before.resizerHidden, false, `${label}: separator starts visible`);
        assert.equal(before.manual, false, `${label}: auto layout has no dragged share`);

        const scrolled = await page.evaluate(() => {
            const otherList = document.querySelector(
                '#dashboard-tab-open .open-other-windows-group .group-list'
            );
            otherList.scrollTop = 120;
            return otherList.scrollTop;
        });
        assert.ok(scrolled > 0, `${label}: OPEN WINDOWS region accepts scroll`);

        const after = await openTabGeometry(page);
        assert.equal(after.bodyScrollY, 0, `${label}: scrolling OPEN WINDOWS must not move the page`);
        assert.equal(after.currentList.scrollTop, 0,
            `${label}: scrolling OPEN WINDOWS must not scroll CURRENT WINDOW`);
        assert.ok(
            Math.abs(after.currentGroup.top - before.currentGroup.top) <= 1,
            `${label}: the CURRENT WINDOW region stays put while OPEN WINDOWS scrolls`
        );
    }
});

test('WEBVIEW-OPEN-TAB-SPLIT-001 drags the separator to resize regions and persists the share', async t => {
    const page = await openDashboardPage(t, { width: 800, height: 600 });
    const initial = await openTabGeometry(page);
    const startHeight = initial.currentGroup.height;
    const resizerCenter = initial.resizer.top + initial.resizer.height / 2;
    const inner = initial.panel.height - initial.resizer.height;

    await page.mouse.move(400, resizerCenter);
    await page.mouse.down();
    await page.mouse.move(400, resizerCenter + 100, { steps: 5 });
    const duringDrag = await openTabGeometry(page);
    assert.ok(
        Math.abs(duringDrag.currentGroup.height - (startHeight + 100)) <= 3,
        `dragging down 100px must grow CURRENT WINDOW (was ${startHeight}, now `
            + `${duringDrag.currentGroup.height})`
    );
    assert.ok(
        Math.abs(duringDrag.otherGroup.height - (initial.otherGroup.height - 100)) <= 3,
        'the growth must come out of the OPEN WINDOWS region'
    );
    assert.equal(duringDrag.manual, true, 'dragging switches to the manual share layout');
    assert.ok(duringDrag.shareProperty.endsWith('%'), 'the share is applied as a percentage');
    await page.mouse.up();

    const afterDrag = await openTabGeometry(page);
    const expectedShare = (startHeight + 100) / initial.panel.height;
    const persisted = await page.evaluate(() => window.vscode.getState());
    assert.ok(
        Math.abs(persisted.openTab.currentWindowShare - expectedShare) <= 0.02,
        `the share persists in webview view state `
            + `(expected ~${expectedShare}, got ${persisted.openTab.currentWindowShare})`
    );
    const expectedAriaPercent = Math.round((startHeight + 100) / inner * 100);
    assert.equal(afterDrag.resizerValueNow, String(expectedAriaPercent),
        'aria-valuenow tracks the dragged percentage of the pane space');

    // Shrink CURRENT WINDOW to the minimum: its list must then scroll while
    // OPEN WINDOWS keeps its own scroll position.
    const shrunk = await openTabGeometry(page);
    const shrunkResizerCenter = shrunk.resizer.top + shrunk.resizer.height / 2;
    await page.mouse.move(400, shrunkResizerCenter);
    await page.mouse.down();
    await page.mouse.move(400, shrunkResizerCenter - 1000, { steps: 8 });
    await page.mouse.up();
    const clamped = await openTabGeometry(page);
    assert.ok(
        Math.abs(clamped.currentGroup.height - OPEN_TAB_PANE_MIN_PX) <= 2,
        `the drag clamps at the pane minimum (got ${clamped.currentGroup.height})`
    );
    assert.ok(
        clamped.currentList.scrollHeight > clamped.currentList.clientHeight,
        'the squeezed CURRENT WINDOW region overflows'
    );
    const independence = await page.evaluate(() => {
        const currentList = document.querySelector(
            '#dashboard-tab-open .open-current-workspace-group .group-list'
        );
        currentList.scrollTop = 40;
        return {
            currentScrollTop: currentList.scrollTop,
            otherScrollTop: document.querySelector(
                '#dashboard-tab-open .open-other-windows-group .group-list'
            ).scrollTop,
            bodyScrollY: window.scrollY,
        };
    });
    assert.ok(independence.currentScrollTop > 0, 'CURRENT WINDOW region accepts scroll');
    assert.equal(independence.otherScrollTop, 0,
        'scrolling CURRENT WINDOW must not scroll OPEN WINDOWS');
    assert.equal(independence.bodyScrollY, 0,
        'scrolling CURRENT WINDOW must not move the page');

    // Keyboard: ArrowDown grows the pane above the separator by one step.
    const beforeKeys = await openTabGeometry(page);
    await page.focus('[data-open-tab-split-resizer]');
    await page.keyboard.press('ArrowDown');
    const afterArrow = await openTabGeometry(page);
    assert.ok(
        Math.abs(afterArrow.currentGroup.height - (beforeKeys.currentGroup.height + 24)) <= 2,
        `ArrowDown grows CURRENT WINDOW by one 24px step (was ${beforeKeys.currentGroup.height}, `
            + `now ${afterArrow.currentGroup.height})`
    );
    const afterKeyState = await page.evaluate(() => window.vscode.getState());
    assert.ok(afterKeyState.openTab.currentWindowShare > 0
        && afterKeyState.openTab.currentWindowShare < 1,
        'keyboard resizing also persists the share');
});

test('WEBVIEW-OPEN-TAB-SPLIT-001 restores the persisted share on init', async t => {
    const page = await openDashboardPage(t, {
        width: 800,
        height: 600,
        initialState: { openTab: { currentWindowShare: 0.3 } },
    });
    const geometry = await openTabGeometry(page);
    const inner = geometry.panel.height - geometry.resizer.height;
    assert.equal(geometry.manual, true, 'a persisted share enables the manual layout');
    assert.ok(
        Math.abs(geometry.currentGroup.height - geometry.panel.height * 0.3) <= 2,
        `CURRENT WINDOW restores to ~30% of the split (expected ~${geometry.panel.height * 0.3}, `
            + `got ${geometry.currentGroup.height})`
    );
    const expectedAriaPercent = Math.round(geometry.currentGroup.height / inner * 100);
    assert.equal(geometry.resizerValueNow, String(expectedAriaPercent),
        'aria-valuenow reflects the restored share');
});

test('WEBVIEW-OPEN-TAB-SPLIT-001 hides the separator while OPEN WINDOWS is collapsed', async t => {
    const page = await openDashboardPage(t, { width: 800, height: 600 });
    await page.evaluate(() => {
        document.querySelector('#dashboard-tab-open .open-other-windows-group')
            .classList.add('collapsed');
        window.__agentPivotOpenTabSplit.sync();
    });
    const geometry = await openTabGeometry(page);
    assert.equal(geometry.resizerHidden, true, 'the separator hides while OPEN WINDOWS is collapsed');
    assert.ok(
        geometry.otherGroup.height < 60,
        `the collapsed region releases its space (height ${geometry.otherGroup.height})`
    );
    assert.equal(geometry.bodyScrollHeight <= geometry.viewportHeight + 1, true,
        'collapsing must not reintroduce page scroll');
});

test('WEBVIEW-OPEN-TAB-SPLIT-001 keeps the OPEN WINDOWS scroll anchor across authoritative replacements', async t => {
    const page = await openDashboardPage(t, {
        width: 800,
        height: 600,
        withWorkspaceUpdate: true,
    });

    // Scroll the region, then read the live card identities so the
    // replacement HTML keeps every semantic key.
    const before = await page.evaluate(() => {
        const otherList = document.querySelector(
            '#dashboard-tab-open .open-other-windows-group .group-list'
        );
        const cards = Array.from(otherList.querySelectorAll(
            '.workspace-card[data-open-workspace-list-card][data-workspace-navigation-identity]'
        ));
        otherList.scrollTop = 150;
        const listBox = otherList.getBoundingClientRect();
        const anchorCard = cards.find(card => {
            const box = card.getBoundingClientRect();
            return box.bottom > listBox.top && box.top < listBox.bottom;
        });
        return {
            scrollTop: otherList.scrollTop,
            anchorKey: anchorCard.getAttribute('data-workspace-navigation-identity'),
            anchorOffset: anchorCard.getBoundingClientRect().top - listBox.top,
            scopeIdentity: document.querySelector(
                '#dashboard-tab-open .open-current-workspace-group '
                    + '.workspace-card[data-workspace-scope-identity]'
            ).getAttribute('data-workspace-scope-identity'),
            identities: cards.map(card => ({
                id: card.getAttribute('data-id'),
                nav: card.getAttribute('data-workspace-navigation-identity'),
                isNavigation: card.hasAttribute('data-workspace-navigation'),
                isCurrent: card.hasAttribute('data-open-workspace-current'),
            })),
        };
    });
    assert.ok(before.scrollTop > 0, 'the region must scroll before the update');

    const listCards = before.identities.map(info => '<div class="project-container">'
        + '<div class="workspace-card project steward-item-card" style="height:160px" '
        + `data-id="${info.id}" data-open-workspace-list-card`
        + `${info.isCurrent ? ' data-open-workspace-current' : ''}`
        + `${info.isNavigation ? ' data-workspace-navigation data-other-workspace' : ''}`
        + ` data-workspace-navigation-identity="${info.nav}"></div></div>`
    ).join('');
    const replacementHtml = '<div class="group open-current-workspace-group">'
        + '<div class="group-list">'
        + '<div class="workspace-card project steward-item-card" data-id="current" '
        + `data-current-workspace data-workspace-scope-identity="${before.scopeIdentity}"></div>`
        + '</div></div>'
        + '<div class="group open-other-windows-group" data-other-windows-status="ready">'
        + `<div class="group-list">${listCards}</div></div>`;
    const navigationCount = before.identities.filter(info => info.isNavigation).length;
    const catalog = {
        version: 2,
        sessions: [],
        openWorkspaces: before.identities.map(info => ({
            workspaceId: info.id,
            action: 'switch-open-workspace',
        })),
        savedProjects: [],
        todos: [],
    };

    const after = await page.evaluate(payload => {
        const applied = window.applyOpenWorkspacesUpdate({
            type: 'open-workspaces-updated',
            version: 3,
            semanticRevision: 'scroll-restore',
            currentWorkspaceCount: 1,
            navigationWorkspaceCount: payload.navigationCount,
            otherWindowsStatus: 'ready',
            html: payload.html,
            searchCatalog: payload.catalog,
        });
        const otherList = document.querySelector(
            '#dashboard-tab-open .open-other-windows-group .group-list'
        );
        const anchorCard = otherList.querySelector(
            `[data-workspace-navigation-identity="${payload.anchorKey}"]`
        );
        return {
            applied,
            scrollTop: otherList.scrollTop,
            anchorOffset: anchorCard
                ? anchorCard.getBoundingClientRect().top - otherList.getBoundingClientRect().top
                : null,
        };
    }, { html: replacementHtml, catalog, navigationCount, anchorKey: before.anchorKey });

    assert.equal(after.applied, true, 'the authoritative update must apply');
    assert.ok(
        after.anchorOffset !== null && Math.abs(after.anchorOffset - before.anchorOffset) <= 2,
        `the anchor card must keep its visual offset (was ${before.anchorOffset}, `
            + `now ${after.anchorOffset})`
    );
    assert.ok(after.scrollTop > 0, 'the region must not snap back to the top');
});

// Covers WEBVIEW-CURRENT-WINDOW-SESSION-FIT-001: the expanded CURRENT WINDOW
// card fits its window region (half pane in auto layout, dragged share in
// manual layout) and the session list becomes the only inner scroll surface.
function makeExpandedCurrentWorkspaceCard(sessionCount) {
    const card = makeWorkspaceCard();
    card.aiSessions = {
        workspaceScopeIdentity: card.scopeIdentity,
        workspaceNavigationIdentity: card.navigationIdentity,
        activeProvider: 'codex',
        selectedProviders: ['codex'],
        expanded: true,
        providers: [{ id: 'codex', label: 'Codex', count: sessionCount }],
        sessionsByProvider: {
            codex: Array.from({ length: sessionCount }, (_, index) => ({
                id: `session-${index}`,
                name: `Session ${index}`,
                provider: 'codex',
                primaryRootId: 'root:current:0',
                primaryRootLabel: 'work',
            })),
            kimi: [],
            claude: [],
        },
        unavailableProviders: [],
        activeSessions: [],
        aiSessionCount: sessionCount,
        activeSessionCount: 0,
        attentionCount: 0,
        activeAttentionCount: 0,
        defaultTab: 'sessions',
    };
    return card;
}

function expandedFitGeometry(page) {
    return page.evaluate(() => {
        const group = document.querySelector('#dashboard-tab-open .open-current-workspace-group');
        const groupList = group.querySelector('.group-list');
        const card = group.querySelector('.workspace-card');
        const visiblePanel = group.querySelector('.ai-session-tab-panel:not([hidden])');
        const sessionList = visiblePanel && visiblePanel.querySelector('.codex-sessions-list');
        const rectOf = element => {
            const box = element.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, height: box.height };
        };
        return {
            groupHasFitClass: group.classList.contains('current-card-expanded'),
            group: rectOf(group),
            panel: rectOf(document.querySelector('#dashboard-tab-open')),
            card: rectOf(card),
            cardPaddingBottom: parseFloat(getComputedStyle(card).paddingBottom) || 0,
            groupListBottom: groupList.getBoundingClientRect().bottom,
            groupListOverflowY: getComputedStyle(groupList).overflowY,
            groupListOverhang: groupList.scrollHeight - groupList.clientHeight,
            visiblePanelBottom: visiblePanel ? rectOf(visiblePanel).bottom : null,
            sessionList: sessionList ? {
                clientHeight: sessionList.clientHeight,
                scrollHeight: sessionList.scrollHeight,
                overflowY: getComputedStyle(sessionList).overflowY,
            } : null,
        };
    });
}

test('WEBVIEW-CURRENT-WINDOW-SESSION-FIT-001 fits the expanded CURRENT WINDOW card to its region', async t => {
    // The AI session surface only ships in the sidebar, so the fit layout is
    // scoped there: cover the default and minimum supported sidebar widths.
    for (const config of [
        { width: 360, height: 900, isSidebar: true },
        { width: 240, height: 720, isSidebar: true },
    ]) {
        const cards = [makeExpandedCurrentWorkspaceCard(12), ...makeWorkspaceCards(9).slice(1)];
        const page = await openDashboardPage(t, { ...config, cards });
        const label = `width ${config.width}`;
        const fit = await expandedFitGeometry(page);

        assert.ok(fit.groupHasFitClass, `${label}: the expanded card must mark its group`);
        assert.ok(
            Math.abs(fit.group.height - fit.panel.height / 2) <= 2,
            `${label}: auto layout pins the expanded group to half the pane `
                + `(group ${fit.group.height}, panel ${fit.panel.height})`
        );
        assert.ok(
            Math.abs(fit.card.bottom - fit.groupListBottom) <= 1,
            `${label}: the card fills the group list down to its bottom edge `
                + `(card bottom ${fit.card.bottom}, list bottom ${fit.groupListBottom})`
        );
        assert.ok(
            fit.visiblePanelBottom !== null
                && Math.abs(fit.visiblePanelBottom - (fit.card.bottom - fit.cardPaddingBottom)) <= 1.5,
            `${label}: the visible session panel fills the rest of the card `
                + `(panel bottom ${fit.visiblePanelBottom}, card bottom ${fit.card.bottom}, `
                + `padding ${fit.cardPaddingBottom})`
        );
        assert.equal(fit.groupListOverflowY, 'hidden',
            `${label}: the expanded group list must not be a second scroll surface`);
        assert.ok(fit.groupListOverhang <= 1,
            `${label}: the group list content must fit exactly (overhang ${fit.groupListOverhang})`);
        assert.ok(
            fit.sessionList.scrollHeight > fit.sessionList.clientHeight,
            `${label}: twelve sessions must overflow the fitted list `
                + `(scrollHeight ${fit.sessionList.scrollHeight}, clientHeight ${fit.sessionList.clientHeight})`
        );
        assert.equal(fit.sessionList.overflowY, 'auto',
            `${label}: the session list stays the inner scroll surface`);

        // Collapsing restores the content-sized pane.
        const collapsedGroupHeight = await page.evaluate(() => {
            const groupEl = document.querySelector('#dashboard-tab-open .open-current-workspace-group');
            groupEl.classList.remove('current-card-expanded');
            groupEl.querySelector('.workspace-card').removeAttribute('data-codex-expanded');
            return groupEl.getBoundingClientRect().height;
        });
        assert.ok(
            collapsedGroupHeight < fit.group.height - 50,
            `${label}: collapsing returns the pane to its content height `
                + `(expanded ${fit.group.height}, collapsed ${collapsedGroupHeight})`
        );
    }
});

test('WEBVIEW-CURRENT-WINDOW-SESSION-FIT-001 lets a dragged share size the fitted card', async t => {
    const cards = [makeExpandedCurrentWorkspaceCard(12), ...makeWorkspaceCards(9).slice(1)];
    const page = await openDashboardPage(t, {
        width: 360,
        height: 900,
        isSidebar: true,
        cards,
        initialState: { openTab: { currentWindowShare: 0.7 } },
    });
    const fit = await expandedFitGeometry(page);
    assert.ok(
        Math.abs(fit.group.height - fit.panel.height * 0.7) <= 2,
        `manual layout sizes the expanded group by the dragged share `
            + `(group ${fit.group.height}, expected ~${fit.panel.height * 0.7})`
    );
    assert.ok(
        Math.abs(fit.card.bottom - fit.groupListBottom) <= 1,
        `the card still fills the manually sized region `
            + `(card bottom ${fit.card.bottom}, list bottom ${fit.groupListBottom})`
    );
    assert.ok(
        fit.sessionList.scrollHeight > fit.sessionList.clientHeight,
        'the session list scrolls inside the manually sized card'
    );
});

test('WEBVIEW-CURRENT-WINDOW-SESSION-FIT-001 keeps the AI session chrome reachable at the dragged minimum', async t => {
    const cards = [makeExpandedCurrentWorkspaceCard(12), ...makeWorkspaceCards(9).slice(1)];
    const page = await openDashboardPage(t, {
        width: 360,
        height: 720,
        isSidebar: true,
        cards,
    });

    // Drag far past the top: the expanded pane floor must hold well above the
    // collapsed 72px minimum so the fixed AI session chrome never clips away.
    const geometry = await openTabGeometry(page);
    const resizerCenter = geometry.resizer.top + geometry.resizer.height / 2;
    await page.mouse.move(180, resizerCenter);
    await page.mouse.down();
    await page.mouse.move(180, resizerCenter - 1000, { steps: 8 });
    await page.mouse.up();

    const floor = await openTabGeometry(page);
    assert.ok(
        Math.abs(floor.currentGroup.height - OPEN_TAB_PANE_MIN_EXPANDED_PX) <= 2,
        `the expanded drag clamps at the raised pane floor `
            + `(expected ~${OPEN_TAB_PANE_MIN_EXPANDED_PX}, got ${floor.currentGroup.height})`
    );
    const chrome = await page.evaluate(() => {
        const group = document.querySelector('#dashboard-tab-open .open-current-workspace-group');
        const bottom = group.getBoundingClientRect().bottom;
        const within = selector => {
            const element = group.querySelector(selector);
            return element ? element.getBoundingClientRect().bottom <= bottom + 1 : null;
        };
        const list = group.querySelector('.ai-session-tab-panel:not([hidden]) .codex-sessions-list');
        return {
            moduleHeader: within('.ai-session-module-header'),
            tabs: within('.ai-session-tabs'),
            providerControls: within('.ai-session-provider-controls'),
            listClientHeight: list.clientHeight,
        };
    });
    assert.ok(chrome.moduleHeader, 'the AI SESSIONS header must stay inside the pane');
    assert.ok(chrome.tabs, 'the ACTIVE/SESSIONS tabs must stay inside the pane');
    assert.ok(chrome.providerControls, 'the provider controls must stay inside the pane');
    assert.ok(
        chrome.listClientHeight >= 42,
        `at least one full session row must stay visible (list height ${chrome.listClientHeight})`
    );

    // Keyboard shrinking hits the same raised floor (each ArrowUp steps the
    // pane down 24px and the clamp pulls it back).
    await page.focus('[data-open-tab-split-resizer]');
    for (let step = 0; step < 4; step += 1) {
        await page.keyboard.press('ArrowUp');
    }
    const afterKeys = await openTabGeometry(page);
    assert.ok(
        Math.abs(afterKeys.currentGroup.height - OPEN_TAB_PANE_MIN_EXPANDED_PX) <= 2,
        `ArrowUp clamps at the raised floor while expanded `
            + `(got ${afterKeys.currentGroup.height})`
    );

    // Collapsing restores the collapsed 72px floor.
    await page.evaluate(() => {
        const group = document.querySelector('#dashboard-tab-open .open-current-workspace-group');
        group.classList.remove('current-card-expanded');
        group.querySelector('.workspace-card').removeAttribute('data-codex-expanded');
    });
    for (let step = 0; step < 10; step += 1) {
        await page.keyboard.press('ArrowUp');
    }
    const collapsedFloor = await openTabGeometry(page);
    assert.ok(
        Math.abs(collapsedFloor.currentGroup.height - OPEN_TAB_PANE_MIN_PX) <= 2,
        `the collapsed pane keeps the legacy ${OPEN_TAB_PANE_MIN_PX}px floor `
            + `(got ${collapsedFloor.currentGroup.height})`
    );
});

test('WEBVIEW-CURRENT-WINDOW-SESSION-FIT-001 reconciles below-floor shares for the expanded card', async t => {
    const cards = [makeExpandedCurrentWorkspaceCard(12), ...makeWorkspaceCards(9).slice(1)];

    // A persisted share below the expanded floor is clamped on init, but the
    // stored value keeps the user's drag.
    const persisted = await openDashboardPage(t, {
        width: 360,
        height: 720,
        isSidebar: true,
        cards,
        initialState: { openTab: { currentWindowShare: 0.05 } },
    });
    const restored = await openTabGeometry(persisted);
    assert.ok(
        Math.abs(restored.currentGroup.height - OPEN_TAB_PANE_MIN_EXPANDED_PX) <= 2,
        `init clamps a below-floor persisted share (got ${restored.currentGroup.height})`
    );
    const restoredState = await persisted.evaluate(() => window.vscode.getState());
    assert.ok(
        Math.abs(restoredState.openTab.currentWindowShare - 0.05) < 0.001,
        `the persisted share is not rewritten by the clamp `
            + `(got ${restoredState.openTab.currentWindowShare})`
    );

    // Expanding the card while a dragged share sits below the floor grows the
    // pane through the split module hook (driven by the toggle handler).
    const collapsed = await openDashboardPage(t, {
        width: 360,
        height: 720,
        isSidebar: true,
        initialState: { openTab: { currentWindowShare: 0.11 } },
    });
    const beforeToggle = await openTabGeometry(collapsed);
    assert.ok(
        beforeToggle.currentGroup.height < OPEN_TAB_PANE_MIN_EXPANDED_PX - 50,
        `the collapsed card may sit below the expanded floor (got ${beforeToggle.currentGroup.height})`
    );
    await collapsed.evaluate(() => {
        const group = document.querySelector('#dashboard-tab-open .open-current-workspace-group');
        group.classList.add('current-card-expanded');
        group.querySelector('.workspace-card').setAttribute('data-codex-expanded', '');
        window.__agentPivotOpenTabSplit.syncCurrentPaneMinimum();
    });
    const grown = await openTabGeometry(collapsed);
    assert.ok(
        Math.abs(grown.currentGroup.height - OPEN_TAB_PANE_MIN_EXPANDED_PX) <= 2,
        `expanding raises a below-floor pane to the expanded minimum (got ${grown.currentGroup.height})`
    );
});
