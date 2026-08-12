'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { isValidCodexProfileName } from './codexProfileNames';
import type { SessionProfileDecision } from './types';

export const AI_SESSION_PROFILES_FILE_NAME = 'ai-session-profiles.json';

/** Pending entries older than this are considered orphaned and pruned. */
export const PENDING_PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingProfileRecord {
    decision: SessionProfileDecision;
    createdAt: number;
}

interface SessionProfileFileData {
    sessions: Record<string, SessionProfileDecision>;
    pending: Record<string, PendingProfileRecord>;
}

function normalizeDecision(value: unknown): SessionProfileDecision | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === 'base') {
        return { kind: 'base' };
    }
    if (record.kind === 'profile' && isValidCodexProfileName(record.name)) {
        return { kind: 'profile', name: record.name };
    }
    return null;
}

/**
 * File-backed store for per-session Codex profile decisions. Mirrors the
 * alias-store pattern but writes atomically (temp file + rename) and always
 * re-reads immediately before writing to shrink the multi-window race
 * window. Resolution semantics:
 *
 * - `sessions` maps `provider:sessionId` to the decision recorded at creation
 *   (including an explicit base decision).
 * - `pending` maps a creation-time pendingId to the decision, migrated to
 *   `sessions` when the runtime promotion settles the real session id.
 */
export default class AiSessionProfileStore {
    private readonly profilesPath: string;

    constructor(globalStoragePath: string, private readonly nowMs: () => number = () => Date.now()) {
        this.profilesPath = path.join(globalStoragePath, AI_SESSION_PROFILES_FILE_NAME);
    }

    getAll(): Record<string, SessionProfileDecision> {
        return this.read().sessions;
    }

    get(sessionKey: string): SessionProfileDecision | undefined {
        if (!sessionKey) {
            return undefined;
        }
        return this.read().sessions[sessionKey];
    }

    set(sessionKey: string, decision: SessionProfileDecision): void {
        const normalized = normalizeDecision(decision);
        if (!sessionKey || !normalized) {
            return;
        }
        const data = this.read();
        data.sessions[sessionKey] = normalized;
        this.write(data);
    }

    remove(sessionKey: string): void {
        if (!sessionKey) {
            return;
        }
        const data = this.read();
        if (!(sessionKey in data.sessions)) {
            return;
        }
        delete data.sessions[sessionKey];
        this.write(data);
    }

    getPending(pendingId: string): SessionProfileDecision | undefined {
        if (!pendingId) {
            return undefined;
        }
        return this.read().pending[pendingId]?.decision;
    }

    getPendingAll(): Record<string, SessionProfileDecision> {
        const pending = this.read().pending;
        return Object.keys(pending).reduce<Record<string, SessionProfileDecision>>((result, key) => {
            result[key] = pending[key].decision;
            return result;
        }, {});
    }

    setPending(pendingId: string, decision: SessionProfileDecision): void {
        const normalized = normalizeDecision(decision);
        if (!pendingId || !normalized) {
            return;
        }
        const data = this.read();
        data.pending[pendingId] = { decision: normalized, createdAt: this.nowMs() };
        this.write(data);
    }

    /**
     * Migrates a pending decision to its settled session key. Returns the
     * migrated decision, or null when no pending record exists.
     */
    settlePending(pendingId: string, sessionKey: string): SessionProfileDecision | null {
        if (!pendingId || !sessionKey) {
            return null;
        }
        const data = this.read();
        const entry = data.pending[pendingId];
        if (!entry) {
            return null;
        }
        delete data.pending[pendingId];
        if (!(sessionKey in data.sessions)) {
            data.sessions[sessionKey] = entry.decision;
        }
        this.write(data);
        return entry.decision;
    }

    private read(): SessionProfileFileData {
        const empty: SessionProfileFileData = { sessions: {}, pending: {} };
        if (!fs.existsSync(this.profilesPath)) {
            return empty;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(this.profilesPath, 'utf8'));
        } catch {
            return empty;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return empty;
        }
        const record = parsed as Record<string, unknown>;
        const sessions: Record<string, SessionProfileDecision> = {};
        const rawSessions = record.sessions;
        if (rawSessions && typeof rawSessions === 'object' && !Array.isArray(rawSessions)) {
            for (const [key, value] of Object.entries(rawSessions)) {
                const decision = normalizeDecision(value);
                if (key && decision) {
                    sessions[key] = decision;
                }
            }
        }
        const pending: Record<string, PendingProfileRecord> = {};
        const rawPending = record.pending;
        const nowMs = this.nowMs();
        if (rawPending && typeof rawPending === 'object' && !Array.isArray(rawPending)) {
            for (const [key, value] of Object.entries(rawPending)) {
                if (!key || !value || typeof value !== 'object' || Array.isArray(value)) {
                    continue;
                }
                const pendingRecord = value as Record<string, unknown>;
                const decision = normalizeDecision(pendingRecord.decision);
                const createdAt = typeof pendingRecord.createdAt === 'number'
                    && Number.isFinite(pendingRecord.createdAt)
                    ? pendingRecord.createdAt
                    : 0;
                if (!decision || createdAt <= 0 || nowMs - createdAt > PENDING_PROFILE_TTL_MS) {
                    continue;
                }
                pending[key] = { decision, createdAt };
            }
        }
        return { sessions, pending };
    }

    private write(data: SessionProfileFileData): void {
        fs.mkdirSync(path.dirname(this.profilesPath), { recursive: true });
        const temporaryPath = `${this.profilesPath}.${process.pid}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(temporaryPath, this.profilesPath);
    }
}
