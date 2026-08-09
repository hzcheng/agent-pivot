'use strict';

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import {
    OPEN_WORKSPACE_CAPABILITIES,
    OPEN_WORKSPACE_PROTOCOL_VERSION,
    OPEN_WORKSPACE_HEARTBEAT_MS,
    OpenWorkspaceAggregate,
    OpenWorkspaceRecord,
    validateOpenWorkspaceAggregate,
    validateOpenWorkspacePublication,
    validateOpenWorkspaceRecord,
} from './protocol';
import {
    OPEN_WORKSPACE_PIN_PROTOCOL_VERSION,
    OPEN_WORKSPACE_PIN_SET_COMMAND,
    OPEN_WORKSPACE_PIN_SNAPSHOT_COMMAND,
    OpenWorkspacePinSetOutcome,
    OpenWorkspacePinSnapshot,
    validateOpenWorkspacePinSetOutcome,
    validateOpenWorkspacePinSnapshot,
} from './pinProtocol';
import {
    createOpenWorkspaceRunningFocusRequest,
    OPEN_WORKSPACE_RUNNING_FOCUS_DELIVER_COMMAND,
    OPEN_WORKSPACE_RUNNING_FOCUS_REQUEST_COMMAND,
    OpenWorkspaceRunningFocusRequest,
    validateOpenWorkspaceRunningFocusOutcome,
    validateOpenWorkspaceRunningFocusRequest,
} from './runningFocusProtocol';
import {
    createOpenWorkspaceAttentionFocusRequest,
    OPEN_WORKSPACE_ATTENTION_FOCUS_DELIVER_COMMAND,
    OPEN_WORKSPACE_ATTENTION_FOCUS_REQUEST_COMMAND,
    OpenWorkspaceAttentionFocusRequest,
    OpenWorkspaceAttentionFocusTarget,
    validateOpenWorkspaceAttentionFocusOutcome,
    validateOpenWorkspaceAttentionFocusRequest,
} from './attentionFocusProtocol';

export const OPEN_WORKSPACE_PUBLISH_COMMAND = '_agentPivotOpenWorkspaces.bridge.publish';
export const OPEN_WORKSPACE_UNREGISTER_COMMAND = '_agentPivotOpenWorkspaces.bridge.unregister';
export const OPEN_WORKSPACE_HANDSHAKE_COMMAND = '_agentPivotOpenWorkspaces.bridge.handshake';
export const OPEN_WORKSPACE_AGGREGATE_COMMAND = '_agentPivotOpenWorkspaces.workspace.aggregate';
export const OPEN_WORKSPACE_DIAGNOSTIC_COMMAND = '_agentPivotOpenWorkspaces.workspace.diagnostic';

/**
 * `connecting` is the pre-handshake state. It exists so the Open Windows
 * section can say it is still looking instead of rendering an empty list that
 * looks settled: the handshake alone takes 0.36-3.2s on a remote host, and the
 * first aggregate another 0.3-2.6s after that.
 */
export type OpenWorkspaceBridgeStatus =
    | 'connecting'
    | 'ready'
    | 'unavailable'
    | 'update-required';

const RETRY_DELAYS_MS = [100, 500, 2_000, 10_000, 30_000];
const MAX_FORWARDED_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_REMEMBERED_RUNNING_FOCUS_REQUESTS = 100;
const MAX_REMEMBERED_ATTENTION_FOCUS_REQUESTS = 100;

interface DisposableLike {
    dispose(): void;
}

class OpenWorkspaceHandshakeIncompatibilityError extends Error {
    constructor() {
        super('open workspace handshake response is incompatible');
        this.name = 'OpenWorkspaceHandshakeIncompatibilityError';
    }
}

