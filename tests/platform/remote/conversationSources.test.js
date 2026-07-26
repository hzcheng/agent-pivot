'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const KimiSessionService =
    require('../../../out/services/kimiSessionService').default;

const sessionId = '11111111-1111-4111-8111-111111111111';

for (const remoteName of ['ssh-remote', 'wsl', 'dev-container']) {
    test(`${remoteName} resolves conversation files from the extension-host home only`, async t => {
        const root = await fs.promises.mkdtemp(path.join(
            os.tmpdir(),
            `steward-${remoteName}-conversation-source-`
        ));
        t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
        const uiHome = path.join(root, 'ui-side-home');
        const extensionHostHome = path.join(root, 'extension-host-provider-home');
        const relativeSession = path.join('sessions', 'workspace-hash', sessionId);
        const uiSource = path.join(uiHome, relativeSession, 'wire.jsonl');
        const extensionHostSource = path.join(
            extensionHostHome,
            relativeSession,
            'wire.jsonl'
        );
        await fs.promises.mkdir(path.dirname(uiSource), { recursive: true });
        await fs.promises.mkdir(path.dirname(extensionHostSource), {
            recursive: true,
        });
        await fs.promises.writeFile(uiSource, '{"origin":"ui"}\n');
        await fs.promises.writeFile(
            extensionHostSource,
            '{"origin":"extension-host"}\n'
        );

        const previous = {
            home: process.env.HOME,
            kimiShareDir: process.env.KIMI_SHARE_DIR,
            remoteName: process.env.VSCODE_REMOTE_NAME,
        };
        process.env.HOME = uiHome;
        process.env.KIMI_SHARE_DIR = extensionHostHome;
        process.env.VSCODE_REMOTE_NAME = remoteName;
        try {
            const source =
                new KimiSessionService().resolveConversationSource(sessionId);
            assert.deepEqual(source, {
                providerHome: extensionHostHome,
                sourcePath: extensionHostSource,
            });
            assert.equal(source.sourcePath.startsWith(uiHome), false);
        } finally {
            for (const [name, value] of [
                ['HOME', previous.home],
                ['KIMI_SHARE_DIR', previous.kimiShareDir],
                ['VSCODE_REMOTE_NAME', previous.remoteName],
            ]) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    });
}
