'use strict';

/*
 * Read-only probe for codex app-server 0.147.0 cold-start pagination.
 *
 * Verifies, against real session data:
 *   A. `itemsView:"summary"` item shapes vs `full` on a small session —
 *      is the summary enough to build outline entries (userPreview etc.)?
 *   B. Big PAGINATED session (183MB): summary tail page, full asc summary
 *      walk, full asc full-items walk, and the current `thread/read` pain.
 *   C. Big LEGACY session (60MB): summary walk + tail window cost.
 *   D. `thread/resume` with excludeTurns + initialTurnsPage +
 *      turnsBackwardsCursor — one-shot cold-start bootstrap surface.
 *
 * The probe never writes to sessions under test.
 */

const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const CODEX_EXECUTABLE = '/usr/bin/codex';
const SMALL_THREAD = '019f975c-0b47-7370-bd44-40ee72e9b6f1'; // ~408KB
const BIG_PAGINATED = '019fe66d-bd70-73e3-85a8-e92ac1b19f92'; // ~183MB, 213 turns, in sqlite projection
const BIG_LEGACY = '019f1c4a-6553-7892-9c45-eb0b9be05bf6'; // ~60MB, 503 turns, replay backend

const report = { phases: {} };
let currentPhase = 'setup';

function record(key, value) {
    report.phases[currentPhase][key] = value;
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
                continue; // notifications not needed here
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

async function timed(fn) {
    const started = performance.now();
    const result = await fn();
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    const bytes = Buffer.byteLength(JSON.stringify(result));
    return { elapsedMs, bytes, result };
}

async function walk(client, threadId, pageParams) {
    const pages = [];
    let cursor;
    for (;;) {
        const sample = await timed(() => client.request('thread/turns/list', {
            threadId,
            cursor,
            ...pageParams,
        }));
        pages.push(sample);
        cursor = sample.result.nextCursor || undefined;
        if (!cursor) {
            break;
        }
    }
    const turns = pages.flatMap(page => page.result.data);
    return {
        pages: pages.length,
        turns: turns.length,
        totalMs: Math.round(pages.reduce((sum, page) => sum + page.elapsedMs, 0) * 100) / 100,
        maxPageMs: Math.max(...pages.map(page => page.elapsedMs)),
        totalBytes: pages.reduce((sum, page) => sum + page.bytes, 0),
        pageTurns: pages.map(page => page.result.data.length),
        itemsViewEcho: turns[0] && turns[0].itemsView,
        allTurns: turns,
    };
}

function itemKeyCensus(turns) {
    const census = {};
    for (const turn of turns) {
        for (const item of turn.items || []) {
            const type = item && item.type || 'unknown';
            census[type] = census[type] || { count: 0, keys: new Set() };
            census[type].count += 1;
            for (const key of Object.keys(item || {})) {
                census[type].keys.add(key);
            }
        }
    }
    return Object.fromEntries(Object.entries(census).map(([type, entry]) => [
        type,
        { count: entry.count, keys: [...entry.keys].sort() },
    ]));
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

function preview(value, max = 120) {
    if (typeof value !== 'string') {
        return value;
    }
    return value.length > max ? `${value.slice(0, max)}…(${value.length} chars)` : value;
}

async function phaseA(client) {
    currentPhase = 'A_summary_vs_full_shapes';
    report.phases[currentPhase] = {};
    const full = await walk(client, SMALL_THREAD, {
        limit: 10, sortDirection: 'asc', itemsView: 'full',
    });
    const summary = await walk(client, SMALL_THREAD, {
        limit: 10, sortDirection: 'asc', itemsView: 'summary',
    });
    record('full', { turns: full.turns, totalBytes: full.totalBytes });
    record('summary', { turns: summary.turns, totalBytes: summary.totalBytes });
    record('summaryKeyCensus', itemKeyCensus(summary.allTurns));
    record('fullKeyCensus', itemKeyCensus(full.allTurns));

    // Per-turn item type sequence comparison.
    const sequenceMismatches = [];
    for (let index = 0; index < Math.max(full.turns, summary.turns); index += 1) {
        const a = full.allTurns[index];
        const b = summary.allTurns[index];
        if (!a || !b || a.id !== b.id) {
            sequenceMismatches.push({ index, reason: 'turn mismatch' });
            continue;
        }
        const aTypes = (a.items || []).map(item => item.type).join(',');
        const bTypes = (b.items || []).map(item => item.type).join(',');
        if (aTypes !== bTypes) {
            sequenceMismatches.push({ index, turnId: a.id, full: aTypes, summary: bTypes });
        }
    }
    record('itemTypeSequenceMismatches', sequenceMismatches);

    // Text presence per item type in summary view, and whether short texts
    // survive verbatim (vs truncated).
    const textStats = {};
    for (let index = 0; index < summary.turns; index += 1) {
        const sTurn = summary.allTurns[index];
        const fTurn = full.allTurns[index];
        if (!sTurn || !fTurn) {
            continue;
        }
        for (let itemIndex = 0; itemIndex < (sTurn.items || []).length; itemIndex += 1) {
            const sItem = sTurn.items[itemIndex];
            const fItem = (fTurn.items || [])[itemIndex];
            const type = sItem && sItem.type || 'unknown';
            textStats[type] = textStats[type] || { items: 0, withText: 0, identical: 0, truncated: 0 };
            textStats[type].items += 1;
            const sText = textOf(sItem);
            const fText = textOf(fItem);
            if (typeof sText === 'string' && sText.length > 0) {
                textStats[type].withText += 1;
                if (sText === fText) {
                    textStats[type].identical += 1;
                } else if (typeof fText === 'string' && fText.startsWith(sText.replace(/…$/, ''))) {
                    textStats[type].truncated += 1;
                }
            }
        }
    }
    record('summaryTextStats', textStats);

    // A couple of sanitized samples for eyeballing.
    const samples = [];
    for (const turn of summary.allTurns) {
        for (const item of turn.items || []) {
            if ((item.type === 'userMessage' || item.type === 'agentMessage') && samples.length < 4) {
                samples.push({ type: item.type, keys: Object.keys(item), text: preview(textOf(item)) });
            }
        }
    }
    record('summarySamples', samples);
}

async function phaseB(client) {
    currentPhase = 'B_big_paginated_183MB';
    report.phases[currentPhase] = {};

    const tailSummary = await timed(() => client.request('thread/turns/list', {
        threadId: BIG_PAGINATED, limit: 25, sortDirection: 'desc', itemsView: 'summary',
    }));
    record('tailSummary25', {
        elapsedMs: tailSummary.elapsedMs,
        bytes: tailSummary.bytes,
        keyCensus: itemKeyCensus(tailSummary.result.data),
    });

    const summaryWalk = await walk(client, BIG_PAGINATED, {
        limit: 100, sortDirection: 'asc', itemsView: 'summary',
    });
    record('summaryWalkAsc100', { ...summaryWalk, allTurns: undefined, pageTurns: summaryWalk.pageTurns });

    const fullWalk = await walk(client, BIG_PAGINATED, {
        limit: 25, sortDirection: 'asc', itemsView: 'full',
    });
    record('fullWalkAsc25', { ...fullWalk, allTurns: undefined, pageTurns: fullWalk.pageTurns });

    const read = await timed(() => client.request(
        'thread/read', { threadId: BIG_PAGINATED, includeTurns: true }
    ));
    record('threadRead', { elapsedMs: read.elapsedMs, bytes: read.bytes });
}

async function phaseC(client) {
    currentPhase = 'C_big_legacy_60MB';
    report.phases[currentPhase] = {};

    const summaryWalk = await walk(client, BIG_LEGACY, {
        limit: 100, sortDirection: 'asc', itemsView: 'summary',
    });
    record('summaryWalkAsc100', { ...summaryWalk, allTurns: undefined, pageTurns: summaryWalk.pageTurns });

    const tailFull = await timed(() => client.request('thread/turns/list', {
        threadId: BIG_LEGACY, limit: 25, sortDirection: 'desc', itemsView: 'full',
    }));
    record('tailFull25', { elapsedMs: tailFull.elapsedMs, bytes: tailFull.bytes });
}

async function phaseD(client) {
    currentPhase = 'D_thread_resume_bootstrap';
    report.phases[currentPhase] = {};
    try {
        const resume = await timed(() => client.request('thread/resume', {
            threadId: SMALL_THREAD,
            excludeTurns: true,
            initialTurnsPage: { limit: 4, sortDirection: 'desc', itemsView: 'summary' },
        }));
        const response = resume.result;
        record('resume', {
            elapsedMs: resume.elapsedMs,
            bytes: resume.bytes,
            topLevelKeys: Object.keys(response).sort(),
            threadTurns: response.thread && Array.isArray(response.thread.turns)
                ? response.thread.turns.length : null,
            initialTurnsPage: response.initialTurnsPage ? {
                turns: response.initialTurnsPage.data.length,
                turnIds: response.initialTurnsPage.data.map(turn => turn.id),
                itemsView: response.initialTurnsPage.data[0]
                    && response.initialTurnsPage.data[0].itemsView,
                hasNextCursor: typeof response.initialTurnsPage.nextCursor === 'string',
            } : null,
            hasTurnsBackwardsCursor: typeof response.turnsBackwardsCursor === 'string',
        });
        if (typeof response.turnsBackwardsCursor === 'string') {
            const older = await timed(() => client.request('thread/turns/list', {
                threadId: SMALL_THREAD,
                cursor: response.turnsBackwardsCursor,
                limit: 4,
                sortDirection: 'desc',
                itemsView: 'summary',
            }));
            const pageIds = response.initialTurnsPage
                ? new Set(response.initialTurnsPage.data.map(turn => turn.id)) : new Set();
            record('backwardsCursorPage', {
                elapsedMs: older.elapsedMs,
                turnIds: older.result.data.map(turn => turn.id),
                overlapsInitialPage: older.result.data.some(turn => pageIds.has(turn.id)),
            });
        }
    } catch (error) {
        record('error', { code: error.code, message: error.message });
    }
}

async function main() {
    const phases = [
        ['A', phaseA],
        ['B', phaseB],
        ['C', phaseC],
        ['D', phaseD],
    ];
    for (const [name, fn] of phases) {
        const client = new RpcClient();
        await client.connect();
        try {
            await fn(client);
        } catch (error) {
            report.phases[currentPhase] = report.phases[currentPhase] || {};
            report.phases[currentPhase].fatal = String(error && error.stack || error);
        }
        client.close();
    }
    console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
    console.error('probe failed:', error);
    process.exitCode = 1;
});