export interface OpenWorkspaceBridgeClientDependencies {
    instanceId?: string;
    now?: () => number;
    mainExtensionVersion?: string;
    registerCommand?: (command: string, callback: (raw: unknown) => unknown) => DisposableLike;
    executeCommand?: (command: string, argument: unknown) => PromiseLike<unknown>;
    setInterval?: (callback: () => void, intervalMs: number) => unknown;
    clearInterval?: (handle: unknown) => void;
    setTimeout?: (callback: () => void, delayMs: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    reportDiagnostic?: (event: OpenWorkspaceClientDiagnosticEvent) => void;
    reportBridgeDiagnostic?: (event: unknown) => void;
    onStatusChange?: (status: OpenWorkspaceBridgeStatus) => void;
    onPinSnapshot?: (snapshot: OpenWorkspacePinSnapshot) => unknown;
    onRunningFocusRequest?: (request: OpenWorkspaceRunningFocusRequest) => unknown;
    onAttentionFocusRequest?: (request: OpenWorkspaceAttentionFocusRequest) => unknown;
}

export interface OpenWorkspaceClientDiagnosticEvent {
    event: 'activate' | 'handshake' | 'publish-success' | 'publish-failure' | 'aggregate' | 'dispose';
    atMs: number;
    instanceId: string;
    sequence?: number;
    reason?: 'change' | 'focus' | 'heartbeat';
    workspaceCount?: number;
    registrationCount?: number;
    semanticRevision?: string;
    accepted?: boolean;
    errorCode?: string;
}

interface OpenWorkspaceHandshakeResponse {
    accepted: boolean;
    protocolVersion: 4;
    bridgeExtensionVersion: string;
    capabilities: typeof OPEN_WORKSPACE_CAPABILITIES;
    pinSnapshot: OpenWorkspacePinSnapshot;
    errorCode?: 'update-required';
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
    return Object.keys(value).sort().join('\n') === expected.slice().sort().join('\n');
}

function incompatibleHandshake(): never {
    throw new OpenWorkspaceHandshakeIncompatibilityError();
}

function validateHandshakeResponse(raw: unknown): OpenWorkspaceHandshakeResponse {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return incompatibleHandshake();
    }
    const response = raw as Record<string, unknown>;
    const expected = response.errorCode === undefined
        ? ['accepted', 'protocolVersion', 'bridgeExtensionVersion', 'capabilities', 'pinSnapshot']
        : ['accepted', 'protocolVersion', 'bridgeExtensionVersion', 'capabilities', 'pinSnapshot', 'errorCode'];
    if (!exactKeys(response, expected)
        || response.protocolVersion !== OPEN_WORKSPACE_PROTOCOL_VERSION
        || typeof response.accepted !== 'boolean'
        || typeof response.bridgeExtensionVersion !== 'string'
        || !response.bridgeExtensionVersion
        || response.bridgeExtensionVersion.length > 64) {
        return incompatibleHandshake();
    }
    const capabilities = response.capabilities as Record<string, unknown>;
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
        || !exactKeys(capabilities, Object.keys(OPEN_WORKSPACE_CAPABILITIES))
        || Object.keys(OPEN_WORKSPACE_CAPABILITIES).some(
            capability => capabilities[capability] !== true
        )) {
        return incompatibleHandshake();
    }
    if (response.errorCode !== undefined && response.errorCode !== 'update-required') {
        return incompatibleHandshake();
    }
    if (response.accepted !== true) {
        return incompatibleHandshake();
    }
    try {
        return {
            ...response,
            pinSnapshot: validateOpenWorkspacePinSnapshot(response.pinSnapshot),
        } as unknown as OpenWorkspaceHandshakeResponse;
    } catch (_error) {
        return incompatibleHandshake();
    }
}

export default class OpenWorkspaceBridgeClient implements vscode.Disposable {
    public readonly instanceId: string;

