'use strict';

import * as os from 'os';
import * as path from 'path';
import { resolveCodexManagedSocket } from '../codexManagedRun';
import type { AiSessionDisposable } from '../types';

// ws handles framing, fragmentation, ping/pong and bounded payloads. Never
// launch a daemon or a turn here: this connection only joins loaded threads.
const WebSocket = require('ws');
const MAX_BYTES = 4 * 1024 * 1024;

interface Entry {
    listeners: Set<() => void>;
    turns: any[];
    revision: number;
    socket?: any;
    timer?: ReturnType<typeof setTimeout>;
    stopped: boolean;
    bytes: number;
}

export class CodexLiveFeed implements AiSessionDisposable {
    private readonly entries = new Map<string, Entry>();
    private disposed = false;
    private revision = 0;

    constructor(private readonly socketPath: string | ((sessionId: string) => string) = sessionId => resolveCodexManagedSocket(sessionId) || path.join(
        process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
        'app-server-control', 'app-server-control.sock'
    )) {}

    read(sessionId: string): { turns: unknown[]; revision: number } | undefined {
        const entry = this.entries.get(sessionId);
        return entry?.turns.length
            ? { turns: entry.turns, revision: entry.revision }
            : undefined;
    }

    watch(sessionId: string, callback: () => void): AiSessionDisposable {
        if (this.disposed || !sessionId || sessionId.length > 256
            || process.platform === 'win32') {
            return { dispose() {} };
        }
        let entry = this.entries.get(sessionId);
        if (!entry) {
            if (this.entries.size >= 8) { return { dispose() {} }; }
            entry = { listeners: new Set(), turns: [], revision: 0, stopped: false, bytes: 0 };
            this.entries.set(sessionId, entry);
            this.connect(sessionId, entry);
        }
        entry.listeners.add(callback);
        const owned = entry;
        let active = true;
        return { dispose: () => {
            if (!active) { return; }
            active = false;
            owned.listeners.delete(callback);
            if (!owned.listeners.size) {
                this.stop(owned);
                if (this.entries.get(sessionId) === owned) {
                    this.entries.delete(sessionId);
                }
            }
        } };
    }

    dispose(): void {
        this.disposed = true;
        this.entries.forEach(entry => this.stop(entry));
        this.entries.clear();
    }

    private stop(entry: Entry): void {
        entry.stopped = true;
        clearTimeout(entry.timer);
        entry.socket?.terminate();
        entry.turns = [];
    }

    private changed(entry: Entry): void {
        entry.revision = ++this.revision;
        entry.listeners.forEach(callback => callback());
    }

