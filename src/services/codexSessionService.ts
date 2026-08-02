'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodexSession } from '../models';
import IncrementalJsonlLifecycleReader from '../aiSessions/incrementalJsonlLifecycleReader';
import { compareAiSessionUpdatedAt, filterAiSessionsByCandidatePaths, getAiSessionFileSignature, getAvailableAiSessionArchivePath, normalizeAiSessionCandidatePaths, resolveAiSessionQueryOptions } from '../aiSessions/sessionHelpers';
import type { AiSessionQueryOptions } from '../aiSessions/types';
import { createCodexLifecycleAccumulator, AiSessionLifecycleRequest, AiSessionLifecycleSignal } from '../aiSessions/lifecycle';
import SessionFingerprint from '../aiSessions/sessionFingerprint';

interface CodexSessionIndexEntry {
    id?: string;
    thread_name?: string;
    updated_at?: string;
}

interface CodexSessionMeta {
    id?: string;
    session_id?: string;
    cwd?: string;
    timestamp?: string;
    isExcluded?: boolean;
}

interface CodexDiscoveredSessionFile {
    id: string;
    filePath: string;
    mtimeMs: number;
    sizeBytes: number;
}

export interface CodexSessionReadResult {
    available: boolean;
    sessions: CodexSession[];
    scannedFiles: number;
    parsedFiles: number;
}

export interface Disposable {
    dispose(): void;
}

export default class CodexSessionService {
    private cachedResult: CodexSessionReadResult = null;
    private cachedAt = 0;
    private readonly sessionMetaCache = new Map<string, { signature: string; meta: CodexSessionMeta }>();
    private readonly sessionIndexCache = new Map<string, { signature: string; entries: CodexSessionIndexEntry[] }>();
    private readonly lifecycleSessionFiles = new Map<string, string>();
    private readonly lifecycleReader = new IncrementalJsonlLifecycleReader();
    private readonly cacheTtlMs = 5000;
    private readonly changePollIntervalMs = 3000;

    getSessions(options: boolean | AiSessionQueryOptions = false): CodexSessionReadResult {
        let { forceRefresh, candidatePaths, maxFiles } = resolveAiSessionQueryOptions(options);
        let now = Date.now();
        if (!forceRefresh && this.cachedResult && now - this.cachedAt < this.cacheTtlMs) {
            return this.filterResult(this.cachedResult, candidatePaths);
        }

        let codexHome = this.getCodexHome();
        if (!codexHome) {
            return this.filterResult(this.cacheResult({ available: false, sessions: [], scannedFiles: 0, parsedFiles: 0 }), candidatePaths);
        }

        let indexPath = path.join(codexHome, 'session_index.jsonl');
        let hasIndex = fs.existsSync(indexPath);
        let scanStats = { discoveredFiles: 0 };
        let sessionFiles = this.getSessionFiles(codexHome, maxFiles, scanStats);
        if (!hasIndex && !sessionFiles.size) {
            return this.filterResult(this.cacheResult({
                available: false,
                sessions: [],
                scannedFiles: scanStats.discoveredFiles,
                parsedFiles: sessionFiles.size,
            }), candidatePaths);
        }

        let entries = hasIndex ? this.readSessionIndex(indexPath) : [];
        let sessionsById = new Map<string, CodexSession>();
        for (let entry of entries) {
            if (!entry.id || !sessionFiles.has(entry.id)) {
                continue;
            }

            let meta = this.readSessionMeta(entry.id, sessionFiles);
            if (meta?.isExcluded) {
                continue;
            }

            let previous = sessionsById.get(entry.id);
            let session: CodexSession = {
                id: entry.id,
                name: entry.thread_name || previous?.name || entry.id,
                updatedAt: this.getMostRecentTimestamp(
                    entry.updated_at,
                    meta?.timestamp,
                    this.getSessionFileUpdatedAt(entry.id, sessionFiles),
                    previous?.updatedAt
                ),
                cwd: meta?.cwd,
            };

            if (!previous || compareAiSessionUpdatedAt(session.updatedAt, previous.updatedAt) > 0) {
                sessionsById.set(session.id, session);
            }
        }

        this.addSessionsFromFiles(sessionsById, sessionFiles);

        let sessions = Array.from(sessionsById.values())
            .sort((a, b) => compareAiSessionUpdatedAt(b.updatedAt, a.updatedAt));

        return this.filterResult(this.cacheResult({
            available: true,
            sessions,
            scannedFiles: scanStats.discoveredFiles,
            parsedFiles: sessionFiles.size,
        }), candidatePaths);
    }

    getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal> {
        let activeSessionIds = new Set<string>();
        let codexHome = this.getCodexHome();
        if (!codexHome) {
            this.lifecycleReader.retain(activeSessionIds);
            return {};
        }
        let signals: Record<string, AiSessionLifecycleSignal> = {};
        let discoveredFiles: Map<string, string> = null;
        for (let request of requests || []) {
            if (!request?.sessionId || !Number.isFinite(request.runStartedAtMs)) {
                continue;
            }
            activeSessionIds.add(request.sessionId);
            if (signals[request.sessionId]) {
                continue;
            }
            let sessionFile = this.lifecycleSessionFiles.get(request.sessionId);
            if (sessionFile && !fs.existsSync(sessionFile)) {
                this.lifecycleSessionFiles.delete(request.sessionId);
                this.lifecycleReader.delete(request.sessionId);
                sessionFile = null;
            }
            if (!sessionFile) {
                discoveredFiles = discoveredFiles || this.getSessionFiles(codexHome);
                sessionFile = discoveredFiles.get(request.sessionId);
            }
            if (!sessionFile) {
                this.lifecycleReader.delete(request.sessionId);
                continue;
            }
            let signal = this.lifecycleReader.read(
                request.sessionId,
                sessionFile,
                request.runStartedAtMs,
                () => createCodexLifecycleAccumulator(request.runStartedAtMs)
            );
            if (signal) {
                signals[request.sessionId] = signal;
            }
        }
        this.lifecycleReader.retain(activeSessionIds);
        return signals;
    }

    resolveSessionFilePath(sessionId: string): string | null {
        if (!sessionId) {
            return null;
        }
        const codexHome = this.getCodexHome();
        if (!codexHome) {
            return null;
        }
        return this.getSessionFiles(codexHome).get(sessionId) || null;
    }

