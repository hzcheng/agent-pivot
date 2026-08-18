'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBehaviorCatalog, validateBehaviorCatalog } = require('./lib/behaviorCatalog');
const {
    collectAuditedCommits,
    collectUnauditedCommits,
    isDocumentationPath,
    loadMainCapabilityCoverage,
    loadWorkflowSources,
    validateMainCapabilityCoverage,
} = require('./lib/mainCapabilityCoverage');

const COVERAGE_RELATIVE_PATH = path.join('docs', 'testing', 'main-capability-coverage.json');
const CONTRACTS_RELATIVE_PATH = path.join('docs', 'testing', 'behavior-contracts.json');

const USAGE = `Usage: node scripts/regenerate-capability-audit.js \\
  --assign <full-or-short-sha>=<CAPABILITY-ID> [--assign ...] \\
  [--behavior <CAPABILITY-ID>=<BEHAVIOR-ID>] \\
  --harvest none|updated:<comma-separated .skills/paths> \\
  [--commit "docs: audit message"] [--dry-run]

Regenerates docs/testing/main-capability-coverage.json after a rebase or a new
implementation commit: every commit in audit.base..HEAD is classified exactly
once -- assigned to a capability with --assign, or auto-registered into
audit.ignoredDocumentationCommits when it changes only documentation paths.
Merge commits need no classification. audit.head advances to the last
implementation commit in range, which must be one of the --assign targets.
Every regeneration records the skill harvest review: --harvest none when no
skill change was justified, or --harvest updated:<paths> listing the iterated
.skills/ directories. The decision becomes a Skill-Harvest trailer in the
audit commit message.`;

class AuditRegenerationError extends Error {
    constructor(messages) {
        super(Array.isArray(messages) ? messages.join('\n') : messages);
        this.messages = Array.isArray(messages) ? messages : [messages];
    }
}

function git(repositoryRoot, args) {
    return childProcess.execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
    }).trim();
}

function resolveCommit(repositoryRoot, value) {
    try {
        return git(repositoryRoot, ['rev-parse', '--verify', `${value}^{commit}`]);
    } catch (_error) {
        return null;
    }
}

function listRange(repositoryRoot, base, head = 'HEAD') {
    const output = git(repositoryRoot, ['rev-list', '--reverse', `${base}..${head}`]);
    return output ? output.split(/\r?\n/u).filter(Boolean) : [];
}

function commitSubject(repositoryRoot, hash) {
    return git(repositoryRoot, ['show', '-s', '--format=%s', hash]);
}

function isAncestor(repositoryRoot, maybeAncestor, descendant) {
    try {
        git(repositoryRoot, ['merge-base', '--is-ancestor', maybeAncestor, descendant]);
        return true;
    } catch (_error) {
        return false;
    }
}

function commitFiles(repositoryRoot, hash) {
    const output = git(repositoryRoot, [
        'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', hash,
    ]);
    return output ? output.split(/\r?\n/u).filter(Boolean) : [];
}

function parseArguments(argv) {
    const options = {
        assignments: [],
        behaviors: [],
        commitMessage: null,
        dryRun: false,
        harvest: null,
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--assign' || argument === '--behavior') {
            const value = argv[++index];
            if (!value || !value.includes('=')) {
                throw new AuditRegenerationError(`${argument} expects <sha-or-capability>=<id>, got "${value}"`);
            }
            const [left, ...rest] = value.split('=');
            const record = { left: left.trim(), right: rest.join('=').trim() };
            if (!record.left || !record.right) {
                throw new AuditRegenerationError(`${argument} expects non-empty sides, got "${value}"`);
            }
            (argument === '--assign' ? options.assignments : options.behaviors).push(record);
            continue;
        }
        if (argument === '--commit') {
            const value = argv[++index];
            if (!value) {
                throw new AuditRegenerationError('--commit expects a message');
            }
            options.commitMessage = value;
            continue;
        }
        if (argument === '--harvest') {
            const value = argv[++index];
            if (!value) {
                throw new AuditRegenerationError(
                    '--harvest expects none or updated:<comma-separated .skills/paths>'
                );
            }
            options.harvest = value;
            continue;
        }
        if (argument === '--dry-run') {
            options.dryRun = true;
            continue;
        }
        throw new AuditRegenerationError(`unknown argument: ${argument}\n${USAGE}`);
    }
    return options;
}