    private sequence = 0;
    private latestWorkspace: OpenWorkspaceRecord | null;
    private latestGeneration = 0;
    private lastSemantic = '';
    private lastAggregateRevision = '';
    private lastPinRevision = '';
    private connected = false;
    private incompatible = false;
    private disposed = false;
    private recoveryAcknowledgementRequired = true;
    private retryAttempt = 0;
    private retryTimer: unknown = null;
    private handshakeFlight: Promise<boolean> | null = null;
    private publishCommandFlight: Promise<void> | null = null;
    private publicationQueue: Promise<void> = Promise.resolve();
    private shutdownFlight: Promise<void> | null = null;
    private status: OpenWorkspaceBridgeStatus | null = null;
    private readonly now: () => number;
    private readonly executeCommand: (command: string, argument: unknown) => PromiseLike<unknown>;
    private readonly clearInterval: (handle: unknown) => void;
    private readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
    private readonly cancelTimeout: (handle: unknown) => void;
    private readonly mainExtensionVersion: string;
    private readonly reportDiagnostic: (event: OpenWorkspaceClientDiagnosticEvent) => void;
    private readonly reportBridgeDiagnostic: (event: unknown) => void;
    private readonly onStatusChange: (status: OpenWorkspaceBridgeStatus) => void;
    private readonly onPinSnapshot: (snapshot: OpenWorkspacePinSnapshot) => unknown;
    private readonly onRunningFocusRequest: (
        request: OpenWorkspaceRunningFocusRequest
    ) => unknown;
    private readonly onAttentionFocusRequest: (
        request: OpenWorkspaceAttentionFocusRequest
    ) => unknown;
    private readonly deliveredRunningFocusRequestIds = new Set<string>();
    private readonly deliveredAttentionFocusRequestIds = new Set<string>();
    private readonly aggregateRegistration: DisposableLike;
    private readonly pinSnapshotRegistration: DisposableLike;
    private readonly runningFocusRegistration: DisposableLike;
    private readonly attentionFocusRegistration: DisposableLike;
    private readonly diagnosticRegistration: DisposableLike;
    private readonly heartbeatHandle: unknown;

