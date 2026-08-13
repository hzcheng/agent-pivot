'use strict';

import { randomBytes } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import type { Stats } from 'fs';
import * as path from 'path';
import type { AiSessionProviderId } from '../models';
import type {
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from './runtimeTypes';
import { getAiSessionRuntimeIdentityV3Fields } from './runtimeTypes';
import {
    ambiguousIdentityParts,
    ambiguousRecordIdentityParts,
    ambiguousRecordMatchesIdentity,
    bindingIdentitiesEqual,
    cloneAmbiguous,
    cloneConsumed,
    cloneInactive,
    cloneKnown,
    clonePending,
    clonePromoting,
    consumedMatchesPromoting,
    consumedRecordMatchesIdentity,
    finalRuntimePriority,
    finalRuntimeTimestamp,
    getRecordFilename,
    inactiveBindingsEqual,
    inactiveBindingsMatchRun,
    isBoundedPath,
    isBoundedString,
    isCanonicalRecordPath,
    isFinalRuntimeExpired,
    isFiniteNonNegative,
    isFinitePositive,
    isInactiveExpired,
    isKnownExpired,
    isLegacyProjectKeyConsumedRecord,
    isNodeError,
    isProviderId,
    knownBindingsEqual,
    locatorsEqual,
    pendingBindingsEqual,
    pendingIdentityParts,
    pendingLifecycleRecordKey,
    pendingRecordIdentityParts,
    pendingRecordMatchesIdentity,
    promotingRecordMatchesIdentity,
    validateAmbiguousRecord,
    validateConsumedRecord,
    validateFinalRuntimeRecord,
    validateInactiveRecord,
    validateKnownRebindIntent,
    validateKnownRecord,
    validatePersistedPendingRecord,
    validatePromotingRecord,
    MAX_ID_LENGTH,
} from './tmuxBindingRecords';
import type {
    TmuxAmbiguousRuntimeBinding,
    TmuxConsumedPendingBinding,
    TmuxFinalBindingSnapshot,
    TmuxFinalRecordLock,
    TmuxFinalRuntimeBinding,
    TmuxInactiveAcknowledgementResult,
    TmuxInactiveRuntimeBinding,
    TmuxKnownRebindIntent,
    TmuxKnownRebindResult,
    TmuxKnownRuntimeBinding,
    TmuxPendingRuntimeBinding,
    TmuxPromotingRuntimeBinding,
    TmuxRecoverablePendingBinding,
    TmuxRuntimeBinding,
} from './tmuxBindingRecords';
export type {
    TmuxPendingRuntimeBinding,
    TmuxKnownRuntimeBinding,
    TmuxInactiveRuntimeBinding,
    TmuxInactiveAcknowledgementResult,
    TmuxKnownRebindResult,
    TmuxFinalBindingSnapshot,
    TmuxConsumedPendingBinding,
    TmuxPromotingRuntimeBinding,
    TmuxRecoverablePendingBinding,
    TmuxAmbiguousRuntimeBinding,
    TmuxFinalRecordLock,
} from './tmuxBindingRecords';
export { validateTmuxPendingRuntimeBinding } from './tmuxBindingRecords';

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_KNOWN_RECORDS = 512;
const MAX_INACTIVE_RECORDS = 512;
const NO_FOLLOW_FLAG = (fsConstants as Record<string, number>).O_NOFOLLOW || 0;
const NON_BLOCKING_FLAG = (fsConstants as Record<string, number>).O_NONBLOCK || 0;
const READ_ONLY_FALLBACK = fsConstants.O_RDONLY | NON_BLOCKING_FLAG;
const READ_ONLY_NO_FOLLOW = READ_ONLY_FALLBACK | NO_FOLLOW_FLAG;


const runWithoutFinalRecordLock: TmuxFinalRecordLock = operation => operation();

export class TmuxRuntimeBindingStore {
    private operationQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly root: string,
        private readonly now: () => number = () => Date.now(),
        private readonly withFinalRecordLock: TmuxFinalRecordLock = runWithoutFinalRecordLock
    ) { }

    listPending(): Promise<TmuxPendingRuntimeBinding[]> {
        return this.serialize(() => this.listPendingUnlocked());
    }

    listRecoverablePending(): Promise<TmuxRecoverablePendingBinding[]> {
        return this.serialize(() => this.listRecoverablePendingUnlocked());
    }

    listKnown(): Promise<TmuxKnownRuntimeBinding[]> {
        return this.serializeFinal(() => this.listKnownUnlocked(true));
    }

    listInactive(): Promise<TmuxInactiveRuntimeBinding[]> {
        return this.serializeFinal(() => this.listInactiveUnlocked(true));
    }

    listFinalSnapshot(): Promise<TmuxFinalBindingSnapshot> {
        return this.serializeFinal(async () => ({
            pending: await this.listPendingUnlocked(),
            known: await this.listKnownUnlocked(true),
            inactive: await this.listInactiveUnlocked(true),
        }));
    }

    getPending(identity: AiSessionRuntimeIdentity): Promise<TmuxPendingRuntimeBinding | null> {
        return this.serialize(async () => {
            const identityParts = pendingIdentityParts(identity);
            if (!identityParts) {
                return null;
            }
            const filePath = this.recordPath('pending', ...identityParts);
            const record = validatePersistedPendingRecord(await readJsonRegularFile(filePath), this.now());
            if (!record || !pendingRecordMatchesIdentity(record, identity)
                || !isCanonicalRecordPath(filePath, record)) {
                return null;
            }
            return clonePending(record);
        });
    }

    getKnown(
        provider: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity?: string
    ): Promise<TmuxKnownRuntimeBinding | null> {
        return this.serializeFinal(async () => {
            if (!isProviderId(provider) || !isBoundedString(sessionId, MAX_ID_LENGTH)) {
                return null;
            }
            if (workspaceScopeIdentity === undefined) {
                const matches = (await this.listKnownUnlocked(true)).filter(record =>
                    record.provider === provider && record.sessionId === sessionId);
                return matches.length === 1 ? cloneKnown(matches[0]) : null;
            }
            if (!isBoundedString(workspaceScopeIdentity, MAX_ID_LENGTH)) {
                return null;
            }
            const filePath = this.recordPath('known', provider, workspaceScopeIdentity, sessionId);
            const record = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (!record || record.provider !== provider || record.sessionId !== sessionId
                || !isCanonicalRecordPath(filePath, record)) {
                return null;
            }
            if (isFinalRuntimeExpired(record, this.now())) {
                await removeFile(filePath);
                return null;
            }
            return record.state === 'known' ? cloneKnown(record) : null;
        });
    }

    getInactive(
        provider: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity?: string
    ): Promise<TmuxInactiveRuntimeBinding | null> {
        return this.serializeFinal(async () => {
            if (!isProviderId(provider) || !isBoundedString(sessionId, MAX_ID_LENGTH)) {
                return null;
            }
            if (workspaceScopeIdentity === undefined) {
                const matches = (await this.listInactiveUnlocked(true)).filter(record =>
                    record.provider === provider && record.sessionId === sessionId);
                return matches.length === 1 ? cloneInactive(matches[0]) : null;
            }
            if (!isBoundedString(workspaceScopeIdentity, MAX_ID_LENGTH)) {
                return null;
            }
            const filePath = this.recordPath('known', provider, workspaceScopeIdentity, sessionId);
            const record = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (!record || record.provider !== provider || record.sessionId !== sessionId
                || !isCanonicalRecordPath(filePath, record)) {
                return null;
            }
            if (isFinalRuntimeExpired(record, this.now())) {
                await removeFile(filePath);
                return null;
            }
            return record.state === 'completed' || record.state === 'stopped'
                ? cloneInactive(record) : null;
        });
    }

    getAmbiguous(identity: AiSessionRuntimeIdentity): Promise<TmuxAmbiguousRuntimeBinding | null> {
        return this.serialize(async () => {
            const identityParts = ambiguousIdentityParts(identity);
            if (!identityParts) {
                return null;
            }
            const filePath = this.recordPath('ambiguous', ...identityParts);
            const record = validateAmbiguousRecord(await readJsonRegularFile(filePath));
            if (!record || !ambiguousRecordMatchesIdentity(record, identity)
                || !isCanonicalRecordPath(filePath, record)) {
                return null;
            }
            return cloneAmbiguous(record);
        });
    }

    setPending(record: TmuxPendingRuntimeBinding): Promise<boolean> {
        const validated = validatePersistedPendingRecord(record, this.now());
        if (!validated) {
            return Promise.reject(new Error('The pending tmux binding is invalid or expired.'));
        }
        return this.serialize(async () => {
            await this.writeRecord(this.recordPath(
                'pending', ...pendingRecordIdentityParts(validated)
            ), validated);
            return true;
        });
    }

    getConsumed(identity: AiSessionRuntimeIdentity): Promise<TmuxConsumedPendingBinding | null> {
        return this.serialize(async () => {
            const identityParts = pendingIdentityParts(identity);
            if (!identityParts) {
                return null;
            }
            const filePath = this.recordPath('consumed', ...identityParts);
            const record = validateConsumedRecord(await readJsonRegularFile(filePath));
            return record && consumedRecordMatchesIdentity(record, identity)
                && isCanonicalRecordPath(filePath, record) ? cloneConsumed(record) : null;
        });
    }

    setConsumed(record: TmuxConsumedPendingBinding): Promise<boolean> {
        const validated = validateConsumedRecord(record, true);
        if (!validated) {
            return Promise.reject(new Error('The consumed tmux binding is invalid.'));
        }
        return this.serialize(async () => {
            await this.writeRecord(this.recordPath(
                'consumed', ...pendingRecordIdentityParts(validated)
            ), validated);
            return true;
        });
    }

    getPromoting(identity: AiSessionRuntimeIdentity): Promise<TmuxPromotingRuntimeBinding | null> {
        return this.serialize(async () => {
            const identityParts = pendingIdentityParts(identity);
            if (!identityParts) {
                return null;
            }
            const filePath = this.recordPath('promoting', ...identityParts);
            const record = validatePromotingRecord(await readJsonRegularFile(filePath));
            return record && promotingRecordMatchesIdentity(record, identity)
                && isCanonicalRecordPath(filePath, record) ? clonePromoting(record) : null;
        });
    }

    setPromoting(record: TmuxPromotingRuntimeBinding): Promise<boolean> {
        const validated = validatePromotingRecord(record);
        if (!validated) {
            return Promise.reject(new Error('The promoting tmux binding is invalid.'));
        }
        return this.serialize(async () => {
            await this.writeRecord(this.recordPath(
                'promoting', ...pendingRecordIdentityParts(validated)
            ), validated);
            return true;
        });
    }

    removePromoting(identity: AiSessionRuntimeIdentity): Promise<void> {
        const identityParts = pendingIdentityParts(identity);
        return identityParts
            ? this.serialize(() => removeFile(this.recordPath('promoting', ...identityParts)))
            : Promise.resolve();
    }

    setAmbiguous(record: TmuxAmbiguousRuntimeBinding): Promise<boolean> {
        const validated = validateAmbiguousRecord(record);
        if (!validated) {
            return Promise.reject(new Error('The ambiguous tmux binding is invalid.'));
        }
        const identityParts = ambiguousRecordIdentityParts(validated);
        return this.serialize(async () => {
            await this.writeRecord(this.recordPath('ambiguous', ...identityParts), validated);
            return true;
        });
    }

    removeAmbiguous(identity: AiSessionRuntimeIdentity): Promise<void> {
        const identityParts = ambiguousIdentityParts(identity);
        if (!identityParts) {
            return Promise.resolve();
        }
        return this.serialize(() => removeFile(this.recordPath('ambiguous', ...identityParts)));
    }

    removePending(identity: AiSessionRuntimeIdentity): Promise<void> {
        const identityParts = pendingIdentityParts(identity);
        return identityParts
            ? this.serialize(() => removeFile(this.recordPath('pending', ...identityParts)))
            : Promise.resolve();
    }

    setKnown(record: TmuxKnownRuntimeBinding): Promise<void> {
        const validated = validateKnownRecord(record);
        if (!validated || isKnownExpired(validated, this.now())) {
            return Promise.resolve();
        }
        return this.serializeFinal(async () => {
            const filePath = this.recordPath('known', validated.provider,
                validated.workspaceScopeIdentity, validated.sessionId);
            const current = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (current && current.provider === validated.provider
                && current.sessionId === validated.sessionId
                && (current.state === 'completed' || current.state === 'stopped')) {
                return;
            }
            await this.writeRecord(filePath, validated);
            await this.listKnownUnlocked(true);
        });
    }

    rebindKnown(
        expected: TmuxKnownRuntimeBinding,
        nextSessionId: string
    ): Promise<TmuxKnownRebindResult> {
        const validated = validateKnownRecord(expected);
        if (!validated || isKnownExpired(validated, this.now())
            || !isBoundedString(nextSessionId, MAX_ID_LENGTH)
            || nextSessionId === validated.sessionId) {
            return Promise.resolve('stale');
        }
        return this.serializeFinal(async () => {
            const oldPath = this.recordPath('known', validated.provider,
                validated.workspaceScopeIdentity, validated.sessionId);
            const current = validateFinalRuntimeRecord(await readJsonRegularFile(oldPath), this.now());
            if (!current) {
                return await pathEntryExists(oldPath) ? 'stale' : 'missing';
            }
            if (current.state !== 'known' || !knownBindingsEqual(current, validated)
                || !isCanonicalRecordPath(oldPath, current)) {
                return 'stale';
            }

            const replacement = validateKnownRecord({
                ...validated,
                sessionId: nextSessionId,
            });
            if (!replacement) {
                return 'stale';
            }
            const replacementPath = this.recordPath('known', replacement.provider,
                replacement.workspaceScopeIdentity, replacement.sessionId);
            if (await pathEntryExists(replacementPath)) {
                return 'stale';
            }
            const intent: TmuxKnownRebindIntent = {
                version: 1,
                state: 'rebind-known',
                expected: cloneKnown(validated),
                replacement: cloneKnown(replacement),
                recordedAtMs: this.now(),
            };
            const intentPath = this.rebindIntentPath(intent);
            await this.writeRecord(intentPath, intent);
            await this.writeRecord(replacementPath, replacement);
            await removeFileDurably(oldPath);
            await removeFileDurably(intentPath);
            return 'rebound';
        });
    }

    setInactive(record: TmuxInactiveRuntimeBinding): Promise<void> {
        const validated = validateInactiveRecord(record, this.now());
        if (!validated || isInactiveExpired(validated, this.now())) {
            return Promise.reject(new Error('The inactive tmux binding is invalid or expired.'));
        }
        return this.serializeFinal(async () => {
            const filePath = this.recordPath('known', validated.provider,
                validated.workspaceScopeIdentity, validated.sessionId);
            const current = validateFinalRuntimeRecord(
                await readJsonRegularFile(filePath), this.now()
            );
            if (current) {
                if (current.state === 'known') {
                    return;
                }
                if (!inactiveBindingsMatchRun(current, validated)
                    || validated.detectedAtMs < current.detectedAtMs
                    || (current.state === 'completed' && validated.state === 'stopped')) {
                    return;
                }
            }
            await this.writeRecord(filePath, validated);
            await this.listInactiveUnlocked(true);
        });
    }

    transitionKnownToInactive(
        record: TmuxInactiveRuntimeBinding,
        expectedLastSeenAtMs: number
    ): Promise<boolean> {
        const validated = validateInactiveRecord(record, this.now());
        if (!validated || isInactiveExpired(validated, this.now())
            || !isFiniteNonNegative(expectedLastSeenAtMs)) {
            return Promise.reject(new Error('The inactive tmux binding transition is invalid or expired.'));
        }
        return this.serializeFinal(async () => {
            const filePath = this.recordPath('known', validated.provider,
                validated.workspaceScopeIdentity, validated.sessionId);
            const current = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (!current || current.state !== 'known'
                || current.provider !== validated.provider
                || current.sessionId !== validated.sessionId
                || !bindingIdentitiesEqual(current, validated)
                || current.layout !== validated.layout
                || !locatorsEqual(current.locator, validated.locator)
                || current.lastSeenAtMs !== expectedLastSeenAtMs
                || !isCanonicalRecordPath(filePath, current)) {
                return false;
            }
            await this.writeRecord(filePath, validated);
            await this.listInactiveUnlocked(true);
            return true;
        });
    }

    acknowledgeInactive(
        expected: TmuxInactiveRuntimeBinding
    ): Promise<TmuxInactiveAcknowledgementResult> {
        const validated = validateInactiveRecord(expected, this.now());
        if (!validated) {
            return Promise.reject(new Error('The expected inactive tmux binding is invalid.'));
        }
        return this.serializeFinal(async () => {
            const filePath = this.recordPath('known', validated.provider,
                validated.workspaceScopeIdentity, validated.sessionId);
            const record = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (!record) {
                return await pathEntryExists(filePath) ? 'stale' : 'missing';
            }
            if (record.provider !== validated.provider || record.sessionId !== validated.sessionId
                || !isCanonicalRecordPath(filePath, record)
                || record.state === 'known'
                || !inactiveBindingsEqual(record, validated)) {
                return 'stale';
            }
            await removeFileDurably(filePath);
            return 'acknowledged';
        });
    }

    removeKnown(
        provider: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity?: string
    ): Promise<void> {
        if (!isProviderId(provider) || !isBoundedString(sessionId, MAX_ID_LENGTH)) {
            return Promise.resolve();
        }
        return this.serializeFinal(async () => {
            const records = (await this.listKnownUnlocked(false)).filter(record =>
                record.provider === provider && record.sessionId === sessionId
                && (workspaceScopeIdentity === undefined
                    || record.workspaceScopeIdentity === workspaceScopeIdentity));
            for (const record of records) {
                await removeFile(this.recordPath('known', record.provider,
                    record.workspaceScopeIdentity, record.sessionId));
            }
        });
    }

    reconcileKnown(live: readonly AiSessionRuntimeSnapshot[]): Promise<void> {
        return this.serializeFinal(async () => {
            for (const runtime of live) {
                const sessionId = runtime.identity && runtime.identity.sessionId;
                if (runtime.backend !== 'tmux' || !runtime.tmux || !sessionId) {
                    continue;
                }
                const hasLifecycleEvidence = isBoundedPath(runtime.identity.cwd)
                    && isBoundedPath(runtime.markerPath)
                    && isFinitePositive(runtime.runStartedAtMs);
                const record = validateKnownRecord({
                    version: 3,
                    state: 'known',
                    provider: runtime.identity.provider,
                    sessionId,
                    workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
                    workspaceNavigationIdentity: runtime.identity.workspaceNavigationIdentity,
                    workspaceRootHostPaths: [...runtime.identity.workspaceRootHostPaths],
                    ...getAiSessionRuntimeIdentityV3Fields(runtime.identity),
                    cwd: runtime.identity.cwd,
                    layout: runtime.tmux.layout,
                    locator: runtime.tmux,
                    lastSeenAtMs: this.now(),
                    ...(hasLifecycleEvidence ? {
                        markerPath: runtime.markerPath,
                        runStartedAtMs: runtime.runStartedAtMs,
                    } : {}),
                });
                if (record) {
                    const filePath = this.recordPath('known', record.provider,
                        record.workspaceScopeIdentity, record.sessionId);
                    const current = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
                    if (!current || current.state === 'known') {
                        await this.writeRecord(filePath, record);
                    }
                }
            }
            await this.listKnownUnlocked(true);
        });
    }

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation);
        this.operationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private serializeFinal<T>(operation: () => Promise<T>): Promise<T> {
        return this.serialize(() => this.withFinalRecordLock(async () => {
            await this.recoverRebindIntentsUnlocked();
            return operation();
        }));
    }

    private async recoverRebindIntentsUnlocked(): Promise<void> {
        for (const filePath of await listJsonFiles(this.root)) {
            if (!path.basename(filePath).startsWith('rebind-')) {
                continue;
            }
            const intent = validateKnownRebindIntent(await readJsonRegularFile(filePath));
            if (!intent || filePath !== this.rebindIntentPath(intent)) {
                await removeFileDurably(filePath);
                continue;
            }
            const oldPath = this.recordPath('known', intent.expected.provider,
                intent.expected.workspaceScopeIdentity, intent.expected.sessionId);
            const replacementPath = this.recordPath('known', intent.replacement.provider,
                intent.replacement.workspaceScopeIdentity, intent.replacement.sessionId);
            const oldRecord = validateFinalRuntimeRecord(
                await readJsonRegularFile(oldPath), this.now()
            );
            const replacementRecord = validateFinalRuntimeRecord(
                await readJsonRegularFile(replacementPath), this.now()
            );
            const oldMatches = oldRecord?.state === 'known'
                && knownBindingsEqual(oldRecord, intent.expected);
            const replacementMatches = replacementRecord?.state === 'known'
                && knownBindingsEqual(replacementRecord, intent.replacement);

            if (oldMatches && (!replacementRecord || replacementMatches)) {
                if (!replacementMatches) {
                    await this.writeRecord(replacementPath, intent.replacement);
                }
                await removeFileDurably(oldPath);
                await removeFileDurably(filePath);
                continue;
            }
            if (!oldRecord && replacementMatches) {
                await removeFileDurably(filePath);
                continue;
            }
            await removeFileDurably(filePath);
        }
    }

    private async listPendingUnlocked(): Promise<TmuxPendingRuntimeBinding[]> {
        const records: TmuxPendingRuntimeBinding[] = [];
        const now = this.now();
        if (!Number.isFinite(now)) {
            return records;
        }
        for (const filePath of await listJsonFiles(this.root)) {
            const record = validatePersistedPendingRecord(await readJsonRegularFile(filePath), now);
            if (!record || !isCanonicalRecordPath(filePath, record)) {
                continue;
            }
            records.push(record);
        }
        records.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
            || left.pendingId.localeCompare(right.pendingId));
        return records.map(clonePending);
    }

    private async listRecoverablePendingUnlocked(): Promise<TmuxRecoverablePendingBinding[]> {
        const pending = new Map<string, TmuxPendingRuntimeBinding>();
        const promoting = new Map<string, TmuxPromotingRuntimeBinding>();
        const consumed = new Map<string, TmuxConsumedPendingBinding>();
        const now = this.now();
        if (!Number.isFinite(now)) {
            throw new Error('The tmux promotion record clock is invalid.');
        }
        for (const filePath of await listJsonFiles(this.root)) {
            const name = path.basename(filePath);
            if (name.startsWith('pending-')) {
                const record = validatePersistedPendingRecord(
                    await readJsonRegularFile(filePath), now
                );
                if (record && isCanonicalRecordPath(filePath, record)) {
                    pending.set(pendingLifecycleRecordKey(record), record);
                }
                continue;
            }
            if (name.startsWith('promoting-')) {
                const record = validatePromotingRecord(await readJsonRegularFile(filePath));
                if (!record || !isCanonicalRecordPath(filePath, record)) {
                    throw new Error('A durable tmux promoting record is invalid.');
                }
                const key = pendingLifecycleRecordKey(record);
                if (promoting.has(key)) {
                    throw new Error('Multiple durable tmux promoting records target one pending runtime.');
                }
                promoting.set(key, record);
                continue;
            }
            if (name.startsWith('consumed-')) {
                const value = await readJsonRegularFile(filePath);
                const record = validateConsumedRecord(value);
                if (!record && isLegacyProjectKeyConsumedRecord(value)) {
                    continue;
                }
                if (!record || !isCanonicalRecordPath(filePath, record)) {
                    throw new Error('A durable tmux consumed record is invalid.');
                }
                const key = pendingLifecycleRecordKey(record);
                if (consumed.has(key)) {
                    throw new Error('Multiple durable tmux consumed records target one pending runtime.');
                }
                consumed.set(key, record);
            }
        }

        const result: TmuxRecoverablePendingBinding[] = [];
        const keys = new Set([...promoting.keys(), ...consumed.keys()]);
        for (const key of keys) {
            const intent = promoting.get(key);
            const tombstone = consumed.get(key);
            const livePending = pending.get(key);
            if (intent) {
                if (livePending && !pendingBindingsEqual(intent.pendingBinding, livePending)) {
                    throw new Error('A durable tmux promotion conflicts with its pending record.');
                }
                if (tombstone && !consumedMatchesPromoting(tombstone, intent)) {
                    throw new Error('Durable tmux promotion records disagree on the final runtime.');
                }
                result.push({
                    pendingBinding: clonePending(intent.pendingBinding),
                    promotionRecoveryDisplayName: intent.finalSessionName,
                    recoverySessionId: intent.finalSessionId,
                });
                continue;
            }
            if (tombstone?.finalSessionName && livePending) {
                result.push({
                    pendingBinding: clonePending(livePending),
                    promotionRecoveryDisplayName: tombstone.finalSessionName,
                    recoverySessionId: tombstone.finalSessionId,
                });
            }
        }
        result.sort((left, right) => Date.parse(left.pendingBinding.createdAt)
            - Date.parse(right.pendingBinding.createdAt)
            || left.pendingBinding.pendingId.localeCompare(right.pendingBinding.pendingId));
        return result;
    }

    private async listKnownUnlocked(pruneToCap: boolean): Promise<TmuxKnownRuntimeBinding[]> {
        const entries = await this.listFinalRuntimeUnlocked(pruneToCap);
        return entries.filter((entry): entry is { filePath: string; record: TmuxKnownRuntimeBinding } =>
            entry.record.state === 'known').map(entry => cloneKnown(entry.record));
    }

    private async listInactiveUnlocked(pruneToCap: boolean): Promise<TmuxInactiveRuntimeBinding[]> {
        const entries = await this.listFinalRuntimeUnlocked(pruneToCap);
        return entries.filter((entry): entry is { filePath: string; record: TmuxInactiveRuntimeBinding } =>
            entry.record.state === 'completed' || entry.record.state === 'stopped')
            .map(entry => cloneInactive(entry.record));
    }

    private async listFinalRuntimeUnlocked(
        pruneToCap: boolean
    ): Promise<Array<{ filePath: string; record: TmuxFinalRuntimeBinding }>> {
        const entries: Array<{ filePath: string; record: TmuxFinalRuntimeBinding }> = [];
        for (const filePath of await listJsonFiles(this.root)) {
            const record = validateFinalRuntimeRecord(await readJsonRegularFile(filePath), this.now());
            if (!record || !isCanonicalRecordPath(filePath, record)) {
                continue;
            }
            if (isFinalRuntimeExpired(record, this.now())) {
                await removeFile(filePath);
            } else {
                entries.push({ filePath, record });
            }
        }
        entries.sort((left, right) => finalRuntimePriority(left.record) - finalRuntimePriority(right.record)
            || finalRuntimeTimestamp(right.record) - finalRuntimeTimestamp(left.record)
            || left.record.provider.localeCompare(right.record.provider)
            || left.record.sessionId.localeCompare(right.record.sessionId));
        if (pruneToCap) {
            const knownEntries = entries.filter(entry => entry.record.state === 'known');
            const inactiveEntries = entries.filter(entry => entry.record.state !== 'known');
            const pruned = [
                ...knownEntries.slice(MAX_KNOWN_RECORDS),
                ...inactiveEntries.slice(MAX_INACTIVE_RECORDS),
            ];
            for (const entry of pruned) {
                await removeFile(entry.filePath);
            }
            if (pruned.length) {
                const prunedPaths = new Set(pruned.map(entry => entry.filePath));
                return entries.filter(entry => !prunedPaths.has(entry.filePath));
            }
        }
        return entries;
    }

    private recordPath(
        kind: 'pending' | 'known' | 'ambiguous' | 'consumed' | 'promoting' | 'rebind',
        ...identity: string[]
    ): string {
        return path.join(this.root, getRecordFilename(kind, ...identity));
    }

    private rebindIntentPath(intent: TmuxKnownRebindIntent): string {
        return this.recordPath(
            'rebind',
            intent.expected.provider,
            intent.expected.workspaceScopeIdentity,
            JSON.stringify(intent.expected.locator)
        );
    }

    private async writeRecord(filePath: string, record: TmuxRuntimeBinding): Promise<void> {
        await fs.mkdir(this.root, { recursive: true });
        const temporaryPath = path.join(
            this.root,
            `.${path.basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`
        );
        let handle: fs.FileHandle | undefined;
        try {
            handle = await fs.open(temporaryPath, 'wx');
            await handle.writeFile(JSON.stringify(record), { encoding: 'utf8' });
            await handle.sync();
            await handle.close();
            handle = undefined;
            await fs.rename(temporaryPath, filePath);
        } finally {
            if (handle) {
                await handle.close().catch(() => undefined);
            }
            await removeFile(temporaryPath);
        }
    }
}

