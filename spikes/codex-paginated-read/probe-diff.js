'use strict';

/* Diff the two mismatching turns between thread/read and thread/turns/list. */

const { spawn } = require('node:child_process');

const CODEX_EXECUTABLE = '/usr/bin/codex';
const MEDIUM_THREAD = '019f96d5-d6a5-7482-9f6d-b9f14a38aea4';
const SUSPECT_TURNS = [
    '019f9740-264d-7bd2-bac4-fc8e5eae2c29',
    '019f9791-0f4e-7d33-b8c6-dc7a85ee7907',
];

function canonical(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

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

function itemTypes(items) {
    return (items || []).map(item => item && item.type);
}

function truncate(text, max = 600) {
    return text.length > max ? `${text.slice(0, max)}…[${text.length} chars]` : text;
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
        const a = readTurns.find(turn => turn.id === turnId);
        const b = pagedTurns.find(turn => turn.id === turnId);
        const entry = {
            readStatus: a && a.status,
            pagedStatus: b && b.status,
            readItemTypes: a && itemTypes(a.items),
            pagedItemTypes: b && itemTypes(b.items),
        };
        if (a && b) {
            const max = Math.max(a.items.length, b.items.length);
            entry.firstDiffIndex = -1;
            for (let index = 0; index < max; index += 1) {
                if (canonical(a.items[index]) !== canonical(b.items[index])) {
                    entry.firstDiffIndex = index;
                    entry.readItem = truncate(canonical(a.items[index]));
                    entry.pagedItem = truncate(canonical(b.items[index]));
                    break;
                }
            }
        }
        out[turnId] = entry;
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
