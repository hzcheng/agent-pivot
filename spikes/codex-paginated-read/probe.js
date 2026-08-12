'use strict';

/*
 * Read-only probe for codex app-server 0.147.0 paginated history APIs.
 *
 * Verifies, against real session data:
 *   A. `thread/turns/list` gating without the experimentalApi capability.
 *   B. Pagination semantics (sortDirection / cursor / nextCursor /
 *      backwardsCursor / itemsView) on a real large session.
 *   C. Shape identity: turns/items from `thread/turns/list` (itemsView=full)
 *      vs `thread/read` (includeTurns=true) on a small session.
 *   D. Timing: full `thread/read` vs tail-page `thread/turns/list`.
 *   E. Live turn: notification stream + in-flight turn visibility via
 *      `thread/turns/list`.
 *   F. `thread/turns/list` before the first user message (error shape).
 *
 * The probe never writes to sessions under test. Phase E creates one tiny
 * throwaway thread and archives it afterwards.
 */

const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const CODEX_EXECUTABLE = '/usr/bin/codex';
const BIG_THREAD = '019f1c4a-6553-7892-9c45-eb0b9be05bf6'; // ~59.9MB rollout
const SMALL_THREAD = '019f975c-0b47-7370-bd44-40ee72e9b6f1'; // ~408KB rollout

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
        this.notificationLog = [];
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
            let message;
            try {
                message = JSON.parse(line);
            } catch (error) {
                throw new Error(`unparsable line: ${error.message}`);
            }
            if (typeof message.method === 'string' && message.id === undefined) {
                this.notificationLog.push({
                    at: performance.now(),
                    method: message.method,
                    params: message.params,
                });
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

async function timed(label, fn) {
    const started = performance.now();
    const result = await fn();
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    const bytes = Buffer.byteLength(JSON.stringify(result));
    return { label, elapsedMs, bytes, result };
}

function summarizeTurn(turn) {
    return {
        id: turn.id,
        status: turn.status,
        itemsView: turn.itemsView,
        items: Array.isArray(turn.items) ? turn.items.length : null,
        itemChars: Array.isArray(turn.items)
            ? turn.items.reduce((sum, item) => sum + JSON.stringify(item).length, 0)
            : null,
    };
}

async function phaseA() {
    currentPhase = 'A_gating_without_capability';
    report.phases[currentPhase] = {};
    const client = new RpcClient({});
    await client.connect();
    try {
        await client.request('thread/turns/list', { threadId: BIG_THREAD, limit: 1 });
        record('error', null);
    } catch (error) {
        record('error', { code: error.code, message: error.message });
    }
    client.close();
}

async function phaseB() {
    currentPhase = 'B_pagination_semantics';
    report.phases[currentPhase] = {};
    const client = new RpcClient({ experimentalApi: true });
    await client.connect();

    const first = await timed('turnsList_desc_limit3_full', () => client.request(
        'thread/turns/list',
        { threadId: BIG_THREAD, limit: 3, sortDirection: 'desc', itemsView: 'full' }
    ));
    record('firstPage', {
        elapsedMs: first.elapsedMs,
        bytes: first.bytes,
        turns: first.result.data.map(summarizeTurn),
        hasNextCursor: typeof first.result.nextCursor === 'string',
        hasBackwardsCursor: typeof first.result.backwardsCursor === 'string',
    });

    // Follow backwardsCursor with ascending order: the anchor turn must be
    // included again (the documented "catch updates to that turn" path).
    const backwards = await timed('turnsList_asc_backwardsCursor', () => client.request(
        'thread/turns/list',
        {
            threadId: BIG_THREAD,
            cursor: first.result.backwardsCursor,
            limit: 3,
            sortDirection: 'asc',
            itemsView: 'summary',
        }
    ));
    const anchorId = first.result.data[0] && first.result.data[0].id;
    record('backwardsPage', {
        elapsedMs: backwards.elapsedMs,
        turnIds: backwards.result.data.map(turn => turn.id),
        anchorTurnId: anchorId,
        anchorIncluded: backwards.result.data.some(turn => turn.id === anchorId),
        itemsViewEcho: backwards.result.data[0] && backwards.result.data[0].itemsView,
    });

    // Follow nextCursor descending: older turns, no overlap with first page.
    const older = await timed('turnsList_desc_nextCursor', () => client.request(
        'thread/turns/list',
        {
            threadId: BIG_THREAD,
            cursor: first.result.nextCursor,
            limit: 5,
            sortDirection: 'desc',
            itemsView: 'summary',
        }
    ));
    const firstPageIds = new Set(first.result.data.map(turn => turn.id));
    record('nextPage', {
        elapsedMs: older.elapsedMs,
        turnCount: older.result.data.length,
        overlapsFirstPage: older.result.data.some(turn => firstPageIds.has(turn.id)),
        hasNextCursor: typeof older.result.nextCursor === 'string',
    });

    // Count total turns by paging ascending in summary mode.
    let total = 0;
    let cursor;
    for (;;) {
        const page = await client.request('thread/turns/list', {
            threadId: BIG_THREAD,
            cursor,
            limit: 100,
            sortDirection: 'asc',
            itemsView: 'summary',
        });
        total += page.data.length;
        cursor = page.nextCursor || undefined;
        if (!cursor) {
            break;
        }
    }
    record('totalTurnsViaPaging', total);

    client.close();
}

async function phaseC() {
    currentPhase = 'C_shape_identity_small_session';
    report.phases[currentPhase] = {};
    const client = new RpcClient({ experimentalApi: true });
    await client.connect();

    const read = await timed('threadRead_full', () => client.request(
        'thread/read',
        { threadId: SMALL_THREAD, includeTurns: true }
    ));
    const readTurns = read.result.thread.turns || [];

    const pagedTurns = [];
    let cursor;
    for (;;) {
        const page = await client.request('thread/turns/list', {
            threadId: SMALL_THREAD,
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
    record('mismatches', mismatches);
    record('identical', mismatches.length === 0 && readTurns.length === pagedTurns.length);

    client.close();
}

async function phaseD() {
    currentPhase = 'D_timing_large_session';
    report.phases[currentPhase] = {};
    const client = new RpcClient({ experimentalApi: true });
    await client.connect();

    const reads = [];
    for (let run = 0; run < 3; run += 1) {
        const sample = await timed('threadRead', () => client.request(
            'thread/read',
            { threadId: BIG_THREAD, includeTurns: true }
        ));
        reads.push({ elapsedMs: sample.elapsedMs, bytes: sample.bytes });
    }
    record('threadReadRuns', reads);

    const tailFull = [];
    for (let run = 0; run < 3; run += 1) {
        const sample = await timed('turnsListTailFull', () => client.request(
            'thread/turns/list',
            { threadId: BIG_THREAD, limit: 1, sortDirection: 'desc', itemsView: 'full' }
        ));
        tailFull.push({ elapsedMs: sample.elapsedMs, bytes: sample.bytes });
    }
    record('tailPageFullRuns', tailFull);

    const tailSummary = await timed('turnsListTailSummary', () => client.request(
        'thread/turns/list',
        { threadId: BIG_THREAD, limit: 25, sortDirection: 'desc', itemsView: 'summary' }
    ));
    record('tailSummary25', { elapsedMs: tailSummary.elapsedMs, bytes: tailSummary.bytes });

    client.close();
}

async function phasesEF() {
    currentPhase = 'EF_live_turn';
    report.phases[currentPhase] = {};
    const client = new RpcClient({ experimentalApi: true });
    await client.connect();

    const started = await client.request('thread/start', {});
    const threadId = started.thread.id;
    record('liveThreadId', threadId);

    // Phase F: turns/list before the first user message.
    try {
        await client.request('thread/turns/list', { threadId, limit: 1 });
        record('beforeFirstMessage', { error: null });
    } catch (error) {
        record('beforeFirstMessage', { error: { code: error.code, message: error.message } });
    }

    const notificationStart = client.notificationLog.length;
    const turn = await client.request('turn/start', {
        threadId,
        cwd: '/tmp',
        input: [{ type: 'text', text: 'Reply with exactly: OK' }],
    });
    record('turnStart', { turnId: turn.turn && turn.turn.id, status: turn.turn && turn.turn.status });

    // Poll the tail page while the turn runs.
    const polls = [];
    let completed = false;
    const deadline = performance.now() + 90_000;
    while (!completed && performance.now() < deadline) {
        const page = await client.request('thread/turns/list', {
            threadId,
            limit: 1,
            sortDirection: 'desc',
            itemsView: 'full',
        });
        const summary = page.data[0] ? summarizeTurn(page.data[0]) : null;
        const previous = polls[polls.length - 1];
        if (summary && (!previous
            || previous.status !== summary.status
            || previous.items !== summary.items
            || previous.itemChars !== summary.itemChars)) {
            polls.push(summary);
        }
        completed = client.notificationLog.slice(notificationStart).some(
            entry => entry.method === 'turn/completed'
        );
        if (!completed) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    record('completed', completed);
    record('pollProgression', polls);

    const liveNotifications = client.notificationLog.slice(notificationStart);
    const methods = {};
    let deltaChars = 0;
    for (const entry of liveNotifications) {
        methods[entry.method] = (methods[entry.method] || 0) + 1;
        if (entry.method === 'item/agentMessage/delta' && entry.params
            && typeof entry.params.delta === 'string') {
            deltaChars += entry.params.delta.length;
        }
    }
    record('notificationCounts', methods);
    record('agentMessageDeltaChars', deltaChars);

    const finalPage = await client.request('thread/turns/list', {
        threadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'full',
    });
    const finalTurn = finalPage.data[0];
    const finalMessage = finalTurn && (finalTurn.items || [])
        .filter(item => item && item.type === 'agentMessage')
        .map(item => item.text)
        .join('');
    record('finalTurn', finalTurn ? summarizeTurn(finalTurn) : null);
    record('finalAgentMessage', finalMessage);

    try {
        await client.request('thread/archive', { threadId });
        record('archived', true);
    } catch (error) {
        record('archived', { error: error.message });
    }
    client.close();
}

async function main() {
    const phases = [
        ['A', phaseA],
        ['B', phaseB],
        ['C', phaseC],
        ['D', phaseD],
        ['EF', phasesEF],
    ];
    for (const [name, fn] of phases) {
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