async function listJsonFiles(root: string): Promise<string[]> {
    let names: string[];
    try {
        names = await fs.readdir(root);
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            return [];
        }
        throw error;
    }
    return names.filter(name => name.endsWith('.json')).map(name => path.join(root, name));
}

async function readJsonRegularFile(filePath: string): Promise<unknown> {
    let handle: fs.FileHandle | undefined;
    try {
        const pathStat = await fs.lstat(filePath);
        if (!pathStat.isFile() || pathStat.size <= 0 || pathStat.size > MAX_RECORD_BYTES) {
            return null;
        }
        handle = await openRecordFile(filePath);
        const handleStat = await handle.stat();
        if (!handleStat.isFile() || handleStat.size <= 0 || handleStat.size > MAX_RECORD_BYTES) {
            return null;
        }
        const openedPathStat = await fs.lstat(filePath);
        if (!openedPathStat.isFile() || openedPathStat.size <= 0 || openedPathStat.size > MAX_RECORD_BYTES
            || !isSameFile(pathStat, handleStat) || !isSameFile(openedPathStat, handleStat)) {
            return null;
        }
        return JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    } catch (error) {
        if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ELOOP') || error instanceof SyntaxError) {
            return null;
        }
        throw error;
    } finally {
        if (handle) {
            await handle.close();
        }
    }
}