    constructor(
        initialWorkspace: OpenWorkspaceRecord | null,
        private readonly onAggregate: (aggregate: OpenWorkspaceAggregate) => unknown,
        private readonly onError: (error: unknown) => void,
        dependencies: OpenWorkspaceBridgeClientDependencies = {},
    ) {
        this.instanceId = dependencies.instanceId || crypto.randomBytes(16).toString('hex');
        this.latestWorkspace = initialWorkspace ? validateOpenWorkspaceRecord(initialWorkspace) : null;
        this.now = dependencies.now || Date.now;
        this.mainExtensionVersion = dependencies.mainExtensionVersion || 'unknown';
        this.executeCommand = dependencies.executeCommand
            || ((command, argument) => vscode.commands.executeCommand(command, argument));
        const registerCommand = dependencies.registerCommand
            || ((command, callback) => vscode.commands.registerCommand(command, callback));
        const setHeartbeat = dependencies.setInterval
            || ((callback, intervalMs) => setInterval(callback, intervalMs));
        this.clearInterval = dependencies.clearInterval
            || (handle => clearInterval(handle as NodeJS.Timeout));
        this.scheduleTimeout = dependencies.setTimeout
            || ((callback, delayMs) => setTimeout(callback, delayMs));
        this.cancelTimeout = dependencies.clearTimeout
            || (handle => clearTimeout(handle as NodeJS.Timeout));
        this.reportDiagnostic = dependencies.reportDiagnostic || (() => undefined);
        this.reportBridgeDiagnostic = dependencies.reportBridgeDiagnostic || (() => undefined);
        this.onStatusChange = dependencies.onStatusChange || (() => undefined);
        this.onPinSnapshot = dependencies.onPinSnapshot || (() => undefined);
        this.onRunningFocusRequest = dependencies.onRunningFocusRequest || (() => undefined);
        this.onAttentionFocusRequest = dependencies.onAttentionFocusRequest || (() => undefined);
        let aggregateRegistration: DisposableLike | undefined;
        let pinSnapshotRegistration: DisposableLike | undefined;
        let runningFocusRegistration: DisposableLike | undefined;
        let attentionFocusRegistration: DisposableLike | undefined;
        let diagnosticRegistration: DisposableLike | undefined;
        let heartbeatHandle: unknown;
        let heartbeatStarted = false;
        try {
            aggregateRegistration = registerCommand(
                OPEN_WORKSPACE_AGGREGATE_COMMAND,
                raw => this.receiveAggregate(raw),
            );
            pinSnapshotRegistration = registerCommand(
                OPEN_WORKSPACE_PIN_SNAPSHOT_COMMAND,
                raw => this.receivePinSnapshot(raw),
            );
            runningFocusRegistration = registerCommand(
                OPEN_WORKSPACE_RUNNING_FOCUS_DELIVER_COMMAND,
                raw => this.receiveRunningFocusRequest(raw),
            );
            attentionFocusRegistration = registerCommand(
                OPEN_WORKSPACE_ATTENTION_FOCUS_DELIVER_COMMAND,
                raw => this.receiveAttentionFocusRequest(raw),
            );
            diagnosticRegistration = registerCommand(
                OPEN_WORKSPACE_DIAGNOSTIC_COMMAND,
                raw => this.receiveBridgeDiagnostic(raw),
            );
            heartbeatHandle = setHeartbeat(
                () => {
                    void this.enqueuePublication(
                        this.latestWorkspace,
                        false,
                        true,
                        this.latestGeneration,
                        this.isRecovering(),
                    );
                },
                OPEN_WORKSPACE_HEARTBEAT_MS,
            );
            heartbeatStarted = true;
        } catch (error) {
            if (heartbeatStarted) {
                try {
                    this.clearInterval(heartbeatHandle);
                } catch (_clearError) {
                    // Constructor rollback must preserve the acquisition failure.
                }
            }
            try {
                diagnosticRegistration?.dispose();
            } catch (_disposeError) {
                // Continue releasing earlier constructor acquisitions.
            }
            try {
                attentionFocusRegistration?.dispose();
            } catch (_disposeError) {
                // Continue releasing earlier constructor acquisitions.
            }
            try {
                runningFocusRegistration?.dispose();
            } catch (_disposeError) {
                // Continue releasing earlier constructor acquisitions.
            }
            try {
                pinSnapshotRegistration?.dispose();
            } catch (_disposeError) {
                // Continue releasing earlier constructor acquisitions.
            }
            try {
                aggregateRegistration?.dispose();
            } catch (_disposeError) {
                // Constructor rollback must preserve the acquisition failure.
            }
            throw error;
        }
        this.aggregateRegistration = aggregateRegistration;
        this.pinSnapshotRegistration = pinSnapshotRegistration;
        this.runningFocusRegistration = runningFocusRegistration;
        this.attentionFocusRegistration = attentionFocusRegistration;
        this.diagnosticRegistration = diagnosticRegistration;
        this.heartbeatHandle = heartbeatHandle;
        this.emitDiagnostic({ event: 'activate', workspaceCount: this.latestWorkspace ? 1 : 0 });
        void this.publish(this.latestWorkspace);
    }

    publish(workspace: OpenWorkspaceRecord | null, followsFocusEvent = false): Promise<boolean> {
        if (this.disposed) { return Promise.resolve(false); }
        this.latestWorkspace = workspace ? validateOpenWorkspaceRecord(workspace) : null;
        const generation = ++this.latestGeneration;
        return this.enqueuePublication(
            this.latestWorkspace,
            followsFocusEvent,
            false,
            generation,
            this.isRecovering(),
        );
    }

