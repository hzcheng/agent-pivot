import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { resolveBridgeStorageRoot } from './bridgeStorageRoot';
import { LocalStore } from './localStore';
import { OpenWorkspaceCoordinator } from './openWorkspaceCoordinator';
import { OpenWorkspacePinCoordinator } from './openWorkspacePinCoordinator';
import { OpenWorkspaceRunningFocusCoordinator } from './openWorkspaceRunningFocusCoordinator';
import { OpenWorkspaceAttentionFocusCoordinator } from './openWorkspaceAttentionFocusCoordinator';
import {
    AuthoritativeOpenWorkspaceUri,
    replaceOpenWorkspacePublicationUris,
} from './openWorkspacePublication';
import { ProductionAttentionStore } from './productionAttentionStore';
import { aggregateAttentionSnapshots, validateAttentionAggregate } from '../../../src/aiSessions/attentionAggregate';
import {
    validateAttentionBridgeHandshakeRequest,
    validateAttentionOwnerSnapshot,
    validateAttentionUnregisterRequest,
} from '../../../src/aiSessions/attentionPayload';
import { parseRoutingChallenge } from '../../../shared/attention-bridge/protocol';
import { ProbeSnapshot } from '../../../shared/attention-bridge/storeProtocol';
import { createWorkspaceIdentity } from '../../../shared/attention-bridge/workspaceIdentity';
import {
    OPEN_WORKSPACE_CAPABILITIES,
    OPEN_WORKSPACE_NAVIGATE_COMMAND,
    OPEN_WORKSPACE_PROTOCOL_VERSION,
} from '../../../src/openWorkspaces/protocol';
import {
    OPEN_WORKSPACE_PIN_SET_COMMAND,
    OPEN_WORKSPACE_PIN_SNAPSHOT_COMMAND,
} from '../../../src/openWorkspaces/pinProtocol';
import {
    OPEN_WORKSPACE_RUNNING_FOCUS_DELIVER_COMMAND,
    OPEN_WORKSPACE_RUNNING_FOCUS_REQUEST_COMMAND,
} from '../../../src/openWorkspaces/runningFocusProtocol';
import {
    OPEN_WORKSPACE_ATTENTION_FOCUS_DELIVER_COMMAND,
    OPEN_WORKSPACE_ATTENTION_FOCUS_REQUEST_COMMAND,
} from '../../../src/openWorkspaces/attentionFocusProtocol';
import {
    SAVED_PROJECT_NAVIGATE_COMMAND,
    SAVED_PROJECT_NAVIGATION_PROTOCOL_VERSION,
    validateSavedProjectNavigationRequest,
} from '../../../src/projects/projectNavigationProtocol';

const BRIDGE_CHALLENGE = '_agentPivotAttentionSpike.bridge.challenge';
const WORKSPACE_CHALLENGE = '_agentPivotAttentionSpike.workspace.challenge';
const BRIDGE_PUBLISH = '_agentPivotAttentionSpike.bridge.publish';
const BRIDGE_STATUS = '_agentPivotAttentionSpike.bridge.status';
const BRIDGE_SET_WATCHER = '_agentPivotAttentionSpike.bridge.setWatcher';
const BRIDGE_CLEAR = '_agentPivotAttentionSpike.bridge.clear';
const WORKSPACE_AGGREGATE = '_agentPivotAttentionSpike.workspace.aggregate';
const PRODUCTION_BRIDGE_PUBLISH = '_agentPivotAttention.bridge.publish';
const PRODUCTION_WORKSPACE_AGGREGATE = '_agentPivotAttention.workspace.aggregate';
const PRODUCTION_BRIDGE_ACKNOWLEDGE = '_agentPivotAttention.bridge.acknowledge';
const PRODUCTION_BRIDGE_HANDSHAKE = '_agentPivotAttention.bridge.handshake';
const PRODUCTION_BRIDGE_UNREGISTER = '_agentPivotAttention.bridge.unregister';
const OPEN_WORKSPACE_BRIDGE_HANDSHAKE = '_agentPivotOpenWorkspaces.bridge.handshake';
const OPEN_WORKSPACE_BRIDGE_PUBLISH = '_agentPivotOpenWorkspaces.bridge.publish';
const OPEN_WORKSPACE_BRIDGE_UNREGISTER = '_agentPivotOpenWorkspaces.bridge.unregister';
const OPEN_WORKSPACE_AGGREGATE = '_agentPivotOpenWorkspaces.workspace.aggregate';
const OPEN_WORKSPACE_DIAGNOSTIC = '_agentPivotOpenWorkspaces.workspace.diagnostic';

