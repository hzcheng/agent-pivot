'use strict';

import * as http from 'http';
import * as https from 'https';
import type { Socket } from 'net';
import * as tls from 'tls';
import { URL } from 'url';
import type { NotifyRequest } from './templates/types';

export interface HttpResult {
    statusCode: number;
    durationMs: number;
    viaProxy: boolean;
}

export interface HttpTransport {
    send(request: NotifyRequest, proxy: string | null): Promise<HttpResult>;
}

const RETRY_DELAYS_MS = [1000, 4000, 16000];
const CONNECT_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 15000;

function matchesNoProxy(hostname: string, noProxy: string): boolean {
    return noProxy.split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean)
        .some(entry => {
            const bare = entry.startsWith('.') ? entry.slice(1) : entry;
            return hostname === bare || hostname.endsWith(`.${bare}`);
        });
}

export function resolveProxy(
    sinkProxy: string | null,
    globalProxy: string,
    env: Record<string, string | undefined>,
    targetUrl: string
): string | null {
    const noProxy = env.NO_PROXY || env.no_proxy || '';
    if (noProxy) {
        try {
            if (matchesNoProxy(new URL(targetUrl).hostname.toLowerCase(), noProxy)) {
                return null;
            }
        } catch (_error) {
            // 目标 URL 无法解析时按无代理处理,由发送阶段报错。
        }
    }
    return sinkProxy
        || globalProxy
        || env.HTTPS_PROXY || env.https_proxy
        || env.ALL_PROXY || env.all_proxy
        || null;
}

export async function sendWithRetry(
    transport: HttpTransport,
    request: NotifyRequest,
    proxy: string | null,
    sleep: (ms: number) => Promise<void>
): Promise<HttpResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            const result = await transport.send(request, proxy);
            if (result.statusCode < 500) {
                return result;
            }
            if (attempt === RETRY_DELAYS_MS.length) {
                return result;
            }
        } catch (error) {
            lastError = error;
            if (attempt === RETRY_DELAYS_MS.length) {
                throw error;
            }
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
    }
    throw lastError || new Error('notification transport exhausted retries');
}

function openProxyTunnel(proxy: string, target: URL): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const proxyUrl = new URL(proxy);
        const connectRequest = http.request({
            host: proxyUrl.hostname,
            port: Number(proxyUrl.port || 80),
            method: 'CONNECT',
            path: `${target.hostname}:${target.port || 443}`,
            timeout: CONNECT_TIMEOUT_MS,
        });
        connectRequest.on('connect', (response, socket) => {
            if (response.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`proxy CONNECT failed with ${response.statusCode}`));
                return;
            }
            resolve(socket);
        });
        connectRequest.on('error', reject);
        connectRequest.on('timeout', () => {
            connectRequest.destroy(new Error('proxy CONNECT timed out'));
        });
        connectRequest.end();
    });
}

export function createHttpsTransport(): HttpTransport {
    return {
        async send(request: NotifyRequest, proxy: string | null): Promise<HttpResult> {
            const startedAt = Date.now();
            const target = new URL(request.url);
            const socket = proxy ? await openProxyTunnel(proxy, target) : null;
            return new Promise<HttpResult>((resolve, reject) => {
                const outbound = https.request({
                    host: target.hostname,
                    port: Number(target.port || 443),
                    path: `${target.pathname}${target.search}`,
                    method: request.method,
                    headers: {
                        ...request.headers,
                        'Content-Length': Buffer.byteLength(request.body).toString(),
                    },
                    timeout: TOTAL_TIMEOUT_MS,
                    // 隧道 socket 经 createConnection 显式交给 tls.connect(文档化 API)。
                    // 注意:此时绝不能传 agent(包括 agent:false)——Node 只在未提供
                    // agent 时才使用请求级 createConnection,传了 agent 隧道会被旁路。
                    ...(socket ? {
                        createConnection: () => tls.connect({ socket, servername: target.hostname }),
                    } : {}),
                }, response => {
                    response.on('error', reject);
                    response.resume();
                    response.on('end', () => resolve({
                        statusCode: response.statusCode || 0,
                        durationMs: Date.now() - startedAt,
                        viaProxy: Boolean(proxy),
                    }));
                });
                outbound.on('error', reject);
                outbound.on('timeout', () => {
                    outbound.destroy(new Error('notification request timed out'));
                });
                outbound.end(request.body);
            });
        },
    };
}