    async receiveAggregate(raw: unknown): Promise<void> {
        if (this.disposed) { return; }
        try {
            const aggregate = validateOpenWorkspaceAggregate(raw);
            if (aggregate.semanticRevision === this.lastAggregateRevision) { return; }
            this.emitDiagnostic({
                event: 'aggregate',
                registrationCount: aggregate.registrations.length,
                semanticRevision: aggregate.semanticRevision,
            });
            await this.onAggregate(aggregate);
            this.lastAggregateRevision = aggregate.semanticRevision;
        } catch (error) {
            try {
                this.onError(error);
            } catch (_reportError) {
                // Aggregate acknowledgement must reflect delivery, not local logging.
            }
            throw new Error('open workspace aggregate delivery failed');
        }
    }

    async receivePinSnapshot(raw: unknown): Promise<void> {
        if (this.disposed) { return; }
        try {
            const snapshot = validateOpenWorkspacePinSnapshot(raw);
            if (snapshot.revision === this.lastPinRevision) { return; }
            await this.onPinSnapshot(snapshot);
            this.lastPinRevision = snapshot.revision;
        } catch (error) {
            try {
                this.onError(error);
            } catch (_reportError) {
                // Pin acknowledgement must reflect delivery, not local logging.
            }
            throw new Error('open workspace pin snapshot delivery failed');
        }
    }

    async setPinned(
        requestId: number,
        navigationIdentity: string,
        pinned: boolean,
    ): Promise<OpenWorkspacePinSetOutcome> {
        if (this.disposed || !await this.ensureHandshake() || this.disposed) {
            throw new Error('open workspace pin bridge is unavailable');
        }
        const outcome = validateOpenWorkspacePinSetOutcome(await this.executeCommand(
            OPEN_WORKSPACE_PIN_SET_COMMAND,
            {
                protocolVersion: OPEN_WORKSPACE_PIN_PROTOCOL_VERSION,
                requestId,
                navigationIdentity,
                pinned,
            },
        ));
        if (outcome.requestId !== requestId
            || outcome.navigationIdentity !== navigationIdentity
            || outcome.pinned !== pinned) {
            throw new Error('open workspace pin response does not match its request');
        }
        await this.receivePinSnapshot(outcome.snapshot);
        return outcome;
    }

    receiveRunningFocusRequest(raw: unknown): void {
        if (this.disposed) { return; }
        let request: OpenWorkspaceRunningFocusRequest;
        try {
            request = validateOpenWorkspaceRunningFocusRequest(raw);
        } catch (error) {
            // A malformed request can never become deliverable on retry, so it
            // is acknowledged here and the bridge consumes its mailbox file.
            try {
                this.onError(error);
            } catch (_reportError) {
                // Diagnostics must never change delivery behavior.
            }
            return;
        }
        if (this.deliveredRunningFocusRequestIds.has(request.requestId)) { return; }
        if (this.deliveredRunningFocusRequestIds.size >= MAX_REMEMBERED_RUNNING_FOCUS_REQUESTS) {
            const oldest = this.deliveredRunningFocusRequestIds.values().next();
            if (!oldest.done) { this.deliveredRunningFocusRequestIds.delete(oldest.value); }
        }
        this.deliveredRunningFocusRequestIds.add(request.requestId);
        try {
            const task = this.onRunningFocusRequest(request);
            // Delivery means the target handler accepted the action into its
            // own serialized queue. Later task failures are diagnostic only:
            // retrying after a partial focus could repeat a user-visible jump.
            void Promise.resolve(task).catch(error => {
                try {
                    this.onError(error);
                } catch (_reportError) {
                    // Diagnostics must never change delivery behavior.
                }
            });
        } catch (error) {
            // A synchronous rejection means the handler was not ready and no
            // action was queued. Let the mailbox restore and retry this ID.
            this.deliveredRunningFocusRequestIds.delete(request.requestId);
            try {
                this.onError(error);
            } catch (_reportError) {
                // Diagnostics must never change delivery behavior.
            }
            throw error;
        }
    }