interface AggregateState {
    bridgeProcessId: string;
    workspaceIdentity: string;
    snapshots: ProbeSnapshot[];
    counters: unknown;
    observedAtMs: number;
}

function snapshotAuthoritativeUri(uri: vscode.Uri): AuthoritativeOpenWorkspaceUri {
    return {
        value: uri.toString(),
        scheme: uri.scheme,
        authority: uri.authority,
        path: uri.path,
    };
}

let activeOpenWorkspaceCoordinator: OpenWorkspaceCoordinator | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('Agent Pivot UI Bridge');
    context.subscriptions.push(outputChannel);
    const bridgeExtensionVersion = readBridgeExtensionVersion(context);
    const bridgeProcessId = crypto.randomBytes(16).toString('hex');
    const workspaceIdentity = createWorkspaceIdentity(
        (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.path)
    );
    const bridgeRoot = resolveBridgeStorageRoot(context.globalStoragePath, context.globalStorageUri.scheme);
    const instanceId = crypto.randomBytes(16).toString('hex');
    const store = new LocalStore(bridgeRoot, instanceId, bridgeProcessId);
    const productionStore = new ProductionAttentionStore(path.join(bridgeRoot, 'production-attention', 'v1'), bridgeProcessId);
    let watcherEnabled = false;
    let fsWatcher: fs.FSWatcher | null = null;
    let lastAggregate = '';
    let lastProductionAggregate = '';
    let scanTimer: NodeJS.Timeout | null = null;
    const acknowledgedEventIds = await store.readAcknowledgements();
    const openWorkspaceCoordinator = new OpenWorkspaceCoordinator(bridgeRoot, {
        now: () => Date.now(),
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
        createWatcher: (directory, onDidChange) => {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            return fs.watch(directory, onDidChange);
        },
        deliverAggregate: aggregate => vscode.commands.executeCommand(
            OPEN_WORKSPACE_AGGREGATE,
            aggregate,
        ),
        reportDiagnostic: event => {
            outputChannel.appendLine(`[OpenWorkspaces] ${JSON.stringify(event)}`);
            void vscode.commands.executeCommand(OPEN_WORKSPACE_DIAGNOSTIC, event).then(
                () => undefined,
                () => undefined,
            );
        },
    });
    activeOpenWorkspaceCoordinator = openWorkspaceCoordinator;
    const openWorkspacePinCoordinator = new OpenWorkspacePinCoordinator(bridgeRoot, {
        now: () => Date.now(),
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
        createWatcher: (directory, onDidChange) => {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            return fs.watch(directory, onDidChange);
        },
        deliverSnapshot: snapshot => vscode.commands.executeCommand(
            OPEN_WORKSPACE_PIN_SNAPSHOT_COMMAND,
            snapshot,
        ),
        reportError: error => {
            outputChannel.appendLine(
                `[OpenWorkspacePins] ${error instanceof Error ? error.message : String(error)}`,
            );
        },
    });
    const openWorkspaceRunningFocusCoordinator = new OpenWorkspaceRunningFocusCoordinator(bridgeRoot, {
        now: () => Date.now(),
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
        createWatcher: (directory, onDidChange) => {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            return fs.watch(directory, onDidChange);
        },
        deliverRequest: request => vscode.commands.executeCommand(
            OPEN_WORKSPACE_RUNNING_FOCUS_DELIVER_COMMAND,
            request,
        ),
        isNavigationWinner: navigationIdentity =>
            openWorkspaceCoordinator.isNavigationWinner(navigationIdentity),
        reportError: error => {
            outputChannel.appendLine(
                `[OpenWorkspaceRunningFocus] ${error instanceof Error ? error.message : String(error)}`,
            );
        },
    });
    const openWorkspaceAttentionFocusCoordinator = new OpenWorkspaceAttentionFocusCoordinator(bridgeRoot, {
        now: () => Date.now(),
        setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
        clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
        createWatcher: (directory, onDidChange) => {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            return fs.watch(directory, onDidChange);
        },
        deliverRequest: request => vscode.commands.executeCommand(
            OPEN_WORKSPACE_ATTENTION_FOCUS_DELIVER_COMMAND,
            request,
        ),
        isNavigationWinner: navigationIdentity =>
            openWorkspaceCoordinator.isNavigationWinner(navigationIdentity),
        reportError: error => {
            outputChannel.appendLine(
                `[OpenWorkspaceAttentionFocus] ${error instanceof Error ? error.message : String(error)}`,
            );
        },
    });

    function applyAcknowledgements(snapshots: ProbeSnapshot[]): ProbeSnapshot[] {
        return snapshots.map(snapshot => {
            try {
                const owner = JSON.parse(snapshot.payload) as { items?: Array<Record<string, unknown>> };
                if (!Array.isArray(owner.items)) return snapshot;
                owner.items = owner.items.map(item => typeof item.eventId === 'string' && acknowledgedEventIds.has(item.eventId)
                    ? { ...item, state: 'acknowledged' }
                    : item);
                return { ...snapshot, payload: JSON.stringify(owner) };
            } catch (_error) {
                return snapshot;
            }
        });
    }

    async function scanAndNotify(): Promise<void> {
        const persistedAcknowledgements = await store.readAcknowledgements(Date.now());
        acknowledgedEventIds.clear();
        persistedAcknowledgements.forEach(eventId => acknowledgedEventIds.add(eventId));
        const scan = await store.scan(Date.now());
        const semantic = `${JSON.stringify(scan.snapshots.map(snapshot => ({
            instanceId: snapshot.instanceId,
            sequence: snapshot.sequence,
            payload: snapshot.payload,
        })))}|${JSON.stringify(Array.from(acknowledgedEventIds).sort())}`;
        if (semantic === lastAggregate) {
            return;
        }
        lastAggregate = semantic;
        const aggregate: AggregateState = {
            bridgeProcessId,
            workspaceIdentity,
            snapshots: applyAcknowledgements(scan.snapshots),
            counters: scan.counters,
            observedAtMs: Date.now(),
        };
        await vscode.commands.executeCommand(WORKSPACE_AGGREGATE, aggregate);
    }

    async function scanProductionAndNotify(force = false): Promise<void> {
        const persistedAcknowledgements = await store.readAcknowledgements(Date.now());
        acknowledgedEventIds.clear();
        persistedAcknowledgements.forEach(eventId => acknowledgedEventIds.add(eventId));
        const scan = await productionStore.scan(Date.now());
        const aggregate = validateAttentionAggregate(aggregateAttentionSnapshots(scan.snapshots, acknowledgedEventIds, Date.now()));
        if (!force && aggregate.aggregateRevision === lastProductionAggregate) return;
        lastProductionAggregate = aggregate.aggregateRevision;
        await vscode.commands.executeCommand(PRODUCTION_WORKSPACE_AGGREGATE, aggregate);
    }

    const challengeDisposable = vscode.commands.registerCommand(BRIDGE_CHALLENGE, async (raw: unknown) => {
        const request = parseRoutingChallenge(raw);
        if (request.workspaceIdentity !== workspaceIdentity) {
            throw new Error(`bridge workspace identity mismatch: ${workspaceIdentity}`);
        }
        const reverse = await vscode.commands.executeCommand<Record<string, unknown>>(WORKSPACE_CHALLENGE, {
            ...request,
            bridgeProcessId,
        });
        if (!reverse || reverse.workspaceProcessId !== request.workspaceProcessId ||
            reverse.workspaceIdentity !== request.workspaceIdentity || reverse.nonce !== request.nonce ||
            reverse.bridgeProcessId !== bridgeProcessId) {
            throw new Error('reverse Workspace response mismatch');
        }
        return {
            ...request,
            bridgeProcessId,
        };
    });

    const publishDisposable = vscode.commands.registerCommand(BRIDGE_PUBLISH, async (raw: unknown) => {
        await store.writeForeign(raw as ProbeSnapshot);
        await scanAndNotify();
        return { accepted: true, bridgeProcessId, instanceId };
    });
    const productionHandshakeDisposable = vscode.commands.registerCommand(PRODUCTION_BRIDGE_HANDSHAKE, async (raw: unknown) => {
        validateAttentionBridgeHandshakeRequest(raw);
        await scanProductionAndNotify(true);
        return {
            accepted: true,
            protocolVersion: 1,
            bridgeExtensionVersion,
            capabilities: { snapshots: true, acknowledgements: true, atomicReplace: true },
        };
    });
    const productionPublishDisposable = vscode.commands.registerCommand(PRODUCTION_BRIDGE_PUBLISH, async (raw: unknown) => {
        const snapshot = validateAttentionOwnerSnapshot(raw);
        await productionStore.write(snapshot, Date.now(), bridgeExtensionVersion);
        await scanProductionAndNotify();
        return { accepted: true, bridgeProcessId, instanceId };
    });
    const productionUnregisterDisposable = vscode.commands.registerCommand(PRODUCTION_BRIDGE_UNREGISTER, async (raw: unknown) => {
        const request = validateAttentionUnregisterRequest(raw);
        await productionStore.remove(request.instanceId);
        await scanProductionAndNotify(true);
        return { removed: true };
    });
    const productionAcknowledgeDisposable = vscode.commands.registerCommand(PRODUCTION_BRIDGE_ACKNOWLEDGE, async (raw: unknown) => {
        const eventIds = (raw as { eventIds?: unknown })?.eventIds;
        if (!Array.isArray(eventIds) || eventIds.length > 1000
            || eventIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 1024)) {
            throw new Error('attention acknowledgement eventIds are invalid');
        }
        await store.writeAcknowledgements(eventIds as string[]);
        eventIds.forEach(id => acknowledgedEventIds.add(id as string));
        await scanProductionAndNotify(true);
        return { acknowledged: eventIds.length };
    });
    const openWorkspaceHandshakeDisposable = vscode.commands.registerCommand(
        OPEN_WORKSPACE_BRIDGE_HANDSHAKE,
        async (raw: unknown) => {
            const compatible = isOpenWorkspaceHandshakeCompatible(raw);
            return {
                accepted: compatible,
                protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION,
                bridgeExtensionVersion,
                capabilities: OPEN_WORKSPACE_CAPABILITIES,
                pinSnapshot: await openWorkspacePinCoordinator.getSnapshot(),
                ...(compatible ? {} : { errorCode: 'update-required' }),
            };
        },
    );
    const openWorkspacePublishDisposable = vscode.commands.registerCommand(
        OPEN_WORKSPACE_BRIDGE_PUBLISH,
        (raw: unknown) => {
            const workspaceFile = vscode.workspace.workspaceFile;
            const workspaceUri = workspaceFile
                ? snapshotAuthoritativeUri(workspaceFile)
                : null;
            const rootUris = (vscode.workspace.workspaceFolders || [])
                .map(folder => snapshotAuthoritativeUri(folder.uri));
            return openWorkspaceCoordinator.publish(
                replaceOpenWorkspacePublicationUris(raw, workspaceUri, rootUris),
            );
        },
    );
    const openWorkspaceUnregisterDisposable = vscode.commands.registerCommand(
        OPEN_WORKSPACE_BRIDGE_UNREGISTER,
        (raw: unknown) => openWorkspaceCoordinator.unregister(raw),
    );
    const openWorkspaceSetPinDisposable = vscode.commands.registerCommand(
        OPEN_WORKSPACE_PIN_SET_COMMAND,
        (raw: unknown) => openWorkspacePinCoordinator.setPinned(raw),
    );
    const openWorkspaceRequestRunningFocusDisposable = vscode.commands.registerCommand(
        OPEN_WORKSPACE_RUNNING_FOCUS_REQUEST_COMMAND,
        (raw: unknown) => openWorkspaceRunningFocusCoordinator.submit(raw),
    );
    const openWorkspaceRequestAttentionFocusDisposable = vscode.commands.registerCommand(
        OPEN_WORKSPACE_ATTENTION_FOCUS_REQUEST_COMMAND,
        (raw: unknown) => openWorkspaceAttentionFocusCoordinator.submit(raw),
    );
    const openWorkspaceNavigateDisposable = vscode.commands.registerCommand(
        OPEN_WORKSPACE_NAVIGATE_COMMAND,
        async (raw: unknown) => {
            const target = await openWorkspaceCoordinator.resolveNavigationTarget(raw);
            await vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.parse(target.navigationUri),
                { forceNewWindow: true },
            );
            return {
                protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION,
                opened: true,
            };
        },
    );
    const savedProjectNavigateDisposable = vscode.commands.registerCommand(
        SAVED_PROJECT_NAVIGATE_COMMAND,
        async (raw: unknown) => {
            const request = validateSavedProjectNavigationRequest(raw);
            const options = request.openInNewWindow
                ? { forceNewWindow: true }
                : { forceReuseWindow: true };
            if (request.remoteType === 1) {
                const sshUri = request.projectPath.includes('://')
                    ? vscode.Uri.parse(request.projectPath)
                    : null;
                if (!sshUri || !sshUri.path || sshUri.path === '/') {
                    const remoteAuthority = sshUri
                        ? decodeURIComponent(sshUri.authority)
                        : request.projectPath.replace('vscode-remote://', '');
                    await vscode.commands.executeCommand('vscode.newWindow', {
                        remoteAuthority,
                        reuseWindow: !request.openInNewWindow,
                    });
                    return {
                        protocolVersion: SAVED_PROJECT_NAVIGATION_PROTOCOL_VERSION,
                        opened: true,
                    };
                }
            }
            const uri = request.remoteType === 0 && !request.projectPath.includes('://')
                ? vscode.Uri.file(request.projectPath)
                : vscode.Uri.parse(request.projectPath);
            await vscode.commands.executeCommand('vscode.openFolder', uri, options);
            return {
                protocolVersion: SAVED_PROJECT_NAVIGATION_PROTOCOL_VERSION,
                opened: true,
            };
        },
    );
    const statusDisposable = vscode.commands.registerCommand(BRIDGE_STATUS, async () => {
        const scan = await store.scan(Date.now());
        return {
            bridgeProcessId,
            instanceId,
            workspaceIdentity,
            storageRoot: bridgeRoot,
            watcherEnabled,
            scan,
        };
    });
    const watcherDisposable = vscode.commands.registerCommand(BRIDGE_SET_WATCHER, async (enabled: unknown) => {
        watcherEnabled = enabled === true;
        if (fsWatcher !== null) {
            fsWatcher.close();
            fsWatcher = null;
        }
        if (watcherEnabled) {
            const instancesDirectory = path.join(bridgeRoot, 'instances');
            await fs.promises.mkdir(instancesDirectory, { recursive: true, mode: 0o700 });
            fsWatcher = fs.watch(instancesDirectory, () => {
                void scanAndNotify().catch(() => undefined);
            });
            await scanAndNotify();
        }
        return { watcherEnabled };
    });
    const clearDisposable = vscode.commands.registerCommand(BRIDGE_CLEAR, async () => {
        await store.removeOwnSnapshot();
        lastAggregate = '';
        return { cleared: true, bridgeProcessId, instanceId };
    });
    const scanRegistration = vscode.commands.registerCommand('_agentPivotAttentionSpike.bridge.scan', scanAndNotify);
    scanTimer = setInterval(() => {
        void scanAndNotify().catch(error => {
            void vscode.commands.executeCommand(WORKSPACE_AGGREGATE, {
                bridgeProcessId,
                workspaceIdentity,
                error: error instanceof Error ? error.message : String(error),
                observedAtMs: Date.now(),
            });
        });
        void scanProductionAndNotify().catch(() => undefined);
    }, 2000);

    context.subscriptions.push(
        challengeDisposable,
        publishDisposable,
        productionHandshakeDisposable,
        productionPublishDisposable,
        productionUnregisterDisposable,
        productionAcknowledgeDisposable,
        openWorkspaceHandshakeDisposable,
        openWorkspacePublishDisposable,
        openWorkspaceUnregisterDisposable,
        openWorkspaceSetPinDisposable,
        openWorkspaceRequestRunningFocusDisposable,
        openWorkspaceRequestAttentionFocusDisposable,
        openWorkspaceNavigateDisposable,
        savedProjectNavigateDisposable,
        statusDisposable,
        watcherDisposable,
        clearDisposable,
        scanRegistration,
        openWorkspaceCoordinator,
        openWorkspacePinCoordinator,
        openWorkspaceRunningFocusCoordinator,
        openWorkspaceAttentionFocusCoordinator,
        {
            dispose: () => {
                if (scanTimer !== null) {
                    clearInterval(scanTimer);
                    scanTimer = null;
                }
                if (fsWatcher !== null) {
                    fsWatcher.close();
                    fsWatcher = null;
                }
                void store.removeOwnSnapshot();
            },
        },
    );
}

