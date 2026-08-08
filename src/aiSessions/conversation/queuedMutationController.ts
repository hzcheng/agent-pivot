'use strict';

import * as vscode from 'vscode';
import type { AiSessionProviderId } from '../../models';
import type { CommentErrorCode } from './commentPrimitives';
import { CommentError } from './commentPrimitives';
import type { ConversationViewerTarget } from './viewerTarget';

/**
 * Shared mutation pipeline for the viewer state controllers (comments,
 * workspace notes, bookmarks): serialized operations, optimistic revisions,
 * idempotent settlements with replay, and a rebuild fallback when the
 * webview goes away. Each stack owns its state shape and domain operation
 * through the abstract hooks; everything else lives here exactly once.
 */

export interface QueuedMutationRequestBase {
    type: string;
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: string;
    expectedRevision: number;
    payload: unknown;
}

export interface QueuedMutationResultBase {
    type: string;
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: string;
    success: boolean;
    revision: number;
    error?: CommentErrorCode;
}

export interface QueuedMutationControllerOptions {
    now?: () => number;
    getTarget: () => ConversationViewerTarget | undefined;
    getSubscriptionGeneration: () => number;
    getPanel: () => vscode.WebviewPanel | undefined;
    rebuildLatestDocument: () => void;
}

interface MutationSnapshotStore<TStoreTarget, TSnap> {
    load(target: TStoreTarget): Promise<TSnap>;
    save(target: TStoreTarget, snapshot: TSnap): Promise<void>;
}

export abstract class QueuedMutationController<
    TStoreTarget,
    TSnap extends { revision: number },
    TRequest extends QueuedMutationRequestBase,
    TResult extends QueuedMutationResultBase