    archiveSession(sessionId: string): boolean {
        if (!sessionId) {
            return false;
        }

        let codexHome = this.getCodexHome();
        if (!codexHome) {
            return false;
        }

        let sessionFile = this.getSessionFiles(codexHome).get(sessionId);
        if (!sessionFile) {
            return false;
        }

        try {
            let archivePath = path.join(codexHome, 'archived_sessions');
            fs.mkdirSync(archivePath, { recursive: true });
            fs.renameSync(sessionFile, getAvailableAiSessionArchivePath(archivePath, path.basename(sessionFile)));
            this.lifecycleSessionFiles.delete(sessionId);
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
        let previousFingerprint = this.getSessionFingerprint();
        let interval = setInterval(() => {
            let nextFingerprint = this.getSessionFingerprint();
            if (nextFingerprint === previousFingerprint) {
                return;
            }

            previousFingerprint = nextFingerprint;
            this.invalidateCache();
            onDidChange();
        }, this.changePollIntervalMs);

        return {
            dispose: () => clearInterval(interval),
        };
    }

    private cacheResult(result: CodexSessionReadResult): CodexSessionReadResult {
        this.cachedResult = result;
        this.cachedAt = Date.now();

        return result;
    }

    private filterResult(result: CodexSessionReadResult, candidatePaths: string[]): CodexSessionReadResult {
        return filterAiSessionsByCandidatePaths(result, candidatePaths, session => session.cwd);
    }

    private getCodexHome(): string {
        let configuredHome = process.env.CODEX_HOME;
        if (configuredHome && fs.existsSync(configuredHome)) {
            return configuredHome;
        }

        let defaultHome = path.join(os.homedir(), '.codex');
        return fs.existsSync(defaultHome) ? defaultHome : null;
    }

    private getSessionFingerprint(): string {
        let codexHome = this.getCodexHome();
        if (!codexHome) {
            return 'missing';
        }

        let fingerprint = new SessionFingerprint();
        fingerprint.addEntry(codexHome);
        fingerprint.addEntry(getAiSessionFileSignature(path.join(codexHome, 'session_index.jsonl')));
        // Discovery already stats every file to order by recency, so the change
        // fingerprint reuses that instead of stat'ing every path a second time.
        for (let entry of this.discoverSessionFiles(codexHome)) {
            fingerprint.addEntry(`${entry.id}:${entry.filePath}:${entry.sizeBytes}:${entry.mtimeMs}`);
        }
        return fingerprint.digest();
    }

    private readSessionIndex(indexPath: string): CodexSessionIndexEntry[] {
        let signature = getAiSessionFileSignature(indexPath);
        let cached = this.sessionIndexCache.get(indexPath);
        if (cached?.signature === signature) {
            return cached.entries;
        }

        try {
            let lines = fs.readFileSync(indexPath, 'utf8')
                .split(/\r?\n/g)
                .map(line => line.trim())
                .filter(line => line.length);

            let entries: CodexSessionIndexEntry[] = [];
            for (let line of lines) {
                try {
                    let entry = JSON.parse(line) as CodexSessionIndexEntry;
                    if (entry.id) {
                        entries.push(entry);
                    }
                } catch (e) {
                    // Keep reading the rest of the index if one line is corrupt.
                }
            }

            this.sessionIndexCache.set(indexPath, { signature, entries });
            return entries;
        } catch (e) {
            this.sessionIndexCache.delete(indexPath);
            return [];
        }
    }

    private discoverSessionFiles(
        codexHome: string,
        maxFiles = 0,
        stats?: { discoveredFiles: number }
    ): CodexDiscoveredSessionFile[] {
        let discovered: CodexDiscoveredSessionFile[] = [];
        this.addSessionFiles(path.join(codexHome, 'sessions'), discovered, true);
        if (stats) {
            stats.discoveredFiles = discovered.length;
        }
        return discovered
            .sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
            .slice(0, maxFiles || undefined);
    }

    private getSessionFiles(codexHome: string, maxFiles = 0, stats?: { discoveredFiles: number }): Map<string, string> {
        let files = new Map<string, string>();
        for (let entry of this.discoverSessionFiles(codexHome, maxFiles, stats)) {
            files.set(entry.id, entry.filePath);
        }
        for (let [sessionId, filePath] of files) {
            this.lifecycleSessionFiles.set(sessionId, filePath);
        }

        return files;
    }

    private addSessionFiles(sessionPath: string, files: CodexDiscoveredSessionFile[], recursive: boolean) {
        if (!fs.existsSync(sessionPath)) {
            return;
        }

        try {
            for (let entry of fs.readdirSync(sessionPath, { withFileTypes: true })) {
                let entryPath = path.join(sessionPath, entry.name);
                if (recursive && entry.isDirectory()) {
                    this.addSessionFiles(entryPath, files, recursive);
                    continue;
                }

                if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                    continue;
                }

                let id = this.getSessionIdFromFileName(entry.name);
                if (id) {
                    files.push({ id, filePath: entryPath, ...this.getFileStat(entryPath) });
                }
            }
        } catch (e) {
            return;
        }
    }

    /** One stat carries both the ordering key and the change signature. */
    private getFileStat(filePath: string): { mtimeMs: number; sizeBytes: number } {
        try {
            let stat = fs.statSync(filePath);
            return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
        } catch (e) {
            return { mtimeMs: 0, sizeBytes: 0 };
        }
    }

