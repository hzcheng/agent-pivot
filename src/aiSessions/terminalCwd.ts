'use strict';

import * as path from 'path';
import { lstatSync } from 'fs';
import { isUriString } from '../uriStrings';

export function getUsableTerminalCwd(cwd: string): string {
    if (!cwd || isUriString(cwd)) {
        return null;
    }

    try {
        return lstatSync(cwd).isDirectory() ? cwd : path.dirname(cwd);
    } catch (e) {
        return null;
    }
}
