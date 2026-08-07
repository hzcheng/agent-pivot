'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodexSession } from '../models';
import { aiSessionPathContains, compareAiSessionUpdatedAt, filterAiSessionsByCandidatePaths, getAiSessionFileSignature, normalizeAiSessionCandidatePaths, resolveAiSessionQueryOptions } from '../aiSessions/sessionHelpers';
import IncrementalJsonlLifecycleReader from '../aiSessions/incrementalJsonlLifecycleReader';
import type { AiSessionConversationSourceCandidate, AiSessionQueryOptions } from '../aiSessions/types';
import { createKimiLifecycleAccumulator, AiSessionLifecycleRequest, AiSessionLifecycleSignal } from '../aiSessions/lifecycle';
import SessionFingerprint from '../aiSessions/sessionFingerprint';
import { Disposable } from './codexSessionService';

interface KimiWorkDirEntry {
    path?: string;
    last_session_id?: string;
}

interface KimiConfig {
    work_dirs?: KimiWorkDirEntry[];
}

interface KimiSessionState {
    custom_title?: string;
    archived?: boolean;
    archived_at?: string;
    plan_mode?: boolean;
    plan_slug?: string;
}

interface KimiSessionCandidate {
    workDir: string;
    sessionId: string;
    sessionDir: string;
    mtimeMs: number;
}

export interface KimiSessionReadResult {
    available: boolean;
    sessions: CodexSession[];
    scannedFiles: number;
    parsedFiles: number;
}

export default class KimiSessionService {
    private cachedResult: KimiSessionReadResult = null;
    private cachedAt = 0;
    private readonly sessionDirsById = new Map<string, string>();
    private readonly lifecycleReader = new IncrementalJsonlLifecycleReader();
    private readonly cacheTtlMs = 5000;
    private readonly changePollIntervalMs = 3000;
    private readonly changeListeners = new Set<{ onDidChange: () => void }>();
    private changePoll: ReturnType<typeof setInterval> = null;
    private changeFingerprint: string = null;

    resolveConversationSource(sessionId: string): AiSessionConversationSourceCandidate | null {
        const kimiHome = this.getKimiHome();
        const sessionDir = kimiHome && this.findSessionDir(kimiHome, sessionId);
        const sourcePath = sessionDir && path.join(sessionDir, 'wire.jsonl');
        return sourcePath && fs.existsSync(sourcePath)
            ? { providerHome: kimiHome, sourcePath }
            : null;
    }

