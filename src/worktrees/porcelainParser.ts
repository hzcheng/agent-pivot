'use strict';

const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RECORDS = 4096;

export interface WorktreePorcelainRecord {
    worktreePath: string;
    head: string;
    branchRef?: string;
    bare: boolean;
    detached: boolean;
    locked: boolean;
    prunable: boolean;
}

export interface WorktreePorcelainParserOptions {
    maxInputBytes?: number;
    maxRecords?: number;
}

export class WorktreePorcelainParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorktreePorcelainParseError';
        Object.setPrototypeOf(this, WorktreePorcelainParseError.prototype);
    }
}

/** Parses both LF-delimited porcelain and the Git 2.36+ NUL form. */
export function parseWorktreePorcelain(
    input: string,
    options: WorktreePorcelainParserOptions = {}
): WorktreePorcelainRecord[] {
    if (typeof input !== 'string') {
        throw new WorktreePorcelainParseError('Worktree porcelain output must be text.');
    }
    const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    if (Buffer.byteLength(input, 'utf8') > maxInputBytes) {
        throw new WorktreePorcelainParseError('Worktree porcelain output exceeded the size limit.');
    }
    const rawRecords = input.includes('\0')
        ? splitNulRecords(input)
        : splitLineRecords(input);
    const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (rawRecords.length > maxRecords) {
        throw new WorktreePorcelainParseError('Worktree porcelain output exceeded the record limit.');
    }
    return rawRecords.map((fields, index) => parseRecord(fields, index));
}

function splitNulRecords(input: string): string[][] {
    const records: string[][] = [];
    let fields: string[] = [];
    for (const token of input.split('\0')) {
        if (!token) {
            if (fields.length) {
                records.push(fields);
                fields = [];
            }
            continue;
        }
        fields.push(token.replace(/\r?\n$/, ''));
    }
    if (fields.length) {
        records.push(fields);
    }
    return records;
}

function splitLineRecords(input: string): string[][] {
    const records: string[][] = [];
    let fields: string[] = [];
    for (const line of input.split(/\r?\n/)) {
        if (!line) {
            if (fields.length) {
                records.push(fields);
                fields = [];
            }
            continue;
        }
        fields.push(line);
    }
    if (fields.length) {
        records.push(fields);
    }
    return records;
}

function parseRecord(fields: readonly string[], index: number): WorktreePorcelainRecord {
    const values = new Map<string, string>();
    const flags = new Set<string>();
    for (const field of fields) {
        const separator = field.indexOf(' ');
        const name = separator < 0 ? field : field.slice(0, separator);
        const value = separator < 0 ? '' : field.slice(separator + 1);
        if (!name || (values.has(name) || flags.has(name))) {
            throw new WorktreePorcelainParseError(
                `Worktree porcelain record ${index + 1} contains a duplicate or empty field.`
            );
        }
        if (separator < 0) {
            flags.add(name);
        } else {
            values.set(name, value);
        }
    }
    const encodedWorktreePath = values.get('worktree');
    if (!encodedWorktreePath) {
        throw new WorktreePorcelainParseError(
            `Worktree porcelain record ${index + 1} has no worktree path.`
        );
    }
    const worktreePath = decodeGitQuotedPath(encodedWorktreePath, index);
    const bare = flags.has('bare');
    const head = values.get('HEAD') || '';
    if (!bare && !head) {
        throw new WorktreePorcelainParseError(
            `Worktree porcelain record ${index + 1} has no HEAD.`
        );
    }
    return {
        worktreePath,
        head,
        ...(values.has('branch') ? { branchRef: values.get('branch') } : {}),
        bare,
        detached: flags.has('detached'),
        locked: flags.has('locked') || values.has('locked'),
        prunable: flags.has('prunable') || values.has('prunable'),
    };
}

function decodeGitQuotedPath(value: string, recordIndex: number): string {
    if (!value.startsWith('"')) {
        return value;
    }
    if (!value.endsWith('"') || value.length < 2) {
        throw new WorktreePorcelainParseError(
            `Worktree porcelain record ${recordIndex + 1} has an invalid quoted path.`
        );
    }
    const decoded: Buffer[] = [];
    const body = value.slice(1, -1);
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index];
        if (character !== '\\') {
            decoded.push(Buffer.from(character, 'utf8'));
            continue;
        }
        index += 1;
        const escape = body[index];
        if (escape === undefined) {
            throw new WorktreePorcelainParseError(
                `Worktree porcelain record ${recordIndex + 1} has an invalid path escape.`
            );
        }
        const simpleEscapes: Record<string, number> = {
            a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13,
            '\\': 92, '"': 34,
        };
        if (Object.prototype.hasOwnProperty.call(simpleEscapes, escape)) {
            decoded.push(Buffer.from([simpleEscapes[escape]]));
            continue;
        }
        if (/[0-7]/.test(escape)) {
            const octal = body.slice(index, index + 3);
            if (!/^[0-7]{3}$/.test(octal)) {
                throw new WorktreePorcelainParseError(
                    `Worktree porcelain record ${recordIndex + 1} has an invalid octal path escape.`
                );
            }
            decoded.push(Buffer.from([parseInt(octal, 8)]));
            index += 2;
            continue;
        }
        throw new WorktreePorcelainParseError(
            `Worktree porcelain record ${recordIndex + 1} has an unsupported path escape.`
        );
    }
    return Buffer.concat(decoded).toString('utf8');
}