    /**
     * Hands a running-session focus request to the window owning
     * `targetNavigationIdentity`. Returns false when the hand-off channel is
     * unavailable (older bridge, broken handshake) so the caller can degrade
     * to a plain window switch.
     */
    async requestRunningFocus(targetNavigationIdentity: string): Promise<boolean> {
        if (this.disposed || !await this.ensureHandshake() || this.disposed) {
            return false;
        }
        let request: OpenWorkspaceRunningFocusRequest;
        try {
            request = createOpenWorkspaceRunningFocusRequest({
                requestId: crypto.randomBytes(16).toString('hex'),
                targetNavigationIdentity,
                nowMs: this.safeNow(),
            });
        } catch (error) {
            this.onError(error);
            return false;
        }
        try {
            const outcome = validateOpenWorkspaceRunningFocusOutcome(
                await this.executeCommand(OPEN_WORKSPACE_RUNNING_FOCUS_REQUEST_COMMAND, request),
            );
            return outcome.requestId === request.requestId
                && outcome.targetNavigationIdentity === request.targetNavigationIdentity;
        } catch (error) {
            if (!this.disposed) {
                this.onError(error);
            }
            return false;
        }
    }

    receiveAttentionFocusRequest(raw: unknown): void {
        if (this.disposed) { return; }
        let request: OpenWorkspaceAttentionFocusRequest;
        try {
            request = validateOpenWorkspaceAttentionFocusRequest(raw);
        } catch (error) {
            try {
                this.onError(error);
            } catch (_reportError) {
                // Diagnostics must never change delivery behavior.
            }
            return;
        }
        if (this.deliveredAttentionFocusRequestIds.has(request.requestId)) { return; }
        if (this.deliveredAttentionFocusRequestIds.size
            >= MAX_REMEMBERED_ATTENTION_FOCUS_REQUESTS) {
            const oldest = this.deliveredAttentionFocusRequestIds.values().next();
            if (!oldest.done) {
                this.deliveredAttentionFocusRequestIds.delete(oldest.value);
            }
        }
        this.deliveredAttentionFocusRequestIds.add(request.requestId);
        try {
            const task = this.onAttentionFocusRequest(request);
            void Promise.resolve(task).catch(error => {
                try {
                    this.onError(error);
                } catch (_reportError) {
                    // Diagnostics must never change delivery behavior.
                }
            });
        } catch (error) {
            this.deliveredAttentionFocusRequestIds.delete(request.requestId);
            try {
                this.onError(error);
            } catch (_reportError) {
                // Diagnostics must never change delivery behavior.
            }
            throw error;
        }
    }

    async requestAttentionFocus(
        targetNavigationIdentity: string,
        target: OpenWorkspaceAttentionFocusTarget,
    ): Promise<boolean> {
        if (this.disposed || !await this.ensureHandshake() || this.disposed) {
            return false;
        }
        let request: OpenWorkspaceAttentionFocusRequest;
        try {
            request = createOpenWorkspaceAttentionFocusRequest({
                requestId: crypto.randomBytes(16).toString('hex'),
                targetNavigationIdentity,
                target,
                nowMs: this.safeNow(),
            });
        } catch (error) {
            this.onError(error);
            return false;
        }
        try {
            const outcome = validateOpenWorkspaceAttentionFocusOutcome(
                await this.executeCommand(OPEN_WORKSPACE_ATTENTION_FOCUS_REQUEST_COMMAND, request),
            );
            return outcome.requestId === request.requestId
                && outcome.targetNavigationIdentity === request.targetNavigationIdentity;
        } catch (error) {
            if (!this.disposed) {
                this.onError(error);
            }
            return false;
        }
    }

    dispose(): void {
        void this.shutdown();
    }

