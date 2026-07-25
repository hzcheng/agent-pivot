'use strict';

export interface AiSessionLaunchOptions {
    yolo: boolean;
}

interface ConfigurationReader {
    get<T>(key: string, fallback: T): T;
}

export function readAiSessionLaunchOptions(
    configuration: ConfigurationReader
): AiSessionLaunchOptions {
    return {
        yolo: configuration.get<unknown>('aiSessionYoloMode', false) === true,
    };
}