    getSessions(options: boolean | AiSessionQueryOptions = false): KimiSessionReadResult {
        let { forceRefresh, candidatePaths, maxFiles } = resolveAiSessionQueryOptions(options);
        let now = Date.now();
        if (!forceRefresh && this.cachedResult && now - this.cachedAt < this.cacheTtlMs) {
            return this.filterResult(this.cachedResult, candidatePaths);
        }

        let kimiHome = this.getKimiHome();
        if (!kimiHome) {
            return this.cacheResult({ available: false, sessions: [], scannedFiles: 0, parsedFiles: 0 });
        }

        let workDirs = this.getWorkDirs(kimiHome);
        if (!workDirs.length) {
            return this.cacheResult({ available: false, sessions: [], scannedFiles: 0, parsedFiles: 0 });
        }

        if (candidatePaths.length) {
            workDirs = workDirs.filter(workDir => candidatePaths.some(candidatePath => aiSessionPathContains(candidatePath, workDir)));
            if (!workDirs.length) {
                return { available: true, sessions: [], scannedFiles: 0, parsedFiles: 0 };
            }
        }

        let candidates: KimiSessionCandidate[] = [];
        for (let workDir of workDirs) {
            candidates.push(...this.getSessionCandidatesForWorkDir(kimiHome, workDir));
        }

        let parsedFiles = 0;
        let sessions: CodexSession[] = [];
        for (let candidate of candidates
            .sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId))
            .slice(0, maxFiles || undefined)) {
            parsedFiles++;
            this.sessionDirsById.set(candidate.sessionId, candidate.sessionDir);
            let session = this.readSession(candidate.workDir, candidate.sessionId, candidate.sessionDir);
            if (session) {
                sessions.push(session);
            }
        }

        sessions.sort((a, b) => compareAiSessionUpdatedAt(b.updatedAt, a.updatedAt));
        let result = { available: true, sessions, scannedFiles: candidates.length, parsedFiles };
        return candidatePaths.length ? this.filterResult(result, candidatePaths) : this.cacheResult(result);
    }

    getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal> {
        let activeSessionIds = new Set<string>();
        let kimiHome = this.getKimiHome();
        if (!kimiHome) {
            this.lifecycleReader.retain(activeSessionIds);
            return {};
        }
        let signals: Record<string, AiSessionLifecycleSignal> = {};
        for (let request of requests || []) {
            if (!request?.sessionId || !Number.isFinite(request.runStartedAtMs)) {
                continue;
            }
            activeSessionIds.add(request.sessionId);
            if (signals[request.sessionId]) {
                continue;
            }
            let sessionDir = this.findSessionDir(kimiHome, request.sessionId);
            if (!sessionDir) {
                this.lifecycleReader.delete(request.sessionId);
                continue;
            }
            let sessionFile = path.join(sessionDir, 'wire.jsonl');
            if (!fs.existsSync(sessionFile)) {
                this.lifecycleReader.delete(request.sessionId);
                continue;
            }
            let signal = this.lifecycleReader.read(
                request.sessionId,
                sessionFile,
                request.runStartedAtMs,
                () => createKimiLifecycleAccumulator(request.runStartedAtMs)
            );
            if (signal) {
                signals[request.sessionId] = signal;
            }
        }
        this.lifecycleReader.retain(activeSessionIds);
        return signals;
    }

    archiveSession(sessionId: string): boolean {
        if (!sessionId) {
            return false;
        }

        let kimiHome = this.getKimiHome();
        if (!kimiHome) {
            return false;
        }

        let sessionDir = this.findSessionDir(kimiHome, sessionId);
        if (!sessionDir) {
            return false;
        }

        try {
            let statePath = path.join(sessionDir, 'state.json');
            let state = this.readJson<KimiSessionState>(statePath) || {};
            state.archived = true;
            state.archived_at = new Date().toISOString();
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
            this.lifecycleReader.delete(sessionId);
            this.invalidateCache();
            return true;
        } catch (e) {
            return false;
        }
    }

    invalidateCache() {
        this.cachedResult = null;
        this.cachedAt = 0;
    }

    watchSessionChanges(onDidChange: () => void): Disposable {
        let listener = { onDidChange };
        this.changeListeners.add(listener);
        this.startChangePoll();
        let disposed = false;

        return {
            dispose: () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                this.changeListeners.delete(listener);
                if (this.changeListeners.size === 0) {
                    this.stopChangePoll();
                }
            },
        };
    }

    private startChangePoll(): void {
        if (this.changePoll) {
            return;
        }

        this.changeFingerprint = this.getSessionFingerprint();
        this.changePoll = setInterval(() => {
            let nextFingerprint = this.getSessionFingerprint();
            if (nextFingerprint === this.changeFingerprint) {
                return;
            }

            this.changeFingerprint = nextFingerprint;
            this.invalidateCache();
            for (let listener of Array.from(this.changeListeners)) {
                try {
                    listener.onDidChange();
                } catch (_error) {
                    // One consumer must not prevent the shared poll from
                    // invalidating every other Kimi conversation subscriber.
                }
            }
        }, this.changePollIntervalMs);
    }

    private stopChangePoll(): void {
        if (this.changePoll) {
            clearInterval(this.changePoll);
        }
        this.changePoll = null;
        this.changeFingerprint = null;
    }

    private cacheResult(result: KimiSessionReadResult): KimiSessionReadResult {
        this.cachedResult = result;
        this.cachedAt = Date.now();

        return result;
    }

    private filterResult(result: KimiSessionReadResult, candidatePaths: string[]): KimiSessionReadResult {
        return filterAiSessionsByCandidatePaths(result, candidatePaths, session => session.workDir || session.cwd);
    }

    private getKimiHome(): string {
        let configuredHome = process.env.KIMI_SHARE_DIR;
        if (configuredHome && fs.existsSync(configuredHome)) {
            return configuredHome;
        }

        let defaultHome = path.join(os.homedir(), '.kimi');
        return fs.existsSync(defaultHome) ? defaultHome : null;
    }

    private getWorkDirs(kimiHome: string): string[] {
        let configPath = path.join(kimiHome, 'kimi.json');
        let config = this.readJson<KimiConfig>(configPath);
        if (!config?.work_dirs?.length) {
            return [];
        }

        let seen = new Set<string>();
        let workDirs: string[] = [];
        for (let entry of config.work_dirs) {
            let workDir = this.normalizePath(entry.path);
            if (!workDir || seen.has(workDir)) {
                continue;
            }

            seen.add(workDir);
            workDirs.push(workDir);
        }

        return workDirs;
    }

    private getSessionCandidatesForWorkDir(kimiHome: string, workDir: string): KimiSessionCandidate[] {
        let sessionsDir = path.join(kimiHome, 'sessions', this.getWorkDirHash(workDir));
        if (!fs.existsSync(sessionsDir)) {
            return [];
        }

        let candidates: KimiSessionCandidate[] = [];
        try {
            for (let entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
                if (!entry.isDirectory() || !this.isSessionId(entry.name)) {
                    continue;
                }
                let sessionDir = path.join(sessionsDir, entry.name);
                candidates.push({
                    workDir,
                    sessionId: entry.name,
                    sessionDir,
                    mtimeMs: this.getFileMtimeMs(path.join(sessionDir, 'wire.jsonl')),
                });
            }
            return candidates;
        } catch (e) {
            return candidates;
        }
    }

    private findSessionDir(kimiHome: string, sessionId: string): string {
        if (!this.isSessionId(sessionId)) {
            return null;
        }

        let cached = this.sessionDirsById.get(sessionId);
        if (cached && fs.existsSync(cached)) {
            return cached;
        }
        this.sessionDirsById.delete(sessionId);

        let sessionsRoot = path.join(kimiHome, 'sessions');
        if (!fs.existsSync(sessionsRoot)) {
            return null;
        }

        try {
            for (let workDirEntry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
                if (!workDirEntry.isDirectory()) {
                    continue;
                }

                let sessionDir = path.join(sessionsRoot, workDirEntry.name, sessionId);
                if (fs.existsSync(sessionDir)) {
                    this.sessionDirsById.set(sessionId, sessionDir);
                    return sessionDir;
                }
            }
        } catch (e) {
            return null;
        }

        return null;
    }

    private readSession(workDir: string, sessionId: string, sessionDir: string): CodexSession {
        let wirePath = path.join(sessionDir, 'wire.jsonl');
        if (!fs.existsSync(wirePath)) {
            return null;
        }

        let wireStat: fs.Stats;
        try {
            wireStat = fs.statSync(wirePath);
            if (wireStat.size === 0) {
                return null;
            }
        } catch (e) {
            return null;
        }

        let state = this.readJson<KimiSessionState>(path.join(sessionDir, 'state.json'));
        if (state?.archived) {
            return null;
        }

        return {
            id: sessionId,
            name: state?.custom_title || state?.plan_slug || sessionId,
            updatedAt: new Date(wireStat.mtimeMs).toISOString(),
            cwd: workDir,
            workDir,
            provider: 'kimi',
        };
    }

    private getSessionFingerprint(): string {
        let kimiHome = this.getKimiHome();
        if (!kimiHome) {
            return 'missing';
        }

        let fingerprint = new SessionFingerprint();
        fingerprint.addEntry(kimiHome);
        fingerprint.addEntry(getAiSessionFileSignature(path.join(kimiHome, 'kimi.json')));
        for (let workDir of this.getWorkDirs(kimiHome)) {
            this.addWorkDirFingerprint(fingerprint, kimiHome, workDir);
        }
        return fingerprint.digest();
    }

    private addWorkDirFingerprint(fingerprint: SessionFingerprint, kimiHome: string, workDir: string): void {
        let sessionsDir = path.join(kimiHome, 'sessions', this.getWorkDirHash(workDir));
        if (!fs.existsSync(sessionsDir)) {
            fingerprint.addEntry(`${workDir}:missing`);
            return;
        }

        try {
            let sessionIds = fs.readdirSync(sessionsDir, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && this.isSessionId(entry.name))
                .map(entry => entry.name)
                .sort();
            fingerprint.addEntry(workDir);
            for (let sessionId of sessionIds) {
                let sessionDir = path.join(sessionsDir, sessionId);
                fingerprint.addEntry(sessionId);
                fingerprint.addEntry(getAiSessionFileSignature(path.join(sessionDir, 'state.json')));
                fingerprint.addEntry(getAiSessionFileSignature(path.join(sessionDir, 'wire.jsonl')));
            }
        } catch (e) {
            fingerprint.addEntry(`${workDir}:unreadable`);
        }
    }

    private getFileMtimeMs(filePath: string): number {
        try {
            return fs.statSync(filePath).mtimeMs;
        } catch (e) {
            return 0;
        }
    }

    private getWorkDirHash(workDir: string): string {
        return crypto.createHash('md5').update(workDir, 'utf8').digest('hex');
    }

    private isSessionId(value: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    private readJson<T>(filePath: string): T {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
        } catch (e) {
            return null;
        }
    }

    private normalizePath(value: string): string {
        if (!value) {
            return '';
        }

        return value.replace(/\\/g, '/').replace(/\/+$/g, '');
    }

}
