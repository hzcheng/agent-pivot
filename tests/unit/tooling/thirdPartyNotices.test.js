'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectNotices, renderNotices } = require('../../../scripts/lib/thirdPartyNotices');

function writeJson(root, relativePath, value) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(root, relativePath, value) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value);
}

function makeRepo({ dependencies, lockPackages, files = {} }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-notices-'));
    writeJson(root, 'package.json', { name: 'fake-extension', dependencies });
    writeJson(root, 'package-lock.json', {
        packages: {
            '': { dependencies },
            ...lockPackages,
        },
    });
    for (const [relativePath, value] of Object.entries(files)) {
        if (typeof value === 'string') {
            writeText(root, relativePath, value);
        } else {
            writeJson(root, relativePath, value);
        }
    }
    return root;
}

const MIT_TEXT = [
    'MIT License',
    '',
    'Copyright (c) 2020 Example Author',
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
].join('\n');

test('THIRD-PARTY-NOTICES-CLOSURE-001 walks the transitive production closure deterministically', () => {
    const root = makeRepo({
        dependencies: { 'direct-a': '^1.0.0' },
        lockPackages: {
            'node_modules/direct-a': { version: '1.0.0', dependencies: { 'transitive-b': '^2.0.0' } },
            'node_modules/transitive-b': { version: '2.1.0' },
            'node_modules/dev-only': { version: '9.9.9', dev: true },
        },
        files: {
            'node_modules/direct-a/package.json': { name: 'direct-a', version: '1.0.0', license: 'MIT' },
            'node_modules/direct-a/LICENSE': MIT_TEXT,
            'node_modules/transitive-b/package.json': { name: 'transitive-b', version: '2.1.0', license: 'ISC' },
            'node_modules/transitive-b/LICENSE': 'ISC License\n\nCopyright (c) 2021 B Author\n',
        },
    });

    const notices = collectNotices(root);
    assert.deepEqual(notices.map(notice => notice.name), ['direct-a', 'transitive-b']);
    assert.equal(notices[0].copyright, 'Copyright (c) 2020 Example Author');
    assert.equal(notices[1].license, 'ISC');
});

test('THIRD-PARTY-NOTICES-CLOSURE-001 resolves nested production entries ahead of dev-only hoisted ones', () => {
    const root = makeRepo({
        dependencies: { 'parent-pkg': '^1.0.0' },
        lockPackages: {
            'node_modules/parent-pkg': { version: '1.0.0', dependencies: { shared: '^2.0.0' } },
            'node_modules/parent-pkg/node_modules/shared': { version: '2.0.1' },
            'node_modules/shared': { version: '1.0.0', dev: true },
        },
        files: {
            'node_modules/parent-pkg/package.json': { name: 'parent-pkg', version: '1.0.0', license: 'MIT' },
            'node_modules/parent-pkg/LICENSE': MIT_TEXT,
            'node_modules/parent-pkg/node_modules/shared/package.json':
                { name: 'shared', version: '2.0.1', license: 'MIT' },
            'node_modules/parent-pkg/node_modules/shared/LICENSE': MIT_TEXT,
        },
    });

    const notices = collectNotices(root);
    assert.deepEqual(notices.map(notice => [notice.name, notice.version]), [['parent-pkg', '1.0.0'], ['shared', '2.0.1']]);
});

test('THIRD-PARTY-NOTICES-CLOSURE-001 fails when a production dependency is missing from lock or disk', () => {
    const missingLock = makeRepo({
        dependencies: { ghost: '^1.0.0' },
        lockPackages: {},
    });
    assert.throws(() => collectNotices(missingLock), /missing from package-lock\.json/);

    const missingInstall = makeRepo({
        dependencies: { ghost: '^1.0.0' },
        lockPackages: {
            'node_modules/ghost': { version: '1.0.0' },
        },
    });
    assert.throws(() => collectNotices(missingInstall), /not installed.*npm ci/);
});

