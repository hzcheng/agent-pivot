'use strict';

/*
 * Follow-up probe (round 2):
 *   G. Server-side scaling: `thread/turns/list` tail page + `thread/read`
 *      on the 175MB session (does the store scan the whole rollout?).
 *   H. Shape identity on a medium multi-turn session (all turns, all items).
 */

const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const CODEX_EXECUTABLE = '/usr/bin/codex';
const HUGE_THREAD = '019fe66d-bd70-73e3-85a8-e92ac1b19f92'; // ~175MB rollout
const MEDIUM_THREAD = '019f96d5-d6a5-7482-9f6d-b9f14a38aea4'; // ~9.6MB rollout

const report = { phases: {} };
let currentPhase = 'setup';

function record(key, value) {
    report.phases[currentPhase][key] = value;
}

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
    constructor(capabilities) {
        this.capabilities = capabilities;
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
            capabilities: this.capabilities,
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

async function timed(fn) {
    const started = performance.now();
    const result = await fn();
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    const bytes = Buffer.byteLength(JSON.stringify(result));
    return { elapsedMs, bytes, result };
}

async function phaseG() {
    currentPhase = 'G_scaling_175mb_session';
    report.phases[currentPhase] = {};
    const client = new RpcClient({ experimentalApi: true });
    await client.connect();

    const tail = await timed(() => client.request('thread/turns/list', {
        threadId: HUGE_THREAD,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'full',
    }));
    record('tailPageFull', {
        elapsedMs: tail.elapsedMs,
        bytes: tail.bytes,
        turns: tail.result.data.length,
    });

    const tail2 = await timed(() => client.request('thread/turns/list', {
        threadId: HUGE_THREAD,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'summary',
    }));
    record('tailPageSummaryRepeat', { elapsedMs: tail2.elapsedMs, bytes: tail2.bytes });

    const read = await timed(() => client.request('thread/read', {
        threadId: HUGE_THREAD,
        includeTurns: true,
    }));
    record('threadRead', {
        elapsedMs: read.elapsedMs,
        bytes: read.bytes,
        turns: (read.result.thread.turns || []).length,
    });

    client.close();
}

async function phaseH() {
    currentPhase = 'H_shape_identity_medium_session';
    report.phases[currentPhase] = {};
    const client = new RpcClient({ experimentalApi: true });
    await client.connect();

    const read = await timed(() => client.request('thread/read', {
        threadId: MEDIUM_THREAD,
        includeTurns: true,
    }));
    const readTurns = read.result.thread.turns || [];

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

    const mismatches = [];
    const count = Math.max(readTurns.length, pagedTurns.length);
    for (let index = 0; index < count; index += 1) {
        const a = readTurns[index];
        const b = pagedTurns[index];
        if (!a || !b) {
            mismatches.push({ index, reason: 'missing turn', read: !!a, paged: !!b });
            continue;
        }
        if (a.id !== b.id) {
            mismatches.push({ index, reason: 'turn id', read: a.id, paged: b.id });
            continue;
        }
        if (canonical(a.items) !== canonical(b.items)) {
            mismatches.push({ index, reason: 'items differ', turnId: a.id });
        }
        if (a.status !== b.status) {
            mismatches.push({ index, reason: 'status', read: a.status, paged: b.status });
        }
    }
    record('threadRead', { elapsedMs: read.elapsedMs, bytes: read.bytes, turns: readTurns.length });
    record('paged', { turns: pagedTurns.length });
    record('mismatchCount', mismatches.length);
    record('mismatches', mismatches.slice(0, 10));
    record('identical', mismatches.length === 0 && readTurns.length === pagedTurns.length);

    client.close();
}

async function main() {
    for (const fn of [phaseG, phaseH]) {
        try {
            await fn();
        } catch (error) {
            report.phases[currentPhase] = report.phases[currentPhase] || {};
            report.phases[currentPhase].fatal = String(error && error.stack || error);
        }
    }
    console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
    console.error('probe failed:', error);
    process.exitCode = 1;
});
