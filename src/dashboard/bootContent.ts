export type DashboardBootDocumentState =
    | { kind: 'booting'; generation: number }
    | { kind: 'failed'; generation: number };

export interface DashboardBootWebview {
    readonly cspSource: string;
}

function bootShellContent(): string {
    return `
        <div class="agent-pivot-boot-tab-row" data-agent-pivot-boot-tab-row aria-hidden="true">
            <span class="agent-pivot-boot-tab agent-pivot-boot-tab-active"></span>
            <span class="agent-pivot-boot-tab"></span>
            <span class="agent-pivot-boot-tab"></span>
            <span class="agent-pivot-boot-tab"></span>
        </div>
        <div class="agent-pivot-boot-card-area" data-agent-pivot-boot-card-area aria-hidden="true">
            <div class="agent-pivot-boot-placeholder"></div>
            <div class="agent-pivot-boot-placeholder"></div>
            <div class="agent-pivot-boot-placeholder"></div>
        </div>`;
}

function bootScript(state: DashboardBootDocumentState): string {
    const retryHandler = state.kind === 'failed'
        ? `
            document.getElementById('agent-pivot-boot-retry')?.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'retry-agent-pivot-bootstrap',
                    version: 1,
                });
            });`
        : '';
    return `
        (function () {
            const vscode = acquireVsCodeApi();
            requestAnimationFrame(() => {
                vscode.postMessage({
                    type: 'agent-pivot-browser-first-paint',
                    version: 1,
                    generation: ${JSON.stringify(state.generation)},
                });
            });
            ${retryHandler}
        })();`;
}

export function getDashboardBootContent(
    webview: DashboardBootWebview,
    state: DashboardBootDocumentState,
): string {
    const isBooting = state.kind === 'booting';
    const bodyContent = isBooting
        ? bootShellContent()
        : `<section class="agent-pivot-boot-failure" aria-labelledby="agent-pivot-boot-failure-title">
            <h1 id="agent-pivot-boot-failure-title">Agent Pivot could not finish starting</h1>
            <p>Please try again.</p>
            <button id="agent-pivot-boot-retry" type="button" data-action="retry">Retry</button>
        </section>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent Pivot</title>
    <style>
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        html, body { margin: 0; min-height: 100%; }
        body { background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
        .agent-pivot-boot-shell { min-height: 264px; padding: 12px; }
        .agent-pivot-boot-tab-row { display: flex; gap: 8px; height: 32px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
        .agent-pivot-boot-tab { display: block; width: 52px; height: 20px; margin-top: 4px; border-radius: 4px 4px 0 0; background: var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, .22)); }
        .agent-pivot-boot-tab-active { background: var(--vscode-editor-selectionBackground, rgba(127, 127, 127, .42)); }
        .agent-pivot-boot-card-area { height: 196px; overflow: hidden; padding-top: 12px; }
        .agent-pivot-boot-placeholder { height: 52px; margin-bottom: 10px; border-radius: 6px; background: linear-gradient(90deg, var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, .18)) 20%, var(--vscode-list-hoverBackground, rgba(127, 127, 127, .28)) 50%, var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, .18)) 80%); background-size: 200% 100%; animation: agent-pivot-boot-shimmer 1.4s ease-in-out infinite; }
        .agent-pivot-boot-failure { min-height: 264px; padding: 24px 12px; }
        .agent-pivot-boot-failure h1 { margin: 0 0 8px; font-size: 1rem; }
        .agent-pivot-boot-failure p { margin: 0 0 16px; }
        @keyframes agent-pivot-boot-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
        @media (prefers-reduced-motion: reduce) { .agent-pivot-boot-placeholder { animation-name: none; } }
    </style>
</head>
<body>
    <main class="agent-pivot-boot-shell"${isBooting ? ' aria-busy="true"' : ''}>
        ${bodyContent}
    </main>
    <script>${bootScript(state)}</script>
</body>
</html>`;
}
