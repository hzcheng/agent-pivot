'use strict';

// Generates THIRD_PARTY_NOTICES.md from the production dependency closure of
// package-lock.json. The released VSIX bundles runtime dependencies into
// dist/dashboard.js (webpack) and media/mermaid.min.js (pre-bundled), so the
// notices must cover the full transitive production closure, not only the
// direct dependencies listed in package.json.

const fs = require('node:fs');
const path = require('node:path');

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice)(\.|[-_]|$)/i;

function resolveDependency(lockPackages, parentLockPath, dependencyName) {
    // Node-style resolution over lock paths: try nested paths first, then
    // walk up toward the hoisted node_modules/<name> entry. Skip dev-only
    // instances; a production dependency must resolve to a production entry.
    let current = parentLockPath;
    while (true) {
        const candidate = `${current}/node_modules/${dependencyName}`;
        const entry = lockPackages[candidate];
        if (entry && entry.dev !== true) {
            return candidate;
        }
        const trimmed = current.replace(/(^|\/)node_modules\/[^/]+$/, '');
        if (trimmed === current) {
            const hoisted = `node_modules/${dependencyName}`;
            const hoistedEntry = lockPackages[hoisted];
            return hoistedEntry && hoistedEntry.dev !== true ? hoisted : null;
        }
        current = trimmed;
    }
}

function productionClosure(rootPackage, lockPackages) {
    const resolved = new Map(); // name -> lock path
    const queue = [['', Object.keys(rootPackage.dependencies || {})]];
    while (queue.length > 0) {
        const [parentPath, names] = queue.shift();
        for (const name of names) {
            const lockPath = parentPath === ''
                ? (lockPackages[`node_modules/${name}`] ? `node_modules/${name}` : null)
                : resolveDependency(lockPackages, parentPath, name);
            if (!lockPath) {
                throw new Error(`production dependency ${name} (from ${parentPath || 'root'}) is missing from package-lock.json`);
            }
            if (resolved.has(name)) {
                continue;
            }
            resolved.set(name, lockPath);
            const entry = lockPackages[lockPath];
            queue.push([lockPath, Object.keys(entry.dependencies || {})]);
            queue.push([lockPath, Object.keys(entry.optionalDependencies || {})]);
        }
    }
    return resolved;
}

function declaredLicense(packageJson) {
    if (typeof packageJson.license === 'string') {
        return packageJson.license;
    }
    if (packageJson.license && typeof packageJson.license.type === 'string') {
        return packageJson.license.type;
    }
    if (Array.isArray(packageJson.licenses) && packageJson.licenses.length > 0) {
        return packageJson.licenses
            .map(entry => (entry && entry.type) || '')
            .filter(Boolean)
            .join(' OR ') || 'UNKNOWN';
    }
    return 'UNKNOWN';
}

function findLicenseFile(packageDir) {
    let entries;
    try {
        entries = fs.readdirSync(packageDir);
    } catch {
        return null;
    }
    const candidates = entries
        .filter(name => LICENSE_FILE_PATTERN.test(name))
        .sort((a, b) => {
            const rank = name => (/^licen[cs]e/i.test(name) ? 0 : /^copying/i.test(name) ? 1 : 2);
            return rank(a) - rank(b) || a.localeCompare(b);
        });
    for (const name of candidates) {
        const filePath = path.join(packageDir, name);
        try {
            if (fs.statSync(filePath).isFile()) {
                return filePath;
            }
        } catch {
            // ignore unreadable entries and continue
        }
    }
    return null;
}

function extractCopyright(licenseText, packageJson) {
    // Prefer an actual copyright notice (with a year or © marker); generic
    // license-body lines like the Apache "Licensor" definition also contain
    // the word "copyright" and must not leak into the section header.
    const line = (licenseText || '')
        .split(/\r?\n/)
        .find(candidate => /copyright/i.test(candidate) && /(\(c\)|©|\d{4})/i.test(candidate));
    if (line) {
        return line.trim()
            .replace(/\s+/g, ' ')
            .replace(/[-–—\s]*all rights reserved\.?$/i, '');
    }
    const author = packageJson.author;
    if (typeof author === 'string') {
        return author;
    }
    if (author && typeof author.name === 'string') {
        return author.name;
    }
    return '';
}

function collectNotices(repositoryRoot) {
    const rootPackage = JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    const lock = JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
    const lockPackages = lock.packages || {};
    const closure = productionClosure(lockPackages[''] || {}, lockPackages);

    const notices = [];
    for (const [name, lockPath] of [...closure.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const packageDir = path.join(repositoryRoot, lockPath);
        const packageJsonPath = path.join(packageDir, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            throw new Error(`production dependency ${name} is not installed at ${lockPath}; run npm ci first`);
        }
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const licenseFile = findLicenseFile(packageDir);
        // Normalize to LF: the repository pins `* text=auto`, so embedded
        // CRLF license files would otherwise make the rendered notices
        // disagree with the normalized blob Git stores and checks out.
        const licenseText = licenseFile
            ? fs.readFileSync(licenseFile, 'utf8').replace(/\r\n/g, '\n')
            : '';
        notices.push({
            name,
            version: packageJson.version || (lockPackages[lockPath].version || ''),
            license: declaredLicense(packageJson),
            copyright: extractCopyright(licenseText, packageJson),
            licenseText: licenseText || fallbackLicenseText(declaredLicense(packageJson), name),
            missingLicenseFile: !licenseFile,
        });
    }
    return notices;
}

// A few packages declare a license but ship no license file. For the common
// permissive case we embed the canonical license text so the notices stay
// self-contained; anything else is reported as missing instead of guessing.
function fallbackLicenseText(license, name) {
    if (license === 'MIT') {
        return [
            `The ${name} package declares the MIT License but does not ship a license file;`,
            'the canonical license text follows.',
            '',
            'MIT License',
            '',
            'Permission is hereby granted, free of charge, to any person obtaining a copy',
            'of this software and associated documentation files (the "Software"), to deal',
            'in the Software without restriction, including without limitation the rights',
            'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
            'copies of the Software, and to permit persons to whom the Software is',
            'furnished to do so, subject to the following conditions:',
            '',
            'The above copyright notice and this permission notice shall be included in all',
            'copies or substantial portions of the Software.',
            '',
            'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
            'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
            'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
            'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
            'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
            'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
            'SOFTWARE.',
        ].join('\n');
    }
    return '';
}

function renderNotices(notices) {
    const sections = notices.map(notice => {
        const header = `## ${notice.name} ${notice.version} — ${notice.license}`
            + (notice.copyright ? ` — ${notice.copyright}` : '');
        const body = notice.licenseText
            ? notice.licenseText.replace(/\n*$/, '')
            : `The ${notice.name} package does not ship a license file; its declared license is ${notice.license}.`;
        return `${header}\n\n${body}`;
    });
    return [
        '# Third-Party Notices',
        '',
        'Agent Pivot bundles the following third-party packages in its released VSIX',
        '(the webpack dashboard bundle and media/mermaid.min.js). This file is generated',
        'from the production dependency closure of package-lock.json by',
        'scripts/generate-third-party-notices.js; run that script and commit the result',
        'instead of editing by hand.',
        '',
        ...sections.flatMap(section => [section, '']),
    ].join('\n');
}

module.exports = {
    collectNotices,
    renderNotices,
};
