'use strict';

/* Locate exact first-difference offsets between thread/read and turns/list items. */

const { spawn } = require('node:child_process');

const CODEX_EXECUTABLE = '/usr/bin/codex';
const MEDIUM_THREAD = '019f96d5-d6a5-7482-9f6d-b9f14a38aea4';
const SUSPECT_TURNS = [
    '019f9740-264d-7bd2-bac4-fc8e5eae2c29',
    '019f9791-0f4e-7d33-b8c6-dc7a85ee7907',
];

class RpcClient {
    constructor() {
        this.nextId = 1;
        this.pending = new Map();
        this.buffer = '';
        this.child = spawn(
            CODEX_EXECUTABLE,
            ['app-server', '--listen', 'stdio://'],
            { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        this.child.stderr.on('data', () => undefined);
        this.child.stdout.on('data', chunk => this.accept(chunk));
    }

    accept(chunk) {
        this.buffer += chunk.toString('utf8');
        for (;;) {
            const newline = this.buffer.indexOf('\n');
            if (newline < 0) {
                return;
            }
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (!line.trim()) {
                continue;
            }
            const message = JSON.parse(line);
            if (typeof message.method === 'string' && message.id === undefined) {
                continue;
            }
            const entry = this.pending.get(message.id);
            if (!entry) {
                continue;
            }
            this.pending.delete(message.id);
            if (message.error) {
                const error = new Error(message.error.message);
                error.code = message.error.code;
                entry.reject(error);
            } else {
                entry.resolve(message.result);
            }
        }
    }

    write(message) {
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    async connect() {
        await this.request('initialize', {
            clientInfo: { name: 'agent_pivot_probe', title: 'Probe', version: '0.0.1' },
            capabilities: { experimentalApi: true },
        });
        this.write({ method: 'initialized', params: {} });
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.write({ method, id, params });
        });
    }

    close() {
        try {
            this.child.kill();
        } catch (_error) {
            // best effort
        }
    }
}

function firstDiff(a, b) {
    const limit = Math.min(a.length, b.length);
    for (let index = 0; index < limit; index += 1) {
        if (a[index] !== b[index]) {
            return index;
        }
    }
    return a.length === b.length ? -1 : limit;
}

function context(text, at, radius = 80) {
    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + radius);
    return {
        offset: at,
        codes: Array.from(text.slice(Math.max(0, at - 2), at + 3))
            .map(ch => `U+${ch.codePointAt(0).toString(16).toUpperCase()}`),
        snippet: text.slice(start, end),
    };
}

async function main() {
    const client = new RpcClient();
    await client.connect();

    const read = await client.request('thread/read', {
        threadId: MEDIUM_THREAD,
        includeTurns: true,
    });
    const readTurns = read.thread.turns || [];

    const pagedTurns = [];
    let cursor;
    for (;;) {
        const page = await client.request('thread/turns/list', {
            threadId: MEDIUM_THREAD,
            cursor,
            limit: 10,
            sortDirection: 'asc',
            itemsView: 'full',
        });
        pagedTurns.push(...page.data);
        cursor = page.nextCursor || undefined;
        if (!cursor) {
            break;
        }
    }

    const out = {};
    for (const turnId of SUSPECT_TURNS) {
        const a = (readTurns.find(turn => turn.id === turnId) || {}).items || [];
        const b = (pagedTurns.find(turn => turn.id === turnId) || {}).items || [];
        const diffs = [];
        const max = Math.max(a.length, b.length);
        for (let index = 0; index < max; index += 1) {
            const sa = JSON.stringify(a[index]);
            const sb = JSON.stringify(b[index]);
            if (sa === sb) {
                continue;
            }
            const at = firstDiff(sa, sb);
            diffs.push({
                itemIndex: index,
                itemType: a[index] && a[index].type,
                readLength: sa.length,
                pagedLength: sb.length,
                read: context(sa, at),
                paged: context(sb, at),
            });
        }
        out[turnId] = { differingItems: diffs.length, diffs: diffs.slice(0, 3) };
    }
    console.log(JSON.stringify(out, null, 2));
    client.close();
}

main().catch(error => {
    console.error('probe failed:', error);
    process.exitCode = 1;
}).finally(() => {
    process.exit(process.exitCode || 0);
});
