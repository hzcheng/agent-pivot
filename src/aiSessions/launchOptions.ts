'use strict';

import { AGENT_PIVOT_CONFIG_SECTION } from '../constants';

export interface AiSessionLaunchOptions {
    yolo: boolean;
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
