'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodexSession } from '../models';
import { aiSessionPathContains, compareAiSessionUpdatedAt, filterAiSessionsByCandidatePaths, getAvailableAiSessionArchivePath, normalizeAiSessionCandidatePaths, resolveAiSessionQueryOptions } from '../aiSessions/sessionHelpers';
import IncrementalJsonlLifecycleReader from '../aiSessions/incrementalJsonlLifecycleReader';
import type { AiSessionConversationSourceCandidate, AiSessionQueryOptions } from '../aiSessions/types';
import { createClaudeLifecycleAccumulator, AiSessionLifecycleRequest, AiSessionLifecycleSignal } from '../aiSessions/lifecycle';
import SessionFingerprint from '../aiSessions/sessionFingerprint';
import { Disposable } from './codexSessionService';

interface ClaudeSessionEvent {
    sessionId?: string;
    cwd?: string;
    timestamp?: string;
    type?: string;
    isMeta?: boolean;
    sourceToolUseID?: string;
    sourceToolAssistantUUID?: string;
    promptSource?: string;
    origin?: {
        kind?: string;
    };
    customTitle?: string;
    aiTitle?: string;
    lastPrompt?: string;
    message?: {
        role?: string;
        content?: string | { type?: string; text?: string }[];
    };
}

export interface ClaudeSessionReadResult {
    available: boolean;
    sessions: CodexSession[];
    scannedFiles: number;
    parsedFiles: number;
}

export default class ClaudeSessionService {
    private cachedResult: ClaudeSessionReadResult = null;
    private cachedAt = 0;
    private sessionCache = new Map<string, { signature: string; session: CodexSession }>();
    private readonly sessionFilesById = new Map<string, string>();
    private readonly lifecycleReader = new IncrementalJsonlLifecycleReader();
    private readonly cacheTtlMs = 5000;
    private readonly changePollIntervalMs = 3000;
    private readonly cwdScanChunkBytes = 64 * 1024;
    private readonly sessionSampleBytes = 128 * 1024;
    private readonly maxLifecycleSubagentFiles = 64;

