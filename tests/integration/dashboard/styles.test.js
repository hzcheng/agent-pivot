'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const CleanCSS = require('clean-css');
const sass = require('sass');

const root = path.resolve(__dirname, '../../..');
const stylesPath = path.join(root, 'media/styles.scss');
const generatedStylesPath = path.join(root, 'media/styles.css');
const styles = fs.readFileSync(stylesPath, 'utf8');
const generatedStyles = fs.readFileSync(generatedStylesPath, 'utf8');

function extractBlock(source, selector, occurrence = 0) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...source.matchAll(new RegExp(`^\\s*${escaped}\\s*\\{`, 'gm'))];
    assert.ok(matches[occurrence], `missing ${selector}`);
    const start = matches[occurrence].index;
    const opening = source.indexOf('{', start);
    let depth = 0;
    for (let index = opening; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(opening + 1, index);
    }
    assert.fail(`unterminated ${selector}`);
}

function validateReducedMotion(source) {
    const dashboardMotion = extractBlock(source, '@media (prefers-reduced-motion: reduce)', 0);
    for (const value of ['.steward-item-card', '.steward-item-accent', 'transition: none;']) {
        assert.ok(dashboardMotion.includes(value), `WEBVIEW-REDUCED-MOTION-001 missing ${value}`);
    }
    const sessionMotion = extractBlock(source, '@media (prefers-reduced-motion: reduce)', 1);
    for (const value of [
        '.ai-session-attention-indicator',
        '.project.session-running[data-session-fx^="sharingan-"] .project-kind-icon::after',
        'animation: none !important',
        'transition: none !important',
    ]) {
        assert.ok(sessionMotion.includes(value), `WEBVIEW-REDUCED-MOTION-001 missing ${value}`);
    }
}

function validateTodoFocus(source) {
    const focus = extractBlock(source, '.todo-square-toggle:focus-within');
    assert.ok(focus.includes('outline: 1px solid var(--vscode-focusBorder)'),
        'TODO-KEYBOARD-FOCUS-001 missing visible outline');
    assert.ok(focus.includes('outline-offset: 1px'), 'TODO-KEYBOARD-FOCUS-001 missing outline offset');
}

function validateConversationOutlineStyles(source) {
    const rail = extractBlock(source, '.ai-session-conversation-rail');
    for (const value of [
        '--steward-ai-session-conversation-rail-height,\n                168px',
        'overflow-x: hidden;',
        'overflow-y: auto;',
    ]) {
        assert.ok(rail.includes(value),
            `WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 rail missing ${value}`);
    }
    const marker = extractBlock(source, '.ai-session-conversation-marker');
    for (const value of [
        'grid-template-columns: 14px minmax(0, 1fr);',
        'width: 100%;',
        'height: 28px;',
    ]) {
        assert.ok(marker.includes(value),
            `WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 marker missing ${value}`);
    }
    assert.equal(marker.includes('--ai-input-ratio'), false,
        'WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 marker width must not encode input length');
    const preview = extractBlock(
        source,
        '.ai-session-conversation-marker-preview'
    );
    for (const value of [
        'min-width: 0;',
        'overflow: hidden;',
        'text-overflow: ellipsis;',
        'white-space: nowrap;',
    ]) {
        assert.ok(preview.includes(value),
            `WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 preview missing ${value}`);
    }
    const panel = extractBlock(source, '.ai-session-conversation-panel');
    assert.ok(panel.includes('overflow: hidden;'),
        'WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 expanded content must stay inside its card');
}

