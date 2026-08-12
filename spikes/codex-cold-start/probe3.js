'use strict';

/*
 * probe3 — per-turn summary-vs-full projection divergence census.
 *
 * Walks the 183MB paginated session in both itemsView modes and compares
 * the summary-level projection (turn fields, first userMessage, final
 * agentMessage) per turn. Finding: the summary agentMessage is
 * UNRELIABLE (omitted for interrupted turns, divergent in 1/213 completed
 * turns); the user side and turn-level fields are verbatim everywhere.
 *
 * Read-only; requires a real codex 0.147.0 on this machine.
 */
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const child = spawn('/usr/bin/codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        entry(message);
    }
});
function request(method, params) {
    const id = nextId++;
    return new Promise(resolve => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
}
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
function rawUserMessageText(item) {
    if (!Array.isArray(item.content)) return '';
    let text = '';
    for (const part of item.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') text += part.text;
    }
    return text;
}
function fp(turn) {
    let firstUser = null;
    let finalAgent = null;
    for (const item of turn.items) {
        if (!item || typeof item.id !== 'string') continue;
        if (item.type === 'userMessage' && !firstUser) {
            firstUser = { id: item.id, text: rawUserMessageText(item) };
        } else if (item.type === 'agentMessage') {
            finalAgent = { id: item.id, text: typeof item.text === 'string' ? item.text : '' };
        }
    }
    return createHash('sha256').update(canonicalJson({
        id: turn.id, status: turn.status,
        startedAt: turn.startedAt ?? null, completedAt: turn.completedAt ?? null,
        error: turn.error ?? null, firstUser, finalAgent,
    }), 'utf8').digest('hex');
}
(async () => {
    await request('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '0.0.1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const threadId = '019fe66d-bd70-73e3-85a8-e92ac1b19f92';
    // probe3 — summary-vs-full fingerprint divergence census:
// per-turn comparison of the summary-level projection across both views.
// Finding: the summary agentMessage is unreliable (omitted for interrupted
// turns, divergent elsewhere); the user side is verbatim everywhere.

// asc summary walk → per-turn summary fingerprints
    const summary = [];
    let cursor;
    for (;;) {
        const page = await request('thread/turns/list', { threadId, cursor, limit: 100, sortDirection: 'asc', itemsView: 'summary' });
        summary.push(...page.result.data);
        cursor = page.result.nextCursor || undefined;
        if (!cursor) break;
    }
    // full fetch of turns 40..90 (the validation's safe window area)
    const mismatches = [];
    for (let i = 40; i <= 90; i += 1) {
        const target = summary[i];
        // fetch that single turn full via a desc seek: walk from head asc is expensive; use summary cursor trick — simply fetch asc pages of 1 starting at a boundary… simpler: fetch all full pages asc limit 25 until i+1
    }
    // simpler: full walk asc limit 25 and compare all
    const full = [];
    cursor = undefined;
    for (;;) {
        const page = await request('thread/turns/list', { threadId, cursor, limit: 25, sortDirection: 'asc', itemsView: 'full' });
        full.push(...page.result.data);
        cursor = page.result.nextCursor || undefined;
        if (!cursor) break;
    }
    console.log('summary turns:', summary.length, 'full turns:', full.length);
    for (let i = 0; i < Math.min(summary.length, full.length); i += 1) {
        const a = fp(summary[i]);
        const b = fp(full[i]);
        if (a !== b) {
            mismatches.push({ index: i, id: summary[i].id });
        }
    }
    console.log('fingerprint mismatches:', JSON.stringify(mismatches));
    const divergent = [];
    for (let i = 0; i < Math.min(summary.length, full.length); i += 1) {
        const s = summary[i]; const f = full[i];
        const sUser = s.items.find(x => x.type === 'userMessage');
        const fUsers = f.items.filter(x => x.type === 'userMessage');
        const sHas = !!sUser;
        const fHas = fUsers.length > 0;
        if (sHas !== fHas || fUsers.length > 1
            || (sHas && sUser.id !== fUsers[0].id)
            || (sHas && rawUserMessageText(sUser) !== rawUserMessageText(fUsers[0]))) {
            divergent.push({
                index: i, id: s.id, status: s.status,
                summaryUser: sUser?.id ?? null,
                fullUserCount: fUsers.length,
                fullUserIds: fUsers.map(u => u.id),
                textEqual: sHas && fHas ? rawUserMessageText(sUser) === rawUserMessageText(fUsers[0]) : null,
            });
        }
    }
    console.log('user-side divergent turns:', JSON.stringify(divergent, null, 1));
    child.kill();
})();
// classification rerun
