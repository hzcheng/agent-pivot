'use strict';

import * as os from 'os';
import * as path from 'path';
import { resolveCodexManagedSocket } from '../codexManagedRun';
import type { AiSessionDisposable } from '../types';
import type { SanitizedConversationDiagnostic } from './types';

// ws handles framing, fragmentation, ping/pong and bounded payloads. Never
// launch a daemon or a turn here: this connection only joins loaded threads.
const WebSocket = require('ws');
const MAX_BYTES = 4 * 1024 * 1024;

export interface CodexLiveFeedOptions {
    onDiagnostic?(diagnostic: SanitizedConversationDiagnostic): void;
}

interface Entry {
    listeners: Set<() => void>;
    turns: any[];
    revision: number;
    sessionIdHash?: string;
    socketKind?: 'managed' | 'shared';
    deltas: number;
    /** Item ids seeded from retained text, awaiting a confirming delta. */
    seeded?: Set<string>;
    socket?: any;
    timer?: ReturnType<typeof setTimeout>;
    stopped: boolean;
    bytes: number;
}

function hashSessionId(sessionId: string): string {
    return require('crypto').createHash('sha256')
        .update(sessionId, 'utf8').digest('hex').slice(0, 12);
}

export class CodexLiveFeed implements AiSessionDisposable {
    private readonly entries = new Map<string, Entry>();
    private readonly onDiagnostic?: CodexLiveFeedOptions['onDiagnostic'];
    private readonly resolveSocket: (sessionId: string, entry: Entry) => string;
    // The resume snapshot of a turn already in flight omits its
    // already-started agentMessage item, so the text streamed before a
    // viewer detach (session switch, socket reconnect) would vanish until
    // the next delta or completion. Retain the last in-flight text per
    // (session, turn) and re-seed the item on the next attach.
    private readonly retainedStreams = new Map<string, Map<string, { itemId: string; text: string }>>();
    private disposed = false;
    private revision = 0;

    constructor(
        socketPath: string | ((sessionId: string) => string) | undefined = undefined,
        options: CodexLiveFeedOptions = {}
    ) {
        this.onDiagnostic = options.onDiagnostic;
        if (socketPath === undefined) {
            this.resolveSocket = (sessionId, entry) => {
                const managed = resolveCodexManagedSocket(sessionId);
                entry.socketKind = managed ? 'managed' : 'shared';
                return managed || path.join(
                    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
                    'app-server-control', 'app-server-control.sock'
                );
            };
        } else if (typeof socketPath === 'function') {
            this.resolveSocket = sessionId => socketPath(sessionId);
        } else {
            this.resolveSocket = () => socketPath;
        }
    }