function validateTodoLayout(source) {
    const list = extractBlock(source, '.todo-list');
    assert.ok(list.includes(
        'max-height: calc(var(--todo-list-max-height) + var(--todo-list-expanded-extra-height, 0px))'
    ), 'TODO-RESPONSIVE-LAYOUT-001 list must honor the configured group viewport');
    assert.ok(list.includes('overflow-y: auto'),
        'TODO-RESPONSIVE-LAYOUT-001 overflowing groups must remain scrollable');
    const title = extractBlock(source, '.todo-title-text');
    for (const value of ['display: -webkit-box', '-webkit-line-clamp: 2', '-webkit-box-orient: vertical',
        'overflow-wrap: anywhere']) {
        assert.ok(title.includes(value), `TODO-RESPONSIVE-LAYOUT-001 title missing ${value}`);
    }
    assert.equal(title.includes('white-space: nowrap'), false,
        'TODO-RESPONSIVE-LAYOUT-001 titles must use both available lines');
    const expanded = extractBlock(source, '.todo-item.expanded');
    assert.ok(expanded.includes('height: var(--todo-expanded-item-height, auto) !important'),
        'TODO-MAX-VISIBLE-PER-GROUP-001 expanded cards must own their measured content height');
    assert.ok(expanded.includes('-webkit-line-clamp: unset'),
        'TODO-RESPONSIVE-LAYOUT-001 inline detail must reveal the complete title');
    const inlineValue = extractBlock(source, '.todo-inline-value');
    assert.ok(inlineValue.includes('overflow-wrap: anywhere') && inlineValue.includes('white-space: pre-wrap'),
        'TODO-RESPONSIVE-LAYOUT-001 inline detail values must wrap without clipping');
    const fixedGroup = extractBlock(source, '.todo-compose-group-fixed');
    assert.ok(fixedGroup.includes('flex: 1 1 0') && fixedGroup.includes('min-height: 28px'),
        'TODO-RESPONSIVE-LAYOUT-001 fixed group must align with the full composer controls');
    const narrow = extractBlock(source, '@media (max-width: 320px)');
    for (const value of ['.todo-compose-meta', 'flex-wrap: wrap']) {
        assert.ok(narrow.includes(value), `TODO-RESPONSIVE-LAYOUT-001 narrow layout missing ${value}`);
    }
}

function validatePromptCompactCardStyles(source) {
    const id = 'WEBVIEW-AI-PROMPT-STYLES-001';
    const itemView = extractBlock(source, '.prompt-item-view');
    assert.ok(
        itemView.includes('grid-template-columns: 24px minmax(0, 1fr)'),
        `${id} collapsed card must reserve only drag and content columns`
    );
    assert.equal(
        itemView.includes('28px'),
        false,
        `${id} collapsed card must not reserve a persistent Insert column`
    );
    const preview = extractBlock(source, '.prompt-preview', 1);
    for (const value of [
        'display: -webkit-box',
        'overflow: hidden',
        '-webkit-box-orient: vertical',
        '-webkit-line-clamp: 2',
    ]) {
        assert.ok(preview.includes(value), `${id} preview missing ${value}`);
    }

    const name = extractBlock(source, '.prompt-name');
    for (const value of ['overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap']) {
        assert.ok(name.includes(value), `${id} name missing ${value}`);
    }

    const management = extractBlock(source, '.prompt-management-actions');
    for (const value of [
        'position: absolute',
        'right: 4px',
        'opacity: 0',
        'pointer-events: none',
    ]) {
        assert.ok(management.includes(value), `${id} management actions missing ${value}`);
    }
    assert.equal(management.includes('display: none'), false, `${id} actions must remain keyboard reachable`);
    assert.equal(management.includes('visibility: hidden'), false, `${id} actions must remain keyboard reachable`);

    const compiled = compileStyles(source);
    const reveal = ruleForSelector(compiled, '.prompt-item:focus-within .prompt-management-actions');
    assert.ok(reveal.selectors.includes('.prompt-item:hover .prompt-management-actions'));
    assertDeclarations(reveal, id, ['opacity: 1', 'pointer-events: auto']);
    assertDeclarations(
        ruleForSelector(compiled, '.prompt-item:focus-within .prompt-title-line'),
        id,
        ['padding-right: 132px']
    );
    assertDeclarations(ruleForSelector(compiled, '.prompt-item-view .prompt-copy-button svg'), id,
        ['fill: none', 'stroke: currentColor']);
    assertDeclarations(ruleForSelector(compiled, '.prompt-insert-button', 'pointer-events: inherit'), id,
        ['opacity: 1', 'pointer-events: inherit']);
    assertDeclarations(ruleForSelector(compiled, '.prompt-insert-button[aria-disabled=true]'), id,
        ['opacity: 0.55', 'cursor: progress']);
    assertDeclarations(ruleForSelector(compiled, '.prompt-item[data-prompt-default=true]'), id,
        ['border-color: var(--vscode-focusBorder)']);

    const noHover = extractBlock(source, '@media (hover: none)');
    assert.ok(noHover.includes('.prompt-management-actions'), `${id} missing no-hover actions`);
    assert.ok(noHover.includes('opacity: .72'), `${id} missing no-hover action emphasis`);
    assert.ok(noHover.includes('padding-right: 132px'), `${id} no-hover title must reserve five actions`);

    const promptMotion = extractBlock(source, '@media (prefers-reduced-motion: reduce)', 2);
    assert.ok(promptMotion.includes('.prompt-management-actions'), `${id} missing reduced motion toolbar`);
    assert.ok(promptMotion.includes('transition: none !important'), `${id} missing reduced motion transition`);

    const forcedColors = extractBlock(source, '@media (forced-colors: active)', 1);
    assert.ok(forcedColors.includes('.prompt-management-actions'), `${id} missing forced-color toolbar`);
    assert.ok(forcedColors.includes('.prompt-default-marker'), `${id} missing forced-color default state`);
}

