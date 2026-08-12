'use strict';

import type { AiSessionDisposable } from '../types';
import {
    CONVERSATION_LIMITS,
    ConversationAbortError,
    ConversationAbortSignal,
    ConversationError,
    SanitizedConversationDiagnostic,
} from './types';

type TimerHandle = unknown;

interface CodexReadableStream {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

interface CodexWritableStream {
    readonly writable: boolean;
    write(bytes: Buffer): boolean;
    on(event: 'error', listener: (error: Error) => void): unknown;
    once(event: 'drain', listener: () => void): unknown;
    once(event: 'error', listener: (error: Error) => void): unknown;
    removeListener(event: 'drain', listener: () => void): unknown;
    removeListener(event: 'error', listener: (error: Error) => void): unknown;
}

export interface CodexAppServerChild {
    readonly stdin: CodexWritableStream;
    readonly stdout: CodexReadableStream;
    readonly stderr: CodexReadableStream;
    on(event: 'spawn', listener: () => void): unknown;
    on(
        event: 'exit',
        listener: (code: number | null, signal: string | null) => void
    ): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    removeListener(event: 'spawn', listener: () => void): unknown;
    removeListener(
        event: 'exit',
        listener: (code: number | null, signal: string | null) => void
    ): unknown;
    removeListener(event: 'error', listener: (error: Error) => void): unknown;
    kill(): boolean;
}

export interface CodexAppServerClientOptions {
    // Opts the handshake into experimental app-server methods (for example
    // thread/turns/list). Callers must treat those methods as accelerators
    // with a stable fallback: the server may reject or change them at any
    // version boundary.
    experimentalApi?: boolean;
    spawn(
        executable: string,
        args: string[],
        options: {
            shell: false;
            windowsHide: true;
            stdio: ['pipe', 'pipe', 'pipe'];
        }
    ): CodexAppServerChild;
    resolveExecutable(commandName: 'codex'): string | null;
    now(): number;
    setTimeout(callback: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
    onDiagnostic(diagnostic: SanitizedConversationDiagnostic): void;
}

interface PendingRequest {
    method: string;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeoutHandle?: TimerHandle;
    abortSubscription?: AiSessionDisposable;
}

interface RestartDelay {
    handle?: TimerHandle;
    reject(error: Error): void;
}

const RESTART_WINDOW_MS = 60_000;
const RESTART_DELAYS_MS = [1_000, 4_000] as const;
const INITIALIZE_CLIENT_INFO = Object.freeze({
    name: 'project_steward',
    title: 'Agent Pivot',
    version: '2.1.6',
});

function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined;
}

function protocolError(): ConversationError {
    return new ConversationError(
        'unsupportedVersion',
        'unsupportedCodexProtocol'
    );
}

function sanitizedMajorMinor(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const match = /^(\d{1,6})\.(\d{1,6})(?:\.|$)/.exec(value.trim());
    return match ? `${match[1]}.${match[2]}` : undefined;
}

// Newer app-servers (0.147+) answer initialize without `serverInfo`; the
// server version then rides in the userAgent product token, built as
// `<originator>/<major.minor.patch> (<os> ...) <terminal> (<client>; …)`.
// The parse is deliberately tolerant: the version only gates optional
// accelerators, so an unrecognizable userAgent simply leaves them off.
function sanitizedUserAgentVersion(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const match = /^[^/\s]+\/(\d{1,6})\.(\d{1,6})(?:\.|\s|$)/.exec(
        value.trim()
    );
    return match ? `${match[1]}.${match[2]}` : undefined;
}

export class CodexAppServerClient implements AiSessionDisposable {
    private child?: CodexAppServerChild;
    private connecting?: Promise<void>;
    private initialized = false;
    private disposed = false;
    private nextRequestId = CONVERSATION_LIMITS.minRequestId;
    private stdoutChunks: Buffer[] = [];
    private stdoutBytes = 0;
    private readonly pending = new Map<number, PendingRequest>();
    private writeTail: Promise<void> = Promise.resolve();
    private cancelActiveWrite?: (error: Error) => void;
    private restartRequired = false;
    private restartAttempts: number[] = [];
    private restartDelay?: RestartDelay;
    private serverVersion?: string;
    private childSpawned = false;
    private readonly notificationListeners = new Set<
        (method: string, params: unknown) => void
    >();

