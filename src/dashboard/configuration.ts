'use strict';

import * as vscode from 'vscode';
import { AGENT_PIVOT_CONFIG_SECTION } from '../constants';

export function getAgentPivotConfiguration(
    scope?: vscode.ConfigurationScope
): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(
        AGENT_PIVOT_CONFIG_SECTION,
        scope
    );
}