    resolveConversationSource(
        sessionId: string,
        candidatePaths: readonly string[] = []
    ): AiSessionConversationSourceCandidate | null {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
            return null;
        }
        sessionId = sessionId.toLowerCase();
        const claudeHome = this.getClaudeHome();
        if (!claudeHome) {
            return null;
        }
        const normalizedCandidatePaths = normalizeAiSessionCandidatePaths(Array.from(candidatePaths));
        const matches = this.getSessionFiles(path.join(claudeHome, 'projects'))
            .filter(sessionFile => path.basename(sessionFile) === `${sessionId}.jsonl`)
            .filter(sessionFile => {
                if (!normalizedCandidatePaths.length) {
                    return true;
                }
                const cwd = this.readSessionCwd(sessionFile, sessionId);
                return !!cwd && normalizedCandidatePaths.some(candidatePath => aiSessionPathContains(candidatePath, cwd));
            });
        return matches.length === 1
            ? { providerHome: claudeHome, sourcePath: matches[0] }
            : null;
    }

    getSessions(options: boolean | AiSessionQueryOptions = false): ClaudeSessionReadResult {
        let { forceRefresh, candidatePaths, maxFiles } = resolveAiSessionQueryOptions(options);
        let now = Date.now();
        if (!forceRefresh && this.cachedResult && now - this.cachedAt < this.cacheTtlMs) {
            return this.filterResult(this.cachedResult, candidatePaths);
        }

        let claudeHome = this.getClaudeHome();
        if (!claudeHome) {
            return this.filterResult(this.cacheResult({ available: false, sessions: [], scannedFiles: 0, parsedFiles: 0 }), candidatePaths);
        }

        let projectRoot = path.join(claudeHome, 'projects');
        let scanStats = { discoveredFiles: 0 };
        let sessionFiles = this.getSessionFiles(projectRoot, maxFiles, scanStats);
        if (!sessionFiles.length) {
            return this.filterResult(this.cacheResult({
                available: false,
                sessions: [],
                scannedFiles: scanStats.discoveredFiles,
                parsedFiles: sessionFiles.length,
            }), candidatePaths);
        }

        let sessions = sessionFiles
            .map(sessionFile => this.readSession(sessionFile))
            .filter(session => !!session)
            .sort((a, b) => compareAiSessionUpdatedAt(b.updatedAt, a.updatedAt));

        return this.filterResult(this.cacheResult({
            available: true,
            sessions,
            scannedFiles: scanStats.discoveredFiles,
            parsedFiles: sessionFiles.length,
        }), candidatePaths);
    }

    getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal> {
        let retainedLifecycleKeys = new Set<string>();
        let claudeHome = this.getClaudeHome();
        if (!claudeHome) {
            this.lifecycleReader.retain(retainedLifecycleKeys);
            return {};
        }
        let projectRoot = path.join(claudeHome, 'projects');
        let signals: Record<string, AiSessionLifecycleSignal> = {};
        let discovered = false;
        for (let request of requests || []) {
            if (!request?.sessionId || !Number.isFinite(request.runStartedAtMs)) {
                continue;
            }
            retainedLifecycleKeys.add(request.sessionId);
            if (signals[request.sessionId]) {
                continue;
            }
            let sessionFile = this.sessionFilesById.get(request.sessionId);
            if (sessionFile && !fs.existsSync(sessionFile)) {
                this.sessionFilesById.delete(request.sessionId);
                this.lifecycleReader.delete(request.sessionId);
                sessionFile = null;
            }
            if (!sessionFile && !discovered) {
                this.getSessionFiles(projectRoot);
                discovered = true;
                sessionFile = this.sessionFilesById.get(request.sessionId);
            }
            if (!sessionFile) {
                this.lifecycleReader.delete(request.sessionId);
                continue;
            }
            let mainSignal = this.lifecycleReader.read(
                request.sessionId,
                sessionFile,
                request.runStartedAtMs,
                () => createClaudeLifecycleAccumulator(request.runStartedAtMs)
            );
            let runningSubagents: AiSessionLifecycleSignal[] = [];
            for (let subagentFile of this.getLifecycleSubagentFiles(
                sessionFile,
                request.sessionId
            )) {
                let key = `${request.sessionId}:subagent:${path.basename(
                    subagentFile
                )}`;
                retainedLifecycleKeys.add(key);
                let subagentSignal = this.lifecycleReader.read(
                    key,
                    subagentFile,
                    request.runStartedAtMs,
                    () => createClaudeLifecycleAccumulator(
                        request.runStartedAtMs
                    )
                );
                if (subagentSignal?.executionState === 'running') {
                    runningSubagents.push(subagentSignal);
                }
            }
            let signal = mainSignal;
            if (runningSubagents.length
                && !this.isTerminalMainLifecycleSignal(mainSignal)) {
                let latest = runningSubagents.reduce((current, candidate) =>
                    candidate.occurredAtMs > current.occurredAtMs
                        ? candidate
                        : current
                );
                signal = {
                    token: `claude:subagent-running:${
                        runningSubagents.length
                    }:${latest.occurredAtMs}`,
                    phase: 'running',
                    executionState: 'running',
                    occurredAtMs: latest.occurredAtMs,
                };
            }
            if (signal) {
                signals[request.sessionId] = signal;
            }
        }
        this.lifecycleReader.retain(retainedLifecycleKeys);
        return signals;
    }

    archiveSession(sessionId: string): boolean {
        if (!sessionId || !this.isSessionId(sessionId)) {
            return false;
        }

        let claudeHome = this.getClaudeHome();
        if (!claudeHome) {
            return false;
        }

        let sessionFile = this.findSessionFile(path.join(claudeHome, 'projects'), sessionId);
        if (!sessionFile) {
            return false;
        }

        try {
            let projectDirName = path.basename(path.dirname(sessionFile));
            let archivePath = path.join(claudeHome, 'archived_projects', projectDirName);
            fs.mkdirSync(archivePath, { recursive: true });
            fs.renameSync(sessionFile, getAvailableAiSessionArchivePath(archivePath, path.basename(sessionFile)));
            this.sessionFilesById.delete(sessionId);
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

    private cacheResult(result: ClaudeSessionReadResult): ClaudeSessionReadResult {
        this.cachedResult = result;
        this.cachedAt = Date.now();

        return result;
    }

    private filterResult(result: ClaudeSessionReadResult, candidatePaths: string[]): ClaudeSessionReadResult {
        return filterAiSessionsByCandidatePaths(result, candidatePaths, session => session.workDir || session.cwd);
    }

    private getClaudeHome(): string {
        let configuredHome = process.env.CLAUDE_HOME;
        if (configuredHome && fs.existsSync(configuredHome)) {
            return configuredHome;
        }

        let defaultHome = path.join(os.homedir(), '.claude');
        return fs.existsSync(defaultHome) ? defaultHome : null;
    }

    private getSessionFiles(projectRoot: string, maxFiles = 0, stats?: { discoveredFiles: number }): string[] {
        return this.getSessionFileEntries(projectRoot, maxFiles, stats).map(entry => entry.filePath);
    }

    private getSessionFileEntries(projectRoot: string, maxFiles = 0, stats?: { discoveredFiles: number }): { filePath: string; mtimeMs: number; sizeBytes: number }[] {
        if (!fs.existsSync(projectRoot)) {
            return [];
        }

        let files: string[] = [];
        try {
            for (let projectEntry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
                if (!projectEntry.isDirectory()) {
                    continue;
                }

                let projectPath = path.join(projectRoot, projectEntry.name);
                for (let sessionEntry of fs.readdirSync(projectPath, { withFileTypes: true })) {
                    if (sessionEntry.isFile() && sessionEntry.name.endsWith('.jsonl') && this.isSessionId(sessionEntry.name)) {
                        files.push(path.join(projectPath, sessionEntry.name));
                    }
                }
            }
        } catch (e) {
            return [];
        }

        if (stats) {
            stats.discoveredFiles = files.length;
        }
        // Stat once per file rather than once per comparison: a comparator that
        // reads the filesystem turns an O(n) listing into O(n log n) syscalls, and
        // this runs on every dashboard refresh and every change poll. The change
        // fingerprint reuses the same stats instead of stat'ing every path again.
        let entries = files
            .map(filePath => ({ filePath, ...this.getFileStat(filePath) }))
            .sort((left, right) => right.mtimeMs - left.mtimeMs
                || left.filePath.localeCompare(right.filePath))
            .slice(0, maxFiles || undefined);

        for (let entry of entries) {
            let sessionId = this.getSessionIdFromFileName(path.basename(entry.filePath));
            if (sessionId) {
                this.sessionFilesById.set(sessionId, entry.filePath);
            }
        }

        return entries;
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

    private getFileMtimeMs(filePath: string): number {
        try {
            return fs.statSync(filePath).mtimeMs;
        } catch (e) {
            return 0;
        }
    }

    private getLifecycleSubagentFiles(
        sessionFile: string,
        sessionId: string
    ): string[] {
        let subagentDirectory = path.join(
            path.dirname(sessionFile),
            sessionId,
            'subagents'
        );
        try {
            return fs.readdirSync(
                subagentDirectory,
                { withFileTypes: true }
            ).filter(entry =>
                entry.isFile()
                && /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/.test(entry.name)
            ).map(entry =>
                path.join(subagentDirectory, entry.name)
            ).map(filePath => ({ filePath, mtimeMs: this.getFileMtimeMs(filePath) }))
                .sort((left, right) => right.mtimeMs - left.mtimeMs
                    || left.filePath.localeCompare(right.filePath))
                .slice(0, this.maxLifecycleSubagentFiles)
                .map(entry => entry.filePath);
        } catch (e) {
            return [];
        }
    }

    private isTerminalMainLifecycleSignal(
        signal: AiSessionLifecycleSignal | null
    ): boolean {
        return signal?.reason === 'failed'
            || signal?.reason === 'input-required'
            || Boolean(signal?.token?.startsWith('claude:user_interrupt:'));
    }

    private findSessionFile(projectRoot: string, sessionId: string): string {
        let cached = this.sessionFilesById.get(sessionId);
        if (cached && fs.existsSync(cached)) {
            return cached;
        }
        let fileName = `${sessionId}.jsonl`;
        return this.getSessionFiles(projectRoot).find(filePath => path.basename(filePath) === fileName) || null;
    }

    private readSession(sessionFile: string): CodexSession {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(sessionFile);
            if (stat.size === 0) {
                return null;
            }
        } catch (e) {
            return null;
        }

        let cacheSignature = this.getStatSignature(stat);
        let cached = this.sessionCache.get(sessionFile);
        if (cached?.signature === cacheSignature) {
            return cached.session;
        }

        let sessionId = this.getSessionIdFromFileName(path.basename(sessionFile));
        if (!sessionId) {
            return null;
        }

        let cwd: string = this.readSessionCwd(sessionFile, sessionId);
        let updatedAt: string = new Date(stat.mtimeMs).toISOString();
        let customTitle: string = null;
        let aiTitle: string = null;
        let promptTitle: string = null;

        try {
            let lines = this.readSessionLines(sessionFile, stat);
            for (let line of lines) {
                if (!line.trim()) {
                    continue;
                }

                let event: ClaudeSessionEvent;
                try {
                    event = JSON.parse(line);
                } catch (e) {
                    continue;
                }

                if (event.sessionId && event.sessionId !== sessionId) {
                    continue;
                }
                let eventCwd = this.getEventCwd(event, sessionId);
                if (eventCwd) {
                    cwd = eventCwd;
                }
                if (event.timestamp && !isNaN(Date.parse(event.timestamp))) {
                    updatedAt = event.timestamp;
                }
                if (event.customTitle) {
                    customTitle = event.customTitle;
                }
                if (event.aiTitle) {
                    aiTitle = event.aiTitle;
                }
                if (event.lastPrompt) {
                    promptTitle = event.lastPrompt;
                }

                let messageText = this.getMessageText(event);
                if (messageText) {
                    promptTitle = messageText;
                }
            }
        } catch (e) {
            // Fall back to file metadata if the JSONL cannot be read cleanly.
        }

        let session: CodexSession = {
            id: sessionId,
            name: this.trimTitle(customTitle || aiTitle || promptTitle) || sessionId,
            updatedAt,
            cwd,
            workDir: cwd,
            provider: 'claude',
        };
        this.sessionCache.set(sessionFile, { signature: cacheSignature, session });

        return session;
    }

    private readSessionCwd(sessionFile: string, sessionId: string): string {
        let fd: number = null;
        let carry = '';
        try {
            fd = fs.openSync(sessionFile, 'r');
            let buffer = Buffer.alloc(this.cwdScanChunkBytes);
            let bytesRead = 0;

            do {
                bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
                if (bytesRead <= 0) {
                    break;
                }

                let chunk = carry + buffer.slice(0, bytesRead).toString('utf8');
                let lines = chunk.split(/\r?\n/g);
                carry = lines.pop() || '';

                for (let line of lines) {
                    let cwd = this.readCwdFromJsonLine(line, sessionId);
                    if (cwd) {
                        return cwd;
                    }
                }
            } while (bytesRead === buffer.length);

            return this.readCwdFromJsonLine(carry, sessionId);
        } catch (e) {
            return null;
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (e) {
                    // Ignore close failures for best-effort cwd reads.
                }
            }
        }
    }

    private readCwdFromJsonLine(line: string, sessionId: string): string {
        if (!line.trim()) {
            return null;
        }

        try {
            return this.getEventCwd(JSON.parse(line), sessionId);
        } catch (e) {
            return null;
        }
    }

    private getEventCwd(event: ClaudeSessionEvent, sessionId: string): string {
        if (!event || (event.sessionId && event.sessionId !== sessionId) || !event.cwd) {
            return null;
        }

        return this.normalizePath(event.cwd);
    }

    private readSessionLines(sessionFile: string, stat: fs.Stats): string[] {
        if (stat.size <= this.sessionSampleBytes * 2) {
            return fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/g);
        }

        let fd: number = null;
        try {
            fd = fs.openSync(sessionFile, 'r');
            let firstBuffer = Buffer.alloc(this.sessionSampleBytes);
            let lastBuffer = Buffer.alloc(this.sessionSampleBytes);
            let firstBytes = fs.readSync(fd, firstBuffer, 0, firstBuffer.length, 0);
            let lastOffset = Math.max(stat.size - this.sessionSampleBytes, 0);
            let lastBytes = fs.readSync(fd, lastBuffer, 0, lastBuffer.length, lastOffset);

            return [
                ...firstBuffer.slice(0, firstBytes).toString('utf8').split(/\r?\n/g),
                ...lastBuffer.slice(0, lastBytes).toString('utf8').split(/\r?\n/g),
            ];
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (e) {
                    // Ignore close failures for best-effort session reads.
                }
            }
        }
    }

    private getMessageText(event: ClaudeSessionEvent): string {
        if (event.type !== 'user' || !event.message || event.message.role !== 'user') {
            return null;
        }
        if (event.isMeta
            || event.sourceToolUseID
            || event.sourceToolAssistantUUID
            || event.promptSource === 'system'
            || (event.origin?.kind && event.origin.kind !== 'human')) {
            return null;
        }

        let content = event.message.content;
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            return content
                .filter(part => part?.type === 'text' && !!part.text)
                .map(part => part.text)
                .join(' ');
        }

        return null;
    }

    private trimTitle(value: string): string {
        value = String(value || '').replace(/\s+/g, ' ').trim();
        return value.length > 80 ? `${value.substring(0, 77)}...` : value;
    }

    private getSessionFingerprint(): string {
        let claudeHome = this.getClaudeHome();
        if (!claudeHome) {
            return 'missing';
        }

        let fingerprint = new SessionFingerprint();
        fingerprint.addEntry(claudeHome);
        for (let entry of this.getSessionFileEntries(path.join(claudeHome, 'projects'))) {
            fingerprint.addEntry(`${entry.filePath}:${entry.sizeBytes}:${entry.mtimeMs}`);
        }
        return fingerprint.digest();
    }

    private getStatSignature(stat: fs.Stats): string {
        return `${stat.size}:${stat.mtimeMs}`;
    }

    private getSessionIdFromFileName(fileName: string): string {
        let match = fileName.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return match ? match[0] : null;
    }

    private isSessionId(value: string): boolean {
        return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value || '');
    }

    private normalizePath(value: string): string {
        if (!value) {
            return '';
        }

        return value.replace(/\\/g, '/').replace(/\/+$/g, '');
    }

}