function cssRules(source) {
    return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
        selectors: match[1].split(',').map(selector => selector.trim()),
        body: match[2],
    }));
}

function ruleForSelector(source, selector, requiredDeclaration) {
    const matches = cssRules(source).filter(rule => rule.selectors.includes(selector)
        && (!requiredDeclaration || rule.body.includes(requiredDeclaration)));
    assert.equal(matches.length, 1, `expected exactly one compiled CSS rule for ${selector}`);
    return matches[0];
}

function assertDeclarations(rule, id, declarations) {
    for (const declaration of declarations) {
        assert.ok(rule.body.includes(declaration), `${id} missing ${declaration}`);
    }
}

const sharinganAssets = [
    ['sharingan-itachi', 'sharingan/mangekyou-sharingan-itachi.svg'],
    ['sharingan-obito-kakashi', 'sharingan/mangekyou-sharingan-obito-kakashi.svg'],
    ['sharingan-sasuke', 'sharingan/mangekyou-sharingan-sasuke.svg'],
    ['sharingan-shisui', 'sharingan/mangekyou-sharingan-shisui.svg'],
    ['sharingan-madara', 'sharingan/mangekyou-sharingan-madara.svg'],
    ['sharingan-madara-eternal', 'sharingan/mangekyou-sharingan-madara-eternal.svg'],
];

function findSharinganRule(source, mode) {
    const matches = cssRules(source).filter(rule => rule.selectors.some(selector =>
        (
            selector.includes(`[data-session-fx="${mode}"]`)
            || selector.includes(`[data-session-fx=${mode}]`)
        )
        && selector.endsWith('.project-kind-icon::after')));
    assert.equal(matches.length, 1,
        `SHARINGAN-RUNNING-ANIMATION-001 expected one rule for ${mode}`);
    return matches[0];
}

function findSharinganSharedRule(source, suffix, requiredDeclaration) {
    const matches = cssRules(source).filter(rule => rule.selectors.some(selector =>
        (
            selector.includes('[data-session-fx^="sharingan-"]')
            || selector.includes('[data-session-fx^=sharingan-]')
        )
        && selector.endsWith(suffix))
        && (!requiredDeclaration || rule.body.includes(requiredDeclaration)));
    assert.equal(matches.length, 1,
        `SHARINGAN-RUNNING-ANIMATION-001 expected one shared rule for ${suffix}`);
    return matches[0];
}