> {
    protected revision = 0;
    private operationQueue: Promise<void> = Promise.resolve();
    private readonly settlements = new Map<string, TResult>();

    constructor(
        protected readonly options: QueuedMutationControllerOptions
    ) {}

    protected now(): number {
        return this.options.now?.() ?? Date.now();
    }

    get snapshot(): TSnap {
        return {
            revision: this.revision,
            ...this.statePayload(),
        } as TSnap;
    }

    reset(): void {
        this.revision = 0;
        this.settlements.clear();
        this.clearState();
        this.onReset();
    }

    async drainMutations(): Promise<void> {
        await this.operationQueue;
    }

    enqueue(request: TRequest): Promise<void> {
        return this.enqueueTask(() => this.handleOperation(request));
    }

    /** Serializes an arbitrary task behind the queued mutations. */
    protected enqueueTask(operation: () => Promise<void>): Promise<void> {
        const queued = this.operationQueue.then(operation, operation);
        this.operationQueue = queued.catch(() => undefined);
        return queued;
    }

    async restore(
        target: ConversationViewerTarget,
        generation: number
    ): Promise<void> {
        const store = this.getStore();
        if (!store) {
            return;
        }
        let snapshot: TSnap;
        try {
            snapshot = await store.load(this.toStoreTarget(target));
            if (!this.validateRestoredSnapshot(snapshot)) {
                return;
            }
        } catch (_error) {
            return;
        }
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation) {
            return;
        }
        this.applyRestoredSnapshot(snapshot);
        this.revision = snapshot.revision;
    }

    private async handleOperation(request: TRequest): Promise<void> {
        const target = this.options.getTarget();
        if (!target || !this.options.getPanel()) {
            return;
        }
        const settlementKey = getSettlementKey(request);
        const settled = this.settlements.get(settlementKey);
        if (settled) {
            await this.publishSettlement(
                settled.operation === request.operation
                    ? settled
                    : {
                        ...settled,
                        operation: request.operation,
                        success: false,
                        revision: this.revision,
                        ...this.statePayload(),
                        error: 'invalid',
                    } as TResult,
                false
            );
            return;
        }
        if (this.isMutationsFrozen()
            || !requestTargetsViewer(
                request,
                target,
                this.options.getSubscriptionGeneration()
            )
            || request.expectedRevision !== this.revision) {
            await this.settleRequest(request, false, 'stale');
            return;
        }
        try {
            await this.performRequest(
                request,
                target,
                this.options.getSubscriptionGeneration()
            );
            await this.settleRequest(request, true);
            await this.afterSuccessful(request, target);
        } catch (error) {
            await this.settleRequest(
                request,
                false,
                this.toErrorCode(error)
            );
        }
    }

    /** Persists via the stack store, mapping IO failures to 'failed'. */
    protected async persist(
        target: ConversationViewerTarget,
        snapshot: TSnap
    ): Promise<void> {
        const store = this.getStore();
        if (!store) {
            return;
        }
        try {
            await store.save(this.toStoreTarget(target), snapshot);
        } catch (_error) {
            throw this.makeError('failed');
        }
    }

    /**
     * Post-await commit gate: the target, generation, and revision must not
     * have moved while the persist was in flight.
     */
    protected assertUnchanged(
        target: ConversationViewerTarget,
        generation: number,
        expectedRevision: number
    ): void {
        if (this.options.getTarget() !== target
            || this.options.getSubscriptionGeneration() !== generation
            || this.revision !== expectedRevision) {
            throw this.makeError('stale');
        }
    }

    private async settleRequest(
        request: TRequest,
        success: boolean,
        error?: CommentErrorCode
    ): Promise<void> {
        const settlement = {
            type: this.resultType,
            version: 1,
            requestId: request.requestId,
            subscriptionGeneration: request.subscriptionGeneration,
            projectId: request.projectId,
            provider: request.provider,
            sessionId: request.sessionId,
            operation: request.operation,
            success,
            revision: this.revision,
            ...this.statePayload(),
            ...(error ? { error } : {}),
        } as TResult;
        this.rememberSettlement(getSettlementKey(request), settlement);
        await this.publishSettlement(settlement, true);
    }

    private rememberSettlement(key: string, settlement: TResult): void {
        this.settlements.set(key, settlement);
        while (this.settlements.size > 100) {
            const oldest = this.settlements.keys().next().value;
            if (typeof oldest !== 'string') {
                break;
            }
            this.settlements.delete(oldest);
        }
    }

    protected async publishSettlement(
        settlement: object,
        rebuildOnFailure: boolean
    ): Promise<void> {
        const panel = this.options.getPanel();
        if (!panel) {
            return;
        }
        let delivered = false;
        try {
            delivered = await panel.webview.postMessage(settlement);
        } catch (_error) {
            delivered = false;
        }
        if (!delivered
            && rebuildOnFailure
            && this.options.getPanel() === panel) {
            this.options.rebuildLatestDocument();
        }
    }

    protected toErrorCode(error: unknown): CommentErrorCode {
        return error instanceof CommentError
            ? error.code
            : 'failed';
    }

    /** Hook for subclass state cleared alongside the base state. */
    protected onReset(): void {}

    /** Frozen stacks reject mutations as 'stale' (session rebind windows). */
    protected isMutationsFrozen(): boolean {
        return false;
    }

    /** Runs after a successful settlement (e.g. focusing a send target). */
    protected async afterSuccessful(
        _request: TRequest,
        _target: ConversationViewerTarget
    ): Promise<void> {}

    protected abstract readonly resultType: TResult['type'];

    protected abstract getStore():
        MutationSnapshotStore<TStoreTarget, TSnap> | undefined;

    protected abstract toStoreTarget(
        target: ConversationViewerTarget
    ): TStoreTarget;

    protected abstract makeError(code: CommentErrorCode): CommentError;

    /** The state fields embedded in snapshots and result messages. */
    protected abstract statePayload(): object;

    /** Second-line validation for store-provided snapshots. */
    protected abstract validateRestoredSnapshot(snapshot: TSnap): boolean;

    /** Adopts the state carried by a snapshot (revision stays with the base). */
    protected abstract applyRestoredSnapshot(snapshot: TSnap): void;

    /** Clears the subclass-owned state (revision/settlements are the base's). */
    protected abstract clearState(): void;

    /** The domain operation; failures throw CommentError-coded errors. */
    protected abstract performRequest(
        request: TRequest,
        target: ConversationViewerTarget,
        generation: number
    ): Promise<void>;
}

function requestTargetsViewer(
    request: QueuedMutationRequestBase,
    target: ConversationViewerTarget,
    subscriptionGeneration: number
): boolean {
    return request.subscriptionGeneration === subscriptionGeneration
        && request.projectId === target.projectId
        && request.provider === target.provider
        && request.sessionId === target.sessionId;
}

function getSettlementKey(request: QueuedMutationRequestBase): string {
    return JSON.stringify([
        request.projectId,
        request.provider,
        request.sessionId,
        request.requestId,
    ]);
}
