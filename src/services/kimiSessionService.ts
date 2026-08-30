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
    title?: string;
    cwd?: string;
    archived?: boolean;
    archived_at?: string;
    plan_mode?: boolean;
    plan_slug?: string;
}

interface KimiSessionCandidate {
    kimiHome: string;
    workDir: string;
    sessionId: string;
    sessionDir: string;
    mtimeMs: number;
}

interface KimiCodeSessionIndexEntry {
    sessionId?: string;
    sessionDir?: string;
    workDir?: string;
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
        const location = this.findSessionLocation(sessionId);
        const kimiHome = location?.kimiHome;
        const sessionDir = location?.sessionDir;
        const sourcePath = sessionDir && this.getWirePath(kimiHome, sessionDir);
        const workDir = sessionDir
            ? this.findWorkDirForSessionDir(kimiHome, sessionDir)
            : null;
        return sourcePath && fs.existsSync(sourcePath)
            && (!this.isKimiCodeHome(kimiHome)
                || this.isKimiCodePathContained(kimiHome, sourcePath))
            ? {
                providerHome: kimiHome,
                sourcePath,
                ...(workDir ? { cwd: workDir } : {}),
            }
            : null;
    }

    getSessions(options: boolean | AiSessionQueryOptions = false): KimiSessionReadResult {
        let { forceRefresh, candidatePaths, maxFiles } = resolveAiSessionQueryOptions(options);
        let now = Date.now();
        if (!forceRefresh && this.cachedResult && now - this.cachedAt < this.cacheTtlMs) {
            return this.filterResult(this.cachedResult, candidatePaths);
        }

        const kimiHomes = this.getKimiHomes();
        if (!kimiHomes.length) {
            return this.cacheResult({ available: false, sessions: [], scannedFiles: 0, parsedFiles: 0 });
        }

        let candidates: KimiSessionCandidate[] = [];
        for (const kimiHome of kimiHomes) {
            if (this.isKimiCodeHome(kimiHome)) {
                candidates.push(...this.getKimiCodeSessionCandidates(kimiHome));
                continue;
            }
            for (const workDir of this.getWorkDirs(kimiHome)) {
                candidates.push(...this.getSessionCandidatesForWorkDir(kimiHome, workDir));
            }
        }
        if (candidatePaths.length) {
            candidates = candidates.filter(candidate => candidatePaths.some(candidatePath =>
                aiSessionPathContains(candidatePath, candidate.workDir)
            ));
        }

        let parsedFiles = 0;
        let sessions: CodexSession[] = [];
        for (let candidate of candidates
            .sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId))
            .slice(0, maxFiles || undefined)) {
            parsedFiles++;
            this.sessionDirsById.set(candidate.sessionId, candidate.sessionDir);
            let session = this.readSession(
                candidate.kimiHome,
                candidate.workDir,
                candidate.sessionId,
                candidate.sessionDir
            );
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
        if (!this.getKimiHomes().length) {
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
            const location = this.findSessionLocation(request.sessionId);
            if (!location) {
                this.lifecycleReader.delete(request.sessionId);
                continue;
            }
            let sessionFile = this.getWirePath(location.kimiHome, location.sessionDir);
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

        const location = this.findSessionLocation(sessionId);
        if (!location) {
            return false;
        }

        try {
            let statePath = this.getStatePath(location.kimiHome, location.sessionDir);
            if (!statePath) {
                return false;
            }
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

    private getKimiHomes(): string[] {
        let configuredHome = process.env.KIMI_SHARE_DIR;
        if (configuredHome && fs.existsSync(configuredHome)) {
            return [configuredHome];
        }

        let kimiCodeHome = path.join(os.homedir(), '.kimi-code');
        let legacyHome = path.join(os.homedir(), '.kimi');
        return [kimiCodeHome, legacyHome].filter(home =>
            (this.isKimiCodeHome(home) || fs.existsSync(home))
        );
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
                    kimiHome,
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

    private getKimiCodeSessionCandidates(kimiHome: string): KimiSessionCandidate[] {
        const candidates: KimiSessionCandidate[] = [];
        const seenSessionIds = new Set<string>();
        for (const entry of this.readKimiCodeSessionIndex(kimiHome)) {
            const workDir = this.normalizePath(entry.workDir || '');
            const sessionDir = this.resolveKimiCodeSessionDir(kimiHome, entry.sessionDir);
            if (!workDir || !this.isKimiCodeSessionId(entry.sessionId)
                || !sessionDir || path.basename(sessionDir) !== entry.sessionId
                || seenSessionIds.has(entry.sessionId)) {
                continue;
            }
            const wirePath = this.getWirePath(kimiHome, sessionDir);
            if (!this.isKimiCodePathContained(kimiHome, wirePath)) {
                continue;
            }
            seenSessionIds.add(entry.sessionId);
            candidates.push({
                kimiHome,
                workDir,
                sessionId: entry.sessionId,
                sessionDir,
                mtimeMs: this.getFileMtimeMs(wirePath),
            });
        }
        return candidates;
    }

    private findSessionDir(kimiHome: string, sessionId: string): string {
        if (this.isKimiCodeHome(kimiHome)) {
            const indexed = this.readKimiCodeSessionIndex(kimiHome).find(entry =>
                entry.sessionId === sessionId
                    && this.isKimiCodeSessionId(entry.sessionId)
            );
            const sessionDir = indexed
                ? this.resolveKimiCodeSessionDir(kimiHome, indexed.sessionDir)
                : null;
            return sessionDir && path.basename(sessionDir) === sessionId
                ? sessionDir
                : null;
        }
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

    private findSessionLocation(sessionId: string): { kimiHome: string; sessionDir: string } | null {
        for (const kimiHome of this.getKimiHomes()) {
            const sessionDir = this.findSessionDir(kimiHome, sessionId);
            if (sessionDir) {
                return { kimiHome, sessionDir };
            }
        }
        return null;
    }

    private findWorkDirForSessionDir(
        kimiHome: string,
        sessionDir: string
    ): string {
        if (this.isKimiCodeHome(kimiHome)) {
            const normalizedSessionDir = path.resolve(sessionDir);
            const indexed = this.readKimiCodeSessionIndex(kimiHome).find(entry =>
                this.resolveKimiCodeSessionDir(kimiHome, entry.sessionDir)
                    === normalizedSessionDir
            );
            return this.normalizePath(indexed?.workDir || '') || null;
        }
        const workDirHash = path.basename(path.dirname(sessionDir));
        return this.getWorkDirs(kimiHome).find(workDir =>
            this.getWorkDirHash(workDir) === workDirHash
        ) || null;
    }

    private readSession(
        kimiHome: string,
        workDir: string,
        sessionId: string,
        sessionDir: string
    ): CodexSession {
        let wirePath = this.getWirePath(kimiHome, sessionDir);
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

        let state = this.readJson<KimiSessionState>(this.getStatePath(kimiHome, sessionDir));
        if (state?.archived) {
            return null;
        }

        return {
            id: sessionId,
            name: state?.custom_title || state?.title || state?.plan_slug || sessionId,
            updatedAt: new Date(wireStat.mtimeMs).toISOString(),
            cwd: workDir,
            workDir,
            provider: 'kimi',
        };
    }

    private getSessionFingerprint(): string {
        const kimiHomes = this.getKimiHomes();
        if (!kimiHomes.length) {
            return 'missing';
        }

        let fingerprint = new SessionFingerprint();
        for (const kimiHome of kimiHomes) {
            fingerprint.addEntry(kimiHome);
            if (this.isKimiCodeHome(kimiHome)) {
                fingerprint.addEntry(getAiSessionFileSignature(path.join(kimiHome, 'session_index.jsonl')));
                for (const candidate of this.getKimiCodeSessionCandidates(kimiHome)) {
                    fingerprint.addEntry(candidate.workDir);
                    fingerprint.addEntry(candidate.sessionId);
                    fingerprint.addEntry(getAiSessionFileSignature(this.getStatePath(kimiHome, candidate.sessionDir)));
                    fingerprint.addEntry(getAiSessionFileSignature(this.getWirePath(kimiHome, candidate.sessionDir)));
                }
                continue;
            }
            fingerprint.addEntry(getAiSessionFileSignature(path.join(kimiHome, 'kimi.json')));
            for (let workDir of this.getWorkDirs(kimiHome)) {
                this.addWorkDirFingerprint(fingerprint, kimiHome, workDir);
            }
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

    private isKimiCodeHome(kimiHome: string): boolean {
        return fs.existsSync(path.join(kimiHome, 'session_index.jsonl'));
    }

    private isKimiCodeSessionId(value: unknown): value is string {
        return typeof value === 'string'
            && /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    private getWirePath(kimiHome: string, sessionDir: string): string {
        return path.join(sessionDir, this.isKimiCodeHome(kimiHome)
            ? 'agents/main/wire.jsonl'
            : 'wire.jsonl');
    }

    private getStatePath(kimiHome: string, sessionDir: string): string | null {
        const statePath = path.join(sessionDir, 'state.json');
        if (!this.isKimiCodeHome(kimiHome)) {
            return statePath;
        }
        try {
            const stat = fs.lstatSync(statePath);
            if (!stat.isFile() && !stat.isSymbolicLink()) {
                return null;
            }
            return this.isKimiCodePathContained(kimiHome, statePath)
                ? statePath
                : null;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? statePath
                : null;
        }
    }

    private isKimiCodePathContained(kimiHome: string, value: string): boolean {
        try {
            return this.isPathContained(fs.realpathSync(kimiHome), fs.realpathSync(value));
        } catch (_error) {
            return false;
        }
    }

    private isPathContained(home: string, value: string): boolean {
        const relative = path.relative(home, value);
        return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..';
    }

    private readKimiCodeSessionIndex(kimiHome: string): KimiCodeSessionIndexEntry[] {
        try {
            const entries: KimiCodeSessionIndexEntry[] = [];
            for (const line of fs.readFileSync(path.join(kimiHome, 'session_index.jsonl'), 'utf8')
                .split(/\r?\n/)
                .filter(Boolean)) {
                try {
                    const entry = JSON.parse(line) as KimiCodeSessionIndexEntry;
                    if (entry && typeof entry === 'object') {
                        entries.push(entry);
                    }
                } catch (_error) {
                    // Ignore a partially-written trailing index entry.
                }
            }
            return entries;
        } catch (_error) {
            return [];
        }
    }

    private resolveKimiCodeSessionDir(kimiHome: string, value: unknown): string | null {
        if (typeof value !== 'string' || !value) {
            return null;
        }
        const resolvedHome = path.resolve(kimiHome);
        const resolved = path.resolve(path.isAbsolute(value)
            ? value
            : path.join(kimiHome, value));
        if (!this.isPathContained(resolvedHome, resolved)) {
            return null;
        }
        try {
            const canonicalHome = fs.realpathSync(kimiHome);
            const canonicalSessionDir = fs.realpathSync(resolved);
            return this.isPathContained(canonicalHome, canonicalSessionDir)
                ? canonicalSessionDir
                : null;
        } catch (_error) {
            return null;
        }
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