    private report(
        entry: Entry,
        note: string,
        extra: Partial<SanitizedConversationDiagnostic> = {}
    ): void {
        try {
            this.onDiagnostic?.({
                event: 'codex-conversation-live-feed',
                provider: 'codex',
                category: 'unknownSession',
                note,
                sessionIdHash: entry.sessionIdHash,
                ...(entry.socketKind ? { socketKind: entry.socketKind } : {}),
                ...extra,
            });
        } catch (_error) { /* Diagnostics must never break the feed. */ }
    }

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
            entry = { listeners: new Set(), turns: [], revision: 0, stopped: false, bytes: 0,
                deltas: 0, sessionIdHash: hashSessionId(sessionId) };
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
                this.stop(sessionId, owned);
                if (this.entries.get(sessionId) === owned) {
                    this.entries.delete(sessionId);
                }
            }
        } };
    }

    dispose(): void {
        this.disposed = true;
        this.entries.forEach((entry, sessionId) => this.stop(sessionId, entry));
        this.entries.clear();
    }

    private stop(sessionId: string, entry: Entry): void {
        this.retainInflight(sessionId, entry);
        entry.stopped = true;
        clearTimeout(entry.timer);
        entry.socket?.terminate();
        entry.turns = [];
    }

    // Re-seed a freshly snapshotted in-progress turn from text retained at
    // detach: the snapshot omits the already-started agentMessage item, so
    // without this the streamed text vanishes until the next delta lands.
    // Seeded items carry no new content — only what was already streamed —
    // and an item whose id never streams again is dropped at turn end.
    private reseedFromRetained(sessionId: string, entry: Entry): void {
        const retained = this.retainedStreams.get(sessionId);
        if (!retained) { return; }
        for (const turn of entry.turns) {
            if (turn?.status !== 'inProgress' || !Array.isArray(turn.items)) {
                continue;
            }
            if (turn.items.some(item => item?.type === 'agentMessage')) {
                continue;
            }
            const kept = retained.get(turn.id);
            if (kept?.text) {
                turn.items.push({ id: kept.itemId, type: 'agentMessage', text: kept.text });
                if (!entry.seeded) { entry.seeded = new Set(); }
                entry.seeded.add(kept.itemId);
            }
        }
    }

    private retainInflight(sessionId: string, entry: Entry): void {
        const byTurn = new Map<string, { itemId: string; text: string }>();
        for (const turn of entry.turns || []) {
            if (turn?.status !== 'inProgress' || !Array.isArray(turn?.items)) {
                continue;
            }
            for (const item of turn.items) {
                if (item?.type === 'agentMessage' && typeof item.text === 'string'
                    && item.text && !item.completed) {
                    byTurn.set(turn.id, { itemId: item.id, text: item.text });
                }
            }
        }
        if (byTurn.size) {
            this.retainedStreams.set(sessionId, byTurn);
            while (this.retainedStreams.size > 16) {
                const oldest = this.retainedStreams.keys().next().value;
                if (typeof oldest !== 'string') { break; }
                this.retainedStreams.delete(oldest);
            }
        }
    }

    private changed(entry: Entry): void {
        entry.revision = ++this.revision;
        entry.listeners.forEach(callback => callback());
    }

    private connect(sessionId: string, entry: Entry): void {
        if (entry.stopped || this.disposed) { return; }
        const socketPath = this.resolveSocket(sessionId, entry);
        this.report(entry, 'connect');
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
                this.report(entry, 'loaded-list', { threadLoaded: loaded });
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
                    this.reseedFromRetained(sessionId, entry);
                    if ((entry.bytes = JSON.stringify(entry.turns).length) > MAX_BYTES) {
                        retry = false;
                        throw new Error('Live tail exceeds budget');
                    }
                    ready = true;
                    this.report(entry, 'ready', { liveTurns: entry.turns.length });
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
                if (this.accept(sessionId, entry, message.method, message.params)) {
                    if (message.method === 'item/agentMessage/delta') {
                        entry.bytes += message.params.delta.length;
                        entry.deltas += 1;
                        if (entry.deltas === 1) {
                            this.report(entry, 'delta', { count: 1 });
                        }
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
            this.retainInflight(sessionId, entry);
            this.report(entry, 'close', {
                liveTurns: entry.turns.length,
                count: entry.deltas,
            });
            if (entry.turns.length) { entry.turns = []; this.changed(entry); }
            if (retry && !entry.stopped && !this.disposed) {
                entry.timer = setTimeout(() => this.connect(sessionId, entry), 3000);
                entry.timer.unref?.();
            }
        });
    }

    private accept(sessionId: string, entry: Entry, method: string, params: any): boolean {
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
            // A seeded item that never streamed again carried only what was
            // already visible; the turn is over, so it must not linger.
            if (entry.seeded?.size) {
                turn.items = turn.items.filter(item => !entry.seeded?.has(item?.id));
                entry.seeded.clear();
            }
            this.retainedStreams.get(sessionId)?.delete(turnId);
            return true;
        }
        if (method === 'item/started' || method === 'item/completed') {
            const item = params.item;
            if (!item || typeof item.id !== 'string') { return false; }
            const index = turn.items.findIndex(value => value.id === item.id);
            if (method === 'item/completed') { item.completed = true; }
            if (index < 0) { turn.items.push(item); } else { turn.items[index] = item; }
            entry.seeded?.delete(item.id);
            return true;
        }
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
            let item = turn.items.find(value => value.id === params.itemId);
            if (!item && typeof params.itemId === 'string' && params.itemId) {
                // A client that attached mid-turn gets a snapshot without the
                // already-started agentMessage item, but its deltas carry the
                // item's real id. The method scope proves the item type, so
                // synthesize the item instead of dropping the delta — the
                // completed item still replaces it wholesale at completion.
                // Attach-time seeding keeps the text streamed before a
                // detach; the retained prefix belongs to this exact item id.
                const kept = this.retainedStreams.get(sessionId)?.get(turnId);
                item = { id: params.itemId, type: 'agentMessage',
                    text: kept?.itemId === params.itemId ? kept.text : '' };
                turn.items.push(item);
            }
            if (item?.type !== 'agentMessage') { return false; }
            item.text = (item.text || '') + params.delta;
            entry.seeded?.delete(params.itemId);
            return true;
        }
        return false;
    }
}
