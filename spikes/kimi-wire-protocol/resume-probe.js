const { spawn } = require('child_process');
const sessionId = process.argv[2];
const child = spawn('kimi', ['--wire', '--resume', sessionId, '--work-dir', process.cwd()], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
child.stdout.on('data', d => {
    buffer += d.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const msg = JSON.parse(line);
            if (msg.method === 'event') console.log('event:', msg.params?.type);
            else console.log('msg:', JSON.stringify(msg).slice(0, 200));
        } catch { console.log('raw:', line.slice(0, 150)); }
    }
});
child.stderr.on('data', d => console.log('[stderr]', d.toString().trim().slice(0, 300)));
setTimeout(() => child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', method: 'initialize', id: 'init-1',
    params: { protocol_version: '1.10', client: { name: 'agent-pivot-spike', version: '0.1' } },
}) + '\n'), 800);
setTimeout(() => child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', method: 'replay', id: 'replay-1', params: null,
}) + '\n'), 2500);
setTimeout(() => { child.kill('SIGTERM'); process.exit(0); }, 20000);