async function pathEntryExists(filePath: string): Promise<boolean> {
    try {
        await fs.lstat(filePath);
        return true;
    } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
            return false;
        }
        throw error;
    }
}

function isSameFile(pathStat: Stats, handleStat: Stats): boolean {
    return pathStat.dev === handleStat.dev && pathStat.ino === handleStat.ino;
}

async function openRecordFile(filePath: string): Promise<fs.FileHandle> {
    if (NO_FOLLOW_FLAG) {
        try {
            return await fs.open(filePath, READ_ONLY_NO_FOLLOW);
        } catch (error) {
            if (!isUnsupportedNoFollowError(error)) {
                throw error;
            }
        }
    }
    return fs.open(filePath, READ_ONLY_FALLBACK);
}

function isUnsupportedNoFollowError(error: unknown): boolean {
    return isNodeError(error, 'EINVAL') || isNodeError(error, 'ENOTSUP') || isNodeError(error, 'EOPNOTSUPP');
}


async function removeFile(filePath: string): Promise<void> {
    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
}

async function removeFileDurably(filePath: string): Promise<void> {
    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
    let directory: fs.FileHandle | undefined;
    try {
        directory = await fs.open(path.dirname(filePath), 'r');
        await directory.sync();
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    } finally {
        if (directory) {
            await directory.close();
        }
    }
}