function validateSharinganAnimations(source) {
    for (const [mode, asset] of sharinganAssets) {
        assertDeclarations(findSharinganRule(source, mode),
            'SHARINGAN-RUNNING-ANIMATION-001', [`background-image: url("${asset}")`]);
    }
    assertDeclarations(findSharinganSharedRule(source, '.project-kind-icon::after', 'position: absolute'),
        'SHARINGAN-RUNNING-ANIMATION-001', [
            'position: absolute',
            'inset: 0',
            'background-position: center',
            'background-repeat: no-repeat',
            'background-size: 100% 100%',
            'animation: steward-session-running-sharingan 1.8s linear infinite',
            'pointer-events: none',
        ]);
    assertDeclarations(findSharinganSharedRule(source, ':hover .project-kind-icon', 'background: transparent'),
        'SHARINGAN-RUNNING-ANIMATION-001', [
            'color: var(--steward-foreground)',
            'background: transparent',
            'border-color: transparent',
        ]);
    assert.equal(cssRules(source).some(rule => rule.selectors.some(selector =>
        (
            selector.includes('[data-session-fx^="sharingan-"]')
            || selector.includes('[data-session-fx^=sharingan-]')
        )
        && selector.endsWith('.project-kind-icon svg'))), false,
    'SHARINGAN-RUNNING-ANIMATION-001 must retain the ordinary SVG fallback');
    assert.ok(source.includes('@keyframes steward-session-running-sharingan'));
}

const activeSessionIconSelector = 'body.steward-sidebar .project .active-ai-session-row .codex-session-icon';
const activeCurrentIconSelector = 'body.steward-sidebar .project .active-ai-session-row[data-execution-state=running][data-session-icon-fx=current] .codex-session-icon::before';
const activeHaloIconSelector = 'body.steward-sidebar .project .active-ai-session-row[data-execution-state=running][data-session-icon-fx=halo] .codex-session-icon::before';
const activeSharinganIconSelector = 'body.steward-sidebar .project .active-ai-session-row[data-execution-state=running][data-session-icon-fx^=sharingan-] .codex-session-icon::after';
const activeCurrentIconMotionSelector = '.active-ai-session-row[data-execution-state=running][data-session-icon-fx=current] .codex-session-icon::before';
const activeHaloIconMotionSelector = '.active-ai-session-row[data-execution-state=running][data-session-icon-fx=halo] .codex-session-icon::before';
const activeSharinganIconMotionSelector = '.active-ai-session-row[data-execution-state=running][data-session-icon-fx^=sharingan-] .codex-session-icon::after';

function validateActiveSessionIconAnimation(source) {
    const id = 'ACTIVE-SESSION-ICON-ANIMATION-001';
    assertDeclarations(ruleForSelector(source, activeSessionIconSelector, 'border-radius: 50%'), id,
        ['position: relative', 'border-radius: 50%']);
    assertDeclarations(ruleForSelector(source,
        'body.steward-sidebar .project .codex-session-icon', 'width: 26px'), id,
    ['width: 26px', 'height: 26px', 'border-radius: 50%']);
    assertDeclarations(ruleForSelector(source,
        'body.steward-sidebar .project .codex-session-icon svg', 'width: 17px'), id,
    ['width: 17px', 'height: 17px']);
    assertDeclarations(ruleForSelector(source,
        'body.steward-sidebar .project .codex-session-icon', 'width: 21px'), id,
    ['width: 21px', 'height: 21px']);
    assertDeclarations(ruleForSelector(source,
        'body.steward-sidebar .project .codex-session-icon svg', 'width: 14px'), id,
    ['width: 14px', 'height: 14px']);
    assertDeclarations(ruleForSelector(source, activeCurrentIconSelector), id,
        ['border-radius: 50%', '-webkit-mask:', 'mask:',
            'animation: steward-session-icon-spin 2.6s linear infinite']);
    assertDeclarations(ruleForSelector(source, activeHaloIconSelector), id,
        ['content: ""', 'position: absolute', 'inset: -1px', 'border-radius: 50%',
            'conic-gradient(', 'radial-gradient(', 'filter: drop-shadow(',
            'animation: steward-session-icon-spin 2.6s linear infinite', 'pointer-events: none']);
    assertDeclarations(ruleForSelector(source, activeSharinganIconSelector), id,
        ['position: absolute', 'inset: 0', 'background-size: 100% 100%', 'border-radius: 50%',
            'animation: steward-session-running-sharingan 1.8s linear infinite', 'pointer-events: none']);
    for (const [mode, asset] of sharinganAssets) {
        const selector = `body.steward-sidebar .project .active-ai-session-row[data-execution-state=running][data-session-icon-fx=${mode}] .codex-session-icon::after`;
        assertDeclarations(ruleForSelector(source, selector), id, [`background-image: url("${asset}")`]);
    }
    assert.equal(cssRules(source).some(rule => rule.selectors.some(selector =>
        selector.includes('[data-session-icon-fx=none]') && /::(?:before|after)$/.test(selector))), false,
    `${id} none must not create an animated pseudo-element`);
    assert.equal(cssRules(source).some(rule => rule.selectors.some(selector =>
        selector.includes('sharingan-') && selector.includes('.codex-session-icon svg'))), false,
    `${id} Sharingan must retain the terminal SVG`);
    assert.equal(cssRules(source).some(rule => rule.selectors.some(selector =>
        selector.includes('[data-session-icon-fx') && !selector.includes('.active-ai-session-row'))), false,
    `${id} icon effects must not target History rows`);
    const reducedMotion = extractBlock(source, '@media (prefers-reduced-motion: reduce)', 1);
    for (const selector of [
        activeCurrentIconMotionSelector,
        activeHaloIconMotionSelector,
        activeSharinganIconMotionSelector,
    ]) {
        assertDeclarations(ruleForSelector(reducedMotion, selector), id,
            ['animation: none !important', 'transition: none !important']);
    }
    const forcedColors = extractBlock(source, '@media (forced-colors: active)');
    assertDeclarations(ruleForSelector(forcedColors, activeSessionIconSelector, 'border: 1px solid CanvasText'), id,
        ['border: 1px solid CanvasText']);
}

