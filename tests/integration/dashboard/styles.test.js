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
const conversationViewerStylesPath = path.join(root, 'media/conversationViewer.scss');
const generatedConversationViewerStylesPath = path.join(root, 'media/conversationViewer.css');
const styles = fs.readFileSync(stylesPath, 'utf8');
const generatedStyles = fs.readFileSync(generatedStylesPath, 'utf8');
const conversationViewerStyles = fs.readFileSync(conversationViewerStylesPath, 'utf8');
const generatedConversationViewerStyles = fs.readFileSync(generatedConversationViewerStylesPath, 'utf8');

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
        '.project.session-running[data-session-fx="custom"] .project-kind-icon::after',
        'animation: none !important',
        'transition: none !important',
    ]) {
        assert.ok(sessionMotion.includes(value), `WEBVIEW-REDUCED-MOTION-001 missing ${value}`);
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

function findCustomImageRule(source, suffix, requiredDeclaration) {
    const matches = cssRules(source).filter(rule => rule.selectors.some(selector =>
        (
            selector.includes('[data-session-fx="custom"]')
            || selector.includes('[data-session-fx=custom]')
        )
        && selector.endsWith(suffix))
        && (!requiredDeclaration || rule.body.includes(requiredDeclaration)));
    assert.equal(matches.length, 1,
        `CUSTOM-RUNNING-IMAGE-001 expected one rule for ${suffix}`);
    return matches[0];
}

function validateCustomImageAnimation(source) {
    const id = 'CUSTOM-RUNNING-IMAGE-001';
    assertDeclarations(findCustomImageRule(source, '.project-kind-icon::after', 'position: absolute'),
        id, [
            'position: absolute',
            'inset: 0',
            'background-image: var(--agent-pivot-running-card-image, none)',
            'background-position: center',
            'background-repeat: no-repeat',
            'background-size: 100% 100%',
            'animation: steward-session-running-custom-image 1.8s linear infinite',
            'pointer-events: none',
        ]);
    assertDeclarations(findCustomImageRule(source, ':hover .project-kind-icon', 'background: transparent'),
        id, [
            'color: var(--steward-foreground)',
            'background: transparent',
            'border-color: transparent',
        ]);
    assert.equal(cssRules(source).some(rule => rule.selectors.some(selector =>
        (
            selector.includes('[data-session-fx="custom"]')
            || selector.includes('[data-session-fx=custom]')
        )
        && selector.endsWith('.project-kind-icon svg'))), false,
    `${id} must retain the ordinary SVG fallback`);
    assert.ok(source.includes('@keyframes steward-session-running-custom-image'),
        `${id} must keep the shared rotation keyframes`);
    assert.equal(source.toLowerCase().includes('sharingan'), false,
        `${id} must not retain bundled third-party artwork references`);
}

const activeSessionIconSelector = 'body.steward-sidebar .project .active-ai-session-row .codex-session-icon';
const activeCurrentIconSelector = 'body.steward-sidebar .project .active-ai-session-row[data-execution-state=running][data-session-icon-fx=current] .codex-session-icon::before';
const activeHaloIconSelector = 'body.steward-sidebar .project .active-ai-session-row[data-execution-state=running][data-session-icon-fx=halo] .codex-session-icon::before';
const activeCustomIconSelector = 'body.steward-sidebar .project .active-ai-session-row[data-execution-state=running][data-session-icon-fx=custom] .codex-session-icon::after';
const activeCurrentIconMotionSelector = '.active-ai-session-row[data-execution-state=running][data-session-icon-fx=current] .codex-session-icon::before';
const activeHaloIconMotionSelector = '.active-ai-session-row[data-execution-state=running][data-session-icon-fx=halo] .codex-session-icon::before';
const activeCustomIconMotionSelector = '.active-ai-session-row[data-execution-state=running][data-session-icon-fx=custom] .codex-session-icon::after';

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
    assertDeclarations(ruleForSelector(source, activeCustomIconSelector), id,
        ['position: absolute', 'inset: 0', 'background-size: 100% 100%', 'border-radius: 50%',
            'background-image: var(--agent-pivot-running-icon-image, none)',
            'animation: steward-session-running-custom-image 1.8s linear infinite', 'pointer-events: none']);
    assert.equal(cssRules(source).some(rule => rule.selectors.some(selector =>
        selector.includes('[data-session-icon-fx=none]') && /::(?:before|after)$/.test(selector))), false,
    `${id} none must not create an animated pseudo-element`);
    assert.equal(cssRules(source).some(rule => rule.selectors.some(selector =>
        selector.includes('[data-session-icon-fx=custom]') && selector.includes('.codex-session-icon svg'))), false,
    `${id} custom image must retain the terminal SVG`);
    assert.equal(cssRules(source).some(rule => rule.selectors.some(selector =>
        selector.includes('[data-session-icon-fx') && !selector.includes('.active-ai-session-row'))), false,
    `${id} icon effects must not target History rows`);
    const reducedMotion = extractBlock(source, '@media (prefers-reduced-motion: reduce)', 1);
    for (const selector of [
        activeCurrentIconMotionSelector,
        activeHaloIconMotionSelector,
        activeCustomIconMotionSelector,
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

function minifyStyles(source, artifactPath = generatedStylesPath) {
    const result = new CleanCSS({ rebaseTo: path.dirname(artifactPath) }).minify({
        [artifactPath]: { styles: source },
    });
    assert.deepEqual(result.errors, [], 'WEBVIEW-STYLES-ARTIFACT-001 styles must minify without errors');
    assert.deepEqual(result.warnings, [], 'WEBVIEW-STYLES-ARTIFACT-001 styles must minify without warnings');
    return result.styles;
}

function assertStyleArtifact(scssSource, cssArtifact, artifactPath) {
    assert.equal(minifyStyles(compileStyles(scssSource), artifactPath), cssArtifact,
        'WEBVIEW-STYLES-ARTIFACT-001 committed CSS must equal compiled and minified SCSS');
}

const compiledStyles = compileStyles(styles);

test('WEBVIEW-STYLES-ARTIFACT-001 committed CSS exactly matches compiled and minified SCSS', () => {
    assertStyleArtifact(styles, generatedStyles);
    assertStyleArtifact(
        conversationViewerStyles,
        generatedConversationViewerStyles,
        generatedConversationViewerStylesPath
    );
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

test('WEBVIEW-REDUCED-MOTION-001 disables dashboard and session animation for reduced motion', () => {
    validateReducedMotion(styles);
    assert.throws(() => validateReducedMotion(styles.replace(
        'body.steward-sidebar .steward-item-accent {\n        transition: none;',
        'body.steward-sidebar .steward-item-accent {\n        transition: all 1s;')),
        /WEBVIEW-REDUCED-MOTION-001/);
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

test('WEBVIEW-COLLAPSE-PRESENTATION-001 rotates group collapse indicators', () => {
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

test('CUSTOM-RUNNING-IMAGE-001 renders user-supplied artwork through CSS variables', () => {
    validateCustomImageAnimation(compiledStyles);
    assert.throws(() => validateCustomImageAnimation(compileStyles(styles.replace(
        'animation: steward-session-running-custom-image 1.8s linear infinite;',
        'animation: none;'
    ))), /CUSTOM-RUNNING-IMAGE-001/);
});

test('ACTIVE-SESSION-ICON-ANIMATION-001 scopes every Active Session icon mode', () => {
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
    const customReducedMotionSelector = '    .active-ai-session-row[data-execution-state="running"][data-session-icon-fx="custom"] .codex-session-icon::after {\n';
    for (const mutatedStyles of [
        styles.replace(currentReducedMotionSelector, ''),
        styles.replace(haloReducedMotionSelector, ''),
        styles.replace(`${haloReducedMotionSelector}${customReducedMotionSelector}`,
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
