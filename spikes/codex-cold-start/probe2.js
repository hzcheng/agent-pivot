'use strict';

/*
 * Probe 2 — linchpin questions for windowed cold start:
 *   A. Cursor portability: a nextCursor recorded during a limit=100 summary
 *      walk, reused with limit=4 itemsView=full — does it seek to the same
 *      turn boundary and return identical items to the full walk?
 *   B. Summary text fidelity: are summary userMessage/agentMessage texts
 *      verbatim copies of full-view texts (same turn), or truncated/digested?
 */

const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const CODEX_EXECUTABLE = '/usr/bin/codex';
const BIG_PAGINATED = '019fe66d-bd70-73e3-85a8-e92ac1b19f92'; // 183MB, 213 turns

const report = {};
let client;

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

function textOf(item) {
    if (!item || typeof item !== 'object') {
        return undefined;
    }
    if (typeof item.text === 'string') {
        return item.text;
    }
    if (Array.isArray(item.content)) {
        return item.content.map(part => part && part.text || '').join('');
    }
    return undefined;
}

function textsByTurn(turns) {
    const map = new Map();
    for (const turn of turns) {
        const entry = { user: [], agent: [] };
        for (const item of turn.items || []) {
            if (item.type === 'userMessage') {
                entry.user.push(textOf(item));
            } else if (item.type === 'agentMessage') {
                entry.agent.push(textOf(item));
            }
        }
        map.set(turn.id, entry);
    }
    return map;
}

async function main() {
    client = new RpcClient();
    await client.connect();

    // --- A. Cursor portability -------------------------------------------
    // Summary walk with limit 100; record the first nextCursor (boundary at
    // turn index 100).
    const page1 = await client.request('thread/turns/list', {
        threadId: BIG_PAGINATED, limit: 100, sortDirection: 'asc', itemsView: 'summary',
    });
    const boundaryCursor = page1.nextCursor;
    const page2 = await client.request('thread/turns/list', {
        threadId: BIG_PAGINATED, cursor: boundaryCursor,
        limit: 100, sortDirection: 'asc', itemsView: 'summary',
    });
    const boundaryTurnIds = page2.data.slice(0, 4).map(turn => turn.id);

    // Reuse the same cursor with different limit AND different itemsView.
    const started = performance.now();
    const seekedFull = await client.request('thread/turns/list', {
        threadId: BIG_PAGINATED, cursor: boundaryCursor,
        limit: 4, sortDirection: 'asc', itemsView: 'full',
    });
    const seekMs = Math.round((performance.now() - started) * 100) / 100;
    const seekedIds = seekedFull.data.map(turn => turn.id);

    // Ground truth: full walk asc limit 25, turns 100..103.
    let fullWalkTurns = [];
    let cursor;
    for (;;) {
        const page = await client.request('thread/turns/list', {
            threadId: BIG_PAGINATED, cursor,
            limit: 25, sortDirection: 'asc', itemsView: 'full',
        });
        fullWalkTurns.push(...page.data);
        cursor = page.nextCursor || undefined;
        if (!cursor || fullWalkTurns.length >= 125) {
            break;
        }
    }
    const truthTurns = fullWalkTurns.slice(100, 104);
    const truthIds = truthTurns.map(turn => turn.id);

    const itemsIdentical = seekedFull.data.length === truthTurns.length
        && seekedFull.data.every((turn, index) =>
            turn.id === truthTurns[index].id
            && canonical(turn.items) === canonical(truthTurns[index].items));

    report.A_cursorPortability = {
        boundaryTurnIds,
        seekedIds,
        truthIds,
        sameBoundary: JSON.stringify(seekedIds) === JSON.stringify(boundaryTurnIds)
            && JSON.stringify(seekedIds) === JSON.stringify(truthIds),
        itemsIdenticalToFullWalk: itemsIdentical,
        seekMs,
        seekBytes: Buffer.byteLength(JSON.stringify(seekedFull)),
    };

    // --- B. Summary text fidelity ----------------------------------------
    const tailSummary = await client.request('thread/turns/list', {
        threadId: BIG_PAGINATED, limit: 4, sortDirection: 'desc', itemsView: 'summary',
    });
    const tailFull = await client.request('thread/turns/list', {
        threadId: BIG_PAGINATED, limit: 4, sortDirection: 'desc', itemsView: 'full',
    });
    const summaryTexts = textsByTurn(tailSummary.data);
    const fullTexts = textsByTurn(tailFull.data);
    const comparisons = [];
    for (const [turnId, s] of summaryTexts) {
        const f = fullTexts.get(turnId);
        if (!f) {
            comparisons.push({ turnId, error: 'missing in full' });
            continue;
        }
        const sUser = s.user.join('');
        const fUser = f.user.join('');
        const sAgent = s.agent.join('');
        const fAgentLast = f.agent[f.agent.length - 1] || '';
        comparisons.push({
            turnId,
            summaryItems: tailSummary.data.find(t => t.id === turnId).items.length,
            fullItems: tailFull.data.find(t => t.id === turnId).items.length,
            userIdentical: sUser === fUser,
            userChars: { summary: sUser.length, full: fUser.length },
            agentEqualsLastFull: sAgent === fAgentLast,
            agentChars: { summary: sAgent.length, fullLast: fAgentLast.length },
        });
    }
    report.B_summaryTextFidelity = comparisons;

    client.close();
    console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
    console.error('probe2 failed:', error);
    if (client) {
        client.close();
    }
    process.exitCode = 1;
});