function validateSharedCardPresentation(source) {
    const id = 'WEBVIEW-SHARED-CARD-STATE-001';
    assertDeclarations(ruleForSelector(source, 'body.steward-sidebar .steward-group-header'), id,
        ['padding: 4px 6px', 'border-radius: 7px', 'font-size: 15px', 'line-height: 1.25']);
    assertDeclarations(ruleForSelector(source, 'body.steward-sidebar .steward-item-card', 'height: 58px'), id,
        ['width: 100%', 'height: 58px', 'padding: 8px 10px 8px 15px', 'border-radius: 18px']);
    const hover = ruleForSelector(source, 'body.steward-sidebar .steward-item-card:focus-within');
    assertDeclarations(hover, id,
        ['background: var(--vscode-list-hoverBackground)', 'border-color: var(--vscode-focusBorder)', 'transform: translateY(-1px)']);
    const expanded = ruleForSelector(source, 'body.steward-sidebar .steward-item-card.expanded');
    assertDeclarations(expanded, id, ['height: auto', 'min-height: 58px']);
    const selected = ruleForSelector(source, 'body.steward-sidebar .steward-item-card.selected');
    assertDeclarations(selected, id, ['border-color: var(--vscode-focusBorder)']);
}

function validateDangerActions(source) {
    const id = 'WEBVIEW-ACTION-ACCESSIBILITY-001';
    const hover = 'body.steward-sidebar .steward-group-header .group-actions > .danger:hover';
    const focus = 'body.steward-sidebar .steward-group-header .group-actions > .danger:focus-visible';
    const rule = ruleForSelector(source, hover);
    assert.ok(rule.selectors.includes(focus), `${id} danger actions must share hover and keyboard focus state`);
    assertDeclarations(rule, id, ['color: var(--vscode-errorForeground)']);
}

