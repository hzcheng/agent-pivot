'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    assertManagedSshMaterializerPlatform,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshConsentCoordinator');

test('MANAGED-REMOTE-SSH-CONSENT-001 keeps Windows materialization fail-closed before its ACL gate', () => {
    assert.throws(
        () => assertManagedSshMaterializerPlatform('win32'),
        /DACL and reparse-point safety gate/,
    );
    assert.doesNotThrow(() => assertManagedSshMaterializerPlatform('linux'));
    assert.doesNotThrow(() => assertManagedSshMaterializerPlatform('darwin'));
});