    shutdown(): Promise<void> {
        if (this.shutdownFlight) { return this.shutdownFlight; }
        this.disposed = true;
        this.recoveryAcknowledgementRequired = false;
        this.aggregateRegistration.dispose();
        this.pinSnapshotRegistration.dispose();
        this.runningFocusRegistration.dispose();
        this.attentionFocusRegistration.dispose();
        this.diagnosticRegistration.dispose();
        this.clearInterval(this.heartbeatHandle);
        if (this.retryTimer !== null) { this.cancelTimeout(this.retryTimer); }
        this.retryTimer = null;
        this.emitDiagnostic({ event: 'dispose', sequence: this.sequence });
        const unregister = () => Promise.resolve().then(() => this.executeCommand(
            OPEN_WORKSPACE_UNREGISTER_COMMAND,
            { protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION, instanceId: this.instanceId },
        )).then(() => undefined, error => { this.onError(error); });
        const flight = this.publishCommandFlight
            ? this.publishCommandFlight.then(unregister, unregister)
            : unregister();
        this.shutdownFlight = flight.then(() => undefined, () => undefined);
        return this.shutdownFlight;
    }

    private enqueuePublication(
        workspace: OpenWorkspaceRecord | null,
        followsFocusEvent: boolean,
        forceHeartbeat: boolean,
        generation: number,
        latestOnly: boolean,
    ): Promise<boolean> {
        if (this.disposed) { return Promise.resolve(false); }
        let accepted = false;
        const operation = async () => {
            if (latestOnly && generation !== this.latestGeneration) { return; }
            if (this.disposed || !await this.ensureHandshake() || this.disposed) { return; }
            if (latestOnly && generation !== this.latestGeneration) { return; }
            accepted = await this.publishNow(workspace, followsFocusEvent, forceHeartbeat, generation);
        };
        const result = this.publicationQueue.then(operation, operation);
        this.publicationQueue = result.then(() => undefined, () => undefined);
        return result.then(() => accepted);
    }

    private async publishNow(
        workspace: OpenWorkspaceRecord | null,
        followsFocusEvent: boolean,
        forceHeartbeat: boolean,
        generation: number,
    ): Promise<boolean> {
        if (this.disposed) { return false; }
        if (this.sequence >= Number.MAX_SAFE_INTEGER) {
            this.onError(new Error('open workspace publication sequence is exhausted'));
            return false;
        }
        const semantic = JSON.stringify(workspace);
        if (!this.recoveryAcknowledgementRequired
            && !forceHeartbeat
            && !followsFocusEvent
            && semantic === this.lastSemantic) { return true; }
        const publication = validateOpenWorkspacePublication({
            protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION,
            instanceId: this.instanceId,
            sequence: ++this.sequence,
            followsFocusEvent,
            workspace,
        });
        const reason = forceHeartbeat ? 'heartbeat' : followsFocusEvent ? 'focus' : 'change';
        const commandFlight = Promise.resolve()
            .then(() => this.executeCommand(OPEN_WORKSPACE_PUBLISH_COMMAND, publication))
            .then(() => undefined);
        this.publishCommandFlight = commandFlight;
        try {
            await commandFlight;
            if (generation === this.latestGeneration) {
                this.lastSemantic = semantic;
                this.retryAttempt = 0;
                this.recoveryAcknowledgementRequired = false;
                if (!this.disposed) { this.setStatus('ready'); }
            }
            this.emitDiagnostic({
                event: 'publish-success',
                sequence: publication.sequence,
                reason,
                workspaceCount: publication.workspace ? 1 : 0,
            });
            return true;
        } catch (error) {
            if (this.disposed) { return false; }
            this.recoveryAcknowledgementRequired = true;
            this.connected = false;
            this.setStatus('unavailable');
            this.emitDiagnostic({
                event: 'publish-failure',
                sequence: publication.sequence,
                reason,
                workspaceCount: publication.workspace ? 1 : 0,
            });
            this.onError(error);
            this.scheduleRetry();
            return false;
        } finally {
            if (this.publishCommandFlight === commandFlight) {
                this.publishCommandFlight = null;
            }
        }
    }

