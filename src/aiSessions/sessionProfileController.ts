'use strict';

import type { AiSessionProviderId } from '../models';
import type { SessionProfileDecision } from './types';

export const CODEX_LAST_PROFILE_KEY = 'codexLastProfile.v1';

const PROFILE_AVAILABILITY_CACHE_TTL_MS = 10 * 1000;

export interface AiSessionProfileStoreLike {
    getAll(): Record<string, SessionProfileDecision>;
    get(sessionKey: string): SessionProfileDecision | undefined;
    set(sessionKey: string, decision: SessionProfileDecision): void;
    remove(sessionKey: string): void;
    getPending(pendingId: string): SessionProfileDecision | undefined;
    getPendingAll(): Record<string, SessionProfileDecision>;
    setPending(pendingId: string, decision: SessionProfileDecision): void;
    settlePending(pendingId: string, sessionKey: string): SessionProfileDecision | null;
}

export interface AiSessionProfileMementoLike {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

export interface AiSessionProfileControllerOptions {
    store: AiSessionProfileStoreLike;
    isProviderId: (value: string) => value is AiSessionProviderId;
    getSessionKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    logError: (message: string, error: unknown) => void;
    showSaveError?: () => void;
    lastUsedMemento?: AiSessionProfileMementoLike;
    isProfileAvailable?: (name: string) => boolean;
    nowMs?: () => number;
}

function normalizeDecision(value: unknown): SessionProfileDecision | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === 'base') {
        return { kind: 'base' };
    }
    if (record.kind === 'profile' && typeof record.name === 'string' && record.name) {
        return { kind: 'profile', name: record.name };
    }
    return null;
}

/**
 * Owns Codex profile decisions for AI sessions: the per-session mapping
 * (persisted via the store, including explicit base decisions), the
 * pendingId-keyed pre-promotion records, the "last used" picker default, and
 * profile-file availability for badge rendering.
 */
export default class AiSessionProfileController {
    private availabilityCache: { at: number; values: Record<string, boolean> } | null = null;

    constructor(private readonly options: AiSessionProfileControllerOptions) {}

    getDecision(providerId: AiSessionProviderId, sessionId: string): SessionProfileDecision | undefined {
        if (!this.options.isProviderId(providerId) || !sessionId) {
            return undefined;
        }
        try {
            return this.options.store.get(this.options.getSessionKey(providerId, sessionId));
        } catch (error) {
            this.options.logError('Failed to read the AI session profile.', error);
            return undefined;
        }
    }

    getAll(): Record<string, SessionProfileDecision> {
        try {
            return this.options.store.getAll();
        } catch (error) {
            this.options.logError('Failed to read AI session profiles.', error);
            return {};
        }
    }

    getPendingAll(): Record<string, SessionProfileDecision> {
        try {
            return this.options.store.getPendingAll();
        } catch (error) {
            this.options.logError('Failed to read pending AI session profiles.', error);
            return {};
        }
    }

    recordPending(pendingId: string, decision: SessionProfileDecision): void {
        if (!pendingId || !normalizeDecision(decision)) {
            return;
        }
        try {
            this.options.store.setPending(pendingId, decision);
        } catch (error) {
            this.options.logError('Failed to save the AI session profile.', error);
            this.options.showSaveError?.();
        }
    }

    settlePending(providerId: AiSessionProviderId, pendingId: string, sessionId: string): void {
        if (!this.options.isProviderId(providerId) || !pendingId || !sessionId) {
            return;
        }
        try {
            this.options.store.settlePending(
                pendingId,
                this.options.getSessionKey(providerId, sessionId)
            );
        } catch (error) {
            this.options.logError('Failed to persist the AI session profile.', error);
            this.options.showSaveError?.();
        }
    }

    copyForRebind(
        providerId: AiSessionProviderId,
        previousSessionId: string,
        nextSessionId: string
    ): void {
        if (!this.options.isProviderId(providerId)
            || !previousSessionId
            || !nextSessionId
            || previousSessionId === nextSessionId) {
            return;
        }
        const previousKey = this.options.getSessionKey(providerId, previousSessionId);
        const nextKey = this.options.getSessionKey(providerId, nextSessionId);
        try {
            const previous = this.options.store.get(previousKey);
            if (!previous || this.options.store.get(nextKey)) {
                return;
            }
            this.options.store.set(nextKey, previous);
        } catch (error) {
            this.options.logError(
                'Failed to preserve the AI session profile after runtime rebind.',
                error
            );
            this.options.showSaveError?.();
        }
    }

    getLastUsed(): SessionProfileDecision | null {
        try {
            return normalizeDecision(this.options.lastUsedMemento?.get(CODEX_LAST_PROFILE_KEY));
        } catch (error) {
            this.options.logError('Failed to read the last used Codex profile.', error);
            return null;
        }
    }

    rememberLastUsed(decision: SessionProfileDecision): void {
        const normalized = normalizeDecision(decision);
        if (!normalized || !this.options.lastUsedMemento) {
            return;
        }
        try {
            void this.options.lastUsedMemento.update(CODEX_LAST_PROFILE_KEY, normalized);
        } catch (error) {
            this.options.logError('Failed to save the last used Codex profile.', error);
        }
    }

    /**
     * Maps every profile name referenced by settled or pending decisions to
     * whether its `<name>.config.toml` file still exists. Results are cached
     * briefly so hydration refreshes do not stat the filesystem repeatedly.
     */
    getAvailability(): Record<string, boolean> {
        if (!this.options.isProfileAvailable) {
            return {};
        }
        const nowMs = this.options.nowMs ? this.options.nowMs() : Date.now();
        if (this.availabilityCache
            && nowMs - this.availabilityCache.at < PROFILE_AVAILABILITY_CACHE_TTL_MS) {
            return this.availabilityCache.values;
        }
        const names = new Set<string>();
        for (const decision of Object.values(this.getAll())) {
            if (decision.kind === 'profile') {
                names.add(decision.name);
            }
        }
        for (const decision of Object.values(this.getPendingAll())) {
            if (decision.kind === 'profile') {
                names.add(decision.name);
            }
        }
        const values: Record<string, boolean> = {};
        for (const name of names) {
            try {
                values[name] = this.options.isProfileAvailable(name) === true;
            } catch {
                values[name] = false;
            }
        }
        this.availabilityCache = { at: nowMs, values };
        return values;
    }
}

export interface DefaultCodexProfileDecisionSources {
    getLastUsed?: () => SessionProfileDecision | null;
    getCodexDefaultProfile?: () => string | undefined;
    isCodexProfileFileAvailable?: (name: string) => boolean;
}

/**
 * Resolves the Codex profile a picker-free creation should launch with:
 * the last-used profile while its config file is available, an explicit
 * base decision, then the configured default profile while available.
 */
export function resolveDefaultCodexProfileDecision(
    sources: DefaultCodexProfileDecisionSources
): SessionProfileDecision | undefined {
    const lastUsed = sources.getLastUsed?.();
    if (lastUsed && lastUsed.kind === 'profile') {
        if (sources.isCodexProfileFileAvailable?.(lastUsed.name) !== false) {
            return lastUsed;
        }
    }
    if (lastUsed?.kind === 'base') {
        return lastUsed;
    }
    const defaultFromSetting = sources.getCodexDefaultProfile?.();
    if (defaultFromSetting
        && sources.isCodexProfileFileAvailable?.(defaultFromSetting) !== false) {
        return { kind: 'profile', name: defaultFromSetting };
    }
    return undefined;
}
