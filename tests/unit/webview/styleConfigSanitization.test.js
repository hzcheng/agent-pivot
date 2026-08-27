'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadWebviewContent() {
    const modulePath = '../../../out/webview/webviewContent';
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return {};
            return previousLoad.call(this, request, parent, isMain);
        };
        delete require.cache[require.resolve(modulePath)];
        return require(modulePath);
    } finally {
        Module._load = previousLoad;
    }
}

const { sanitizeCustomCss, sanitizeCssColor } = loadWebviewContent();

test('WEBVIEW-STYLE-CONFIG-SANITIZATION-001 keeps plain custom CSS rules intact', () => {
    const css = '.project-container { border-radius: 8px; } .project-header > h2 { color: red; }';
    assert.equal(sanitizeCustomCss(css), css);
});

test('WEBVIEW-STYLE-CONFIG-SANITIZATION-001 strips style-breakout markup from custom CSS', () => {
    const sanitized = sanitizeCustomCss('</style><img src="https://evil.example/x"><style>.a{color:red}');
    assert.ok(!sanitized.includes('<'), 'sanitized CSS must not contain markup delimiters');
    assert.ok(sanitized.includes('.a{color:red}'));
});

test('WEBVIEW-STYLE-CONFIG-SANITIZATION-001 strips remote url() references from custom CSS', () => {
    for (const css of [
        '.a { background: url(https://evil.example/beacon.png); }',
        ".a { background: url('http://evil.example/beacon.png'); }",
        '.a { background: URL(  https://evil.example/beacon.png); }',
    ]) {
        assert.ok(!/url\(\s*['"]?\s*https?:/i.test(sanitizeCustomCss(css)),
            `remote url() must be stripped: ${css}`);
    }
    assert.ok(sanitizeCustomCss('.a { background: url(data:image/png;base64,AAAA); }')
        .includes('url(data:image/png;base64,AAAA)'), 'data: url() must be preserved');
});

test('WEBVIEW-STYLE-CONFIG-SANITIZATION-001 strips imports and script-like constructs from custom CSS', () => {
    assert.ok(!/@import/i.test(sanitizeCustomCss('@import "https://evil.example/x.css";')));
    assert.ok(!/expression\s*\(/i.test(sanitizeCustomCss('.a { width: expression(alert(1)); }')));
    assert.ok(!/javascript\s*:/i.test(sanitizeCustomCss('.a { background: url(javascript:alert(1)); }')));
});

test('WEBVIEW-STYLE-CONFIG-SANITIZATION-001 accepts plain CSS colors', () => {
    for (const color of [
        '#fff',
        '#ff8800',
        '#ff8800cc',
        'rebeccapurple',
        'rgb(10, 20, 30)',
        'rgba(10, 20, 30, 0.5)',
        'hsl(120, 50%, 50%)',
        'hsla(120 50% 50% / 0.5)',
        'var(--steward-foreground)',
    ]) {
        assert.equal(sanitizeCssColor(color), color, `${color} must be accepted`);
    }
});

test('WEBVIEW-STYLE-CONFIG-SANITIZATION-001 rejects non-color style values', () => {
    for (const color of [
        'url(https://evil.example/beacon.png)',
        'red; background: url(https://evil.example/x)',
        'red }</style><script>alert(1)</script>',
        '"quoted"',
        'expression(alert(1))',
        '',
        '   ',
        null,
        undefined,
        `#${'a'.repeat(200)}`,
    ]) {
        assert.equal(sanitizeCssColor(color), '', `${JSON.stringify(color)} must be rejected`);
    }
});