function findMatchingBracket(text, openIndex) {
    let depth = 0;
    let inString = false;
    for (let index = openIndex; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (char === '\\') {
                index++;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === '[') {
            depth++;
        } else if (char === ']') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    throw new AuditRegenerationError('unbalanced JSON array in the coverage manifest');
}

/** Appends one JSON string element to an array, preserving the file's indentation. */
function appendJsonStringToArray(text, openBracketIndex, value) {
    const closeIndex = findMatchingBracket(text, openBracketIndex);
    let last = closeIndex - 1;
    while (last > openBracketIndex && /\s/u.test(text[last])) {
        last--;
    }
    if (last === openBracketIndex) {
        const lineStart = text.lastIndexOf('\n', openBracketIndex) + 1;
        const baseIndent = /^\s*/u.exec(text.slice(lineStart, openBracketIndex))[0];
        const indent = `${baseIndent}    `;
        return text.slice(0, openBracketIndex + 1)
            + `\n${indent}${JSON.stringify(value)}\n${baseIndent}`
            + text.slice(closeIndex);
    }
    const lineStart = text.lastIndexOf('\n', last) + 1;
    const indent = /^\s*/u.exec(text.slice(lineStart))[0];
    return text.slice(0, last + 1)
        + `,\n${indent}${JSON.stringify(value)}`
        + text.slice(last + 1);
}

function uniqueIndexOf(text, needle, label) {
    const first = text.indexOf(needle);
    if (first < 0 || text.indexOf(needle, first + 1) >= 0) {
        throw new AuditRegenerationError(`${label} must appear exactly once in the coverage manifest`);
    }
    return first;
}

function arrayOpenIndex(text, keyNeedle, fromIndex, label) {
    const keyIndex = text.indexOf(keyNeedle, fromIndex);
    if (keyIndex < 0) {
        throw new AuditRegenerationError(`${label} is missing from the coverage manifest`);
    }
    return text.indexOf('[', keyIndex);
}

/**
 * Normalizes the mandatory skill harvest decision. Returns { kind: 'none' }
 * or { kind: 'updated', skills: [...] }; every problem is pushed into errors.
 */
function normalizeHarvestDecision(repositoryRoot, rawValue, errors) {
    if (rawValue === null || rawValue === undefined) {
        errors.push('--harvest is required: record the skill harvest review as'
            + ' --harvest none or --harvest updated:<comma-separated .skills/paths>');
        return { kind: 'none' };
    }
    const value = String(rawValue).trim();
    if (value === 'none') {
        return { kind: 'none' };
    }
    if (!value.startsWith('updated:')) {
        errors.push(`--harvest expects none or updated:<paths>, got "${value}"`);
        return { kind: 'none' };
    }
    const skills = value.slice('updated:'.length).split(',')
        .map(entry => entry.trim()).filter(Boolean);
    if (skills.length === 0) {
        errors.push('--harvest updated: expects at least one .skills/ path');
        return { kind: 'none' };
    }
    for (const skillPath of skills) {
        if (!skillPath.startsWith('.skills/')) {
            errors.push(`--harvest updated: path ${skillPath} must live under .skills/`);
            continue;
        }
        if (!fs.existsSync(path.join(repositoryRoot, skillPath))) {
            errors.push(`--harvest updated: path ${skillPath} does not exist`);
        }
    }
    return { kind: 'updated', skills };
}

function harvestTrailer(decision) {
    return decision.kind === 'updated'
        ? `Skill-Harvest: updated ${decision.skills.join(', ')}`
        : 'Skill-Harvest: none';
}

/**
 * Classifies every commit in audit.base..HEAD and plans the manifest edits.
 * Throws AuditRegenerationError listing every refusal reason.
 */
function planCapabilityAudit(repositoryRoot, cli) {
    const errors = [];
    const harvestDecision = normalizeHarvestDecision(repositoryRoot, cli.harvest, errors);
    const coveragePath = path.join(repositoryRoot, COVERAGE_RELATIVE_PATH);
    const manifest = loadMainCapabilityCoverage(coveragePath);
    const behaviorEntries = loadBehaviorCatalog(path.join(repositoryRoot, CONTRACTS_RELATIVE_PATH));
    const capabilitiesById = new Map(manifest.capabilities.map(capability => [capability.id, capability]));
    const behaviorIds = new Set(behaviorEntries.map(entry => entry.id));

    const assignments = new Map();
    for (const { left, right } of cli.assignments) {
        const hash = resolveCommit(repositoryRoot, left);
        if (!hash) {
            errors.push(`--assign ${left}=${right}: cannot resolve commit ${left}`);
            continue;
        }
        if (!capabilitiesById.has(right)) {
            errors.push(`--assign ${left}=${right}: unknown capability ${right}`);
            continue;
        }
        if (assignments.has(hash)) {
            errors.push(`--assign ${left}=${right}: commit ${hash} is assigned more than once`);
            continue;
        }
        assignments.set(hash, { hash, capabilityId: right });
    }
    for (const { left, right } of cli.behaviors) {
        if (!capabilitiesById.has(left)) {
            errors.push(`--behavior ${left}=${right}: unknown capability ${left}`);
            continue;
        }
        if (!behaviorIds.has(right)) {
            errors.push(`--behavior ${left}=${right}: unknown behavior ${right}`);
            continue;
        }
        if (capabilitiesById.get(left).behaviors.includes(right)) {
            errors.push(`--behavior ${left}=${right}: ${left} already lists behavior ${right}`);
        }
    }

    const alreadyAssigned = new Map();
    for (const capability of manifest.capabilities) {
        for (const hash of capability.commits) {
            alreadyAssigned.set(hash, capability.id);
        }
    }
    const alreadyIgnored = new Set(manifest.audit.ignoredDocumentationCommits);

    // The unprocessed range: commits beyond the recorded audit head. Older
    // history is already classified (the post-write validation re-proves the
    // complete base..newHead range); reclassifying it would churn the manifest.
    const range = listRange(repositoryRoot, manifest.audit.head);
    const commits = range.map(hash => ({
        hash,
        subject: commitSubject(repositoryRoot, hash),
        files: commitFiles(repositoryRoot, hash),
    }));
    const inRange = new Set(range);
    for (const { hash, capabilityId } of assignments.values()) {
        if (!inRange.has(hash)) {
            errors.push(`--assign ${hash}=${capabilityId}: commit ${hash} is outside the newly audited range`);
        }
        if (alreadyAssigned.has(hash)) {
            errors.push(`--assign ${hash}=${capabilityId}: commit ${hash} is already assigned to ${alreadyAssigned.get(hash)}`);
        }
    }

    const pendingDocsToIgnore = [];
    const unassigned = [];
    const assignedInRange = [];
    for (const commit of commits) {
        if (alreadyAssigned.has(commit.hash) || alreadyIgnored.has(commit.hash) || commit.files.length === 0) {
            continue;
        }
        if (commit.files.every(isDocumentationPath)) {
            if (!assignments.has(commit.hash)) {
                pendingDocsToIgnore.push(commit);
                continue;
            }
            errors.push(`--assign ${commit.hash}=${assignments.get(commit.hash).capabilityId}`
                + `: commit ${commit.hash} changes only documentation paths; it must be ignored, not assigned`);
            continue;
        }
        if (assignments.has(commit.hash)) {
            assignedInRange.push(commit.hash);
            continue;
        }
        unassigned.push(commit);
    }
    for (const commit of unassigned) {
        errors.push(`unassigned implementation commit ${commit.hash}: ${commit.subject}`);
    }

    const implementationCommits = commits.filter(commit =>
        commit.files.some(file => !isDocumentationPath(file)));
    const lastImplementation = implementationCommits[implementationCommits.length - 1] || null;
    let newHead = manifest.audit.head;
    if (lastImplementation) {
        if (!assignments.has(lastImplementation.hash)) {
            errors.push(`last implementation commit ${lastImplementation.hash} (${lastImplementation.subject})`
                + ' must be one of the --assign targets');
        }
        newHead = lastImplementation.hash;
    } else if (range.length) {
        newHead = range[range.length - 1];
    }
    if (errors.length) {
        throw new AuditRegenerationError(errors);
    }
    // Rebase residue (review R7 follow-up): a rebase rewrites commit SHAs, so
    // assignments and documentation exemptions recorded against pre-rebase
    // SHAs fall outside the audited range and would fail the post-write
    // validation. Prune them from the regenerated manifest; the rebased
    // commits arrive through fresh --assign targets.
    const auditedHashes = new Set(listRange(repositoryRoot, manifest.audit.base, newHead));
    const staleAssignments = [];
    for (const capability of manifest.capabilities) {
        for (const hash of capability.commits) {
            if (!auditedHashes.has(hash)) {
                staleAssignments.push({ capabilityId: capability.id, hash });
            }
        }
    }
    const staleExemptions = (manifest.audit.ignoredDocumentationCommits || [])
        .filter(hash => !auditedHashes.has(hash));
    // Only documentation commits covered by the new head may be registered:
    // an exemption outside the audited range is itself a validation error.
    // Tail documentation commits beyond the head stay unregistered until a
    // later regeneration advances the head past them.
    const docsToIgnore = [];
    const deferredDocs = [];
    for (const commit of pendingDocsToIgnore) {
        (isAncestor(repositoryRoot, commit.hash, newHead) ? docsToIgnore : deferredDocs).push(commit);
    }
    return {
        coveragePath,
        manifest,
        newHead,
        docsToIgnore,
        deferredDocs,
        assignedInRange,
        staleAssignments,
        staleExemptions,
        assignments,
        harvestDecision,
        behaviorAdditions: cli.behaviors.map(({ left, right }) => ({ capabilityId: left, behaviorId: right })),
    };
}

/** Removes one JSON string element from an array, preserving formatting. */
function removeJsonStringFromArray(text, value) {
    const needle = JSON.stringify(value);
    const index = text.indexOf(needle);
    if (index < 0) {
        throw new AuditRegenerationError(`could not find ${needle} to prune`);
    }
    const afterIndex = index + needle.length;
    const trailing = /^[ \t]*,\r?\n[ \t]*/.exec(text.slice(afterIndex));
    if (trailing) {
        // Not the last element: drop the value, comma, and line break.
        return text.slice(0, index) + text.slice(afterIndex + trailing[0].length);
    }
    const preceding = /,[ \t]*\r?\n[ \t]*$/.exec(text.slice(0, index));
    if (preceding) {
        // Last element: drop the preceding comma and line break as well.
        return text.slice(0, index - preceding[0].length) + text.slice(afterIndex);
    }
    // Only element: collapse to an empty array.
    const openIndex = text.lastIndexOf('[', index);
    const closeIndex = findMatchingBracket(text, openIndex);
    return text.slice(0, openIndex + 1) + text.slice(closeIndex);
}

/** Applies the planned edits text-surgically, preserving manifest formatting. */
function applyCapabilityAuditPlan(originalText, plan) {
    let text = originalText;
    text = text.replace(
        `"head": "${plan.manifest.audit.head}"`,
        `"head": "${plan.newHead}"`
    );
    if (!text.includes(`"head": "${plan.newHead}"`)) {
        throw new AuditRegenerationError('could not replace audit.head in the coverage manifest');
    }
    for (const { hash } of plan.staleAssignments || []) {
        text = removeJsonStringFromArray(text, hash);
    }
    for (const hash of plan.staleExemptions || []) {
        text = removeJsonStringFromArray(text, hash);
    }
    for (const commit of plan.docsToIgnore) {
        const openIndex = arrayOpenIndex(text, '"ignoredDocumentationCommits"', 0, 'audit.ignoredDocumentationCommits');
        text = appendJsonStringToArray(text, openIndex, commit.hash);
    }
    for (const hash of plan.assignedInRange) {
        const { capabilityId } = plan.assignments.get(hash);
        const idIndex = uniqueIndexOf(text, `"id": "${capabilityId}"`, `capability ${capabilityId}`);
        const openIndex = arrayOpenIndex(text, '"commits"', idIndex, `${capabilityId}.commits`);
        text = appendJsonStringToArray(text, openIndex, hash);
    }
    for (const { capabilityId, behaviorId } of plan.behaviorAdditions) {
        const idIndex = uniqueIndexOf(text, `"id": "${capabilityId}"`, `capability ${capabilityId}`);
        const openIndex = arrayOpenIndex(text, '"behaviors"', idIndex, `${capabilityId}.behaviors`);
        text = appendJsonStringToArray(text, openIndex, behaviorId);
    }
    return text;
}

function validateManifest(repositoryRoot, coveragePath) {
    const manifest = loadMainCapabilityCoverage(coveragePath);
    const behaviorEntries = loadBehaviorCatalog(path.join(repositoryRoot, CONTRACTS_RELATIVE_PATH));
    const errors = [
        ...validateBehaviorCatalog(behaviorEntries, { repositoryRoot }),
        ...validateMainCapabilityCoverage(manifest, {
            repositoryRoot,
            behaviors: behaviorEntries,
            scripts: require(path.join(repositoryRoot, 'package.json')).scripts,
            workflows: loadWorkflowSources(repositoryRoot),
            auditedCommits: collectAuditedCommits(repositoryRoot, manifest.audit),
            unauditedCommits: collectUnauditedCommits(repositoryRoot, manifest.audit),
        }),
    ];
    return errors;
}

function printPlannedDiff(originalText, editedText, output) {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-audit-'));
    try {
        fs.mkdirSync(path.join(temporaryDirectory, 'a'));
        fs.mkdirSync(path.join(temporaryDirectory, 'b'));
        fs.writeFileSync(path.join(temporaryDirectory, 'a', 'main-capability-coverage.json'), originalText);
        fs.writeFileSync(path.join(temporaryDirectory, 'b', 'main-capability-coverage.json'), editedText);
        const result = childProcess.spawnSync('git', [
            'diff', '--no-index', '--no-prefix', '--',
            'a/main-capability-coverage.json',
            'b/main-capability-coverage.json',
        ], { cwd: temporaryDirectory, encoding: 'utf8' });
        output(result.stdout || '');
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

function summarizePlan(plan, output) {
    output(`audit.head: ${plan.manifest.audit.head} -> ${plan.newHead}`);
    for (const hash of plan.assignedInRange) {
        output(`assign ${hash} -> ${plan.assignments.get(hash).capabilityId}`);
    }
    for (const { capabilityId, hash } of plan.staleAssignments || []) {
        output(`prune stale assignment ${hash} from ${capabilityId} (rewritten by rebase)`);
    }
    for (const hash of plan.staleExemptions || []) {
        output(`prune stale documentation exemption ${hash} (rewritten by rebase)`);
    }
    for (const commit of plan.docsToIgnore) {
        output(`ignore documentation commit ${commit.hash}: ${commit.subject}`);
    }
    for (const commit of plan.deferredDocs) {
        output(`defer documentation commit ${commit.hash} (not covered by the new head): ${commit.subject}`);
    }
    for (const { capabilityId, behaviorId } of plan.behaviorAdditions) {
        output(`behavior ${capabilityId} += ${behaviorId}`);
    }
    output(`harvest: ${plan.harvestDecision.kind === 'updated'
        ? `updated ${plan.harvestDecision.skills.join(', ')}`
        : 'none'}`);
}

function regenerateCapabilityAudit(repositoryRoot, cli, output = () => undefined) {
    const plan = planCapabilityAudit(repositoryRoot, cli);
    const originalText = fs.readFileSync(plan.coveragePath, 'utf8');
    const editedText = applyCapabilityAuditPlan(originalText, plan);
    summarizePlan(plan, output);
    if (cli.dryRun) {
        printPlannedDiff(originalText, editedText, output);
        return { plan, committed: false, dryRun: true };
    }
    fs.writeFileSync(plan.coveragePath, editedText);
    const validationErrors = validateManifest(repositoryRoot, plan.coveragePath);
    if (validationErrors.length) {
        fs.writeFileSync(plan.coveragePath, originalText);
        throw new AuditRegenerationError([
            'regenerated manifest failed validation; the original file was restored:',
            ...validationErrors,
        ]);
    }
    output('validation passed');
    let committed = false;
    if (cli.commitMessage) {
        git(repositoryRoot, ['add', COVERAGE_RELATIVE_PATH]);
        git(repositoryRoot, [
            'commit', '-m', cli.commitMessage, '-m', harvestTrailer(plan.harvestDecision),
        ]);
        committed = true;
        output(`created audit commit ${git(repositoryRoot, ['rev-parse', 'HEAD'])}`);
    }
    return { plan, committed, dryRun: false };
}

function main() {
    const repositoryRoot = path.resolve(__dirname, '..');
    let cli;
    try {
        cli = parseArguments(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof AuditRegenerationError ? error.message : String(error));
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }
    try {
        regenerateCapabilityAudit(repositoryRoot, cli, line => console.log(line));
    } catch (error) {
        console.error(error instanceof AuditRegenerationError ? error.message : String(error));
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    appendJsonStringToArray,
    applyCapabilityAuditPlan,
    AuditRegenerationError,
    findMatchingBracket,
    harvestTrailer,
    normalizeHarvestDecision,
    parseArguments,
    planCapabilityAudit,
    regenerateCapabilityAudit,
};