    private getSessionIdFromFileName(fileName: string): string {
        let match = fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return match ? match[0] : null;
    }

    private addSessionsFromFiles(sessionsById: Map<string, CodexSession>, sessionFiles: Map<string, string>) {
        for (let [sessionId] of sessionFiles) {
            let meta = this.readSessionMeta(sessionId, sessionFiles);
            if (!meta || meta.isExcluded) {
                continue;
            }

            let previous = sessionsById.get(sessionId);
            sessionsById.set(sessionId, {
                id: sessionId,
                name: previous?.name || sessionId,
                updatedAt: this.getMostRecentTimestamp(
                    previous?.updatedAt,
                    meta.timestamp,
                    this.getSessionFileUpdatedAt(sessionId, sessionFiles)
                ),
                cwd: previous?.cwd || meta.cwd,
            });
        }
    }

    private getSessionFileUpdatedAt(sessionId: string, sessionFiles: Map<string, string>): string {
        let sessionFile = sessionFiles.get(sessionId);
        if (!sessionFile) {
            return null;
        }

        try {
            return fs.statSync(sessionFile).mtime.toISOString();
        } catch (e) {
            return null;
        }
    }

    private getMostRecentTimestamp(...timestamps: string[]): string {
        let mostRecent: string = null;
        let mostRecentTime = -Infinity;
        for (let timestamp of timestamps) {
            if (!timestamp) {
                continue;
            }

            let parsed = Date.parse(timestamp);
            if (!isNaN(parsed) && parsed > mostRecentTime) {
                mostRecent = timestamp;
                mostRecentTime = parsed;
            }
        }

        return mostRecent || timestamps.find(timestamp => Boolean(timestamp)) || null;
    }

    private isExcludedSessionSource(source: unknown): boolean {
        return source === 'exec' || Boolean(
            source
            && typeof source === 'object'
            && Object.prototype.hasOwnProperty.call(source, 'subagent')
        );
    }

    private readSessionMeta(sessionId: string, sessionFiles: Map<string, string>): CodexSessionMeta {
        let sessionFile = sessionFiles.get(sessionId);
        if (!sessionFile) {
            return null;
        }

        let signature = getAiSessionFileSignature(sessionFile);
        let cached = this.sessionMetaCache.get(sessionFile);
        if (cached?.signature === signature) {
            return cached.meta;
        }

        let firstLine = this.readFirstLine(sessionFile);
        if (!firstLine) {
            this.sessionMetaCache.delete(sessionFile);
            return null;
        }

        try {
            let event = JSON.parse(firstLine);
            if (event?.type !== 'session_meta') {
                this.sessionMetaCache.set(sessionFile, { signature, meta: null });
                return null;
            }

            let payload = event.payload || {};
            let meta = {
                id: payload.id,
                session_id: payload.session_id,
                cwd: payload.cwd,
                timestamp: payload.timestamp || event.timestamp,
                isExcluded: this.isExcludedSessionSource(payload.source),
            };
            this.sessionMetaCache.set(sessionFile, { signature, meta });
            return meta;
        } catch (e) {
            this.sessionMetaCache.delete(sessionFile);
            return null;
        }
    }

    private readFirstLine(filePath: string): string {
        let fd: number = null;
        try {
            fd = fs.openSync(filePath, 'r');
            let chunks: Buffer[] = [];
            let buffer = Buffer.alloc(4096);
            let bytesRead = 0;

            do {
                bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
                if (bytesRead <= 0) {
                    break;
                }

                let chunk = buffer.slice(0, bytesRead);
                let newlineIndex = chunk.indexOf(10);
                if (newlineIndex !== -1) {
                    chunks.push(chunk.slice(0, newlineIndex));
                    break;
                }

                chunks.push(Buffer.from(chunk));
            } while (bytesRead === buffer.length);

            return Buffer.concat(chunks).toString('utf8').trim();
        } catch (e) {
            return null;
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (e) {
                    // Ignore close failures for best-effort metadata reads.
                }
            }
        }
    }

}