function validateTodoVisualState(source) {
    const id = 'TODO-VISUAL-STATE-001';
    assertDeclarations(ruleForSelector(source, '.todo-group-count'), id,
        ['font-size: 10px', 'opacity: 0.55', 'white-space: nowrap']);
    assertDeclarations(ruleForSelector(source, '.todo-priority-choice input:checked + span'), id,
        ['border-color: var(--vscode-panel-border)', 'color: var(--vscode-foreground)',
            'background: var(--vscode-list-inactiveSelectionBackground)']);
    assertDeclarations(ruleForSelector(source, '.todo-list > .steward-item-card:last-child'), id, ['margin-bottom: 0']);
    assertDeclarations(ruleForSelector(source, '.todo-detail-notes'), id, ['white-space: pre-wrap']);
    const completedRules = cssRules(source).filter(rule =>
        rule.selectors.some(selector => selector.includes('.todo-item.completed')));
    assert.ok(completedRules.length > 0, `${id} must retain completed TODO presentation`);
    assert.equal(completedRules.some(rule => /(^|;)\s*background(?:-color)?\s*:/.test(rule.body)), false,
        `${id} completed TODO rules must not override the shared card background`);
}

function validateCollapsePresentation(source) {
    const id = 'WEBVIEW-COLLAPSE-PRESENTATION-001';
    assertDeclarations(ruleForSelector(source, '.group.collapsed .collapse-icon svg'), id,
        ['transform: rotate(-90deg)']);
}

function validateMultiProviderSessionHistoryStyles(source) {
    const id = 'WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-003';
    const compiled = compileStyles(source);
    const ruleWithSelector = (selectorSuffix, declaration) => cssRules(compiled).some(rule =>
        rule.selectors.some(selector => selector.endsWith(selectorSuffix))
        && rule.body.replace(/\s+/g, '').includes(declaration)
    );
    assert.ok(ruleWithSelector('.ai-session-provider-menu', 'position:absolute'),
        `${id} missing .ai-session-provider-menu { position: absolute }`);
    assert.ok(ruleWithSelector('.ai-session-provider-menu', 'z-index:80'),
        `${id} missing .ai-session-provider-menu { z-index: 80 }`);
    for (const selector of [
        '.ai-session-provider-option[aria-checked=true]',
        '.ai-session-provider-option:focus-visible',
        '.ai-session-provider-badge',
        '.ai-session-availability-summary',
        '.ai-session-pinned-heading',
    ]) {
        assert.ok(ruleWithSelector(selector, ''), `${id} missing ${selector}`);
    }
    assert.ok(ruleWithSelector('.ai-session-availability-summary', 'font-size:9px'),
        `${id} availability summary must remain compact`);
    assert.ok(ruleWithSelector(
        '.ai-session-availability-summary',
        'color:var(--vscode-descriptionForeground)'
    ), `${id} availability summary must use readable theme text`);
    assert.ok(source.includes('@media (forced-colors: active)'), `${id} missing forced-colors styles`);
    assert.equal(source.includes('ai-session-provider-section'), false,
        `${id} must not reintroduce provider-section containers`);
}

function compileStyles(source) {
    return sass.compileString(source, {
        loadPaths: [path.join(root, 'media'), path.join(root, 'node_modules')],
        style: 'expanded',
    }).css;
}

function minifyStyles(source) {
    const result = new CleanCSS({ rebaseTo: path.dirname(generatedStylesPath) }).minify({
        [generatedStylesPath]: { styles: source },
    });
    assert.deepEqual(result.errors, [], 'WEBVIEW-STYLES-ARTIFACT-001 styles must minify without errors');
    assert.deepEqual(result.warnings, [], 'WEBVIEW-STYLES-ARTIFACT-001 styles must minify without warnings');
    return result.styles;
}

function assertStyleArtifact(scssSource, cssArtifact) {
    assert.equal(minifyStyles(compileStyles(scssSource)), cssArtifact,
        'WEBVIEW-STYLES-ARTIFACT-001 committed CSS must equal compiled and minified SCSS');
}

const compiledStyles = compileStyles(styles);

test('WEBVIEW-STYLES-ARTIFACT-001 committed CSS exactly matches compiled and minified SCSS', () => {
    assertStyleArtifact(styles, generatedStyles);
    const mutatedArtifact = generatedStyles.replace('box-sizing:border-box', 'box-sizing:content-box');
    assert.notEqual(mutatedArtifact, generatedStyles, 'controlled artifact mutation must alter real CSS');
    assert.throws(() => assertStyleArtifact(styles, mutatedArtifact), /WEBVIEW-STYLES-ARTIFACT-001/);
    const mutatedScss = styles.replace('height: 58px;', 'height: 59px;');
    assert.notEqual(mutatedScss, styles, 'controlled SCSS mutation must alter a real declaration');
    assert.throws(() => assertStyleArtifact(mutatedScss, generatedStyles), /WEBVIEW-STYLES-ARTIFACT-001/);
});

