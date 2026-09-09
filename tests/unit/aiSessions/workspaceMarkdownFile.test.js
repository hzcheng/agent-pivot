'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    applyValidatedWorkspaceMarkdownSuggestion,
} = require('../../../out/aiSessions/conversation/workspaceMarkdownFile');

function version(value) {
    return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

test('CONVERSATION-MARKDOWN-WORKSPACE-001 writes only the validated descriptor and rejects a swapped symlink', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-pivot-markdown-write-'));
    try {
        const root = path.join(temporary, 'workspace');
        const outside = path.join(temporary, 'outside.md');
        const candidate = path.join(root, 'plan.md');
        await require('node:fs/promises').mkdir(root);
        const source = 'Keep this paragraph.';
        await writeFile(candidate, source, 'utf8');
        await writeFile(outside, 'Outside must remain unchanged.', 'utf8');

        assert.equal(await applyValidatedWorkspaceMarkdownSuggestion(root, candidate, {
            documentVersion: version(source), selectedText: source,
            prefix: '', suffix: '', replacement: 'Replace only this paragraph.',
        }), 'applied');
        assert.equal(await readFile(candidate, 'utf8'), 'Replace only this paragraph.');

        if (process.platform === 'linux') {
            await require('node:fs/promises').unlink(candidate);
            await symlink(outside, candidate);
            const result = await applyValidatedWorkspaceMarkdownSuggestion(root, candidate, {
                documentVersion: version('Outside must remain unchanged.'),
                selectedText: 'Outside must remain unchanged.',
                prefix: '', suffix: '', replacement: 'Attacker replacement.',
            });
            assert.notEqual(result, 'applied');
            assert.equal(await readFile(outside, 'utf8'), 'Outside must remain unchanged.');
        }
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});

test('CONVERSATION-MARKDOWN-WORKSPACE-001 applies a version-checked inverse without overwriting later edits', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-pivot-markdown-undo-'));
    try {
        const root = path.join(temporary, 'workspace');
        const candidate = path.join(root, 'plan.md');
        await require('node:fs/promises').mkdir(root);
        const original = 'Keep the rollback plan.';
        const applied = 'Keep the tested rollback plan.';
        await writeFile(candidate, original, 'utf8');
        assert.equal(await applyValidatedWorkspaceMarkdownSuggestion(root, candidate, {
            documentVersion: version(original), selectedText: original,
            prefix: '', suffix: '', replacement: applied,
        }), 'applied');
        assert.equal(await applyValidatedWorkspaceMarkdownSuggestion(root, candidate, {
            documentVersion: version(applied), selectedText: applied,
            prefix: '', suffix: '', replacement: original,
        }), 'applied', 'the Host-owned inverse is a normal guarded file mutation');
        assert.equal(await readFile(candidate, 'utf8'), original);

        await writeFile(candidate, 'A user changed this after the AI edit.', 'utf8');
        assert.equal(await applyValidatedWorkspaceMarkdownSuggestion(root, candidate, {
            documentVersion: version(applied), selectedText: applied,
            prefix: '', suffix: '', replacement: original,
        }), 'stale');
        assert.equal(await readFile(candidate, 'utf8'), 'A user changed this after the AI edit.');
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});
