'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// ATTENTION-NOTIFY-ISOLATION-001

const notifyRoot = path.join(__dirname, '..', '..', '..', '..', 'src', 'aiSessions', 'notify');

function collectSourceFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectSourceFiles(entryPath);
        }
        return entry.name.endsWith('.ts') ? [entryPath] : [];
    });
}

test('notify 目录下没有任何文件依赖 vscode', () => {
    const offenders = collectSourceFiles(notifyRoot).filter(filePath => {
        const source = fs.readFileSync(filePath, 'utf8');
        return /from ['"]vscode['"]/u.test(source) || /require\(['"]vscode['"]\)/u.test(source);
    });
    assert.deepEqual(offenders, [], `these files must not depend on vscode: ${offenders.join(', ')}`);
});

test('notify 目录至少包含预期的核心模块', () => {
    const names = collectSourceFiles(notifyRoot).map(filePath => path.basename(filePath)).sort();
    for (const expected of ['dispatcher.ts', 'httpClient.ts', 'policy.ts', 'store.ts', 'types.ts']) {
        assert.ok(names.includes(expected), `missing ${expected}`);
    }
});