test('WEBVIEW-AI-PROMPT-STYLES-001 exposes every Prompt styling boundary', () => {
    for (const selector of [
        '.ai-subtabs',
        '.prompt-command-bar',
        '.prompt-list',
        '.prompt-item',
        '.prompt-form',
        '.prompt-live-region',
    ]) {
        assert.doesNotThrow(() => extractBlock(styles, selector));
    }
    validatePromptCompactCardStyles(styles);
});

test('WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001 preserves bounded marker and card geometry', () => {
    validateConversationOutlineStyles(styles);
    assert.throws(() => validateConversationOutlineStyles(styles.replace(
        'grid-template-columns: 14px minmax(0, 1fr);',
        'grid-template-columns: minmax(0, 1fr);'
    )), /WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001/);
});

test('WEBVIEW-REDUCED-MOTION-001 disables dashboard and session animation for reduced motion', () => {
    validateReducedMotion(styles);
    assert.throws(() => validateReducedMotion(styles.replace(
        'body.steward-sidebar .steward-item-accent {\n        transition: none;',
        'body.steward-sidebar .steward-item-accent {\n        transition: all 1s;')),
        /WEBVIEW-REDUCED-MOTION-001/);
});

test('TODO-KEYBOARD-FOCUS-001 keeps the hidden completed toggle keyboard-visible', () => {
    validateTodoFocus(styles);
    assert.throws(() => validateTodoFocus(styles.replace(
        '.todo-square-toggle:focus-within {\n    outline: 1px solid var(--vscode-focusBorder);',
        '.todo-square-toggle:focus-within {\n    outline: none;')),
        /TODO-KEYBOARD-FOCUS-001/);
});

test('TODO-RESPONSIVE-LAYOUT-001 keeps TODO titles readable in configured scrolling groups', () => {
    validateTodoLayout(styles);
    assert.throws(() => validateTodoLayout(styles.replace(
        'overflow-wrap: anywhere;\n    -webkit-box-orient: vertical;\n    -webkit-line-clamp: 2;',
        'overflow-wrap: anywhere;\n    -webkit-box-orient: vertical;\n    -webkit-line-clamp: 1;')),
        /TODO-RESPONSIVE-LAYOUT-001/);
    assert.throws(() => validateTodoLayout(styles.replace(
        'overflow-y: auto;',
        'overflow: visible;')),
        /TODO-RESPONSIVE-LAYOUT-001/);
});

test('WEBVIEW-SHARED-CARD-STATE-001 preserves shared header/card geometry and interaction states', () => {
    validateSharedCardPresentation(compiledStyles);
    assert.throws(() => validateSharedCardPresentation(compileStyles(styles.replace('height: 58px;', 'height: 59px;'))),
        /WEBVIEW-SHARED-CARD-STATE-001|expected exactly one compiled CSS rule/);
});

test('WEBVIEW-ACTION-ACCESSIBILITY-001 gives danger actions matching hover and keyboard focus feedback', () => {
    validateDangerActions(compiledStyles);
    assert.throws(() => validateDangerActions(compileStyles(styles.replace(
        '.group-actions > .danger {\n            &:hover,\n            &:focus-visible {',
        '.group-actions > .danger {\n            &:hover,\n            &.removed-focus-state {'))),
        /WEBVIEW-ACTION-ACCESSIBILITY-001|expected exactly one compiled CSS rule/);
});

test('TODO-VISUAL-STATE-001 preserves count, priority, spacing, notes, footer, and completed-card presentation', () => {
    validateTodoVisualState(compiledStyles);
    assert.throws(() => validateTodoVisualState(compileStyles(styles.replace(
        '.todo-item.completed .todo-title-text {',
        '.todo-item.completed .todo-title-text {\n    background: red;'))),
        /TODO-VISUAL-STATE-001/);
});

