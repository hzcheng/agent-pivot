'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveProxy, sendWithRetry } = require('../../../../out/aiSessions/notify/httpClient');

// ATTENTION-NOTIFY-HTTP-001

const request = { url: 'https://example.test/hook', method: 'POST', headers: {}, body: '{}' };

test('sink 级代理优先于全局与环境变量', () => {
    assert.equal(
        resolveProxy('http://sink:1', 'http://global:2', { HTTPS_PROXY: 'http://env:3' }, 'https://x.test/'),
        'http://sink:1');
});

test('无 sink 代理时使用全局', () => {
    assert.equal(
        resolveProxy(null, 'http://global:2', { HTTPS_PROXY: 'http://env:3' }, 'https://x.test/'),
        'http://global:2');
});

test('无 sink 与全局时使用环境变量', () => {
    assert.equal(
        resolveProxy(null, '', { HTTPS_PROXY: 'http://env:3' }, 'https://x.test/'),
        'http://env:3');
});

test('NO_PROXY 命中时不使用代理', () => {
    assert.equal(
        resolveProxy(null, '', { HTTPS_PROXY: 'http://env:3', NO_PROXY: '.internal.test' },
            'https://api.internal.test/x'),
        null);
});

test('都没有时返回 null', () => {
    assert.equal(resolveProxy(null, '', {}, 'https://x.test/'), null);
});

test('2xx 一次成功不重试', async () => {
    let calls = 0;
    const transport = { send: async () => { calls += 1; return { statusCode: 200, durationMs: 1, viaProxy: false }; } };
    const result = await sendWithRetry(transport, request, null, async () => {});
    assert.equal(result.statusCode, 200);
    assert.equal(calls, 1);
});

test('5xx 重试三次后放弃', async () => {
    let calls = 0;
    const delays = [];
    const transport = { send: async () => { calls += 1; return { statusCode: 503, durationMs: 1, viaProxy: false }; } };
    const result = await sendWithRetry(transport, request, null, async ms => { delays.push(ms); });
    assert.equal(result.statusCode, 503);
    assert.equal(calls, 4);
    assert.deepEqual(delays, [1000, 4000, 16000]);
});

test('4xx 不重试', async () => {
    let calls = 0;
    const transport = { send: async () => { calls += 1; return { statusCode: 401, durationMs: 1, viaProxy: false }; } };
    const result = await sendWithRetry(transport, request, null, async () => {});
    assert.equal(result.statusCode, 401);
    assert.equal(calls, 1);
});

test('网络异常重试后成功', async () => {
    let calls = 0;
    const transport = {
        send: async () => {
            calls += 1;
            if (calls < 3) {
                throw new Error('ECONNRESET');
            }
            return { statusCode: 200, durationMs: 1, viaProxy: false };
        },
    };
    const result = await sendWithRetry(transport, request, null, async () => {});
    assert.equal(result.statusCode, 200);
    assert.equal(calls, 3);
});

test('全部尝试都抛异常时抛出最后一个错误', async () => {
    const transport = { send: async () => { throw new Error('ENETUNREACH'); } };
    await assert.rejects(
        () => sendWithRetry(transport, request, null, async () => {}),
        /ENETUNREACH/u);
});
