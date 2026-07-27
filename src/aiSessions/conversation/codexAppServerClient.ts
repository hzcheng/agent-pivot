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
const INITIALIZE_PARAMS = Object.freeze({
    clientInfo: Object.freeze({
        name: 'project_steward',
        title: 'Agent Pivot',
        version: '2.1.6',
    }),
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

export class CodexAppServerClient implements AiSessionDisposable {
    private child?: CodexAppServerChild;
    private connecting?: Promise<void>;
    private initialized = false;
    private disposed = false;
    private nextRequestId = CONVERSATION_LIMITS.minRequestId;
    private stdoutRemainder = Buffer.alloc(0);
    private readonly pending = new Map<number, PendingRequest>();
    private writeTail: Promise<void> = Promise.resolve();
    private cancelActiveWrite?: (error: Error) => void;
    private restartRequired = false;
    private restartAttempts: number[] = [];
    private restartDelay?: RestartDelay;
    private serverVersion?: string;
    private childSpawned = false;

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
        this.stdoutRemainder = Buffer.alloc(0);
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
        this.stdoutRemainder = Buffer.alloc(0);
        child.stdin.on('error', this.onStdinError);
        child.stdout.on('data', this.onStdoutData);
        child.stderr.on('data', this.onStderrData);
        child.on('spawn', this.onChildSpawn);
        child.on('exit', this.onChildExit);
        child.on('error', this.onChildError);

        let result: unknown;
        try {
            result = await this.sendRequest('initialize', INITIALIZE_PARAMS);
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
        this.serverVersion = sanitizedMajorMinor(serverInfo?.version);
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
        this.stdoutRemainder = Buffer.concat([this.stdoutRemainder, chunk]);
        let newline = this.stdoutRemainder.indexOf(0x0a);
        while (newline >= 0) {
            if (newline > CONVERSATION_LIMITS.maxCodexResponseBytes) {
                const error = new ConversationError('tooLarge');
                this.report('oversized');
                if (this.child) {
                    this.releaseChild(this.child, error, true);
                }
                return;
            }
            let line = this.stdoutRemainder.subarray(0, newline);
            this.stdoutRemainder = this.stdoutRemainder.subarray(newline + 1);
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
            newline = this.stdoutRemainder.indexOf(0x0a);
        }
        if (this.stdoutRemainder.length
            > CONVERSATION_LIMITS.maxCodexResponseBytes) {
            const error = new ConversationError('tooLarge');
            this.report('oversized');
            if (this.child) {
                this.releaseChild(this.child, error, true);
            }
        }
    }

    private acceptResponse(value: unknown): boolean {
        const response = asRecord(value);
        if (!response) {
            return this.failProtocol();
        }
        if (typeof response.method === 'string') {
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
        this.stdoutRemainder = Buffer.alloc(0);
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
