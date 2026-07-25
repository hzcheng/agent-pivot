'use strict';

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
    const configuration = workspace.getConfiguration('projectSteward');
    return {
        yolo: configuration.get<unknown>('aiSessionYoloMode', false) === true,
    };
}