test('THIRD-PARTY-NOTICES-CLOSURE-001 reads legacy license metadata shapes', () => {
    const root = makeRepo({
        dependencies: { 'object-license': '^1.0.0', 'array-licenses': '^1.0.0', 'no-license': '^1.0.0' },
        lockPackages: {
            'node_modules/object-license': { version: '1.0.0' },
            'node_modules/array-licenses': { version: '1.0.0' },
            'node_modules/no-license': { version: '1.0.0' },
        },
        files: {
            'node_modules/object-license/package.json':
                { name: 'object-license', version: '1.0.0', license: { type: 'BSD-2-Clause' } },
            'node_modules/object-license/LICENSE': 'BSD License\n',
            'node_modules/array-licenses/package.json':
                { name: 'array-licenses', version: '1.0.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] },
            'node_modules/array-licenses/license.txt': 'Dual license\n',
            'node_modules/no-license/package.json': { name: 'no-license', version: '1.0.0' },
            'node_modules/no-license/COPYING': 'Copying text\n',
        },
    });

    const notices = collectNotices(root);
    assert.equal(notices.find(notice => notice.name === 'object-license').license, 'BSD-2-Clause');
    assert.equal(notices.find(notice => notice.name === 'array-licenses').license, 'MIT OR Apache-2.0');
    assert.equal(notices.find(notice => notice.name === 'no-license').license, 'UNKNOWN');
});

test('THIRD-PARTY-NOTICES-CLOSURE-001 does not leak license-body definitions into section headers', () => {
    const apacheBody = [
        'Apache License',
        'Version 2.0, January 2004',
        '"Licensor" shall mean the copyright owner or entity authorized by',
        'the copyright owner that is granting the License.',
    ].join('\n');
    const root = makeRepo({
        dependencies: { 'apache-pkg': '^1.0.0' },
        lockPackages: {
            'node_modules/apache-pkg': { version: '1.0.0' },
        },
        files: {
            'node_modules/apache-pkg/package.json':
                { name: 'apache-pkg', version: '1.0.0', license: 'Apache-2.0', author: { name: 'Apache Author' } },
            'node_modules/apache-pkg/LICENSE': apacheBody,
        },
    });

    const [notice] = collectNotices(root);
    assert.equal(notice.copyright, 'Apache Author',
        'generic license-body copyright mentions must fall back to the package author');
    assert.ok(!notice.copyright.includes('Licensor'));
});

test('THIRD-PARTY-NOTICES-CLOSURE-001 embeds the canonical MIT text when a package ships no license file', () => {
    const root = makeRepo({
        dependencies: { 'mit-nofile': '^1.0.0', 'weird-nofile': '^1.0.0' },
        lockPackages: {
            'node_modules/mit-nofile': { version: '1.0.0' },
            'node_modules/weird-nofile': { version: '1.0.0' },
        },
        files: {
            'node_modules/mit-nofile/package.json': { name: 'mit-nofile', version: '1.0.0', license: 'MIT' },
            'node_modules/weird-nofile/package.json':
                { name: 'weird-nofile', version: '1.0.0', license: 'WTFPL' },
        },
    });

    const notices = collectNotices(root);
    const mit = notices.find(notice => notice.name === 'mit-nofile');
    assert.equal(mit.missingLicenseFile, true);
    assert.ok(mit.licenseText.includes('Permission is hereby granted'),
        'MIT packages without a license file must embed the canonical MIT text');
    const weird = notices.find(notice => notice.name === 'weird-nofile');
    assert.equal(weird.licenseText, '', 'unknown licenses without a file must not guess license text');

    const rendered = renderNotices(notices);
    assert.ok(rendered.includes('## mit-nofile 1.0.0 — MIT'));
    assert.ok(rendered.includes('does not ship a license file; its declared license is WTFPL'));
    assert.ok(rendered.startsWith('# Third-Party Notices'));
});

test('THIRD-PARTY-NOTICES-CLOSURE-001 normalizes embedded license line endings to LF', () => {
    const root = makeRepo({
        dependencies: { 'crlf-pkg': '^1.0.0' },
        lockPackages: {
            'node_modules/crlf-pkg': { version: '1.0.0' },
        },
        files: {
            'node_modules/crlf-pkg/package.json': { name: 'crlf-pkg', version: '1.0.0', license: 'MIT' },
            'node_modules/crlf-pkg/LICENSE': 'MIT License\r\n\r\nCopyright (c) 2022 CRLF Author\r\n',
        },
    });

    const [notice] = collectNotices(root);
    assert.ok(!notice.licenseText.includes('\r'), 'embedded license text must not carry CR bytes');
    assert.equal(notice.copyright, 'Copyright (c) 2022 CRLF Author');
});

test('THIRD-PARTY-NOTICES-CLOSURE-001 covers every direct production dependency of this repository', () => {
    const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
    const rootPackage = JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    const notices = collectNotices(repositoryRoot);
    const names = new Set(notices.map(notice => notice.name));
    for (const dependency of Object.keys(rootPackage.dependencies)) {
        assert.ok(names.has(dependency), `notices must include direct dependency ${dependency}`);
    }
    for (const transitive of ['entities', 'mdurl', 'd3', 'katex']) {
        assert.ok(names.has(transitive), `notices must include bundled transitive dependency ${transitive}`);
    }
    const rendered = renderNotices(notices);
    assert.equal(rendered,
        fs.readFileSync(path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    'committed THIRD_PARTY_NOTICES.md must match the generated output');
});
