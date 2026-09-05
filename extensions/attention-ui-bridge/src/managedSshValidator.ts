'use strict';

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ManagedSshProjectionEntry } from '../../../src/projects/managedRemote/sshConfigProjection';

export interface ManagedSshCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export interface ManagedSshCommandRunner {
    run(executable: string, args: string[], timeoutMs: number): Promise<ManagedSshCommandResult>;
}

export interface ManagedSshValidationInput {
    executable: string;
    aggregateConfigContent: string;
    entries: ManagedSshProjectionEntry[];
}

export interface ManagedSshProjectionValidationService {
    probe(executable: string): Promise<void>;
    validate(input: ManagedSshValidationInput): Promise<void>;
}

export class NodeManagedSshCommandRunner implements ManagedSshCommandRunner {
    run(executable: string, args: string[], timeoutMs: number): Promise<ManagedSshCommandResult> {
        return new Promise(resolve => {
            execFile(executable, args, {
                timeout: timeoutMs,
                windowsHide: true,
                maxBuffer: 4 * 1024 * 1024,
            }, (error, stdout, stderr) => {
                const exitCode = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
                    ? (error as NodeJS.ErrnoException & { code: number }).code
                    : error ? -1 : 0;
                resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
            });
        });
    }
}

function parseEffectiveConfig(stdout: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/u)) {
        const separator = line.search(/\s/u);
        if (separator <= 0) { continue; }
        const key = line.slice(0, separator).toLowerCase();
        if (!result.has(key)) { result.set(key, line.slice(separator).trim()); }
    }
    return result;
}

function hostEquals(actual: string | undefined, expected: string): boolean {
    return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
}

function isDisabledRoute(value: string | undefined): boolean {
    return value === undefined || value === 'none';
}

function isSafeBoolean(value: string | undefined, safeValues: string[]): boolean {
    return value === undefined || safeValues.includes(value);
}

function hasUnsafeInheritedBehavior(config: Map<string, string>): boolean {
    return [
        'localforward',
        'remoteforward',
        'dynamicforward',
    ].some(key => config.has(key))
        || !isDisabledRoute(config.get('remotecommand'))
        || !isSafeBoolean(config.get('requesttty'), ['auto', 'no'])
        || !isSafeBoolean(config.get('tunnel'), ['false', 'no'])
        || !isSafeBoolean(config.get('forkafterauthentication'), ['no'])
        || !isSafeBoolean(config.get('stdinnull'), ['no'])
        || !isSafeBoolean(config.get('forwardagent'), ['no'])
        || !isSafeBoolean(config.get('forwardx11'), ['no'])
        || !isSafeBoolean(config.get('gatewayports'), ['no'])
        || !isSafeBoolean(config.get('controlmaster'), ['false', 'no'])
        || !isDisabledRoute(config.get('controlpath'))
        || !isDisabledRoute(config.get('knownhostscommand'))
        || !isDisabledRoute(config.get('hostkeyalias'));
}

/**
 * OpenSSH reports the offending file, line, and directive on stderr. Dropping
 * it leaves an unactionable failure, so the first stderr line and the exit
 * code are carried into the message. Only OpenSSH's own diagnostic text is
 * included; the config content itself is never echoed.
 */
function diagnosticSuffix(result: ManagedSshCommandResult): string {
    const detail = `${result.stderr}`
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line && !/^Pseudo-terminal/u.test(line))[0];
    return detail
        ? ` OpenSSH exited ${result.exitCode}: ${detail.slice(0, 300)}`
        : ` OpenSSH exited ${result.exitCode} without a diagnostic.`;
}

function assertEffectiveTarget(
    entry: ManagedSshProjectionEntry,
    result: ManagedSshCommandResult,
    phase: string,
): void {
    if (result.exitCode !== 0) {
        throw new Error(
            `OpenSSH ${phase} validation failed for ${entry.machineId}.`
            + diagnosticSuffix(result),
        );
    }
    const config = parseEffectiveConfig(result.stdout);
    const mismatch = !hostEquals(config.get('hostname'), entry.host) ? 'hostname'
        : config.get('user') !== entry.user ? 'user'
            : config.get('port') !== String(entry.port) ? 'port'
                : !isDisabledRoute(config.get('proxyjump')) ? 'proxyjump'
                    : !isDisabledRoute(config.get('proxycommand')) ? 'proxycommand'
                        : config.get('permitlocalcommand') !== 'no' ? 'permitlocalcommand'
                            : hasUnsafeInheritedBehavior(config) ? 'inherited-behavior'
                                : '';
    if (mismatch) {
        throw new Error(
            `OpenSSH ${phase} resolved an unsafe target for ${entry.machineId}`
            + ` (${mismatch}).`,
        );
    }
}

export class ManagedSshProjectionValidator implements ManagedSshProjectionValidationService {
    constructor(
        private readonly runner: ManagedSshCommandRunner = new NodeManagedSshCommandRunner(),
        private readonly timeoutMs = 3_000,
    ) {
    }

    async probe(executable: string): Promise<void> {
        const result = await this.runner.run(executable, ['-V'], this.timeoutMs);
        const output = `${result.stdout}\n${result.stderr}`;
        if (result.exitCode !== 0 || !/OpenSSH/i.test(output)) {
            throw new Error('The configured SSH executable is not a supported OpenSSH client.');
        }
    }

    async validate(input: ManagedSshValidationInput): Promise<void> {
        await this.probe(input.executable);
        const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-ssh-validate-'));
        const aggregatePath = path.join(temporaryRoot, 'config');
        try {
            fs.writeFileSync(aggregatePath, input.aggregateConfigContent, { mode: 0o600 });
            await Promise.all(input.entries.map(async entry => {
                const aggregate = await this.runner.run(
                    input.executable,
                    ['-F', aggregatePath, '-G', entry.alias],
                    this.timeoutMs,
                );
                assertEffectiveTarget(entry, aggregate, 'aggregate');
            }));
        } finally {
            try { fs.unlinkSync(aggregatePath); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            }
            fs.rmdirSync(temporaryRoot);
        }
    }
}
