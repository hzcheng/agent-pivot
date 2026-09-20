'use strict';
import { runCodexTerminal } from './codexTerminal';
void runCodexTerminal(JSON.parse(process.argv[2] || 'null')).then(code => {
    process.exitCode = code;
}).catch(() => {
    process.stderr.write('[Agent Pivot] Could not start the Codex streaming terminal. The existing chat history is unchanged.\n');
    process.exitCode = 1;
});
