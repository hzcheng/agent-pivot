'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    assertBootstrapOwnedResource,
    withDuplicateBootstrapPush,
    withRenamedBootstrapFactory,
} = require('../../../scripts/lib/bootstrapOwnedResource');

const source = `
export async function activate(context: ExtensionContext): Promise<void> {
    context.subscriptions.push(rootProvider);
    context.subscriptions.push(bootstrapController);
}

async function initializeDashboard(context: ExtensionContext): Promise<void> {
    const ownResource = <T>(factory: () => T): T => factory();
    const tmuxFocusedRuntimeMonitor = ownResource(() =>
        new TmuxFocusedRuntimeMonitor<Terminal>({}));
    let conversationCapability: ConversationCapability;
    conversationCapability = ownResource(() => createConversationCapability({}));
    let openWorkspaceBridgeClient: OpenWorkspaceBridgeClient;
    openWorkspaceBridgeClient = ownResource(() => new OpenWorkspaceBridgeClient());
}
`;

const resources = [
    {
        variableName: 'tmuxFocusedRuntimeMonitor',
        factoryKind: 'new',
        factoryName: 'TmuxFocusedRuntimeMonitor',
    },
    {
        variableName: 'conversationCapability',
        factoryKind: 'call',
        factoryName: 'createConversationCapability',
    },
    {
        variableName: 'openWorkspaceBridgeClient',
        factoryKind: 'new',
        factoryName: 'OpenWorkspaceBridgeClient',
    },
];

test('bootstrap ownership accepts exact factory wrappers and root activation owners', () => {
    for (const resource of resources) {
        assert.doesNotThrow(() => assertBootstrapOwnedResource(source, resource));
    }
});

test('bootstrap ownership rejects a wrapper around the wrong factory', () => {
    const mutated = withRenamedBootstrapFactory(
        source,
        resources[0],
        'OtherRuntimeMonitor',
    );
    assert.throws(
        () => assertBootstrapOwnedResource(mutated, resources[0]),
        /tmuxFocusedRuntimeMonitor must have exactly one bootstrap-owned TmuxFocusedRuntimeMonitor factory/,
    );
});

test('bootstrap ownership rejects a second wrapper for the same resource', () => {
    const mutated = source.replace(
        'new TmuxFocusedRuntimeMonitor<Terminal>({}));',
        'new TmuxFocusedRuntimeMonitor<Terminal>({}));'
            + '\n    tmuxFocusedRuntimeMonitor = ownResource(() =>'
            + '\n        new TmuxFocusedRuntimeMonitor<Terminal>({}));',
    );
    assert.throws(
        () => assertBootstrapOwnedResource(mutated, resources[0]),
        /tmuxFocusedRuntimeMonitor must have exactly one bootstrap-owned TmuxFocusedRuntimeMonitor factory/,
    );
});

for (const resource of resources) {
    test(`bootstrap ownership rejects duplicate direct push for ${resource.variableName}`, () => {
        const mutated = withDuplicateBootstrapPush(source, resource.variableName);
        assert.throws(
            () => assertBootstrapOwnedResource(mutated, resource),
            new RegExp(`${resource.variableName} must not also be pushed directly`),
        );
    });
}
