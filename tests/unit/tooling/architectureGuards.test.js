'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateArchitectureGuards } = require('../../../scripts/run-architecture-guards');
const repositoryRoot = path.resolve(__dirname, '../../..');

function writeFixture(t, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-architecture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [relativePath, contents] of Object.entries(files)) {
        const target = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
    return root;
}

function copyGuardFixture(t, mutationPath, mutate = source => source) {
    const relativePaths = [
        'src/dashboard.ts',
        'src/workspaces/currentWorkspaceSessionAuthority.ts',
        'src/openWorkspaces/dashboardController.ts',
        'src/workspaces/sessionHydrationController.ts',
        'src/workspaces/sessionHydration.ts',
        'src/aiSessions/dashboardController.ts',
        'src/aiSessions/presentationMessage.ts',
        'src/aiSessions/providers.ts',
        'src/aiSessions/conversation/types.ts',
        'src/aiSessions/conversation/diffs.ts',
        'src/aiSessions/conversation/subagentSessions.ts',
        'src/aiSessions/conversation/codexAdapter.ts',
        'src/aiSessions/conversation/codexAppServerClient.ts',
        'src/aiSessions/conversation/model.ts',
        'src/aiSessions/conversation/text.ts',
        'src/aiSessions/types.ts',
        'src/aiSessions/archiveBatch.ts',
        'src/aiSessions/archiveBatchAcrossProviders.ts',
        'src/aiSessions/launchOptions.ts',
        'src/aiSessions/launchSpec.ts',
        'src/aiSessions/lifecycle.ts',
        'src/aiSessions/runtimeTypes.ts',
        'src/dashboard/sessionQuickSwitch.ts',
        'src/dashboard/webviewUpdateMessages.ts',
        'src/constants.ts',
        'src/models.ts',
        'src/todos/types.ts',
        'src/webview/dashboardViewModel.ts',
        'src/workspaces/sessionAssignment.ts',
        'src/workspaces/types.ts',
        'src/aiSessions/conversation/composition.ts',
        'src/aiSessions/conversation/worktreeResolver.ts',
        'src/aiSessions/codexRolloutWorkdir.ts',
        'src/aiSessions/conversation/kimiAdapter.ts',
        'src/aiSessions/conversation/claudeAdapter.ts',
        'src/aiSessions/conversation/coordinator.ts',
        'src/aiSessions/conversation/viewer.ts',
        'src/aiSessions/conversation/sessionStatusController.ts',
        'src/webview/webviewAiSessionViewStateScripts.js',
        'src/webview/webviewWorkspaceUpdateScripts.js',
        'src/webview/webviewTodoGroupScripts.js',
        'src/webview/webviewProjectCollapseScripts.js',
        'src/webview/webviewTodoControlScripts.js',
        'src/webview/webviewProjectContextMenuScripts.js',
        'src/webview/webviewContent.ts',
        'src/webview/webviewProjectAiUpdateScripts.js',
        'src/webview/webviewProjectAiSessionControlsScripts.js',
        'src/webview/webviewProjectScripts.js',
        'src/webview/conversationViewerScripts.js',
        'src/aiSessions/attentionController.ts',
        'src/aiSessions/attentionEventCapability.ts',
        'src/aiSessions/attentionAggregate.ts',
        'src/openWorkspaces/protocol.ts',
        'src/openWorkspaces/bridgeClient.ts',
        'src/openWorkspaces/focusBridgeChannel.ts',
        'src/aiSessions/attentionPayload.ts',
        'src/aiSessions/attentionBridgeClient.ts',
        'src/services/codexSessionService.ts',
        'extensions/attention-ui-bridge/src/openWorkspaceCoordinator.ts',
        'extensions/attention-ui-bridge/src/openWorkspaceFocusMailboxStore.ts',
        'extensions/attention-ui-bridge/src/openWorkspaceFocusMailboxCoordinator.ts',
        'extensions/attention-ui-bridge/src/openWorkspaceAttentionFocusStore.ts',
        'extensions/attention-ui-bridge/src/openWorkspaceAttentionFocusCoordinator.ts',
        'extensions/attention-ui-bridge/src/openWorkspaceRunningFocusStore.ts',
        'extensions/attention-ui-bridge/src/openWorkspaceRunningFocusCoordinator.ts',
        'extensions/attention-ui-bridge/src/extension.ts',
        'scripts/lib/brandIdentity.js',
        'package.json',
        'extensions/attention-ui-bridge/package.json',
    ];
    const files = Object.fromEntries(relativePaths.map(relativePath => {
        const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
        if (relativePath !== mutationPath) return [relativePath, source];
        const mutated = mutate(source);
        assert.notEqual(mutated, source, `controlled mutation must change ${mutationPath}`);
        return [relativePath, mutated];
    }));
    return writeFixture(t, files);
}

function replaceFixtureSource(source, search, replacement, suffix = '') {
    assert.ok(source.includes(search), `controlled mutation must find ${search}`);
    const replaced = source.replace(search, replacement);
    assert.notEqual(replaced, source, `controlled mutation must replace ${search}`);
    return replaced + suffix;
}

