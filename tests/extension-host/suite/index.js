'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');

const MAIN_EXTENSION_ID = 'hzcheng.agent-pivot';
const BRIDGE_EXTENSION_ID = 'hzcheng.agent-pivot-attention-ui-bridge';
const PUBLIC_COMMANDS = [
    'agentPivot.open',
    'agentPivot.addProject',
    'agentPivot.saveProject',
    'agentPivot.removeProject',
    'agentPivot.editProjects',
    'agentPivot.addGroup',
    'agentPivot.removeGroup',
    'agentPivot.addProjectsFromFolder',
    'agentPivot.addFileToActiveTerminal',
    'agentPivot.insertPromptToActiveTerminal',
];

async function verifyExtensionHostLifecycle() {
    const mainExtension = vscode.extensions.getExtension(MAIN_EXTENSION_ID);
    const bridgeExtension = vscode.extensions.getExtension(BRIDGE_EXTENSION_ID);
    assert.ok(mainExtension, `${MAIN_EXTENSION_ID} must be discoverable in the Extension Host`);
    assert.ok(bridgeExtension, `${BRIDGE_EXTENSION_ID} must be discoverable in the Extension Host`);
    assert.deepEqual(mainExtension.packageJSON.extensionDependencies, [BRIDGE_EXTENSION_ID],
        `${MAIN_EXTENSION_ID} extensionDependencies must contain only ${BRIDGE_EXTENSION_ID}`);
    assert.deepEqual(bridgeExtension.packageJSON.extensionKind, ['ui'],
        `${BRIDGE_EXTENSION_ID} must remain a UI extension`);

    await mainExtension.activate();
    assert.equal(mainExtension.isActive, true, `${MAIN_EXTENSION_ID} must activate`);
    assert.equal(bridgeExtension.isActive, true,
        `${BRIDGE_EXTENSION_ID} must be active after main activation`);
    // WEBVIEW-DASHBOARD-COMMAND-AVAILABILITY-001
    const availableCommands = new Set(await vscode.commands.getCommands(true));
    assert.deepEqual(
        PUBLIC_COMMANDS.filter(command => !availableCommands.has(command)),
        [],
        'every public Agent Pivot command must be registered when activation returns'
    );

    await vscode.commands.executeCommand('agentPivot.open');
    await vscode.commands.executeCommand('agentPivot.dashboard.focus');
}

// RELEASE-SCHEDULED-EXTENSION-HOST-001
async function run() {
    const timeoutMs = Number(process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
        'Extension Host timeout must be a positive integer');
    let timeout;
    try {
        await Promise.race([
            verifyExtensionHostLifecycle(),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(
                    `Extension Host lifecycle exceeded ${timeoutMs} ms`
                )), timeoutMs);
            }),
        ]);
        console.log(`RELEASE-SCHEDULED-EXTENSION-HOST-001 passed on VS Code ${vscode.version}.`);
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { run };