function isOpenWorkspaceHandshakeCompatible(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const request = raw as Record<string, unknown>;
    if (Object.keys(request).sort().join('\n')
        !== ['protocolVersion', 'mainExtensionVersion', 'instanceId', 'capabilities'].sort().join('\n')) {
        return false;
    }
    if (request.protocolVersion !== OPEN_WORKSPACE_PROTOCOL_VERSION
        || typeof request.mainExtensionVersion !== 'string'
        || !request.mainExtensionVersion
        || request.mainExtensionVersion.length > 64
        || typeof request.instanceId !== 'string'
        || !/^[a-f0-9]{32}$/.test(request.instanceId)) {
        return false;
    }
    const capabilities = request.capabilities as Record<string, unknown>;
    return !!capabilities
        && typeof capabilities === 'object'
        && !Array.isArray(capabilities)
        && Object.keys(capabilities).sort().join('\n')
            === Object.keys(OPEN_WORKSPACE_CAPABILITIES).sort().join('\n')
        && Object.keys(OPEN_WORKSPACE_CAPABILITIES).every(
            capability => capabilities[capability] === true
        );
}

function readBridgeExtensionVersion(context: vscode.ExtensionContext): string {
    try {
        const packageJson = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8')) as {
            version?: unknown;
        };
        if (typeof packageJson.version === 'string' && packageJson.version.length > 0 && packageJson.version.length <= 64) {
            return packageJson.version;
        }
    } catch (_error) {
        // A nonempty fallback preserves the strict handshake if extension metadata is unavailable.
    }
    return 'unknown';
}

export function deactivate(): Promise<void> {
    const coordinator = activeOpenWorkspaceCoordinator;
    activeOpenWorkspaceCoordinator = null;
    return coordinator ? coordinator.shutdown() : Promise.resolve();
}