    private ensureHandshake(): Promise<boolean> {
        if (this.disposed || this.incompatible) { return Promise.resolve(false); }
        if (this.connected) { return Promise.resolve(true); }
        if (this.handshakeFlight) { return this.handshakeFlight; }
        if (this.retryTimer !== null) { return Promise.resolve(false); }
        this.handshakeFlight = this.handshake().then(result => {
            this.handshakeFlight = null;
            return result;
        }, error => {
            this.handshakeFlight = null;
            throw error;
        });
        return this.handshakeFlight;
    }

    private async handshake(): Promise<boolean> {
        try {
            const response = validateHandshakeResponse(await this.executeCommand(
                OPEN_WORKSPACE_HANDSHAKE_COMMAND,
                {
                    protocolVersion: OPEN_WORKSPACE_PROTOCOL_VERSION,
                    mainExtensionVersion: this.mainExtensionVersion,
                    instanceId: this.instanceId,
                    capabilities: OPEN_WORKSPACE_CAPABILITIES,
                },
            ));
            if (this.disposed) { return false; }
            await this.receivePinSnapshot(response.pinSnapshot);
            if (this.disposed) { return false; }
            this.connected = true;
            if (this.retryTimer !== null) { this.cancelTimeout(this.retryTimer); }
            this.retryTimer = null;
            this.emitDiagnostic({ event: 'handshake', accepted: response.accepted });
            return true;
        } catch (error) {
            if (this.disposed) { return false; }
            if (error instanceof OpenWorkspaceHandshakeIncompatibilityError) {
                this.incompatible = true;
                this.setStatus('update-required');
                this.emitDiagnostic({ event: 'handshake', accepted: false, errorCode: 'update-required' });
            } else {
                this.recoveryAcknowledgementRequired = true;
                this.setStatus('unavailable');
                this.scheduleRetry();
            }
            this.onError(error);
            return false;
        }
    }

    private scheduleRetry(): void {
        if (this.disposed || this.incompatible || this.retryTimer !== null) { return; }
        const delay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)];
        this.retryAttempt += 1;
        this.retryTimer = this.scheduleTimeout(() => {
            this.retryTimer = null;
            void this.enqueuePublication(
                this.latestWorkspace,
                false,
                true,
                this.latestGeneration,
                true,
            );
        }, delay);
    }

    private isRecovering(): boolean {
        return !this.connected
            || this.handshakeFlight !== null
            || this.retryTimer !== null
            || this.retryAttempt > 0
            || this.status !== 'ready';
    }

    private setStatus(status: OpenWorkspaceBridgeStatus): void {
        if (this.disposed || this.status === status) { return; }
        this.status = status;
        try {
            this.onStatusChange(status);
        } catch (error) {
            this.onError(error);
        }
    }

    private receiveBridgeDiagnostic(raw: unknown): void {
        try {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw new Error('open workspace diagnostic must be an object');
            }
            const serialized = JSON.stringify(raw);
            if (Buffer.byteLength(serialized, 'utf8') > MAX_FORWARDED_DIAGNOSTIC_BYTES) {
                throw new Error('open workspace diagnostic exceeds 64 KiB');
            }
            this.reportBridgeDiagnostic(JSON.parse(serialized));
        } catch (error) {
            this.onError(error);
        }
    }

    private emitDiagnostic(
        event: Omit<OpenWorkspaceClientDiagnosticEvent, 'atMs' | 'instanceId'>,
    ): void {
        try {
            this.reportDiagnostic({ ...event, atMs: this.safeNow(), instanceId: this.instanceId });
        } catch (_error) {
            // Diagnostics must never change bridge behavior.
        }
    }

    private safeNow(): number {
        try {
            const timestamp = this.now();
            return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
        } catch (_error) {
            return Date.now();
        }
    }
}
