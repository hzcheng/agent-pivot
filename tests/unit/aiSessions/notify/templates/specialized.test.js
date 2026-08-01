'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { buildNtfyRequest } = require('../../../../../out/aiSessions/notify/templates/ntfy');
const { buildTelegramRequest } = require('../../../../../out/aiSessions/notify/templates/telegram');
const { buildBarkRequest } = require('../../../../../out/aiSessions/notify/templates/bark');
const { buildDingtalkRequest } = require('../../../../../out/aiSessions/notify/templates/dingtalk');

// ATTENTION-NOTIFY-TEMPLATE-SPECIALIZED-001

const title = '⏸ Claude 在等你输入';
const body = '项目  p';

test('ntfy 把 topic 拼进路径,正文放 body', () => {
    const request = buildNtfyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', topic: 't1', token: null, priority: 4 },
        title, body, 4);
    assert.equal(request.url, 'https://ntfy.sh/t1');
    assert.equal(request.method, 'POST');
    assert.equal(request.body, body);
    assert.equal(request.headers.Priority, '4');
});

test('ntfy 的非 ASCII 标题按 RFC 2047 base64 编码', () => {
    const request = buildNtfyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', topic: 't1', token: null, priority: 3 },
        title, body, 3);
    assert.match(request.headers.Title, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/u);
    const encoded = request.headers.Title.slice('=?UTF-8?B?'.length, -'?='.length);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), title);
});

test('ntfy 的纯 ASCII 标题不编码', () => {
    const request = buildNtfyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', topic: 't1', token: null, priority: 3 },
        'Claude is waiting', body, 3);
    assert.equal(request.headers.Title, 'Claude is waiting');
});

test('ntfy 有 token 时带 Authorization 头', () => {
    const request = buildNtfyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', topic: 't1', token: 'tk_1', priority: 3 },
        'x', body, 3);
    assert.equal(request.headers.Authorization, 'Bearer tk_1');
});

test('ntfy baseUrl 末尾斜杠不产生双斜杠', () => {
    const request = buildNtfyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh/', topic: 't1', token: null, priority: 3 },
        'x', body, 3);
    assert.equal(request.url, 'https://ntfy.sh/t1');
});

test('telegram 把 botToken 拼进路径', () => {
    const request = buildTelegramRequest(
        { id: 'a', channel: 'telegram', proxy: null, botToken: 'BOT:1', chatId: '99' }, title, body);
    assert.equal(request.url, 'https://api.telegram.org/botBOT:1/sendMessage');
    assert.deepEqual(JSON.parse(request.body), { chat_id: '99', text: `${title}\n${body}` });
});

test('bark 把 deviceKey 拼进路径', () => {
    const request = buildBarkRequest(
        { id: 'a', channel: 'bark', proxy: null, serverUrl: 'https://api.day.app', deviceKey: 'KEY' }, title, body);
    assert.equal(request.url, 'https://api.day.app/KEY');
    assert.deepEqual(JSON.parse(request.body), { title, body });
});

test('dingtalk 追加 timestamp 与 HMAC 签名', () => {
    const nowMs = 1753948800000;
    const secret = 'SEC';
    const request = buildDingtalkRequest(
        { id: 'a', channel: 'dingtalk', proxy: null, url: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret },
        title, body, nowMs);
    const expectedSign = encodeURIComponent(
        crypto.createHmac('sha256', secret).update(`${nowMs}\n${secret}`).digest('base64'));
    assert.ok(request.url.includes(`&timestamp=${nowMs}`));
    assert.ok(request.url.includes(`&sign=${expectedSign}`));
    assert.equal(JSON.parse(request.body).msgtype, 'markdown');
});