    private readonly onStdoutData = (chunk: Buffer): void => {
        this.acceptStdoutChunk(chunk);
    }
    private readonly onStderrData = (_chunk: Buffer): void => undefined;
    private readonly onStdinError = (_error: Error): void => {
        if (!this.child) {
            return;
        }
        this.report('exit');
        this.releaseChild(
            this.child,
            new ConversationError('unavailable', 'reconnectingCodex'),
            true
        );
    }
    private readonly onChildSpawn = (): void => {
        if (this.child) {
            this.childSpawned = true;
        }
    }
    private readonly onChildExit = (
        _code: number | null,
        _signal: string | null
    ): void => {
        if (!this.child) {
            return;
        }
        this.report('exit');
        this.releaseChild(
            this.child,
            new ConversationError('unavailable', 'reconnectingCodex'),
            false
        );
    }
    private readonly onChildError = (_error: Error): void => {
        if (!this.child) {
            return;
        }
        const spawnFailure = !this.childSpawned;
        this.report(spawnFailure ? 'spawn' : 'exit');
        this.releaseChild(
            this.child,
            new ConversationError(
                'unavailable',
                spawnFailure ? 'updateCodex' : 'reconnectingCodex'
            ),
            true,
            !spawnFailure
        );
    }

    constructor(private readonly options: CodexAppServerClientOptions) {}

    /**
     * Sanitized `major.minor` reported by the server at initialize time,
     * or undefined until the handshake completes. Lets callers gate
     * version-sensitive protocol features.
     */
    getServerVersion(): string | undefined {
        return this.serverVersion;
    }

    /**
     * Resolves once the initialize handshake has completed and returns the
     * sanitized server version (undefined when the server reports none).
     * Shares the same in-flight handshake as request(): concurrent callers
     * attach to one connection attempt, and a caller's abort cancels only
     * its own wait, never the shared handshake.
     */
    async ensureReady(
        signal?: ConversationAbortSignal
    ): Promise<string | undefined> {
        if (this.disposed) {
            throw new ConversationError('unavailable', 'reconnectingCodex');
        }
        if (signal?.aborted) {
            throw new ConversationAbortError();
        }
        await this.waitForConnection(this.ensureConnection(), signal);
        if (signal?.aborted) {
            throw new ConversationAbortError();
        }
        return this.serverVersion;
    }

    private initializeParams(): Record<string, unknown> {
        if (!this.options.experimentalApi) {
            return { clientInfo: INITIALIZE_CLIENT_INFO };
        }
        return {
            clientInfo: INITIALIZE_CLIENT_INFO,
            capabilities: { experimentalApi: true },
        };
    }

    async request<T = unknown>(
        method: string,
        params: unknown,
        signal?: ConversationAbortSignal
    ): Promise<T> {
        if (this.disposed) {
            throw new ConversationError('unavailable', 'reconnectingCodex');
        }
        if (signal?.aborted) {
            throw new ConversationAbortError();
        }
        await this.waitForConnection(this.ensureConnection(), signal);
        if (signal?.aborted) {
            throw new ConversationAbortError();
        }
        return this.sendRequest(method, params, signal) as Promise<T>;
    }

    watchNotifications(
        listener: (method: string, params: unknown) => void
    ): AiSessionDisposable {
        if (this.disposed) {
            return { dispose() {} };
        }
        this.notificationListeners.add(listener);
        return {
            dispose: () => {
                this.notificationListeners.delete(listener);
            },
        };
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.restartDelay) {
            const delay = this.restartDelay;
            this.restartDelay = undefined;
            if (delay.handle !== undefined) {
                this.options.clearTimeout(delay.handle);
            }
            delay.reject(
                new ConversationError('unavailable', 'reconnectingCodex')
            );
        }
        if (this.child) {
            this.releaseChild(
                this.child,
                new ConversationError('unavailable', 'reconnectingCodex'),
                true,
                false
            );
        } else {
            this.rejectAllPending(
                new ConversationError('unavailable', 'reconnectingCodex')
            );
        }
        this.connecting = undefined;
        this.restartAttempts = [];
        this.resetStdoutBuffer();
        this.notificationListeners.clear();
    }

    private async ensureConnection(): Promise<void> {
        if (this.initialized && this.child) {
            return;
        }
        if (!this.connecting) {
            const connecting = this.openConnection();
            this.connecting = connecting;
            connecting.then(
                () => {
                    if (this.connecting === connecting) {
                        this.connecting = undefined;
                    }
                },
                () => {
                    if (this.connecting === connecting) {
                        this.connecting = undefined;
                    }
                }
            );
        }
        return this.connecting;
    }

