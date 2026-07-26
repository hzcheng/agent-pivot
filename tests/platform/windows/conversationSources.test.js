'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    openValidatedConversationSource,
} = require('../../../out/aiSessions/conversation/source');

test('Windows uses a portable edge hash and validates the no-O_NOFOLLOW fallback', async t => {
    const root = await fs.promises.mkdtemp(path.join(
        os.tmpdir(),
        'steward-windows-conversation-source-'
    ));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const providerHome = path.join(root, 'provider-home');
    const sourcePath = path.join(providerHome, 'conversation.jsonl');
    await fs.promises.mkdir(providerHome, { recursive: true });
    await fs.promises.writeFile(sourcePath, '{"inside":true}\n');

    const opened = await openValidatedConversationSource(
        { providerHome, sourcePath },
        { forcePortableIdentity: true, noFollowFlag: 0 }
    );
    assert.ok(opened);
    assert.match(opened.identity, /^portable:/);
    assert.equal(opened.device, undefined);
    assert.equal(opened.inode, undefined);
    assert.match(opened.portableFirstHash, /^[0-9a-f]{64}$/);
    assert.match(opened.portableLastHash, /^[0-9a-f]{64}$/);
    await opened.handle.close();

    const outsidePath = path.join(root, 'outside.jsonl');
    await fs.promises.writeFile(outsidePath, '{"outside":true}\n');
    const substituteOpenedHandle = async (_resolvedPath, flags) =>
        fs.promises.open(outsidePath, flags);
    assert.equal(await openValidatedConversationSource(
        { providerHome, sourcePath },
        { noFollowFlag: 0, openFile: substituteOpenedHandle }
    ), null);
});