test('SECURITY-AI-SESSION-CONVERSATION-SOURCE-001 complete production fixture satisfies every architecture guard', t => {
    validateArchitectureGuards(copyGuardFixture(t));
});

test('ARCH-CURRENT-WORKSPACE-SESSION-AUTHORITY-001 rejects scope identity at the current-card authority boundary', t => {
    const root = copyGuardFixture(
        t,
        'src/openWorkspaces/dashboardController.ts',
        source => replaceFixtureSource(
            source,
            'workspaceNavigationIdentity: navigationIdentity,',
            'workspaceNavigationIdentity: workspace.scopeIdentity,'
        )
    );
    assert.throws(
        () => validateArchitectureGuards(root, {
            ids: ['ARCH-CURRENT-WORKSPACE-SESSION-AUTHORITY-001'],
        }),
        error => /ARCH-CURRENT-WORKSPACE-SESSION-AUTHORITY-001/.test(error.message)
            && /root changes/i.test(error.message)
    );
});

test('ARCH-CURRENT-WORKSPACE-SESSION-AUTHORITY-001 rejects scope-based retention inside the authority', t => {
    const root = copyGuardFixture(
        t,
        'src/workspaces/currentWorkspaceSessionAuthority.ts',
        source => replaceFixtureSource(
            source,
            'normalized.workspaceNavigationIdentity\n        );',
            'normalized.workspaceScopeIdentity\n        );'
        )
    );
    assert.throws(
        () => validateArchitectureGuards(root, {
            ids: ['ARCH-CURRENT-WORKSPACE-SESSION-AUTHORITY-001'],
        }),
        error => /ARCH-CURRENT-WORKSPACE-SESSION-AUTHORITY-001/.test(error.message)
            && /workspace navigation/i.test(error.message)
    );
});

test('ARCH-AI-SESSION-FALLBACK-REASON-001 accepts an ownership-wrapped focused runtime monitor', t => {
    validateArchitectureGuards(copyGuardFixture(t), {
        ids: ['ARCH-AI-SESSION-FALLBACK-REASON-001'],
    });
});

test('ARCH-AI-SESSION-FALLBACK-REASON-001 rejects a parameterized ownership wrapper', t => {
    const root = copyGuardFixture(t, 'src/dashboard.ts', source => replaceFixtureSource(
        source,
        'const tmuxFocusedRuntimeMonitor = ownResource(() =>',
        'const tmuxFocusedRuntimeMonitor = ownResource((_unexpected) =>',
    ));
    assert.throws(
        () => validateArchitectureGuards(root, {
            ids: ['ARCH-AI-SESSION-FALLBACK-REASON-001'],
        }),
        error => /ARCH-AI-SESSION-FALLBACK-REASON-001/.test(error.message)
            && /constructed with one options object/.test(error.message),
    );
});

test('ARCH-AI-SESSION-FALLBACK-REASON-001 rejects an async ownership wrapper', t => {
    const root = copyGuardFixture(t, 'src/dashboard.ts', source => replaceFixtureSource(
        source,
        'const tmuxFocusedRuntimeMonitor = ownResource(() =>',
        'const tmuxFocusedRuntimeMonitor = ownResource(async () =>',
    ));
    assert.throws(
        () => validateArchitectureGuards(root, {
            ids: ['ARCH-AI-SESSION-FALLBACK-REASON-001'],
        }),
        error => /ARCH-AI-SESSION-FALLBACK-REASON-001/.test(error.message)
            && /constructed with one options object/.test(error.message),
    );
});

test('ARCH-AI-SESSION-SCAN-BOUNDARY-001 reports the ID and unbounded-scan risk', t => {
    const root = writeFixture(t, {});
    assert.throws(
        () => validateArchitectureGuards(root, { ids: ['ARCH-AI-SESSION-SCAN-BOUNDARY-001'] }),
        error => /ARCH-AI-SESSION-SCAN-BOUNDARY-001/.test(error.message)
            && /risk:/i.test(error.message)
            && /unbounded/i.test(error.message)
    );
});

test('ARCH-PROTOCOL-001 reports the ID and compatibility risk for an unstable protocol', t => {
    const root = writeFixture(t, {
        'src/openWorkspaces/protocol.ts': 'export const OPEN_WORKSPACE_PROTOCOL_VERSION = 3;\n',
    });
    assert.throws(
        () => validateArchitectureGuards(root, { ids: ['ARCH-PROTOCOL-001'] }),
        error => /ARCH-PROTOCOL-001/.test(error.message)
            && /risk:/i.test(error.message)
            && /compatib/i.test(error.message)
    );
});

test('ARCH-RELEASE-IDENTITY-001 reports the ID and release risk for malformed metadata', t => {
    const root = writeFixture(t, {
        'package.json': '{bad json',
        'extensions/attention-ui-bridge/package.json': '{}',
    });
    assert.throws(
        () => validateArchitectureGuards(root, { ids: ['ARCH-RELEASE-IDENTITY-001'] }),
        error => /ARCH-RELEASE-IDENTITY-001/.test(error.message)
            && /risk:/i.test(error.message)
            && /release identity/i.test(error.message)
    );
});

