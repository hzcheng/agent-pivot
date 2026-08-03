const { spawn } = require('child_process');
const child = spawn('kimi', ['--wire', '--work-dir', '/tmp/wire-spike'], { stdio: ['pipe', 'pipe', 'pipe'] });
const events = [];
let buffer = '';
child.stdout.on('data', d => {
    buffer += d.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const msg = JSON.parse(line);
            if (msg.method === 'event') {
                const type = msg.params?.message?.type || msg.params?.type;
                events.push(type);
                console.log('event:', type, JSON.stringify(msg.params).slice(0, 120));
            } else if (msg.result !== undefined || msg.error) {
                console.log('response id=' + msg.id, JSON.stringify(msg.result || msg.error).slice(0, 200));
            } else {
                console.log('other:', JSON.stringify(msg).slice(0, 150));
            }
        } catch { console.log('raw:', line.slice(0, 150)); }
    }
});
child.stderr.on('data', d => console.log('[stderr]', d.toString().trim().slice(0, 200)));
setTimeout(() => child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', method: 'initialize', id: 'init-1',
    params: { protocol_version: '1.10', client: { name: 'agent-pivot-spike', version: '0.1' } },
}) + '\n'), 800);
setTimeout(() => child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', method: 'prompt', id: 'prompt-1',
    params: { user_input: '只回复两个字：收到' },
}) + '\n'), 2500);
setTimeout(() => { console.log('--- 事件序列:', events.join(' → ')); child.kill('SIGTERM'); process.exit(0); }, 40000);