    private waitForConnection(
        connection: Promise<void>,
        signal?: ConversationAbortSignal
    ): Promise<void> {
        if (!signal) {
            return connection;
        }
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let subscription: AiSessionDisposable | undefined;
            const finish = (
                callback: (value?: any) => void,
                value?: unknown
            ): void => {
                if (settled) {
                    return;
                }
                settled = true;
                subscription?.dispose();
                callback(value);
            };
            subscription = signal.onAbort(() => {
                finish(reject, new ConversationAbortError());
            });
            if (settled) {
                subscription.dispose();
            }
            connection.then(
                () => finish(resolve),
                error => finish(reject, error)
            );
        });
    }

    private async openConnection(): Promise<void> {
        if (this.disposed) {
            throw new ConversationError('unavailable', 'reconnectingCodex');
        }
        if (this.restartRequired) {
            await this.waitForRestartBudget();
        }
        if (this.disposed) {
            throw new ConversationError('unavailable', 'reconnectingCodex');
        }
        const executable = this.options.resolveExecutable('codex');
        if (!executable) {
            throw new ConversationError('unavailable', 'updateCodex');
        }
        let child: CodexAppServerChild;
        try {
            child = this.options.spawn(
                executable,
                ['app-server', '--listen', 'stdio://'],
                {
                    shell: false,
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                }
            );
        } catch (_error) {
            this.report('spawn');
            throw new ConversationError('unavailable', 'updateCodex');
        }
        if (!child?.stdin || !child.stdout || !child.stderr) {
            this.report('spawn');
            try {
                child?.kill();
            } catch (_error) {
                // The public failure remains sanitized.
            }
            throw new ConversationError('unavailable', 'updateCodex');
        }
        this.child = child;
        this.childSpawned = false;
        this.initialized = false;
        this.resetStdoutBuffer();
        child.stdin.on('error', this.onStdinError);
        child.stdout.on('data', this.onStdoutData);
        child.stderr.on('data', this.onStderrData);
        child.on('spawn', this.onChildSpawn);
        child.on('exit', this.onChildExit);
        child.on('error', this.onChildError);

        let result: unknown;
        try {
            result = await this.sendRequest(
                'initialize',
                this.initializeParams()
            );
        } catch (error) {
            if (this.child === child) {
                this.releaseChild(
                    child,
                    error instanceof ConversationError
                        ? error
                        : protocolError(),
                    true
                );
            }
            throw error;
        }
        const initializeResult = asRecord(result);
        if (!initializeResult) {
            const error = protocolError();
            this.report('protocol');
            this.releaseChild(child, error, true);
            throw error;
        }
        const serverInfo = initializeResult.serverInfo === undefined
            ? undefined
            : asRecord(initializeResult.serverInfo);
        if (initializeResult.serverInfo !== undefined
            && (!serverInfo
                || (serverInfo.name !== undefined
                    && typeof serverInfo.name !== 'string')
                || (serverInfo.version !== undefined
                    && typeof serverInfo.version !== 'string'))) {
            const error = protocolError();
            this.report('protocol');
            this.releaseChild(child, error, true);
            throw error;
        }
        this.serverVersion = sanitizedMajorMinor(serverInfo?.version)
            ?? sanitizedUserAgentVersion(initializeResult.userAgent);
        try {
            await this.enqueueWrite({ method: 'initialized', params: {} }, child);
        } catch (_error) {
            const error = new ConversationError(
                'unavailable',
                'reconnectingCodex'
            );
            if (this.child === child) {
                this.releaseChild(child, error, true);
            }
            throw error;
        }
        if (this.child !== child) {
            throw new ConversationError('unavailable', 'reconnectingCodex');
        }
        this.initialized = true;
        this.restartRequired = false;
    }

    private waitForRestartBudget(): Promise<void> {
        const now = this.options.now();
        const cutoff = now - RESTART_WINDOW_MS;
        this.restartAttempts = this.restartAttempts.filter(
            attemptedAt => attemptedAt > cutoff
        );
        if (this.restartAttempts.length >= RESTART_DELAYS_MS.length) {
            const retryAfterMs = Math.max(
                1,
                this.restartAttempts[0] + RESTART_WINDOW_MS - now
            );
            throw new ConversationError(
                'unavailable',
                'codexRetryExhausted',
                retryAfterMs
            );
        }
        const delayMs = RESTART_DELAYS_MS[this.restartAttempts.length];
        this.restartAttempts.push(now);
        return new Promise<void>((resolve, reject) => {
            const delay: RestartDelay = { reject };
            let settledSynchronously = false;
            const finish = (): void => {
                settledSynchronously = true;
                if (this.restartDelay === delay) {
                    this.restartDelay = undefined;
                }
                resolve();
            };
            const handle = this.options.setTimeout(finish, delayMs);
            if (!settledSynchronously) {
                delay.handle = handle;
                this.restartDelay = delay;
            }
        });
    }

    private sendRequest(
        method: string,
        params: unknown,
        signal?: ConversationAbortSignal
    ): Promise<unknown> {
        const child = this.child;
        if (!child) {
            return Promise.reject(
                new ConversationError('unavailable', 'reconnectingCodex')
            );
        }
        const id = this.nextRequestId++;
        const response = new Promise<unknown>((resolve, reject) => {
            const pending: PendingRequest = {
                method,
                resolve,
                reject,
            };
            this.pending.set(id, pending);
            let timeoutFiredSynchronously = false;
            const timeoutHandle = this.options.setTimeout(() => {
                timeoutFiredSynchronously = true;
                if (!this.pending.has(id)) {
                    return;
                }
                const error = new ConversationError('timeout');
                this.report('timeout');
                this.releaseChild(child, error, true);
            }, CONVERSATION_LIMITS.codexRequestTimeoutMs);
            if (!timeoutFiredSynchronously && this.pending.has(id)) {
                pending.timeoutHandle = timeoutHandle;
            } else {
                this.options.clearTimeout(timeoutHandle);
            }
            if (signal && this.pending.has(id)) {
                pending.abortSubscription = signal.onAbort(() => {
                    this.rejectPending(id, new ConversationAbortError());
                });
            }
        });
        void this.enqueueWrite({ method, id, params }, child).catch(() => {
            if (this.child !== child || !this.pending.has(id)) {
                return;
            }
            this.releaseChild(
                child,
                new ConversationError('unavailable', 'reconnectingCodex'),
                true
            );
        });
        return response;
    }

    private enqueueWrite(
        message: unknown,
        child: CodexAppServerChild
    ): Promise<void> {
        const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
        const write = (): Promise<void> => new Promise((resolve, reject) => {
            if (this.child !== child || !child.stdin.writable) {
                reject(
                    new ConversationError('unavailable', 'reconnectingCodex')
                );
                return;
            }
            let settled = false;
            const cleanup = (): void => {
                child.stdin.removeListener('drain', onDrain);
                child.stdin.removeListener('error', onError);
                if (this.cancelActiveWrite === cancel) {
                    this.cancelActiveWrite = undefined;
                }
            };
            const finish = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve();
            };
            const fail = (error: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(error);
            };
            const onDrain = (): void => finish();
            const onError = (_error: Error): void => fail(
                new ConversationError('unavailable', 'reconnectingCodex')
            );
            const cancel = (error: Error): void => fail(error);
            this.cancelActiveWrite = cancel;
            let accepted: boolean;
            try {
                accepted = child.stdin.write(bytes);
            } catch (_error) {
                fail(
                    new ConversationError('unavailable', 'reconnectingCodex')
                );
                return;
            }
            if (accepted) {
                finish();
                return;
            }
            child.stdin.once('drain', onDrain);
            child.stdin.once('error', onError);
        });
        const queued = this.writeTail.then(write, write);
        this.writeTail = queued.catch(() => undefined);
        return queued;
    }

    private acceptStdoutChunk(chunk: Buffer): void {
        if (!Buffer.isBuffer(chunk)) {
            const error = protocolError();
            this.report('protocol');
            if (this.child) {
                this.releaseChild(this.child, error, true);
            }
            return;
        }
        let offset = 0;
        while (offset < chunk.length) {
            const newline = chunk.indexOf(0x0a, offset);
            if (newline < 0) {
                const remainder = chunk.subarray(offset);
                if (this.stdoutBytes + remainder.length
                    > CONVERSATION_LIMITS.maxCodexResponseBytes) {
                    this.failOversizedResponse();
                    return;
                }
                if (remainder.length > 0) {
                    this.stdoutChunks.push(remainder);
                    this.stdoutBytes += remainder.length;
                }
                return;
            }
            const segment = chunk.subarray(offset, newline);
            const lineBytes = this.stdoutBytes + segment.length;
            if (lineBytes > CONVERSATION_LIMITS.maxCodexResponseBytes) {
                this.failOversizedResponse();
                return;
            }
            let line: Buffer;
            if (this.stdoutChunks.length === 0) {
                line = segment;
            } else {
                if (segment.length > 0) {
                    this.stdoutChunks.push(segment);
                }
                line = Buffer.concat(this.stdoutChunks, lineBytes);
            }
            this.resetStdoutBuffer();
            if (line.length > 0 && line[line.length - 1] === 0x0d) {
                line = line.subarray(0, line.length - 1);
            }
            let response: unknown;
            try {
                response = JSON.parse(line.toString('utf8'));
            } catch (_error) {
                const error = protocolError();
                this.report('protocol');
                if (this.child) {
                    this.releaseChild(this.child, error, true);
                }
                return;
            }
            if (!this.acceptResponse(response)) {
                return;
            }
            offset = newline + 1;
        }
    }

    private resetStdoutBuffer(): void {
        this.stdoutChunks = [];
        this.stdoutBytes = 0;
    }

    private failOversizedResponse(): void {
        const error = new ConversationError('tooLarge');
        this.report('oversized');
        if (this.child) {
            this.releaseChild(this.child, error, true);
        } else {
            this.resetStdoutBuffer();
        }
    }

    private acceptResponse(value: unknown): boolean {
        const response = asRecord(value);
        if (!response) {
            return this.failProtocol();
        }
        if (typeof response.method === 'string') {
            this.notificationListeners.forEach(listener => {
                try {
                    listener(response.method, response.params);
                } catch (_error) {
                    // Notification consumers cannot affect the transport.
                }
            });
            return true;
        }
        if (!Number.isSafeInteger(response.id)
            || response.id < CONVERSATION_LIMITS.minRequestId) {
            return this.failProtocol();
        }
        const pending = this.pending.get(response.id);
        if (!pending) {
            return true;
        }
        const hasResult = Object.prototype.hasOwnProperty.call(
            response,
            'result'
        );
        const hasError = Object.prototype.hasOwnProperty.call(
            response,
            'error'
        );
        if (hasResult === hasError) {
            return this.failProtocol();
        }
        if (hasResult) {
            this.resolvePending(response.id, response.result);
            return true;
        }
        const remoteError = asRecord(response.error);
        if (!remoteError || typeof remoteError.code !== 'number') {
            return this.failProtocol();
        }
        if (pending.method === 'thread/read' && remoteError.code === -32601) {
            this.rejectPending(
                response.id,
                new ConversationError('unavailable', 'updateCodex')
            );
            return true;
        }
        this.report('protocol');
        this.rejectPending(response.id, protocolError());
        return true;
    }

    private failProtocol(): false {
        const error = protocolError();
        this.report('protocol');
        if (this.child) {
            this.releaseChild(this.child, error, true);
        }
        return false;
    }

    private resolvePending(id: number, value: unknown): void {
        const pending = this.takePending(id);
        pending?.resolve(value);
    }

    private rejectPending(id: number, error: Error): void {
        const pending = this.takePending(id);
        pending?.reject(error);
    }

    private takePending(id: number): PendingRequest | undefined {
        const pending = this.pending.get(id);
        if (!pending) {
            return undefined;
        }
        this.pending.delete(id);
        if (pending.timeoutHandle !== undefined) {
            this.options.clearTimeout(pending.timeoutHandle);
        }
        pending.abortSubscription?.dispose();
        return pending;
    }

    private rejectAllPending(error: Error): void {
        Array.from(this.pending.keys()).forEach(id => {
            this.rejectPending(id, error);
        });
    }

    private releaseChild(
        child: CodexAppServerChild,
        error: Error,
        kill: boolean,
        allowRestart = true
    ): void {
        if (this.child !== child) {
            return;
        }
        child.stdout.removeListener('data', this.onStdoutData);
        child.stderr.removeListener('data', this.onStderrData);
        child.stdin.removeListener('error', this.onStdinError);
        child.removeListener('spawn', this.onChildSpawn);
        child.removeListener('exit', this.onChildExit);
        child.removeListener('error', this.onChildError);
        this.child = undefined;
        this.childSpawned = false;
        this.initialized = false;
        this.resetStdoutBuffer();
        this.serverVersion = undefined;
        if (allowRestart) {
            this.restartRequired = true;
        }
        this.cancelActiveWrite?.(error);
        this.cancelActiveWrite = undefined;
        this.rejectAllPending(error);
        if (kill) {
            try {
                child.kill();
            } catch (_error) {
                // The public failure remains sanitized.
            }
        }
    }

    private report(
        category: 'spawn' | 'timeout' | 'protocol' | 'oversized' | 'exit'
    ): void {
        const diagnostic: SanitizedConversationDiagnostic = {
            event: 'codex-conversation-app-server',
            provider: 'codex',
            category,
        };
        if (this.serverVersion) {
            diagnostic.version = this.serverVersion;
        }
        try {
            this.options.onDiagnostic(diagnostic);
        } catch (_error) {
            // Diagnostics must not affect the private protocol lifecycle.
        }
    }
}