test('architecture guard runner rejects unknown guard IDs', () => {
    assert.throws(
        () => validateArchitectureGuards(repositoryRoot, { ids: ['ARCH-UNKNOWN-001'] }),
        /unknown architecture guard ARCH-UNKNOWN-001/
    );
});

test('ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001 accepts an empty-block stderr sink', t => {
    const root = copyGuardFixture(
        t,
        'src/aiSessions/conversation/codexAppServerClient.ts',
        source => source.replace(
            'private readonly onStderrData = (_chunk: Buffer): void => undefined;',
            'private readonly onStderrData = (_chunk: Buffer): void => {};'
        )
    );
    validateArchitectureGuards(root, {
        ids: ['ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001'],
    });
});

test('ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001 permits the structured app-server client in the Codex reachable graph', t => {
    const root = copyGuardFixture(
        t,
        'src/aiSessions/conversation/codexAdapter.ts',
        source => source.replace(
            "import { createHash } from 'crypto';",
            "import { createHash } from 'crypto';\n"
                + "import type { CodexAppServerClient } "
                + "from './codexAppServerClient';\n"
                + 'type ReachableAppServerClient = CodexAppServerClient;'
        )
    );
    validateArchitectureGuards(root, {
        ids: ['ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001'],
    });
});

test('ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001 rejects a transitive filesystem bridge from a reachable Codex helper', t => {
    const root = copyGuardFixture(
        t,
        'src/aiSessions/conversation/model.ts',
        source => source.replace(
            "'use strict';",
            "'use strict';\nimport './codexFilesystemBridge';"
        )
    );
    const bridge = path.join(
        root,
        'src/aiSessions/conversation/codexFilesystemBridge.ts'
    );
    fs.writeFileSync(bridge, "import { readFile } from 'node:fs/promises';\n");
    assert.throws(
        () => validateArchitectureGuards(root, {
            ids: ['ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001'],
        }),
        error => error.message.includes(
            'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001'
        )
            && /risk:/i.test(error.message)
            && error.message.includes(
                'Codex reachable modules must not import filesystem or transcript readers'
            )
    );
});

test('ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001 permits safe local and external re-exports in the Codex graph', t => {
    const root = copyGuardFixture(
        t,
        'src/aiSessions/conversation/model.ts',
        source => source.replace(
            "'use strict';",
            "'use strict';\n"
                + "export type { ConversationOutline } from './types';\n"
                + "export { createHash } from 'crypto';"
        )
    );
    validateArchitectureGuards(root, {
        ids: ['ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001'],
    });
});

for (const [label, reExport] of [
    ['star', "export * from './codexFilesystemBridge';"],
    ['named', "export { bridge } from './codexFilesystemBridge';"],
]) {
    test(`ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001 rejects a filesystem helper reached through a ${label} re-export`, t => {
        const root = copyGuardFixture(
            t,
            'src/aiSessions/conversation/model.ts',
            source => source.replace(
                "'use strict';",
                `'use strict';\n${reExport}`
            )
        );
        const bridge = path.join(
            root,
            'src/aiSessions/conversation/codexFilesystemBridge.ts'
        );
        fs.writeFileSync(
            bridge,
            "import { readFile } from 'node:fs/promises';\n"
                + 'export const bridge = readFile;\n'
        );
        assert.throws(
            () => validateArchitectureGuards(root, {
                ids: ['ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001'],
            }),
            error => error.message.includes(
                'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001'
            )
                && /risk:/i.test(error.message)
                && error.message.includes(
                    'Codex reachable modules must not import filesystem or transcript readers'
                )
        );
    });
}