    private connect(sessionId: string, entry: Entry): void {
        if (entry.stopped || this.disposed) { return; }
        const socketPath = typeof this.socketPath === 'function' ? this.socketPath(sessionId) : this.socketPath;
        const socket = new WebSocket(`ws+unix://${socketPath}:/`, {
            maxPayload: 64 * 1024 * 1024,
            handshakeTimeout: 3000,
            perMessageDeflate: false,
        });
        entry.socket = socket;
        let initialized = false;
        let ready = false;
        let retry = true;
        let requestId = 0;
        const pending = new Map<number, {
            resolve(value: any): void; reject(): void;
            timer: ReturnType<typeof setTimeout>;
            accept?(value: any): void;
        }>();
        const request = (method: string, params: unknown, accept?: (value: any) => void): Promise<any> =>
            new Promise((resolve, reject) => {
                const id = ++requestId;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error('Live conversation request timed out'));
                    socket.terminate();
                }, 5000);
                pending.set(id, { resolve, reject, timer, accept });
                socket.send(JSON.stringify({ id, method, params }));
            });
        socket.on('open', () => {
            void (async () => {
                await request('initialize', {
                    clientInfo: { name: 'agent_pivot_live_view', version: '1.0' },
                    capabilities: { experimentalApi: true },
                });
                initialized = true;
                socket.send(JSON.stringify({ method: 'initialized' }));
                // Do not resume historical/inactive sessions just to view them.
                let cursor: string | undefined;
                let loaded = false;
                for (let page = 0; page < 10 && !loaded; page++) {
                    const result = await request('thread/loaded/list', { limit: 100, cursor });
                    loaded = Array.isArray(result.data) && result.data.includes(sessionId);
                    cursor = result.nextCursor;
                    if (!cursor) { break; }
                }
                if (!loaded || entry.stopped) { socket.close(); return; }
                await request('thread/resume', {
                    threadId: sessionId,
                }, result => {
                    // Install the snapshot synchronously in the response handler:
                    // ws can emit the following delta before this promise resumes.
                    const turns = result.thread?.turns;
                    if (!Array.isArray(turns)) {
                        retry = false;
                        throw new Error('Missing live turns');
                    }
                    entry.turns = turns.slice(-2);
                    if ((entry.bytes = JSON.stringify(entry.turns).length) > MAX_BYTES) {
                        retry = false;
                        throw new Error('Live tail exceeds budget');
                    }
                    ready = true;
                    this.changed(entry);
                });
            })().catch(() => socket.terminate());
        });
        socket.on('message', (data: Buffer) => {
            try {
                const message = JSON.parse(data.toString());
                const wait = pending.get(message.id);
                if (wait && !message.method) {
                    pending.delete(message.id);
                    clearTimeout(wait.timer);
                    if (message.error) {
                        wait.reject();
                    } else {
                        try { wait.accept?.(message.result); wait.resolve(message.result); }
                        catch (_error) { wait.reject(); socket.terminate(); }
                    }
                    return;
                }
                // Approval requests remain owned by the existing terminal client.
                if (!initialized || !ready || message.id !== undefined
                    || message.params?.threadId !== sessionId) { return; }
                if (this.accept(entry, message.method, message.params)) {
                    if (message.method === 'item/agentMessage/delta') {
                        entry.bytes += message.params.delta.length;
                    } else {
                        entry.bytes = JSON.stringify(entry.turns).length;
                    }
                    if (entry.bytes > MAX_BYTES) {
                        retry = false;
                        socket.terminate();
                    } else {
                        this.changed(entry);
                    }
                }
            } catch (_error) { socket.terminate(); }
        });
        socket.on('error', (error: { code?: string }) => {
            if (error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') { retry = false; }
            socket.terminate();
        });
        socket.on('close', () => {
            pending.forEach(wait => { clearTimeout(wait.timer); wait.reject(); });
            pending.clear();
            if (entry.socket !== socket) { return; }
            entry.socket = undefined;
            if (entry.turns.length) { entry.turns = []; this.changed(entry); }
            if (retry && !entry.stopped && !this.disposed) {
                entry.timer = setTimeout(() => this.connect(sessionId, entry), 3000);
                entry.timer.unref?.();
            }
        });
    }

    private accept(entry: Entry, method: string, params: any): boolean {
        if (method === 'turn/started') {
            const turn = params.turn;
            if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items)) { return false; }
            entry.turns = entry.turns.filter(value => value.id !== turn.id).concat(turn).slice(-2);
            return true;
        }
        const turnId = params.turnId || params.turn?.id;
        const turn = entry.turns.find(value => value.id === turnId);
        if (!turn) { return false; }
        if (method === 'turn/completed') {
            turn.status = params.turn.status;
            return true;
        }
        if (method === 'item/started' || method === 'item/completed') {
            const item = params.item;
            if (!item || typeof item.id !== 'string') { return false; }
            const index = turn.items.findIndex(value => value.id === item.id);
            if (index < 0) { turn.items.push(item); } else { turn.items[index] = item; }
            return true;
        }
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
            const item = turn.items.find(value => value.id === params.itemId);
            if (item?.type !== 'agentMessage') { return false; }
            item.text = (item.text || '') + params.delta;
            return true;
        }
        return false;
    }
}
