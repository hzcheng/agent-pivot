#!/usr/bin/env node
'use strict';
// Isolated protocol fixture: never connects to a real provider.
const fs = require('node:fs');
const http = require('node:http');
const WS = require(process.env.AP_TEST_WS);
const args = process.argv.slice(2);
const control = process.env.AP_TEST_CONTROL;
const mark = (name, value = true) => fs.writeFileSync(control + '.' + name, JSON.stringify(value));
if (args.includes('--help')) {
    console.log(process.env.AP_TEST_UNSUPPORTED ? 'ordinary CLI' : '--remote unix://');
} else if (args.includes('--version')) {
    console.log('codex-cli 0.155.0');
} else if (args[0] === 'app-server') {
    if (process.env.AP_TEST_SERVER_FAIL) process.exit(23);
    const server = http.createServer();
    const wss = new WS.WebSocketServer({ server, perMessageDeflate: false });
    let turns = [];
    const notify = (method, params) => {
        for (const socket of wss.clients) socket.send(JSON.stringify({ method, params }));
    };
    wss.on('connection', socket => socket.on('message', data => {
        const request = JSON.parse(data);
        if (request.id === undefined) return;
        let result = {};
        if (['thread/start', 'thread/resume', 'thread/fork'].includes(request.method) && !request.params?.ephemeral) mark('lifecycle', request);
        const threadId = request.params?.threadId || (request.params?.ephemeral ? 'helper-title' : 'root-a');
        if (request.method === 'thread/start' || request.method === 'thread/resume' || request.method === 'thread/fork') {
            result = { thread: { id: threadId, turns, ephemeral: request.params?.ephemeral === true }, cwd: request.params?.cwd || process.cwd(),
                runtimeWorkspaceRoots: process.env.AP_TEST_WRONG_ROOTS ? ['/wrong'] : request.params?.runtimeWorkspaceRoots || [process.cwd()] };
        }
        if (request.method === 'thread/loaded/list') result = { data: ['root-a', 'root-b'], nextCursor: null };
        socket.send(JSON.stringify({ id: request.id, result }));
        if (request.method === 'turn/start') {
            const turn = { id: 'turn-a', status: 'inProgress', items: [
                { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
                { id: 'a', type: 'agentMessage', text: '' },
            ] };
            turns = [turn];
            notify('turn/started', { threadId: 'root-a', turn });
            let n = 0;
            const timer = setInterval(() => {
                turn.items[1].text += String(n);
                notify('item/agentMessage/delta', { threadId: 'root-a', turnId: turn.id, itemId: 'a', delta: String(n++) });
                if (n === 10) {
                    clearInterval(timer);
                    turn.status = 'completed';
                    notify('item/completed', { threadId: 'root-a', turnId: turn.id, item: turn.items[1] });
                    notify('turn/completed', { threadId: 'root-a', turn });
                }
            }, 30);
        }
    }));
    mark('server', process.pid);
    mark('serverArgv', process.argv.slice(2));
    server.listen(args[args.indexOf('--listen') + 1].slice('unix://'.length));
} else {
    mark('terminalSpawned');
    if (!args.includes('--remote')) { mark('ordinary', args); process.exit(0); }
    if (args.includes('resume') && args.includes('--dangerously-bypass-approvals-and-sandbox')) {
        console.error('Permission overrides are not supported when resuming a remote task.'); process.exit(1);
    }
    if (args.includes('--add-dir')) { console.error('Remote TUI rejects --add-dir'); process.exit(1); }
    const socketPath = args[args.indexOf('--remote') + 1].slice('unix://'.length);
    const socket = new WS('ws+unix://' + socketPath + ':/', { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    const request = (method, params = {}) => new Promise(resolve => {
        const key = ++id; pending.set(key, resolve); socket.send(JSON.stringify({ id: key, method, params }));
    });
    socket.on('message', data => {
        const message = JSON.parse(data);
        if (pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); }
    });
    socket.on('open', async () => {
        await request('initialize');
        await request(args.includes('resume') ? 'thread/resume' : 'thread/start', { ephemeral: false, threadId: 'root-a' });
        await request('thread/start', { ephemeral: true });
        mark('created');
        if (process.env.AP_TEST_WRONG_ROOTS) { setTimeout(() => socket.close(), 50); return; }
        let started = false, switched = false;
        const timer = setInterval(async () => {
            if (!started && fs.existsSync(control + '.go')) { started = true; await request('turn/start'); }
            if (!switched && fs.existsSync(control + '.switch')) {
                switched = true; await request(process.env.AP_TEST_SWITCH_METHOD || 'thread/resume', { threadId: 'root-b' }); mark('switched');
            }
            if (fs.existsSync(control + '.finish')) { clearInterval(timer); socket.close(); }
        }, 20);
    });
    socket.on('close', () => process.exit(0));
    socket.on('error', () => process.exit(1));
}
