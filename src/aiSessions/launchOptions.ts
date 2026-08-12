'use strict';

import { AGENT_PIVOT_CONFIG_SECTION } from '../constants';
import { sanitizeCodexProfileName } from './codexProfileNames';

export interface AiSessionLaunchOptions {
    yolo: boolean;
    /**
     * Effective Codex configuration profile for this launch (`-p <name>`).
     * Resolved per session from the recorded/selected profile decision;
     * never read from settings inside command builders.
     */
    codexProfile?: string;
}

interface ConfigurationReader {
    get<T>(key: string, fallback: T): T;
}

interface WorkspaceConfigurationProvider {
    getConfiguration(section: string): ConfigurationReader;
}

export function readAiSessionLaunchOptions(
    workspace: WorkspaceConfigurationProvider
): AiSessionLaunchOptions {
    const configuration = workspace.getConfiguration(AGENT_PIVOT_CONFIG_SECTION);
    return {
        yolo: configuration.get<unknown>('aiSessionYoloMode', false) === true,
    };
}

/**
 * Reads the configured default Codex profile. This setting only feeds the
 * NEW session flow (picker default / fallback); resumed sessions always use
 * the profile decision recorded at creation time.
 */
export function readCodexDefaultProfile(
    workspace: WorkspaceConfigurationProvider
): string | undefined {
    const configuration = workspace.getConfiguration(AGENT_PIVOT_CONFIG_SECTION);
    return sanitizeCodexProfileName(configuration.get<unknown>('codexDefaultProfile', '')) || undefined;
}
