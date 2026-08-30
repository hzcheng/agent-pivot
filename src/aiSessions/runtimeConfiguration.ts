'use strict';

import type { AiSessionRuntimeConfiguration } from './runtimeTypes';

interface ConfigurationReader {
    get<T>(key: string, fallback: T): T;
}

export function readAiSessionRuntimeConfiguration(configuration: ConfigurationReader): AiSessionRuntimeConfiguration {
    const mode = configuration.get<unknown>('aiSessionTerminalMode', 'auto');
    const tmuxLayout = configuration.get<unknown>('aiSessionTmuxLayout', 'project');
    const configuredTmuxPath = configuration.get<unknown>('aiSessionTmuxPath', 'tmux');
    const tmuxPath = typeof configuredTmuxPath === 'string' ? configuredTmuxPath.trim() : '';

    return {
        mode: mode === 'vscode' || mode === 'tmux' ? mode : 'auto',
        tmuxLayout: tmuxLayout === 'session' ? 'session' : 'project',
        tmuxPath: tmuxPath || 'tmux',
    };
}