for (const mutation of [
    {
        id: 'ARCH-OPEN-WORKSPACE-FOCUS-CLIENT-OWNERSHIP-001',
        file: 'src/openWorkspaces/bridgeClient.ts',
        expectedDetail: 'bridge client must configure exactly two shared focus channels',
        mutate: source => source.replace(
            'this.attentionFocusChannel = new OpenWorkspaceFocusBridgeChannel({',
            'this.attentionFocusChannel = new LegacyAttentionFocusChannel({',
        ),
    },
    {
        id: 'ARCH-OPEN-WORKSPACE-FOCUS-CLIENT-OWNERSHIP-001',
        file: 'src/openWorkspaces/bridgeClient.ts',
        expectedDetail: 'receiveRunningFocusRequest must remain a thin shared-channel delegate',
        mutate: source => source.replace(
            'this.runningFocusChannel.receive(raw);',
            'this.receiveLegacyRunningFocusRequest(raw);',
        ),
    },
    {
        id: 'ARCH-OPEN-WORKSPACE-FOCUS-CLIENT-OWNERSHIP-001',
        file: 'src/openWorkspaces/bridgeClient.ts',
        expectedDetail: 'requestRunningFocus must remain a thin shared-channel delegate',
        mutate: source => source.replace(
            'return this.runningFocusChannel.request('
                + 'targetNavigationIdentity, sourceNavigationIdentity);',
            'return this.requestLegacyRunningFocus('
                + 'targetNavigationIdentity, sourceNavigationIdentity);',
        ),
    },
    {
        id: 'ARCH-OPEN-WORKSPACE-FOCUS-TRANSPORT-OWNERSHIP-001',
        file: 'extensions/attention-ui-bridge/src/openWorkspaceAttentionFocusStore.ts',
        expectedDetail: 'Attention focus store must extend the shared mailbox store',
        mutate: source => source.replace(
            'extends OpenWorkspaceFocusMailboxStore<OpenWorkspaceAttentionFocusRequest>',
            'extends LegacyAttentionFocusStore<OpenWorkspaceAttentionFocusRequest>',
        ),
    },
    {
        id: 'ARCH-OPEN-WORKSPACE-FOCUS-TRANSPORT-OWNERSHIP-001',
        file: 'extensions/attention-ui-bridge/src/openWorkspaceRunningFocusCoordinator.ts',
        expectedDetail: 'Running focus coordinator must delegate to one shared mailbox coordinator',
        mutate: source => source.replace(
            'this.coordinator = new OpenWorkspaceFocusMailboxCoordinator({',
            'this.coordinator = new LegacyRunningFocusCoordinator({',
        ),
    },
    {
        id: 'ARCH-OPEN-WORKSPACE-FOCUS-TRANSPORT-OWNERSHIP-001',
        file: 'extensions/attention-ui-bridge/src/openWorkspaceRunningFocusStore.ts',
        expectedDetail: 'Running focus store must preserve its v2 temporary-file naming',
        mutate: source => source.replace(
            'temporaryFileStem: requestId => requestId,',
            'temporaryFileStem: requestId => `${requestId}.request.json`,',
        ),
    },
    {
        id: 'ARCH-AI-SESSION-NAVIGATION-OWNERSHIP-001',
        file: 'src/dashboard.ts',
        expectedDetail: 'every direct session command must use the shared navigation coordinator',
        mutate: source => source.replace(
            'navigationCoordinator: sessionNavigationCoordinator,',
            'navigationCoordinator: createSessionNavigationCoordinator(),',
        ),
    },
    {
        id: 'ARCH-AI-SESSION-NAVIGATION-OWNERSHIP-001',
        file: 'src/dashboard.ts',
        expectedDetail: 'every direct session command must use the shared local focus executor',
        mutate: source => source.replace(
            'navigateSession: (item, executionOptions) =>\n'
                + '            sessionNavigationFocusExecutor.execute(item, executionOptions),',
            'navigateSession: async () => ({ focused: false, conversationOpened: false }),',
        ),
    },
    {
        id: 'ARCH-AI-SESSION-NAVIGATION-OWNERSHIP-001',
        file: 'src/dashboard/sessionQuickSwitch.ts',
        expectedDetail: 'Quick Switch and Toggle must own no navigation path outside the shared transaction',
        mutate: source => source.replace(
            'await navigationCoordinator.enqueue(() => jumpToLocal(target));',
            'await jumpToLocal(target);',
        ),
    },
    {
        id: 'ARCH-AI-SESSION-NAVIGATION-OWNERSHIP-001',
        file: 'src/dashboard.ts',
        expectedDetail: 'every direct session command must use the shared navigation coordinator',
        mutate: source => source.replace(
            'const aiSessionQuickSwitchHandlers = createAiSessionQuickSwitchHandlers({\n'
                + '        navigationCoordinator: sessionNavigationCoordinator,',
            'const aiSessionQuickSwitchHandlers = createAiSessionQuickSwitchHandlers({\n'
                + '        navigationCoordinator: createSessionNavigationCoordinator(),',
        ),
    },
    {
        id: 'ARCH-AI-SESSION-NAVIGATION-OWNERSHIP-001',
        file: 'src/dashboard.ts',
        expectedDetail: 'every direct session command must use the shared local focus executor',
        mutate: source => source.replace(
            'navigateSession: (target, executionOptions) =>\n'
                + '            sessionNavigationFocusExecutor.execute(target, executionOptions),',
            'navigateSession: async () => ({ focused: false, conversationOpened: false }),',
        ),
    },
    {
        id: 'ARCH-AI-SESSION-NAVIGATION-OWNERSHIP-001',
        file: 'src/dashboard.ts',
        expectedDetail: 'Previous and Next Active Session commands must use the shared navigation coordinator',
        mutate: source => source.replace(
            "previousActiveSession: () => sessionNavigationCoordinator.enqueue(\n"
                + "            () => followAdjacentActiveConversationWithFeedback('previous')\n"
                + '        ),',
            "previousActiveSession: () => followAdjacentActiveConversationWithFeedback('previous'),",
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/codexAdapter.ts',
        expectedDetail: 'Codex conversation adapter must not import filesystem or transcript JSONL readers',
        mutate: source => source.replace(
            "import { createHash } from 'crypto';",
            "import { createHash } from 'crypto';\nimport * as fs from 'fs';"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/codexAdapter.ts',
        expectedDetail: 'Codex production content must remain app-server-only',
        mutate: source => source.replace(
            "import { createHash } from 'crypto';",
            "import { createHash } from 'crypto';\n"
                + "import { openValidatedConversationSource } from './source';"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/services/codexSessionService.ts',
        expectedDetail: 'Codex production content must remain app-server-only',
        mutate: source => source.replace(
            '    getSessions(options: boolean | AiSessionQueryOptions = false): CodexSessionReadResult {',
            '    resolveConversationSource(sessionId: string): unknown { return sessionId; }\n\n'
                + '    getSessions(options: boolean | AiSessionQueryOptions = false): CodexSessionReadResult {'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/composition.ts',
        expectedDetail: 'Codex production content must remain app-server-only',
        mutate: source => source.replace(
            '        client: codexClient,',
            '        client: codexClient,\n'
                + '        resolveSource: sessionId => '
                + 'options.services.codex.resolveConversationSource?.(sessionId),'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/codexAdapter.ts',
        expectedDetail: 'Codex conversation adapter must not import filesystem or transcript JSONL readers',
        mutate: source => source.replace(
            "import { createHash } from 'crypto';",
            "import { createHash } from 'crypto';\n"
                + "void import('node:fs/promises');"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/codexAdapter.ts',
        expectedDetail: 'Codex conversation adapter must not import filesystem or transcript JSONL readers',
        mutate: source => source.replace(
            "import { createHash } from 'crypto';",
            "import { createHash } from 'crypto';\n"
                + "import fs = require('node:fs/promises');"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/codexAdapter.ts',
        expectedDetail: 'Codex conversation adapter must not import filesystem or transcript JSONL readers',
        mutate: source => source.replace(
            "import { createHash } from 'crypto';",
            "import { createHash } from 'crypto';\n"
                + "import { readFile } from 'node:fs/promises';"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/viewer.ts',
        expectedDetail: 'extension-host TypeScript must not import DOMPurify',
        mutate: source => source.replace(
            "import { URL } from 'url';",
            "import { URL } from 'url';\nimport DOMPurify from 'dompurify';"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/viewer.ts',
        expectedDetail: 'extension-host TypeScript must not import DOMPurify',
        mutate: source => source.replace(
            "import { URL } from 'url';",
            "import { URL } from 'url';\n"
                + "void import('dompurify');"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/viewer.ts',
        expectedDetail: 'extension-host TypeScript must not import DOMPurify',
        mutate: source => source.replace(
            "import { URL } from 'url';",
            "import { URL } from 'url';\n"
                + "import purifier = require('dompurify/dist/purify.cjs.js');"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/viewer.ts',
        expectedDetail: 'extension-host TypeScript must not import DOMPurify',
        mutate: source => source.replace(
            "import { URL } from 'url';",
            "import { URL } from 'url';\n"
                + "import sanitize from 'dompurify/dist/purify.es.mjs';"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/viewer.ts',
        expectedDetail: 'extension-host TypeScript must not import DOMPurify',
        mutate: source => source.replace(
            "import { URL } from 'url';",
            "import { URL } from 'url';\n"
                + "const purifier = require('../../media/purify.min.js');"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/types.ts',
        expectedDetail: 'conversation resource and protocol limits must remain exact',
        mutate: source => replaceFixtureSource(
            source,
            'maxSourceBytes: 64 * 1024 * 1024',
            'maxSourceBytes: 65 * 1024 * 1024'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/types.ts',
        expectedDetail: 'conversation resource and protocol limits must remain exact',
        mutate: source => replaceFixtureSource(
            source,
            'inactiveIndexTtlMs: 10 * 60 * 1000',
            'inactiveIndexTtlMs: 11 * 60 * 1000'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/codexAppServerClient.ts',
        expectedDetail: 'app-server stderr and responses must never be logged',
        mutate: source => source.replace(
            'private readonly onStderrData = (_chunk: Buffer): void => undefined;',
            'private readonly onStderrData = (chunk: Buffer): void => console.error(chunk);'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/codexAppServerClient.ts',
        expectedDetail: 'app-server stderr and responses must never be logged',
        mutate: source => source.replace(
            'if (!this.acceptResponse(response)) {',
            'process.stdout.write(JSON.stringify(response));\n'
                + '            if (!this.acceptResponse(response)) {'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/codexAppServerClient.ts',
        expectedDetail: 'app-server stderr and responses must never be logged',
        mutate: source => source.replace(
            'if (!this.acceptResponse(response)) {',
            'process.stderr.write(JSON.stringify(response));\n'
                + '            if (!this.acceptResponse(response)) {'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/kimiAdapter.ts',
        expectedDetail: 'provider watchers must remain bounded and releasable',
        mutate: source => source.replace(
            '        this.providerWatch?.dispose();\n'
                + '        this.providerWatch = undefined;\n'
                + '        if (this.invalidationTimer !== undefined) {',
            '        // provider watch intentionally leaked\n'
                + '        this.providerWatch = undefined;\n'
                + '        if (this.invalidationTimer !== undefined) {'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/kimiAdapter.ts',
        expectedDetail: 'provider watchers must remain bounded and releasable',
        mutate: source => source.replace(
            '        if (this.subscriptions.size) {\n',
            '        if (!this.subscriptions.size) {\n'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/kimiAdapter.ts',
        expectedDetail: 'provider watchers must remain bounded and releasable',
        mutate: source => source.replace(
            '        if (this.subscriptions.size) {\n',
            '        if (this.subscriptions.size || true) {\n'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/kimiAdapter.ts',
        expectedDetail: 'provider watchers must remain bounded and releasable',
        mutate: source => source.replace(
            '        this.providerWatch?.dispose();\n'
                + '        this.providerWatch = undefined;\n'
                + '        if (this.invalidationTimer !== undefined) {',
            '        if (false) { this.providerWatch?.dispose(); }\n'
                + '        this.providerWatch = undefined;\n'
                + '        if (this.invalidationTimer !== undefined) {'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/kimiAdapter.ts',
        expectedDetail: 'provider watchers must remain bounded and releasable',
        mutate: source => source.replace(
            '        if (this.subscriptions.size) {\n'
                + '            return;\n'
                + '        }\n'
                + '        this.providerWatch?.dispose();\n'
                + '        this.providerWatch = undefined;\n',
            '        if (this.subscriptions.size) {\n'
                + '            return;\n'
                + '        }\n'
                + '        return;\n'
                + '        this.providerWatch?.dispose();\n'
                + '        this.providerWatch = undefined;\n'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001',
        file: 'src/aiSessions/conversation/kimiAdapter.ts',
        expectedDetail: 'provider watchers must remain bounded and releasable',
        mutate: source => source.replace(
            '        const listener = (): void => onChange();',
            '        this.options.watchSessionChanges(onChange);\n'
                + '        const listener = (): void => onChange();'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-SCAN-BOUNDARY-001',
        file: 'src/dashboard.ts',
        expectedDetail: 'incremental scans must keep a positive finite file budget',
        mutate: source => replaceFixtureSource(source,
            'AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 2000',
            'AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 0',
            '\nconst OLD_AI_SESSION_INCREMENTAL_SCAN_MAX_FILES = 2000;\n'),
    },
    {
        id: 'ARCH-AI-SESSION-INCREMENTAL-REFRESH-SOURCE-001',
        file: 'src/aiSessions/dashboardController.ts',
        expectedDetail: 'provider watchers must use the coalesced incremental refresh path exactly once',
        mutate: source => replaceFixtureSource(source,
            "this.scheduleRefresh('watcher')", "this.options.refresh('watcher')",
            "\n// this.scheduleRefresh('watcher')\n"),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/aiSessions/dashboardController.ts',
        expectedDetail: 'cards and HTML must consume the transaction and publish its revision',
        mutate: source => replaceFixtureSource(
            source,
            'sequence: projection.revision',
            'sequence: projection.revision + 1'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must accept only v3 envelopes and close each revision against direct Presentation',
        mutate: source => replaceFixtureSource(
            source,
            'revision <= latestAiSessionPresentationProjectionRevision',
            'revision < latestAiSessionPresentationProjectionRevision'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must accept only v3 envelopes and close each revision against direct Presentation',
        mutate: source => replaceFixtureSource(
            source,
            'revision <= latestAiSessionClosedPresentationRevision',
            'revision < latestAiSessionClosedPresentationRevision'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must accept only v3 envelopes and close each revision against direct Presentation',
        mutate: source => replaceFixtureSource(
            source,
            'revision >= latestAiSessionPresentationProjectionRevision',
            'revision > latestAiSessionPresentationProjectionRevision'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/openWorkspaces/dashboardController.ts',
        expectedDetail: 'OPEN HTML and Presentation must share one Host message',
        mutate: source => replaceFixtureSource(
            source,
            'cards: this.getCards(projection)',
            'cards: this.getCards()'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/aiSessions/dashboardController.ts',
        expectedDetail: 'AI incremental HTML and Presentation must share one Host message',
        mutate: source => replaceFixtureSource(
            source,
            'presentation: buildAiSessionPresentationState(',
            'detachedPresentation: buildAiSessionPresentationState('
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/aiSessions/dashboardController.ts',
        expectedDetail: 'AI incremental HTML and Presentation must share one Host message',
        mutate: source => replaceFixtureSource(
            source,
            'presentation: buildAiSessionPresentationState(\n                false,\n                projection,',
            'presentation: buildAiSessionPresentationState(\n                true,\n                projection,'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/openWorkspaces/dashboardController.ts',
        expectedDetail: 'OPEN HTML and Presentation must share one Host message',
        mutate: source => replaceFixtureSource(
            source,
            'presentation: buildAiSessionPresentationState(\n                false,\n                projection,',
            'presentation: buildAiSessionPresentationState(\n                true,\n                projection,'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/dashboard.ts',
        expectedDetail: 'OPEN HTML and Presentation must share one Host message',
        mutate: source => replaceFixtureSource(
            source,
            'const message = buildAiSessionPresentationState(\n            true,\n            transaction,',
            'const message = buildAiSessionPresentationState(\n            false,\n            transaction,'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'AI atomic replacement must reconcile batch and provider state inside the transaction hook',
        mutate: source => replaceFixtureSource(
            source,
            'afterReplacement: () => {',
            'detachedAfterReplacement: () => {'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'AI atomic replacement must reconcile batch and provider state inside the transaction hook',
        mutate: source => replaceFixtureSource(
            source,
            'syncAiSessionBatchManagementDom(projectDiv);',
            'syncAiSessionProjectionDom(false);'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must validate v3 envelopes atomically and reserve direct Presentation for focus',
        mutate: source => replaceFixtureSource(
            source,
            'message.presentation.projectionRevision !== message.projectionRevision',
            'message.presentation.projectionRevision < message.projectionRevision'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must validate v3 envelopes atomically and reserve direct Presentation for focus',
        mutate: source => replaceFixtureSource(
            source,
            'message.presentation.revealFocused !== false',
            'message.presentation.revealFocused !== true'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectScripts.js',
        expectedDetail: 'Webview must validate v3 envelopes atomically and reserve direct Presentation for focus',
        mutate: source => replaceFixtureSource(
            source,
            'presentationTransactions.applyAtomicEnvelope({',
            'presentationTransactions.applyDirectPresentation({'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must validate v3 envelopes atomically and reserve direct Presentation for focus',
        mutate: source => replaceFixtureSource(
            source,
            'commitAtomicProjectionRevision(message.projectionRevision)',
            'commitAtomicProjectionRevision(message.projectionRevision - 1)'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must validate v3 envelopes atomically and reserve direct Presentation for focus',
        mutate: source => replaceFixtureSource(
            source,
            '|| !canApplyAtomicPresentationProjectionRevision(message.projectionRevision)',
            '|| !canApplyProjectionRevision(message.projectionRevision)'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'AI atomic replacement must reconcile batch and provider state inside the transaction hook',
        mutate: source => replaceFixtureSource(
            source,
            'presentationTransactions.applyAtomicEnvelope({',
            'presentationTransactions.applyDirectPresentation({'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must accept only v3 envelopes and close each revision against direct Presentation',
        mutate: source => replaceFixtureSource(
            source,
            'message.version !== 3',
            'message.version !== 2'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewWorkspaceUpdateScripts.js',
        expectedDetail: 'Webview must validate v3 envelopes atomically and reserve direct Presentation for focus',
        mutate: source => replaceFixtureSource(
            source,
            "message.type !== 'open-workspaces-updated'\n        || message.version !== 3",
            "message.type !== 'open-workspaces-updated'\n        || message.version !== 2"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'all Presentation revision counters must belong to the shared transaction owner',
        mutate: source => replaceFixtureSource(
            replaceFixtureSource(
                source,
                '    var latestAiSessionProjectionRevision = 0;\n',
                ''
            ),
            'function initAiSessionPresentationTransactions(options) {',
            'var latestAiSessionProjectionRevision = 0;\n\n'
                + 'function initAiSessionPresentationTransactions(options) {'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must validate v3 envelopes atomically and reserve direct Presentation for focus',
        mutate: source => replaceFixtureSource(
            source,
            'message.revealFocused !== true',
            'message.revealFocused === undefined'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must validate v3 envelopes atomically and reserve direct Presentation for focus',
        mutate: source => replaceFixtureSource(
            source,
            "if (!input.replaceContent()) {\n"
                + "            requestFullRefresh(input.invalidReplacementReason);\n"
                + "            return false;\n"
                + "        }\n"
                + "        commitAtomicProjectionRevision(message.projectionRevision);",
            "commitAtomicProjectionRevision(message.projectionRevision);\n"
                + "        if (!input.replaceContent()) {\n"
                + "            requestFullRefresh(input.invalidReplacementReason);\n"
                + "            return false;\n"
                + "        }"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectAiUpdateScripts.js',
        expectedDetail: 'Webview must validate v3 envelopes atomically and reserve direct Presentation for focus',
        mutate: source => replaceFixtureSource(
            source,
            "if (typeof input.afterReplacement === 'function') {\n"
                + "            input.afterReplacement();\n"
                + "        }\n"
                + "        applyValidatedAiSessionPresentationState(message.presentation);",
            "applyValidatedAiSessionPresentationState(message.presentation);\n"
                + "        if (typeof input.afterReplacement === 'function') {\n"
                + "            input.afterReplacement();\n"
                + "        }"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/dashboard.ts',
        expectedDetail: 'full Dashboard document must capture and embed one Presentation transaction',
        mutate: source => replaceFixtureSource(
            source,
            'getOpenWorkspaceCards(transaction),',
            'getOpenWorkspaceCards(),'
        ),
    },
    {
        id: 'ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001',
        file: 'src/webview/webviewProjectScripts.js',
        expectedDetail: 'Webview must seed revision and complete owners from the full document',
        mutate: source => replaceFixtureSource(
            source,
            "getElementById('dashboard-ai-session-presentation')",
            "getElementById('missing-ai-session-presentation')"
        ),
    },
    {
        id: 'ARCH-AI-SESSION-FALLBACK-REASON-001',
        file: 'src/dashboard.ts',
        expectedDetail: 'focused-runtime fallback must have an explicit diagnostic reason',
        mutate: source => replaceFixtureSource(source,
            "onError: error => logAiSessionRuntimeFailure('sync-focused-runtime', error)",
            "onError: error => logAiSessionRuntimeFailure('sync-runtime', error)",
            "\nfunction deadFallbackDecoy(error: unknown) {"
                + " logAiSessionRuntimeFailure('sync-focused-runtime', error); }\n"),
    },
    {
        id: 'ARCH-AI-SESSION-FALLBACK-REASON-001',
        file: 'src/aiSessions/attentionController.ts',
        expectedDetail: 'runtime completion must not be converted into, or used to suppress, attention',
        mutate: source => `${source}\nconst obsoleteRuntimeAttentionToken = 'terminal-exit:fixture';\n`,
    },
    {
        id: 'ARCH-PROVIDER-REGISTRY-COMPLETENESS-001',
        file: 'src/aiSessions/providers.ts',
        expectedDetail: 'the supported provider ID list must remain complete and ordered',
        mutate: source => replaceFixtureSource(source,
            "['codex', 'kimi', 'claude']", "['codex', 'kimi']",
            "\nconst OLD_AI_SESSION_PROVIDER_IDS = ['codex', 'kimi', 'claude'];\n"),
    },
    {
        id: 'ARCH-PROTOCOL-001',
        file: 'src/openWorkspaces/protocol.ts',
        expectedDetail: 'open-workspace protocol version must remain 4 until an explicit migration exists',
        mutate: source => replaceFixtureSource(source,
            'OPEN_WORKSPACE_PROTOCOL_VERSION = 4', 'OPEN_WORKSPACE_PROTOCOL_VERSION = 5',
            '\nconst OLD_OPEN_WORKSPACE_PROTOCOL_VERSION = 4;\n'),
    },
    {
        id: 'ARCH-PROTOCOL-001',
        file: 'src/aiSessions/attentionBridgeClient.ts',
        expectedDetail: 'attention client unregister writer must contain exactly one protocolVersion: 1',
        mutate: source => replaceFixtureSource(source,
            '{ protocolVersion: 1, instanceId: this.instanceId }',
            '{ protocolVersion: 2, instanceId: this.instanceId }'),
    },
    {
        id: 'ARCH-PROTOCOL-001',
        file: 'src/aiSessions/attentionPayload.ts',
        expectedDetail: 'validateAttentionUnregisterRequest validator and normalized return must contain exactly one record.protocolVersion !== 1',
        mutate: source => replaceFixtureSource(source,
            "if (record.protocolVersion !== 1) throw new Error('attention unregister protocol is incompatible');",
            "if (record.protocolVersion !== 2) throw new Error('attention unregister protocol is incompatible');"),
    },
    ...[
        {
            file: 'package.json',
            expectedDetail: 'Main manifest name is stale',
            mutate: manifest => { manifest.name = 'project-steward'; },
        },
        {
            file: 'package.json',
            expectedDetail: 'Main manifest version is stale',
            mutate: manifest => { manifest.version = '2.1.8'; },
        },
        {
            file: 'package.json',
            expectedDetail: 'Main manifest extension dependencies are invalid',
            mutate: manifest => {
                manifest.extensionDependencies = [
                    'hzcheng.project-steward-attention-ui-bridge',
                ];
            },
        },
        {
            file: 'extensions/attention-ui-bridge/package.json',
            expectedDetail: 'Bridge manifest name is stale',
            mutate: manifest => {
                manifest.name = 'project-steward-attention-ui-bridge';
            },
        },
        {
            file: 'extensions/attention-ui-bridge/package.json',
            expectedDetail: 'Bridge manifest icon is invalid',
            mutate: manifest => { delete manifest.icon; },
        },
    ].map(mutation => ({
        id: 'ARCH-RELEASE-IDENTITY-001',
        file: mutation.file,
        expectedDetail: mutation.expectedDetail,
        mutate: source => {
            const manifest = JSON.parse(source);
            mutation.mutate(manifest);
            return `${JSON.stringify(manifest, null, 4)}\n`;
        },
    })),
    ...[
        ['AGENT_PIVOT_CONFIG_SECTION', "'agentPivot'", "'projectSteward'"],
        ['AGENT_PIVOT_EXTENSION_ID', "'hzcheng.agent-pivot'", "'hzcheng.project-steward'"],
        ['AGENT_PIVOT_VIEW_CONTAINER_ID', "'agentPivot'", "'projectSteward'"],
        ['AGENT_PIVOT_DASHBOARD_VIEW_ID', "'agentPivot.dashboard'", "'projectSteward.dashboard'"],
        ['AGENT_PIVOT_CONVERSATION_VIEW_TYPE', "'agentPivot.aiConversation'", "'projectSteward.aiConversation'"],
    ].map(([constant, current, stale]) => ({
        id: 'ARCH-RELEASE-IDENTITY-001',
        file: 'src/constants.ts',
        expectedDetail: `${constant} must remain`,
        mutate: source => replaceFixtureSource(
            source,
            constant === 'AGENT_PIVOT_CONVERSATION_VIEW_TYPE'
                ? `${constant} =\n    ${current}`
                : `${constant} = ${current}`,
            constant === 'AGENT_PIVOT_CONVERSATION_VIEW_TYPE'
                ? `${constant} =\n    ${stale}`
                : `${constant} = ${stale}`,
        ),
    })),
]) {
    test(`${mutation.id} controlled mutation is rejected at its exact expectation site`, t => {
        const root = copyGuardFixture(t, mutation.file, mutation.mutate);
        assert.throws(
            () => validateArchitectureGuards(root, { ids: [mutation.id] }),
            error => error.message.includes(mutation.id)
                && /risk:/i.test(error.message)
                && error.message.includes(mutation.expectedDetail)
        );
    });
}