test('WEBVIEW-COLLAPSE-PRESENTATION-001 rotates group and TODO collapse indicators', () => {
    validateCollapsePresentation(compiledStyles);
    assert.throws(() => validateCollapsePresentation(compileStyles(styles.replace(
        'transform: rotate(-90deg);', 'transform: rotate(0deg);'))),
        /WEBVIEW-COLLAPSE-PRESENTATION-001/);
});

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-003 styles the menu, rows, and forced-colors state', () => {
    validateMultiProviderSessionHistoryStyles(styles);
    assert.throws(() => validateMultiProviderSessionHistoryStyles(styles.replace('z-index: 80;', 'z-index: 79;')),
        /WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-003/);
});

test('SHARINGAN-RUNNING-ANIMATION-001 maps and rotates each authentic eye', () => {
    validateSharinganAnimations(compiledStyles);
    assert.throws(() => validateSharinganAnimations(compileStyles(styles.replace(
        'animation: steward-session-running-sharingan 1.8s linear infinite;',
        'animation: none;'
    ))), /SHARINGAN-RUNNING-ANIMATION-001/);
});

test('ACTIVE-SESSION-ICON-ANIMATION-001 scopes all nine Active Session icon modes', () => {
    validateActiveSessionIconAnimation(compiledStyles);
    assert.throws(() => validateActiveSessionIconAnimation(compileStyles(styles.replace(
        'width: 26px;\n            height: 26px;\n            border: 1px solid var(--vscode-panel-border);\n            border-radius: 50%;',
        'width: 26px;\n            height: 26px;\n            border: 1px solid var(--vscode-panel-border);\n            border-radius: 7px;'
    ))), /ACTIVE-SESSION-ICON-ANIMATION-001/);
    assert.throws(() => validateActiveSessionIconAnimation(compileStyles(styles.replace(
        'animation: steward-session-icon-spin 2.6s linear infinite;',
        'animation: none;'
    ))), /ACTIVE-SESSION-ICON-ANIMATION-001/);
    const currentReducedMotionSelector = '    .active-ai-session-row[data-execution-state="running"][data-session-icon-fx="current"] .codex-session-icon::before,\n';
    const haloReducedMotionSelector = '    .active-ai-session-row[data-execution-state="running"][data-session-icon-fx="halo"] .codex-session-icon::before,\n';
    const sharinganReducedMotionSelector = '    .active-ai-session-row[data-execution-state="running"][data-session-icon-fx^="sharingan-"] .codex-session-icon::after {\n';
    for (const mutatedStyles of [
        styles.replace(currentReducedMotionSelector, ''),
        styles.replace(haloReducedMotionSelector, ''),
        styles.replace(`${haloReducedMotionSelector}${sharinganReducedMotionSelector}`,
            `${haloReducedMotionSelector.slice(0, -2)} {\n`),
    ]) {
        assert.notEqual(mutatedStyles, styles, 'controlled reduced-motion mutation must alter the SCSS');
        assert.throws(() => validateActiveSessionIconAnimation(compileStyles(mutatedStyles)));
    }
    const forcedColorsIconRule = '        .active-ai-session-row .codex-session-icon {\n            border: 1px solid CanvasText;\n        }\n';
    const withoutForcedColorsIconRule = styles.replace(forcedColorsIconRule, '');
    assert.notEqual(withoutForcedColorsIconRule, styles,
        'controlled forced-colors removal must alter the SCSS');
    assert.throws(() => validateActiveSessionIconAnimation(compileStyles(withoutForcedColorsIconRule)));
    const compiledForcedColorsIconRule = `  ${activeSessionIconSelector} {\n    border: 1px solid CanvasText;\n  }\n`;
    const movedForcedColors = `${compiledStyles.replace(compiledForcedColorsIconRule, '')}\n${compiledForcedColorsIconRule}`;
    assert.notEqual(movedForcedColors, compiledStyles,
        'controlled forced-colors move must alter the compiled CSS');
    assert.throws(() => validateActiveSessionIconAnimation(movedForcedColors));
});
